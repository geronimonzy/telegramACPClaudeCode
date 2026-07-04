// Composition root: assembles every prior module into a working bot.
//
// The Bridge owns the Map<threadId, TopicSession>, one PermissionBroker and one
// TerminalRegistry per process, and the single StateStore. It is
// transport-agnostic: it talks to Telegram exclusively through the thin
// {@link BotApi} interface (adapted to grammY in bot.ts, faked in tests), so
// the whole command table, upload handling and callback routing are unit
// testable without a real bot.
//
// Every user-facing string interpolated into a send goes through escapeHtml;
// every message send carries a message_thread_id (via BotApi, whose adapter
// threads it through). All logic lives here — bot.ts is a thin adapter.

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSession, type AgentSessionOptions } from "./acp/agent-session.js";
import { makeFsHandlers } from "./acp/fs-handlers.js";
import {
  readNewTurns,
  readSessionTurns,
  sessionFilePath,
  type ToolCallSummary,
  type TranscriptTurn,
} from "./acp/session-file.js";
import {
  collectUsageStats,
  lastContextUsed,
  renderUsageRich,
  type LiveSessionUsage,
  type UsageStats,
} from "./usage.js";
import {
  buildProjectKeyboard,
  renderProjectRich,
  renderProjectsHeader,
  shortenHome,
  type ProjectSession,
  type ProjectView,
} from "./projects.js";
import { TerminalRegistry } from "./acp/terminals.js";
import type { Config } from "./config.js";
import { escapeHtml } from "./html.js";
import { log } from "./log.js";
import { StateStore, type SessionState } from "./state.js";
import { TopicSession, type TopicUi } from "./orchestrator.js";
import { MessageDraft } from "./telegram/draft.js";
import {
  escapeRich,
  fitDetailsList,
  renderAgentTurnRich,
  renderUserTurnRich,
  RICH_MAX_LEN,
} from "./telegram/rich-html.js";
import { randomName } from "./telegram/names.js";
import { PermissionBroker } from "./telegram/permissions.js";
import type { MessageApi } from "./telegram/live-message.js";

/**
 * One inline-keyboard button: either a callback button (`callback_data`) or a
 * URL button (`url`). The Projects panel uses `url` buttons to deep-link into a
 * session's forum topic; every other keyboard uses `callback_data`. Read sites
 * narrow with `"callback_data" in btn`.
 */
export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

/** An inline keyboard, in Telegram's `inline_keyboard` shape. */
export interface InlineKeyboard {
  inline_keyboard: InlineKeyboardButton[][];
}

/**
 * The thin slice of the grammY Api the Bridge depends on. The bot.ts adapter
 * fills in `chat_id` (always `cfg.forumChatId`) and threads `message_thread_id`
 * / HTML parse mode / disabled link previews through every send. Faked in tests.
 */
export interface BotApi {
  /** Create a forum topic; resolves to its `message_thread_id`. */
  createForumTopic(name: string, iconColor: number): Promise<number>;
  /** Send an HTML message to a topic (`undefined` = General); resolves to its message id. */
  sendMessage(
    threadId: number | undefined,
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<number>;
  /** Edit a message's text (identified chat-globally by message id). */
  editMessageText(messageId: number, html: string): Promise<void>;
  /** Send a Rich Message (Bot API 10.1) to a topic (`undefined` = General); resolves to its message id. */
  sendRich(
    threadId: number | undefined,
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<number>;
  /**
   * Edit a message in place with new Rich Message content. An optional keyboard
   * is passed as `reply_markup` — NOTE Telegram DROPS an existing keyboard when
   * `reply_markup` is omitted on an edit, so a panel refresh must ALWAYS pass it.
   */
  editRich(messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Delete a message (identified chat-globally by message id). */
  deleteMessage(messageId: number): Promise<void>;
  /** Emit a chat action (typing heartbeat) for a topic. */
  sendChatAction(threadId: number | undefined, action: string): Promise<void>;
  /** Upload a local file as a document into a topic. */
  sendDocument(threadId: number, filePath: string, caption?: string): Promise<void>;
  /** Look up a Telegram file's server path + size by file id. */
  getFile(fileId: string): Promise<{ filePath?: string; fileSize?: number }>;
  /** Download a Telegram file (by server path) into memory. */
  downloadFile(filePath: string): Promise<Buffer>;
  /** Pin a message in a topic. */
  pinChatMessage(threadId: number | undefined, messageId: number): Promise<void>;
  /** Register the bot's command list (adapter scopes it to the forum chat). */
  setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void>;
  /** Close a forum topic. */
  closeForumTopic(threadId: number): Promise<void>;
}

/** How the Bridge starts an AgentSession; overridden in tests to inject a stream. */
export type AgentStarter = (opts: AgentSessionOptions) => Promise<AgentSession>;

/** An inbound Telegram message, normalized by the bot.ts adapter. */
export interface IncomingMsg {
  text?: string;
  caption?: string;
  photo?: { fileId: string; fileSize?: number };
  document?: { fileId: string; fileName: string; fileSize?: number; mimeType?: string };
}

/** The six forum-topic icon colors Telegram permits, cycled by `/new`. */
const ICON_COLORS = [7322096, 16766590, 13338331, 9367192, 16749490, 16478047];

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const TELEGRAM_MSG_LIMIT = 4000;
/** How many resumable sessions `/sessions` offers to attach at once. */
const MAX_LISTED_SESSIONS = 10;
/** Telegram forum-topic titles are capped at 128 chars; keep well under. */
const MAX_TITLE_LEN = 64;
/** How often the 📊 Claude Usage panel refreshes itself (edit-only). */
const USAGE_REFRESH_MS = 60 * 60 * 1000;
/** How often the CLI-mirror tails stored sessions' JSONLs. */
const MIRROR_POLL_MS = 15 * 1000;
/** Rows shown in one historical Activity panel before an "…and N more" row takes over. */
const TOOLS_PANEL_MAX_ROWS = 30;

/** Display labels for the select config options the bridge exposes as commands. */
const CONFIG_LABELS: Record<string, string> = { model: "Model", effort: "Effort" };

/**
 * Sessions record `entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT` in their
 * JSONL, and the Claude Code CLI HIDES entrypoints `sdk-cli`/`sdk-ts`/`sdk-py`
 * from the /resume picker — so bridge sessions (left to the SDK default,
 * `sdk-ts`) were unresumable from the terminal. The binary keeps any other
 * preset value verbatim (it only rewrites `cli` → `sdk-cli` when driven
 * programmatically), so we identify honestly and stay visible. Overridable
 * via cfg.adapterEnv.
 */
const ADAPTER_ENV_DEFAULTS: Record<string, string> = {
  CLAUDE_CODE_ENTRYPOINT: "telegram-acp-bridge",
};

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(homedir(), p.slice(1));
  return p;
}

/** The command list registered with Telegram (BotCommandScopeChat in bot.ts). */
export const COMMAND_LIST: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a session topic: /new [folder] [name…]" },
  { command: "sessions", description: "List resumable sessions to attach" },
  { command: "usage", description: "Update the 📊 Claude Usage stats topic" },
  { command: "projects", description: "Update the 📁 Projects overview topic" },
  { command: "end", description: "End this session and close the topic" },
  { command: "cancel", description: "Cancel the in-flight turn" },
  { command: "mode", description: "Choose the agent mode" },
  { command: "model", description: "Choose the model" },
  { command: "effort", description: "Choose the reasoning effort" },
  { command: "yolo", description: "Toggle bypass-permissions mode" },
  { command: "status", description: "Show session status" },
  { command: "commands", description: "List agent-supported commands" },
  { command: "cwd", description: "Show the session working directory" },
  { command: "file", description: "Send a file from the session cwd" },
];

const UNKNOWN_COMMAND =
  "Unknown command — /commands lists what the agent supports.";
const NO_SESSION =
  "No active session in this topic — /new to start one.";

/**
 * Parse a leading slash command; returns undefined for non-commands.
 *
 * ANY trimmed text starting with `/` is treated as a command attempt — never
 * falls through to a raw prompt forward. The name capture is intentionally
 * broad (`[^\s@]+`, not just `[A-Za-z0-9_:]+`) so hyphenated/unusual agent
 * command names (`/pr-comments`, `/frobnicate-now`) are recognized as commands
 * and run through the known/unknown decision, rather than slipping past the
 * regex and being forwarded to the agent as an ordinary prompt. In the rare
 * case the body doesn't match at all (e.g. `/` followed immediately by
 * whitespace), we still return a (deliberately unmatchable) command so the
 * caller's unknown-command path — not the prompt path — handles it.
 */
function parseCommand(text: string): { cmd: string; args: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const m = /^\/([^\s@]+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return { cmd: "", args: "" };
  return { cmd: m[1]!, args: (m[2] ?? "").trim() };
}

/** Best-effort image MIME type from a Telegram file path (photos are JPEG). */
function imageMime(filePath: string | undefined): string {
  const ext = (filePath ?? "").toLowerCase();
  if (ext.endsWith(".png")) return "image/png";
  if (ext.endsWith(".webp")) return "image/webp";
  if (ext.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

/** Split text into chunks no longer than `limit`, breaking on line boundaries. */
function chunk(text: string, limit: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur.length + line.length + 1 > limit && cur.length > 0) {
      out.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out.length ? out : [text];
}

function logError(context: string, e: unknown): void {
  log.error({ err: e }, `[bridge] ${context}`);
}

/**
 * True when a Telegram error means the target forum topic no longer exists
 * (user deleted it in the Telegram UI — bots receive NO update for that, so
 * it can only be noticed when a call into the thread fails). A closed topic
 * (`TOPIC_CLOSED`) is deliberately NOT matched: it still exists.
 */
function isThreadNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /thread not found|TOPIC_DELETED/i.test(msg);
}

/** Truncate to `max` chars, appending an ellipsis when cut. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Split `/new`'s argument into `[folder, title]`: the first whitespace-
 * delimited word selects the working directory; everything after it is the
 * topic title. Either part may be absent (`undefined`).
 */
function splitFolderAndTitle(
  arg: string | undefined,
): [string | undefined, string | undefined] {
  if (!arg) return [undefined, undefined];
  const sp = arg.search(/\s/);
  if (sp === -1) return [arg, undefined];
  const title = arg.slice(sp + 1).trim();
  return [arg.slice(0, sp), title === "" ? undefined : title];
}

export class Bridge {
  readonly #cfg: Config;
  readonly #botApi: BotApi;
  readonly #store: StateStore;
  readonly #startAgent: AgentStarter;

  readonly #broker = new PermissionBroker();
  readonly #terminals = new TerminalRegistry();
  readonly #sessions = new Map<number, TopicSession>();

  #seq = 0;

  // Attach targets from the LAST `/sessions` call, keyed by a global counter
  // that the `attach:{k}` callback_data references. Cleared wholesale on each
  // new `/sessions` call and per-entry on use, so a stale button is a no-op.
  #attachSeq = 0;
  readonly #attachTargets = new Map<number, { sessionId: string; cwd: string; title: string }>();
  // Session ids with an attach currently in flight. The store entry is only
  // written after the (possibly long) history replay finishes, so without this
  // a /sessions re-list during a replay would still offer the same session and
  // allow a duplicate attach.
  readonly #attaching = new Set<string>();

  // The 📊 Claude Usage topic + its single edited stats message, persisted at
  // {dataDir}/usage-topic.json so the topic is reused across restarts.
  #usageTopic: { threadId: number; messageId?: number } | undefined;
  #usageTimer: ReturnType<typeof setInterval> | undefined;
  readonly #collectUsage: () => Promise<UsageStats>;

  // The 📁 Projects topic: a pinned HEADER message plus ONE edited message PER
  // project (keyed by cwd), persisted at {dataDir}/projects-topic.json so the
  // topic + its messages are reused across restarts. A legacy `{threadId,
  // messageId}` pointer (the old single-panel shape) is read as `headerId`.
  #projectsTopic:
    | { threadId: number; headerId?: number; byCwd?: Record<string, number> }
    | undefined;
  #projectsTimer: ReturnType<typeof setInterval> | undefined;
  // Backlink targets from the LAST panel render, keyed by a monotonic counter
  // referenced by proj:new:{k} / proj:att:{k} callback_data (paths never go in
  // callback_data — 64-byte cap). Cleared + repopulated on every render; a tap
  // whose key is gone answers "no longer listed" (exactly like #attachTargets).
  #projSeq = 0;
  readonly #projTargets = new Map<
    number,
    { kind: "new"; cwd: string } | { kind: "att"; sessionId: string; cwd: string; title: string }
  >();
  // Last successful resumable listing, kept warm so a timer/event refresh can
  // render a 💤 section WITHOUT spawning a throwaway adapter (that cost is only
  // acceptable for the manual /projects command).
  #cachedSessions: acp.SessionInfo[] = [];

  // CLI-mirror: tail each stored session's JSONL and relay turns produced
  // OUTSIDE the bridge (e.g. `claude /resume` on the machine) into its topic.
  #mirrorTimer: ReturnType<typeof setInterval> | undefined;
  #mirrorRunning = false;
  readonly #mirrorExclude: Set<string>;
  readonly #projectsDir: string | undefined;

  constructor(
    cfg: Config,
    botApi: BotApi,
    store: StateStore,
    startAgent: AgentStarter = AgentSession.start,
    collectUsage: () => Promise<UsageStats> = () => collectUsageStats(),
    projectsDir?: string,
  ) {
    this.#cfg = cfg;
    this.#botApi = botApi;
    this.#store = store;
    this.#startAgent = startAgent;
    this.#collectUsage = collectUsage;
    this.#projectsDir = projectsDir;
    // Entries the bridge itself writes must never be mirrored back into the
    // topic (they were already streamed live): the configured entrypoint plus
    // "sdk-ts", which pre-entrypoint-fix bridge sessions were stamped with.
    const ownEntrypoint =
      { ...ADAPTER_ENV_DEFAULTS, ...cfg.adapterEnv }.CLAUDE_CODE_ENTRYPOINT ?? "sdk-ts";
    this.#mirrorExclude = new Set([ownEntrypoint, "sdk-ts"]);
  }

  /** The session JSONL path, honoring the test override for the projects root. */
  #sessionFile(cwd: string, sessionId: string): string {
    return sessionFilePath(cwd, sessionId, this.#projectsDir);
  }

  /**
   * Load persisted state and offer each stored session a Reconnect button.
   *
   * The bridge does NOT auto-reattach on boot: a restarted process has no live
   * agent subprocesses, and eagerly respawning every stored session at startup
   * is slow and surprising (it wakes agents the user may not touch this run).
   * Instead each stored topic gets a one-tap Reconnect button; tapping it loads
   * that session on demand (see {@link Bridge.handleCallback} → reconnect).
   * Telegram persists each topic's message history, so a reconnect never needs
   * to re-stream the transcript.
   */
  async init(): Promise<void> {
    await this.#store.load();
    const stored = this.#store.list();
    this.#seq = stored.length;
    for (const s of stored) {
      await this.#offerReconnect(
        s,
        `🔌 <b>${escapeHtml(s.title)}</b> — disconnected (bridge restarted). Tap Reconnect to resume.`,
      );
    }
    await this.#botApi.setMyCommands(COMMAND_LIST).catch((e) => logError("setMyCommands", e));

    // Hourly usage-panel refresh. Edit-only: it keeps an existing 📊 topic
    // current but never creates one — that stays a /usage decision. unref'd
    // so the timer alone never keeps the process alive.
    this.#usageTimer = setInterval(() => void this.#refreshUsagePanel(), USAGE_REFRESH_MS);
    this.#usageTimer.unref?.();

    // Hourly 📁 Projects panel refresh, same edit-only semantics as usage: keeps
    // an existing topic current but never creates one and never spawns a
    // throwaway adapter (a live agent or the cached listing supplies 💤).
    this.#projectsTimer = setInterval(() => void this.#refreshProjectsPanel(), USAGE_REFRESH_MS);
    this.#projectsTimer.unref?.();

    // CLI-mirror poll: relay turns appended to a stored session's JSONL from
    // outside the bridge (claude /resume on the machine) into its topic.
    this.#mirrorTimer = setInterval(() => void this.mirrorNow(), MIRROR_POLL_MS);
    this.#mirrorTimer.unref?.();
  }

  /**
   * Create a new forum topic + agent session. `arg` is `[folder] [name…]`:
   * the first word selects the working directory (an absolute/`~` path, a
   * `cfg.projects` key, or a directory under `defaultCwd`); anything after it
   * becomes the topic title. With no title the topic gets a random three-word
   * name. `reply` targets whichever topic the `/new` was issued from (General
   * or a session topic); the substantive intro is sent into the new topic.
   */
  async newTopic(
    arg: string | undefined,
    reply: (html: string) => Promise<void>,
  ): Promise<void> {
    const [folderArg, titleArg] = splitFolderAndTitle(arg);
    const cwd = await this.#resolveNewCwd(folderArg, reply);
    if (cwd === undefined) return; // an error reply was already sent; create nothing.

    const n = ++this.#seq;
    const title = titleArg !== undefined ? truncate(titleArg, MAX_TITLE_LEN) : randomName();
    const iconColor = ICON_COLORS[(n - 1) % ICON_COLORS.length]!;

    let threadId: number;
    try {
      threadId = await this.#botApi.createForumTopic(title, iconColor);
    } catch (e) {
      logError("createForumTopic failed", e);
      await reply("⚠️ could not create the topic — check the bot's admin rights.");
      return;
    }

    let session: TopicSession;
    try {
      session = await this.#spawnTopic(threadId, cwd, undefined);
    } catch (e) {
      logError("newTopic agent start failed", e);
      const notice = "💥 could not start the agent — /new to retry.";
      await this.#send(threadId, notice);
      // The topic is never stored (no Reconnect path exists for it), so leaving
      // it open would orphan an empty topic forever — best-effort close, never
      // fail the flow over it.
      await this.#botApi.closeForumTopic(threadId).catch((e) => logError("closeForumTopic", e));
      await reply(notice);
      return;
    }

    const agent = session.agentSession;
    await this.#store.upsert({
      threadId,
      acpSessionId: agent.sessionId,
      cwd,
      title,
      createdAt: new Date().toISOString(),
    });
    let introId: number | undefined;
    try {
      introId = await this.#botApi.sendMessage(
        threadId,
        `🆕 <b>${escapeHtml(title)}</b>\n` +
          `cwd: <code>${escapeHtml(cwd)}</code>\n` +
          `mode: ${escapeHtml(agent.currentModeId ?? "default")}\n` +
          `/commands for the commands this agent supports`,
      );
    } catch (e) {
      logError("send failed", e);
    }
    // Pin the intro so the session's key context stays reachable; a missing
    // can_pin_messages right (or any pin failure) must not fail /new.
    if (introId !== undefined) {
      await this.#botApi
        .pinChatMessage(threadId, introId)
        .catch((e) => logError("pinChatMessage failed", e));
    }
    await reply(`🆕 Created <b>${escapeHtml(title)}</b>.`);
    this.#pokeProjects(); // a new running session changed the overview
  }

  /**
   * Resolve the working directory for `/new`'s folder word. Returns the cwd,
   * or `undefined` after sending an error reply (caller then creates nothing):
   *   - no folder → defaultCwd;
   *   - starting with `/` or `~` → expanded path that MUST be an existing
   *     directory (else `⚠️ not a directory: <path>`);
   *   - otherwise → a `cfg.projects` key, else a directory under `defaultCwd`
   *     (zero-config folder selection), else a usage error.
   */
  async #resolveNewCwd(
    arg: string | undefined,
    reply: (html: string) => Promise<void>,
  ): Promise<string | undefined> {
    if (!arg) return this.#cfg.defaultCwd;

    if (arg.startsWith("/") || arg.startsWith("~")) {
      const expanded = expandHome(arg);
      try {
        const st = await stat(expanded);
        if (!st.isDirectory()) {
          await reply(`⚠️ not a directory: <code>${escapeHtml(expanded)}</code>`);
          return undefined;
        }
      } catch {
        await reply(`⚠️ not a directory: <code>${escapeHtml(expanded)}</code>`);
        return undefined;
      }
      return expanded;
    }

    const mapped = this.#cfg.projects[arg];
    if (mapped) return mapped;

    // A bare word can also name a directory under defaultCwd — zero-config
    // folder selection (`/new receiptSaas …` → {defaultCwd}/receiptSaas).
    const sub = path.join(this.#cfg.defaultCwd, arg);
    try {
      const st = await stat(sub);
      if (st.isDirectory()) return sub;
    } catch {
      // not a directory under defaultCwd either → usage error below
    }

    const known = Object.keys(this.#cfg.projects);
    const list = known.length > 0 ? known.map((k) => `<code>${escapeHtml(k)}</code>`).join(", ") : "(none)";
    await reply(
      `⚠️ unknown folder: <code>${escapeHtml(arg)}</code>\n` +
        `Usage: <code>/new [folder] [name…]</code> — the first word picks the working directory, the rest names the topic.\n` +
        `Folder can be a project (${list}), an absolute or <code>~</code> path, ` +
        `or a directory under <code>${escapeHtml(this.#cfg.defaultCwd)}</code>.`,
    );
    return undefined;
  }

  /**
   * Route one inbound message. `threadId === undefined` is the General topic
   * (only `/new` and `/sessions` are accepted there); a session topic dispatches
   * the full command table, uploads and plain-text prompts.
   */
  async handleMessage(threadId: number | undefined, msg: IncomingMsg): Promise<void> {
    if (threadId === undefined) {
      await this.#handleGeneral(msg);
      return;
    }

    const cmd = msg.text ? parseCommand(msg.text) : undefined;

    // `/new` works from any topic (creates a *new* one).
    if (cmd?.cmd === "new") {
      await this.newTopic(cmd.args || undefined, (h) => this.#send(threadId, h));
      return;
    }

    // `/sessions` works from any topic (the listing posts back into this one).
    if (cmd?.cmd === "sessions") {
      await this.#handleSessions(threadId);
      return;
    }

    // `/usage` works from any topic (it updates the 📊 Claude Usage topic).
    if (cmd?.cmd === "usage") {
      await this.#handleUsage(threadId);
      return;
    }

    // `/projects` works from any topic (it updates the 📁 Projects topic).
    if (cmd?.cmd === "projects") {
      await this.#handleProjects(threadId);
      return;
    }

    const session = this.#sessions.get(threadId);
    if (!session) {
      // A stored-but-disconnected topic (e.g. after a bridge restart) still has
      // persisted state — steer the user to Reconnect rather than /new, which
      // would abandon the session. A topic with no stored state gets the plain
      // "start one" notice.
      const stored = this.#store.get(threadId);
      if (stored) {
        await this.#offerReconnect(stored, "🔌 This session is disconnected. Tap Reconnect to resume.");
      } else {
        await this.#send(threadId, NO_SESSION);
      }
      return;
    }

    if (cmd) {
      await this.#dispatchCommand(threadId, session, cmd.cmd, cmd.args, msg.text!);
      return;
    }

    await this.#handlePrompt(threadId, session, msg);
  }

  /**
   * Route a callback query. `callbackMessageId` is the message the tapped
   * keyboard is attached to (used as the fallback edit target for a permission
   * decision whose prompt id the broker never learned). Returns the toast text.
   */
  async handleCallback(
    data: string,
    callbackMessageId: number | undefined,
  ): Promise<{ toast: string } | undefined> {
    if (data.startsWith("perm:")) return this.#handlePermCallback(data, callbackMessageId);
    if (data.startsWith("mode:")) return this.#handleModeCallback(data, callbackMessageId);
    if (data.startsWith("cfg:")) return this.#handleConfigCallback(data, callbackMessageId);
    if (data.startsWith("reconnect:")) return this.#handleReconnectCallback(data);
    if (data.startsWith("compact:")) return this.#handleCompactCallback(data, callbackMessageId);
    if (data.startsWith("continue:")) return this.#handleContinueCallback(data, callbackMessageId);
    if (data.startsWith("restart:")) return this.#handleRestartCallback(data);
    if (data.startsWith("attach:")) return this.#handleAttachCallback(data);
    if (data.startsWith("proj:")) return this.#handleProjectsCallback(data);
    return undefined;
  }

  /** Dispose every session + agent, kill terminals. Store is persisted eagerly. */
  async shutdown(): Promise<void> {
    if (this.#usageTimer !== undefined) {
      clearInterval(this.#usageTimer);
      this.#usageTimer = undefined;
    }
    if (this.#projectsTimer !== undefined) {
      clearInterval(this.#projectsTimer);
      this.#projectsTimer = undefined;
    }
    if (this.#mirrorTimer !== undefined) {
      clearInterval(this.#mirrorTimer);
      this.#mirrorTimer = undefined;
    }
    for (const session of this.#sessions.values()) {
      try {
        await session.dispose();
        await session.agentSession.dispose();
      } catch (e) {
        logError("shutdown dispose failed", e);
      }
    }
    this.#sessions.clear();
    this.#terminals.disposeAll();
  }

  // --- command dispatch ----------------------------------------------------

  async #dispatchCommand(
    threadId: number,
    session: TopicSession,
    cmd: string,
    args: string,
    rawText: string,
  ): Promise<void> {
    const agent = session.agentSession;
    switch (cmd) {
      case "end":
        await this.#endTopic(threadId, session);
        return;
      case "cancel":
        await session.cancel();
        await this.#send(threadId, "⏹ cancelling the current turn…");
        return;
      case "mode":
        await this.#send(threadId, "Choose a mode:", this.#modeKeyboard(threadId, agent));
        return;
      case "model":
        await this.#sendConfigKeyboard(threadId, agent, "model");
        return;
      case "effort":
        await this.#sendConfigKeyboard(threadId, agent, "effort");
        return;
      case "yolo":
        await this.#yolo(threadId, agent);
        return;
      case "status":
        await this.#send(threadId, this.#statusText(threadId, session));
        return;
      case "commands":
        await this.#sendCommands(threadId, agent);
        return;
      case "cwd": {
        const cwd = this.#store.get(threadId)?.cwd ?? this.#cfg.defaultCwd;
        await this.#send(threadId, `cwd: <code>${escapeHtml(cwd)}</code>`);
        return;
      }
      case "file":
        await this.#sendFile(threadId, args);
        return;
      default:
        await this.#dispatchAgentCommand(threadId, session, cmd, rawText);
    }
  }

  /** A non-builtin slash command: forward verbatim if the agent knows it, else refuse. */
  async #dispatchAgentCommand(
    threadId: number,
    session: TopicSession,
    cmd: string,
    rawText: string,
  ): Promise<void> {
    const known = session.agentSession.availableCommands.some(
      (c) => c.name === cmd || c.name === `mcp:${cmd}`,
    );
    if (!known) {
      await this.#send(threadId, UNKNOWN_COMMAND);
      return;
    }
    // The verbatim `/xyz args` text IS the ACP command invocation mechanism.
    await session.handleUserPrompt([{ type: "text", text: rawText.trim() }]);
  }

  async #endTopic(threadId: number, session: TopicSession): Promise<void> {
    this.#sessions.delete(threadId);
    this.#terminals.releaseForSession(session.agentSession.sessionId);
    try {
      await session.dispose();
      await session.agentSession.dispose();
    } catch (e) {
      logError("end dispose failed", e);
    }
    await this.#store.remove(threadId);
    // Best-effort cleanup of this topic's saved uploads; failure must not fail /end.
    await rm(path.join(this.#cfg.dataDir, "uploads", String(threadId)), {
      recursive: true,
      force: true,
    }).catch((e) => logError("uploads cleanup failed", e));
    await this.#botApi.closeForumTopic(threadId).catch((e) => logError("closeForumTopic", e));
    this.#pokeProjects(); // the session left the overview
  }

  async #yolo(threadId: number, agent: AgentSession): Promise<void> {
    const modes = agent.availableModes();
    let target: string;
    if (agent.currentModeId === "bypassPermissions") {
      target = "default";
    } else if (modes.some((m) => m.id === "bypassPermissions")) {
      target = "bypassPermissions";
    } else {
      target = "dontAsk";
    }
    try {
      await agent.setMode(target);
    } catch (e) {
      logError("yolo setMode failed", e);
      await this.#send(threadId, "⚠️ could not switch mode.");
      return;
    }
    const name = modes.find((m) => m.id === (agent.currentModeId ?? target))?.name ?? target;
    await this.#send(threadId, `Mode: <b>${escapeHtml(name)}</b>`);
  }

  #statusText(threadId: number, session: TopicSession): string {
    const agent = session.agentSession;
    const stored = this.#store.get(threadId);
    const lines = [
      `📊 <b>Status</b>`,
      `session: <code>${escapeHtml(agent.sessionId.slice(0, 8))}</code>`,
      `cwd: <code>${escapeHtml(stored?.cwd ?? this.#cfg.defaultCwd)}</code>`,
      `mode: ${escapeHtml(agent.currentModeId ?? "default")}`,
    ];
    for (const key of ["model", "effort"] as const) {
      const value = agent.currentConfigValue(key);
      if (value === undefined) continue;
      const name = agent.availableConfigValues(key).find((v) => v.id === value)?.name ?? value;
      lines.push(`${key}: ${escapeHtml(name)}`);
    }
    const u = session.lastUsage;
    if (u) {
      let usage = `usage: ${u.used}/${u.size} tokens`;
      if (u.cost) usage += ` · cost ${u.cost.amount} ${escapeHtml(u.cost.currency)}`;
      lines.push(usage);
    }
    return lines.join("\n");
  }

  async #sendCommands(threadId: number, agent: AgentSession): Promise<void> {
    const cmds = agent.availableCommands;
    if (cmds.length === 0) {
      await this.#send(threadId, "This agent advertises no commands.");
      return;
    }
    const body = cmds
      .map((c) => `/${escapeHtml(c.name)} — ${escapeHtml(c.description)}`)
      .join("\n");
    for (const part of chunk(body, TELEGRAM_MSG_LIMIT)) {
      await this.#send(threadId, part);
    }
  }

  async #sendFile(threadId: number, arg: string): Promise<void> {
    if (!arg) {
      await this.#send(threadId, "Usage: /file &lt;path&gt;");
      return;
    }
    const base = this.#store.get(threadId)?.cwd ?? this.#cfg.defaultCwd;
    const resolved = path.resolve(base, arg);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      await this.#send(threadId, "⚠️ path escapes the session directory.");
      return;
    }
    let size: number;
    try {
      const st = await stat(resolved);
      if (!st.isFile()) {
        await this.#send(threadId, "⚠️ not a regular file.");
        return;
      }
      size = st.size;
    } catch {
      await this.#send(threadId, `⚠️ no such file: <code>${escapeHtml(arg)}</code>`);
      return;
    }
    if (size > MAX_FILE_BYTES) {
      await this.#send(threadId, "⚠️ file is larger than 50 MB.");
      return;
    }
    try {
      await this.#botApi.sendDocument(threadId, resolved);
    } catch (e) {
      logError("sendDocument failed", e);
      await this.#send(threadId, "⚠️ could not send the file.");
    }
  }

  // --- prompts + uploads ---------------------------------------------------

  async #handlePrompt(
    threadId: number,
    session: TopicSession,
    msg: IncomingMsg,
  ): Promise<void> {
    let blocks: acp.ContentBlock[];
    try {
      blocks = await this.#buildBlocks(threadId, msg);
    } catch (e) {
      logError("upload handling failed", e);
      await this.#send(threadId, "⚠️ could not process the attachment.");
      return;
    }
    if (blocks.length === 0) return;
    await session.handleUserPrompt(blocks);
  }

  async #buildBlocks(threadId: number, msg: IncomingMsg): Promise<acp.ContentBlock[]> {
    const blocks: acp.ContentBlock[] = [];

    if (msg.photo) {
      const file = await this.#botApi.getFile(msg.photo.fileId);
      const size = file.fileSize ?? msg.photo.fileSize ?? 0;
      if (size > MAX_UPLOAD_BYTES) {
        await this.#send(threadId, "⚠️ photo is larger than 20 MB — skipped.");
      } else if (file.filePath) {
        const buf = await this.#botApi.downloadFile(file.filePath);
        blocks.push({
          type: "image",
          data: buf.toString("base64"),
          mimeType: imageMime(file.filePath),
        });
      }
      if (msg.caption) blocks.push({ type: "text", text: msg.caption });
      return blocks;
    }

    if (msg.document) {
      // Check the size Telegram already told us BEFORE calling getFile, so an
      // oversized upload is refused without an extra round trip (mirrors the
      // cap photos are held to).
      if ((msg.document.fileSize ?? 0) > MAX_UPLOAD_BYTES) {
        await this.#send(threadId, "⚠️ file is larger than 20 MB — skipped.");
        return blocks;
      }
      const file = await this.#botApi.getFile(msg.document.fileId);
      if (file.filePath) {
        const buf = await this.#botApi.downloadFile(file.filePath);
        const dir = path.join(this.#cfg.dataDir, "uploads", String(threadId));
        await mkdir(dir, { recursive: true });
        const rawBase = path.basename(msg.document.fileName);
        // `.` / `..` (and an empty basename) would otherwise resolve to the
        // uploads dir itself or its parent once joined — reject those and
        // fall back to a generated name instead of writing outside the
        // per-thread upload directory.
        const safeBase =
          rawBase === "" || rawBase === "." || rawBase === ".."
            ? `upload-${Date.now()}`
            : rawBase;
        const absPath = path.join(dir, safeBase);
        await writeFile(absPath, buf);
        if (msg.caption) blocks.push({ type: "text", text: msg.caption });
        blocks.push({ type: "text", text: `Attached file saved at: ${absPath}` });
        blocks.push({
          type: "resource_link",
          uri: `file://${absPath}`,
          name: msg.document.fileName,
          ...(msg.document.mimeType ? { mimeType: msg.document.mimeType } : {}),
        });
      }
      return blocks;
    }

    if (msg.text) blocks.push({ type: "text", text: msg.text });
    return blocks;
  }

  // --- callbacks -----------------------------------------------------------

  async #handlePermCallback(
    data: string,
    callbackMessageId: number | undefined,
  ): Promise<{ toast: string }> {
    const r = this.#broker.resolve(data);
    if (!r) return { toast: "" };
    // When the broker never learned the prompt's message id (a fast tap beat
    // the send), the orchestrator can't reflect the decision — fall back to the
    // callback query's own message id here.
    if (r.messageId === undefined && callbackMessageId !== undefined) {
      await this.#botApi
        .editMessageText(callbackMessageId, `➡️ ${escapeHtml(r.label)}`)
        .catch((e) => logError("perm fallback edit failed", e));
    }
    return { toast: r.label };
  }

  async #handleModeCallback(
    data: string,
    callbackMessageId: number | undefined,
  ): Promise<{ toast: string }> {
    const m = /^mode:(\d+):(.+)$/.exec(data);
    if (!m) return { toast: "" };
    const threadId = Number(m[1]);
    const modeId = m[2]!;
    const session = this.#sessions.get(threadId);
    if (!session) return { toast: "no session" };
    try {
      await session.agentSession.setMode(modeId);
    } catch (e) {
      logError("mode callback setMode failed", e);
      return { toast: "failed" };
    }
    const name =
      session.agentSession.availableModes().find((x) => x.id === modeId)?.name ?? modeId;
    if (callbackMessageId !== undefined) {
      await this.#botApi
        .editMessageText(callbackMessageId, `Mode: <b>${escapeHtml(name)}</b>`)
        .catch((e) => logError("mode edit failed", e));
    }
    return { toast: `Mode: ${name}` };
  }

  /**
   * Reconnect a stored-but-disconnected topic (the boot-time Reconnect button).
   * Loads the persisted ACP session on demand via `session/load`; replay chunks
   * are suppressed (no `onReplayChunk`) since Telegram already holds the topic's
   * history. If the agent no longer knows the id, AgentSession falls back to a
   * fresh session and we say so + persist the new id. A hard failure re-offers
   * the Reconnect button. A double-tap (already live) is a no-op.
   */
  async #handleReconnectCallback(data: string): Promise<{ toast: string }> {
    const threadId = Number(data.slice("reconnect:".length));
    const stored = this.#store.get(threadId);
    if (!stored) return { toast: "no session" };
    if (this.#sessions.has(threadId)) return { toast: "already connected" };

    // Terminals from the pre-restart process (if any lingered) reference the old
    // acp id; release them before loading so they don't leak past the reconnect.
    this.#terminals.releaseForSession(stored.acpSessionId);
    try {
      const session = await this.#spawnTopic(threadId, stored.cwd, stored.acpSessionId);
      const agent = session.agentSession;
      if (agent.loaded) {
        // The reconnect-offer notice (if any) is now stale — clear it, and
        // drop the field from the store since nothing is tracking it anymore.
        if (stored.reconnectMsgId !== undefined) {
          await this.#botApi
            .deleteMessage(stored.reconnectMsgId)
            .catch((e) => logError("reconnect notice delete failed", e));
          const { reconnectMsgId: _reconnectMsgId, ...rest } = stored;
          await this.#store.upsert(rest);
        }
        // Mirror the Claude Code TUI's resume choice: a restored session may
        // carry a large context, so offer a one-tap /compact alongside plain
        // continue. (Over ACP there is no such prompt from the agent itself —
        // /compact is an ordinary advertised command we forward.)
        await this.#send(threadId, `🔌 <b>${escapeHtml(stored.title)}</b> — reconnected.`, {
          inline_keyboard: [
            [
              { text: "🧠 Compact", callback_data: `compact:${threadId}` },
              { text: "▶️ Continue", callback_data: `continue:${threadId}` },
            ],
          ],
        });
        this.#pokeProjects(); // session moved disconnected → running
        return { toast: "reconnected" };
      }
      // loadSession failed; AgentSession fell back to a fresh session. The
      // reconnect-offer notice (if any) is stale too — clear it, folding the
      // field's omission into the upsert this branch already needs.
      if (stored.reconnectMsgId !== undefined) {
        await this.#botApi
          .deleteMessage(stored.reconnectMsgId)
          .catch((e) => logError("reconnect notice delete failed", e));
      }
      const { reconnectMsgId: _reconnectMsgId, ...rest } = stored;
      await this.#store.upsert({ ...rest, acpSessionId: agent.sessionId });
      await this.#send(
        threadId,
        `⚠️ <b>${escapeHtml(stored.title)}</b> — previous session could not be restored; started fresh.`,
      );
      this.#pokeProjects(); // session moved disconnected → running
      return { toast: "started fresh" };
    } catch (e) {
      logError(`reconnect failed for thread ${threadId}`, e);
      await this.#offerReconnect(
        stored,
        `💥 <b>${escapeHtml(stored.title)}</b> — could not reconnect. Tap Reconnect to retry.`,
      );
      return { toast: "reconnect failed" };
    }
  }

  /**
   * The post-reconnect "🧠 Compact" button: fire `/compact` into the session as
   * an ordinary agent command. Deliberately NOT awaited — a compaction is a
   * full prompt turn and can take a while; the callback must answer promptly,
   * and the adapter streams "Compacting..." / "Compacting completed." into the
   * topic as normal agent output.
   */
  async #handleCompactCallback(
    data: string,
    callbackMessageId: number | undefined,
  ): Promise<{ toast: string }> {
    const threadId = Number(data.slice("compact:".length));
    const session = this.#sessions.get(threadId);
    if (!session) return { toast: "no session" };
    if (callbackMessageId !== undefined) {
      await this.#botApi
        .editMessageText(callbackMessageId, "🔌 reconnected — 🧠 compacting…")
        .catch((e) => logError("compact edit failed", e));
    }
    void session
      .handleUserPrompt([{ type: "text", text: "/compact" }])
      .catch((e) => logError("compact prompt failed", e));
    return { toast: "compacting" };
  }

  /** The post-reconnect "▶️ Continue" button: dismiss the choice, change nothing. */
  async #handleContinueCallback(
    data: string,
    callbackMessageId: number | undefined,
  ): Promise<{ toast: string }> {
    const threadId = Number(data.slice("continue:".length));
    if (!this.#store.get(threadId)) return { toast: "no session" };
    if (callbackMessageId !== undefined) {
      await this.#botApi
        .editMessageText(callbackMessageId, "🔌 reconnected — continuing.")
        .catch((e) => logError("continue edit failed", e));
    }
    return { toast: "continuing" };
  }

  /** Set a select config option from a `cfg:{threadId}:{key}:{value}` tap. */
  async #handleConfigCallback(
    data: string,
    callbackMessageId: number | undefined,
  ): Promise<{ toast: string }> {
    const m = /^cfg:(\d+):(\w+):(.+)$/.exec(data);
    if (!m) return { toast: "" };
    const threadId = Number(m[1]);
    const key = m[2]!;
    const value = m[3]!;
    const session = this.#sessions.get(threadId);
    if (!session) return { toast: "no session" };
    try {
      await session.agentSession.setConfigValue(key, value);
    } catch (e) {
      logError("config callback failed", e);
      return { toast: "failed" };
    }
    const label = CONFIG_LABELS[key] ?? key;
    const name =
      session.agentSession.availableConfigValues(key).find((v) => v.id === value)?.name ?? value;
    if (callbackMessageId !== undefined) {
      await this.#botApi
        .editMessageText(callbackMessageId, `${label}: <b>${escapeHtml(name)}</b>`)
        .catch((e) => logError("config edit failed", e));
    }
    return { toast: `${label}: ${name}` };
  }

  async #handleRestartCallback(data: string): Promise<{ toast: string }> {
    const threadId = Number(data.slice("restart:".length));
    const stored = this.#store.get(threadId);
    if (!stored) return { toast: "no session" };

    const existing = this.#sessions.get(threadId);
    if (existing) {
      this.#sessions.delete(threadId);
      this.#terminals.releaseForSession(existing.agentSession.sessionId);
      try {
        await existing.dispose();
        await existing.agentSession.dispose();
      } catch (e) {
        logError("restart dispose failed", e);
      }
    } else {
      this.#terminals.releaseForSession(stored.acpSessionId);
    }

    try {
      const session = await this.#spawnTopic(threadId, stored.cwd, stored.acpSessionId);
      await this.#store.upsert({ ...stored, acpSessionId: session.agentSession.sessionId });
      await this.#send(threadId, "🔄 agent restarted.");
      return { toast: "restarted" };
    } catch (e) {
      logError("restart failed", e);
      await this.#store.remove(threadId);
      await this.#send(threadId, "💥 restart failed — /new to start again.");
      return { toast: "restart failed" };
    }
  }

  // --- /sessions + attach --------------------------------------------------

  /**
   * List the agent's resumable sessions into `replyThreadId` (undefined =
   * General), filtering out ids already attached in this process, and offer an
   * inline `attach:{k}` button per remaining session (most recent ~10).
   */
  async #handleSessions(replyThreadId: number | undefined): Promise<void> {
    // Reconcile first: a topic deleted in the Telegram UI leaves a stale
    // store entry that would permanently hide its session from this listing
    // (deletion produces no bot update). Probe each stored topic with a chat
    // action — the cheapest thread-scoped call — and prune the dead ones.
    for (const s of this.#store.list()) {
      try {
        await this.#botApi.sendChatAction(s.threadId, "typing");
      } catch (e) {
        if (isThreadNotFound(e)) await this.#pruneDeletedTopic(s.threadId);
      }
    }

    let sessions: acp.SessionInfo[];
    try {
      sessions = await this.#fetchSessions();
      this.#cachedSessions = sessions; // keep the Projects panel's 💤 cache warm
    } catch (e) {
      logError("listSessions failed", e);
      await this.#send(replyThreadId, "⚠️ could not list sessions — see logs.");
      return;
    }

    const attached = new Set(this.#store.list().map((s) => s.acpSessionId));
    const available = sessions
      .filter((s) => !attached.has(s.sessionId) && !this.#attaching.has(s.sessionId))
      .slice(0, MAX_LISTED_SESSIONS);

    if (available.length === 0) {
      await this.#send(replyThreadId, "No resumable sessions to attach.");
      return;
    }

    // A fresh listing supersedes the previous one: drop all stale targets.
    this.#attachTargets.clear();

    const rows: Array<Array<{ text: string; callback_data: string }>> = [];
    const lines: string[] = ["📂 <b>Resumable sessions</b> — tap to attach:"];
    let i = 0;
    for (const s of available) {
      const k = ++this.#attachSeq;
      const title = (s.title ?? "").trim() || randomName();
      this.#attachTargets.set(k, { sessionId: s.sessionId, cwd: s.cwd, title });
      i += 1;
      const date = s.updatedAt ? new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ") : "";
      lines.push(
        `\n<b>${i}.</b> ${escapeHtml(truncate(title, 80))}\n` +
          `<code>${escapeHtml(s.cwd)}</code>${date ? ` · ${escapeHtml(date)}` : ""}`,
      );
      rows.push([{ text: `${i}. ${truncate(title, 40)}`, callback_data: `attach:${k}` }]);
    }

    await this.#send(replyThreadId, lines.join("\n"), { inline_keyboard: rows });
  }

  /**
   * Obtain a live AgentSession to call `session/list`. Reuses any existing
   * topic's agent when present; otherwise spawns a short-lived throwaway
   * (defaultCwd) and disposes it right after listing.
   */
  async #fetchSessions(): Promise<acp.SessionInfo[]> {
    const existing = this.#sessions.values().next().value as TopicSession | undefined;
    if (existing) {
      const res = await existing.agentSession.listSessions({});
      return res.sessions;
    }
    const agent = await this.#startAgent({
      cwd: this.#cfg.defaultCwd,
      spawn: { command: this.#cfg.adapterCommand, env: { ...ADAPTER_ENV_DEFAULTS, ...this.#cfg.adapterEnv } },
      client: { ...makeFsHandlers(), ...this.#terminals.handlers() },
      onUpdate: () => {},
      onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      onExit: () => {},
    });
    try {
      const res = await agent.listSessions({});
      return res.sessions;
    } finally {
      await agent.dispose().catch((e) => logError("throwaway dispose failed", e));
    }
  }

  /**
   * Attach the session behind an `attach:{k}` button: create a forum topic,
   * `session/load` it, and stream its FULL history into the topic as a readable
   * transcript before persisting it like any other topic.
   */
  async #handleAttachCallback(data: string): Promise<{ toast: string }> {
    const k = Number(data.slice("attach:".length));
    const target = this.#attachTargets.get(k);
    if (!target) return { toast: "session no longer listed" };
    this.#attachTargets.delete(k); // evict on use
    this.#attaching.add(target.sessionId);
    try {
      return await this.#attachTarget(target);
    } finally {
      this.#attaching.delete(target.sessionId);
    }
  }

  async #attachTarget(target: { sessionId: string; cwd: string; title: string }): Promise<{ toast: string }> {

    const title = truncate(target.title, MAX_TITLE_LEN);
    const n = ++this.#seq;
    const iconColor = ICON_COLORS[(n - 1) % ICON_COLORS.length]!;

    let threadId: number;
    try {
      threadId = await this.#botApi.createForumTopic(title, iconColor);
    } catch (e) {
      logError("attach createForumTopic failed", e);
      return { toast: "could not create topic" };
    }

    // Collect the suppressed replay into speaker TURNS (consecutive same-role
    // chunks merge). AgentSession routes every replay chunk to onReplayChunk
    // during session/load, all before #spawnTopic resolves. NOTE: this is only
    // the FALLBACK transcript source — the adapter's replay is truncated for
    // some sessions (its getSessionMessages stops after the first turn), so
    // the session's own JSONL file is preferred below.
    const turns: Array<{ role: "user" | "agent"; text: string }> = [];
    const onReplayChunk = (u: acp.SessionUpdate): void => {
      let role: "user" | "agent";
      if (u.sessionUpdate === "user_message_chunk") role = "user";
      else if (u.sessionUpdate === "agent_message_chunk") role = "agent";
      else return;
      if (u.content.type !== "text") return;
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.text += u.content.text;
      else turns.push({ role, text: u.content.text });
    };

    let session: TopicSession;
    try {
      session = await this.#spawnTopic(threadId, target.cwd, target.sessionId, onReplayChunk);
    } catch (e) {
      logError("attach spawn failed", e);
      await this.#send(threadId, "💥 could not attach the session — /new to start fresh.");
      return { toast: "attach failed" };
    }

    // Prefer the transcript from Claude Code's own session file: it is local,
    // authoritative, and immune to the adapter's truncated replay — and the
    // only source with tool-call bursts (the replay fallback below only ever
    // carries prose chunks). The replay turns win only when the file is
    // missing/unreadable or somehow holds LESS than the replay delivered
    // (format drift safety net).
    let transcript: TranscriptTurn[] = turns;
    try {
      const fileTurns = await readSessionTurns(
        this.#sessionFile(target.cwd, target.sessionId),
      );
      if (fileTurns.length >= turns.length) transcript = fileTurns;
    } catch (e) {
      log.warn(
        { err: e, sessionId: target.sessionId },
        "[bridge] session file unavailable; using adapter replay transcript",
      );
    }

    await this.#postTranscript(threadId, transcript);

    const agent = session.agentSession;
    await this.#store.upsert({
      threadId,
      acpSessionId: agent.sessionId,
      cwd: target.cwd,
      title,
      createdAt: new Date().toISOString(),
    });
    await this.#send(threadId, "📎 attached — full history above; the session is live");
    this.#pokeProjects(); // session moved resumable → running
    return { toast: "attached" };
  }

  // --- CLI mirror ------------------------------------------------------------

  /**
   * One mirror pass over every stored session (public so tests — and anything
   * wanting an immediate sync — can drive it without the timer). Single-flight:
   * a pass still running when the next tick fires is not overlapped.
   */
  async mirrorNow(): Promise<void> {
    if (this.#mirrorRunning) return;
    this.#mirrorRunning = true;
    try {
      for (const s of this.#store.list()) {
        try {
          await this.#mirrorOne(s);
        } catch (e) {
          logError(`mirror failed for thread ${s.threadId}`, e);
        }
      }
    } finally {
      this.#mirrorRunning = false;
    }
  }

  /**
   * Tail one session's JSONL. The first sighting BASELINES the cursor at the
   * current file size without posting anything — everything before that point
   * is already in the topic (live streaming or the attach transcript). After
   * that, appended entries produced outside the bridge (CLI resume) are
   * rendered like an attach transcript; the bridge's own entries are excluded
   * but still advance the cursor.
   */
  async #mirrorOne(s: SessionState): Promise<void> {
    const fp = this.#sessionFile(s.cwd, s.acpSessionId);
    let size: number;
    try {
      size = (await stat(fp)).size;
    } catch {
      return; // no session file yet (no turn ever ran) — nothing to mirror
    }
    if (s.mirrorOffset === undefined) {
      await this.#store.upsert({ ...s, mirrorOffset: size });
      return;
    }
    if (size <= s.mirrorOffset) return;
    const { turns, nextOffset } = await readNewTurns(fp, s.mirrorOffset, this.#mirrorExclude);
    if (turns.length > 0) {
      await this.#send(s.threadId, "💻 <i>picked up outside Telegram — mirroring:</i>");
      await this.#postTranscript(s.threadId, turns);
    }
    // Re-read the entry: a concurrent upsert (e.g. reconnect) may have changed
    // other fields while we were posting.
    const cur = this.#store.get(s.threadId);
    if (cur) await this.#store.upsert({ ...cur, mirrorOffset: nextOffset });
  }

  /**
   * Post transcript turns ONE MESSAGE PER TURN — user turns as literal bold
   * blockquotes, agent turns as markdown under a 🤖 header, tool bursts as a
   * static ⚙️ Activity-style panel — interleaved in file order so historical
   * transcripts read like a live turn. MessageDraft owns rollover for any
   * single prose turn past the rich budget. Shared by the attach replay and
   * the CLI mirror.
   */
  async #postTranscript(threadId: number, turns: TranscriptTurn[]): Promise<void> {
    for (const turn of turns) {
      if (turn.role === "tools") {
        await this.#postToolsBurst(threadId, turn.calls);
        continue;
      }
      if (turn.text.trim() === "") continue;
      const draft = new MessageDraft(this.#makeUi(threadId).messageApi(), {
        intervalMs: this.#cfg.editIntervalMs,
        maxLen: RICH_MAX_LEN,
        render: turn.role === "user" ? renderUserTurnRich : renderAgentTurnRich,
      });
      draft.append(turn.text);
      await draft.finalize();
    }
  }

  /**
   * Render one tool-call burst as a single static Rich Message, styled like
   * activity.ts's live Activity panel (same `⚙️ Activity — N calls` summary,
   * same ✅/❌ status marks) but one-shot: there is no live status to track,
   * so every call renders as either ok (✅) or failed (❌) — never
   * pending/in_progress, since by the time a historical transcript is read
   * the turn is long over. Sent directly through the rich `send` path (no
   * MessageDraft/rollover needed: rows are capped both in count and, via
   * fitDetailsList, in total length). A burst with no calls (defensive —
   * extractTurns never actually produces one) is skipped.
   */
  async #postToolsBurst(threadId: number, calls: ToolCallSummary[]): Promise<void> {
    if (calls.length === 0) return;
    const shown = calls.slice(0, TOOLS_PANEL_MAX_ROWS);
    const rows = shown.map(
      (c) => `<li>${c.failed ? "❌" : "✅"} <b>${escapeRich(c.title)}</b></li>`,
    );
    const omitted = calls.length - shown.length;
    if (omitted > 0) rows.push(`<li><i>…and ${omitted} more</i></li>`);
    const summary = `⚙️ Activity — ${calls.length} call${calls.length === 1 ? "" : "s"}`;
    const html = fitDetailsList({ summary, rows, max: RICH_MAX_LEN, open: true });
    await this.#makeUi(threadId).messageApi().send(html);
  }

  // --- /usage --------------------------------------------------------------

  get #usageTopicFile(): string {
    return path.join(this.#cfg.dataDir, "usage-topic.json");
  }

  async #loadUsageTopic(): Promise<void> {
    if (this.#usageTopic) return;
    try {
      const raw = JSON.parse(await readFile(this.#usageTopicFile, "utf-8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { threadId?: unknown }).threadId === "number"
      ) {
        this.#usageTopic = raw as { threadId: number; messageId?: number };
      }
    } catch {
      // missing/corrupt file → a fresh topic is created on demand
    }
  }

  async #saveUsageTopic(): Promise<void> {
    await writeFile(this.#usageTopicFile, JSON.stringify(this.#usageTopic ?? null)).catch((e) =>
      logError("usage-topic save failed", e),
    );
  }

  /**
   * `/usage`: aggregate token stats from the local Claude session files and
   * render them into the dedicated 📊 Claude Usage topic — ONE stats message,
   * edited in place on every refresh (created + pinned on first use; the
   * topic is recreated if it was deleted). A short confirmation goes to
   * wherever the command was issued (unless that IS the stats topic).
   */
  async #handleUsage(replyThreadId: number | undefined): Promise<void> {
    try {
      await this.#updateUsagePanel(true);
    } catch (e) {
      logError("usage update failed", e);
      await this.#send(replyThreadId, "⚠️ could not update the usage stats — see logs.");
      return;
    }
    if (replyThreadId !== this.#usageTopic?.threadId) {
      await this.#send(replyThreadId, "📊 usage stats updated.");
    }
  }

  /** The hourly refresh tick: edit-only (never resurrects a deleted topic). */
  async #refreshUsagePanel(): Promise<void> {
    try {
      await this.#loadUsageTopic();
      if (!this.#usageTopic) return; // never ran /usage → nothing to refresh
      await this.#updateUsagePanel(false);
    } catch (e) {
      logError("scheduled usage refresh failed", e);
    }
  }

  /** Collect + render + deliver the stats panel. Throws on hard failure. */
  async #updateUsagePanel(recreate: boolean): Promise<void> {
    const stats = await this.#collectUsage();
    const live: LiveSessionUsage[] = [];
    for (const s of this.#store.list()) {
      const session = this.#sessions.get(s.threadId);
      const u = session?.lastUsage;
      const entry: LiveSessionUsage = {
        title: s.title,
        connected: session !== undefined,
        ...(u ? { used: u.used, size: u.size } : {}),
      };
      if (!u) {
        // No live usage_update (disconnected, or no turn yet this process):
        // recover the last-turn context from the session's own JSONL.
        try {
          const fileUsed = await lastContextUsed(this.#sessionFile(s.cwd, s.acpSessionId));
          if (fileUsed !== undefined) entry.fileUsed = fileUsed;
        } catch {
          // no session file → leave the dash
        }
      }
      live.push(entry);
    }
    await this.#loadUsageTopic();
    await this.#deliverUsage(renderUsageRich(stats, live), recreate);
  }

  /**
   * Edit the stats message in place. With `recreate` the topic/message are
   * (re)created as needed (`/usage`); without it a deleted topic just clears
   * the pointer — the scheduler must not resurrect a topic the user deleted.
   */
  async #deliverUsage(html: string, recreate: boolean): Promise<void> {
    // Existing topic + message: try the in-place edit first.
    if (this.#usageTopic?.messageId !== undefined) {
      try {
        await this.#botApi.editRich(this.#usageTopic.messageId, html);
        return;
      } catch (e) {
        if (e instanceof Error && /not modified/i.test(e.message)) return; // same content
        if (isThreadNotFound(e)) {
          this.#usageTopic = undefined; // topic deleted
        } else {
          // e.g. message deleted or too old to edit → send a fresh one below
          this.#usageTopic = { threadId: this.#usageTopic.threadId };
        }
      }
    }
    if (!this.#usageTopic) {
      if (!recreate) {
        await this.#saveUsageTopic(); // persist the cleared pointer
        return;
      }
      const threadId = await this.#botApi.createForumTopic("📊 Claude Usage", ICON_COLORS[0]!);
      this.#usageTopic = { threadId };
    }
    try {
      const messageId = await this.#botApi.sendRich(this.#usageTopic.threadId, html);
      this.#usageTopic.messageId = messageId;
      await this.#botApi
        .pinChatMessage(this.#usageTopic.threadId, messageId)
        .catch((e) => logError("usage pin failed", e));
    } catch (e) {
      // The stored topic may itself be deleted.
      if (!isThreadNotFound(e)) throw e;
      if (!recreate) {
        this.#usageTopic = undefined;
        await this.#saveUsageTopic();
        return;
      }
      const threadId = await this.#botApi.createForumTopic("📊 Claude Usage", ICON_COLORS[0]!);
      this.#usageTopic = { threadId };
      const messageId = await this.#botApi.sendRich(threadId, html);
      this.#usageTopic.messageId = messageId;
      await this.#botApi
        .pinChatMessage(threadId, messageId)
        .catch((e2) => logError("usage pin failed", e2));
    }
    await this.#saveUsageTopic();
  }

  // --- /projects -----------------------------------------------------------

  get #projectsTopicFile(): string {
    return path.join(this.#cfg.dataDir, "projects-topic.json");
  }

  async #loadProjectsTopic(): Promise<void> {
    if (this.#projectsTopic) return;
    try {
      const raw = JSON.parse(await readFile(this.#projectsTopicFile, "utf-8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        typeof (raw as { threadId?: unknown }).threadId === "number"
      ) {
        const o = raw as { threadId: number; headerId?: number; byCwd?: Record<string, number>; messageId?: number };
        // Legacy migration: the deployed single-panel bridge wrote `messageId`.
        // Treat that old panel message as the header — it gets edited into header
        // content on the next delivery, and the new shape is persisted on save.
        const headerId = o.headerId ?? o.messageId;
        this.#projectsTopic = {
          threadId: o.threadId,
          ...(headerId !== undefined ? { headerId } : {}),
          byCwd: o.byCwd ?? {},
        };
      }
    } catch {
      // missing/corrupt file → a fresh topic is created on demand
    }
  }

  async #saveProjectsTopic(): Promise<void> {
    await writeFile(this.#projectsTopicFile, JSON.stringify(this.#projectsTopic ?? null)).catch(
      (e) => logError("projects-topic save failed", e),
    );
  }

  /**
   * `/projects`: (re)build the 📁 Projects overview into its dedicated topic — a
   * pinned header plus ONE message per project (each with its backlink keyboard),
   * edited in place where possible (topic created on first use; recreated if it
   * was deleted). A short confirmation goes to wherever the command was issued
   * (unless that IS the projects topic).
   */
  async #handleProjects(replyThreadId: number | undefined): Promise<void> {
    try {
      await this.#updateProjectsPanel(true);
    } catch (e) {
      logError("projects update failed", e);
      await this.#send(replyThreadId, "⚠️ could not update the projects overview — see logs.");
      return;
    }
    if (replyThreadId !== this.#projectsTopic?.threadId) {
      await this.#send(replyThreadId, "📁 projects updated.");
    }
  }

  /** The hourly/event refresh tick: edit-only (never resurrects a deleted topic). */
  async #refreshProjectsPanel(): Promise<void> {
    try {
      await this.#loadProjectsTopic();
      if (!this.#projectsTopic) return; // never ran /projects → nothing to refresh
      await this.#updateProjectsPanel(false);
    } catch (e) {
      logError("scheduled projects refresh failed", e);
    }
  }

  /**
   * Fire-and-forget edit-only Projects refresh after a state change. Wrapped so
   * no caller path (newTopic, /end, attach, reconnect, prune) can be failed by
   * the panel; the refresh is itself edit-only and never spawns a throwaway.
   */
  #pokeProjects(): void {
    void this.#refreshProjectsPanel().catch((e) => logError("projects poke failed", e));
  }

  /** Collect + deliver the overview panel. Throws on hard failure. */
  async #updateProjectsPanel(recreate: boolean): Promise<void> {
    const resumable = await this.#listResumable(recreate);
    const projects = this.#buildProjects(resumable);
    await this.#loadProjectsTopic();
    await this.#deliverProjects(projects, recreate);
  }

  /**
   * Resumable listing for the panel. Reuses an existing live agent when one
   * exists (a real `session/list`, no subprocess); otherwise spawns a throwaway
   * ONLY when `allowSpawn` (the manual /projects command). A timer/event refresh
   * passes `allowSpawn=false` and falls back to the cached last listing — it
   * must NEVER spawn from a timer.
   */
  async #listResumable(allowSpawn: boolean): Promise<acp.SessionInfo[]> {
    if (this.#sessions.size > 0 || allowSpawn) {
      try {
        const sessions = await this.#fetchSessions();
        this.#cachedSessions = sessions;
        return sessions;
      } catch (e) {
        logError("projects resumable listing failed", e);
      }
    }
    return this.#cachedSessions;
  }

  /**
   * Shape the projects + their grouped sessions for the panel, and (re)populate
   * the backlink target map. Projects = union of cfg.projects paths (listed even
   * with zero sessions), stored-session cwds, and free resumable-session cwds.
   * Order: cfg projects first (object order), then the rest alphabetically by
   * display name; within a project running → disconnected → resumable (newest
   * first). Clears + repopulates #projTargets so stale taps miss.
   */
  #buildProjects(resumable: acp.SessionInfo[]): ProjectView[] {
    this.#projTargets.clear();

    const stored = this.#store.list();
    const attachedIds = new Set(stored.map((s) => s.acpSessionId));
    // Same filter as #handleSessions: exclude ids already attached / attaching.
    const freeResumable = resumable.filter(
      (s) => !attachedIds.has(s.sessionId) && !this.#attaching.has(s.sessionId),
    );

    // Reverse cfg.projects (name → path) into path → display name (first wins).
    const pathToName = new Map<string, string>();
    for (const [name, p] of Object.entries(this.#cfg.projects)) {
      if (!pathToName.has(p)) pathToName.set(p, name);
    }
    const displayName = (cwd: string): string => pathToName.get(cwd) ?? shortenHome(cwd);

    const cfgPaths = [...new Set(Object.values(this.#cfg.projects))];
    const cfgSet = new Set(cfgPaths);
    const rest = new Set<string>();
    for (const s of stored) if (!cfgSet.has(s.cwd)) rest.add(s.cwd);
    for (const s of freeResumable) if (!cfgSet.has(s.cwd)) rest.add(s.cwd);
    const orderedCwds = [
      ...cfgPaths,
      ...[...rest].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    ];

    const views: ProjectView[] = [];
    for (const cwd of orderedCwds) {
      const running: ProjectSession[] = [];
      const disconnected: ProjectSession[] = [];
      for (const s of stored) {
        if (s.cwd !== cwd) continue;
        const line: ProjectSession = { title: s.title, threadId: s.threadId };
        if (this.#sessions.has(s.threadId)) running.push(line);
        else disconnected.push(line);
      }
      const resumableLines: ProjectSession[] = freeResumable
        .filter((s) => s.cwd === cwd)
        .sort(
          (a, b) =>
            (b.updatedAt ? Date.parse(b.updatedAt) : 0) -
            (a.updatedAt ? Date.parse(a.updatedAt) : 0),
        )
        .map((s) => {
          const k = ++this.#projSeq;
          const title = (s.title ?? "").trim() || randomName();
          this.#projTargets.set(k, { kind: "att", sessionId: s.sessionId, cwd, title });
          const date = s.updatedAt
            ? new Date(s.updatedAt).toISOString().slice(0, 16).replace("T", " ")
            : undefined;
          return { title, attachKey: k, ...(date ? { date } : {}) };
        });

      const newKey = ++this.#projSeq;
      this.#projTargets.set(newKey, { kind: "new", cwd });
      views.push({
        name: displayName(cwd),
        cwd,
        newKey,
        running,
        disconnected,
        resumable: resumableLines,
      });
    }
    return views;
  }

  /**
   * Reconcile the 📁 Projects topic: a pinned HEADER message plus ONE message
   * PER project (keyed by cwd), edited in place where possible and sent/deleted
   * to match `views`. With `recreate` the topic is (re)created as needed
   * (`/projects`); without it a deleted topic just clears the whole pointer —
   * the scheduler must not resurrect a topic the user deleted. `isThreadNotFound`
   * anywhere in the flow means the topic itself is gone. Mirrors the
   * edit-vs-send fallbacks of {@link Bridge.#deliverUsage}.
   */
  async #deliverProjects(views: ProjectView[], recreate: boolean): Promise<void> {
    const headerHtml = renderProjectsHeader();

    // Ensure a topic exists. Without a pointer at all, only the manual
    // /projects (recreate) may create one; a scheduled refresh just persists
    // the (still-empty) pointer and bows out.
    if (!this.#projectsTopic) {
      if (!recreate) {
        await this.#saveProjectsTopic();
        return;
      }
      const threadId = await this.#botApi.createForumTopic("📁 Projects", ICON_COLORS[0]!);
      this.#projectsTopic = { threadId, byCwd: {} };
    }

    try {
      await this.#reconcileProjects(views, headerHtml);
    } catch (e) {
      if (!isThreadNotFound(e)) throw e;
      // The topic itself was deleted mid-flow → drop the WHOLE pointer.
      this.#projectsTopic = undefined;
      if (recreate) {
        // Only the manual /projects rebuilds from scratch into a fresh topic.
        const threadId = await this.#botApi.createForumTopic("📁 Projects", ICON_COLORS[0]!);
        this.#projectsTopic = { threadId, byCwd: {} };
        await this.#reconcileProjects(views, headerHtml);
      }
    }
    await this.#saveProjectsTopic();
  }

  /**
   * The single reconciliation pass over an existing #projectsTopic: header, then
   * one message per project (in view order), then delete the messages of any
   * project whose cwd vanished. Rethrows `isThreadNotFound` (topic gone) to the
   * caller; swallows "not modified" and treats any other edit failure on a known
   * message id as a deleted/too-old message → send a fresh one for it.
   */
  async #reconcileProjects(views: ProjectView[], headerHtml: string): Promise<void> {
    const topic = this.#projectsTopic!;
    const threadId = topic.threadId;
    const byCwd = (topic.byCwd ??= {});

    // Header: edit in place if known, else send + PIN (only the header is pinned;
    // per-project messages are not).
    if (topic.headerId !== undefined) {
      try {
        await this.#botApi.editRich(topic.headerId, headerHtml);
      } catch (e) {
        if (isThreadNotFound(e)) throw e;
        // "not modified" is fine; anything else = message gone → resend below.
        if (!(e instanceof Error && /not modified/i.test(e.message))) topic.headerId = undefined;
      }
    }
    if (topic.headerId === undefined) {
      const id = await this.#botApi.sendRich(threadId, headerHtml);
      topic.headerId = id;
      await this.#botApi
        .pinChatMessage(threadId, id)
        .catch((e) => logError("projects pin failed", e));
    }

    // Per project, in view order: edit its message in place, else send a fresh
    // one. New projects therefore append at the bottom (acceptable).
    const liveCwds = new Set<string>();
    for (const p of views) {
      liveCwds.add(p.cwd);
      const html = renderProjectRich(p);
      const keyboard = buildProjectKeyboard(p, this.#cfg.forumChatId);
      const existing = byCwd[p.cwd];
      if (existing !== undefined) {
        try {
          await this.#botApi.editRich(existing, html, keyboard);
          continue;
        } catch (e) {
          if (isThreadNotFound(e)) throw e;
          if (e instanceof Error && /not modified/i.test(e.message)) continue; // same content
          delete byCwd[p.cwd]; // message deleted/too old → drop id, send fresh
        }
      }
      byCwd[p.cwd] = await this.#botApi.sendRich(threadId, html, keyboard);
    }

    // Projects whose cwd vanished: delete their message (best-effort) and drop
    // the map entry either way.
    for (const cwd of Object.keys(byCwd)) {
      if (liveCwds.has(cwd)) continue;
      const id = byCwd[cwd]!;
      delete byCwd[cwd];
      await this.#botApi
        .deleteMessage(id)
        .catch((e) => logError("projects message delete failed", e));
    }
  }

  /**
   * Route a `proj:` backlink tap. `proj:new:{k}` opens a fresh session in the
   * mapped cwd (reusing newTopic, which pokes the panel on success);
   * `proj:att:{k}` attaches the mapped resumable session (reusing #attachTarget,
   * guarded by #attaching exactly like #handleAttachCallback). A key missing from
   * the (per-render) target map answers a "no longer listed" toast.
   */
  async #handleProjectsCallback(data: string): Promise<{ toast: string }> {
    if (data.startsWith("proj:new:")) {
      const t = this.#projTargets.get(Number(data.slice("proj:new:".length)));
      if (!t || t.kind !== "new") return { toast: "no longer listed" };
      // A no-op reply keeps newTopic's confirmation off Telegram; the toast
      // carries the outcome. newTopic resolves the absolute cwd via its /~ branch.
      let created = false;
      await this.newTopic(t.cwd, async (h) => {
        created = /Created/.test(h);
      });
      return { toast: created ? "session created" : "could not create session" };
    }
    if (data.startsWith("proj:att:")) {
      const k = Number(data.slice("proj:att:".length));
      const t = this.#projTargets.get(k);
      if (!t || t.kind !== "att") return { toast: "no longer listed" };
      this.#projTargets.delete(k); // evict on use
      this.#attaching.add(t.sessionId);
      try {
        return await this.#attachTarget({ sessionId: t.sessionId, cwd: t.cwd, title: t.title });
      } finally {
        this.#attaching.delete(t.sessionId);
      }
    }
    return { toast: "" };
  }

  // --- helpers -------------------------------------------------------------

  async #handleGeneral(msg: IncomingMsg): Promise<void> {
    const cmd = msg.text ? parseCommand(msg.text) : undefined;
    if (cmd?.cmd === "new") {
      await this.newTopic(cmd.args || undefined, (h) => this.#send(undefined, h));
      return;
    }
    if (cmd?.cmd === "sessions") {
      await this.#handleSessions(undefined);
      return;
    }
    if (cmd?.cmd === "usage") {
      await this.#handleUsage(undefined);
      return;
    }
    if (cmd?.cmd === "projects") {
      await this.#handleProjects(undefined);
      return;
    }
    await this.#send(
      undefined,
      "This is the General topic. Use /new [path|project] to start a session or /sessions to attach an existing one; per-session commands run inside a session's own topic.",
    );
  }

  #restartKeyboard(threadId: number): InlineKeyboard {
    return { inline_keyboard: [[{ text: "🔄 Restart", callback_data: `restart:${threadId}` }]] };
  }

  #reconnectKeyboard(threadId: number): InlineKeyboard {
    return { inline_keyboard: [[{ text: "🔌 Reconnect", callback_data: `reconnect:${threadId}` }]] };
  }

  #modeKeyboard(threadId: number, agent: AgentSession): InlineKeyboard {
    return {
      inline_keyboard: agent
        .availableModes()
        .map((m) => [{ text: m.name, callback_data: `mode:${threadId}:${m.id}` }]),
    };
  }

  /** Offer a select config option (`/model`, `/effort`) as an inline keyboard. */
  async #sendConfigKeyboard(threadId: number, agent: AgentSession, key: string): Promise<void> {
    const label = CONFIG_LABELS[key] ?? key;
    const values = agent.availableConfigValues(key);
    if (values.length === 0) {
      await this.#send(threadId, `⚠️ this agent does not expose ${label.toLowerCase()} selection.`);
      return;
    }
    const current = agent.currentConfigValue(key);
    const rows = values.map((v) => [
      {
        text: `${v.id === current ? "✅ " : ""}${v.name}`,
        callback_data: `cfg:${threadId}:${key}:${v.id}`,
      },
    ]);
    const noun = label.toLowerCase();
    const article = /^[aeiou]/.test(noun) ? "an" : "a";
    await this.#send(threadId, `Choose ${article} ${noun}:`, { inline_keyboard: rows });
  }

  /** Start an AgentSession wired to a fresh TopicSession for `threadId`. */
  async #spawnTopic(
    threadId: number,
    cwd: string,
    loadSessionId: string | undefined,
    onReplayChunk?: (u: acp.SessionUpdate) => void,
  ): Promise<TopicSession> {
    const ui = this.#makeUi(threadId);
    let session: TopicSession | undefined;
    const agent = await this.#startAgent({
      cwd,
      loadSessionId,
      ...(onReplayChunk ? { onReplayChunk } : {}),
      spawn: { command: this.#cfg.adapterCommand, env: { ...ADAPTER_ENV_DEFAULTS, ...this.#cfg.adapterEnv } },
      client: { ...makeFsHandlers(), ...this.#terminals.handlers() },
      onUpdate: (u) => session?.handleUpdate(u),
      onPermission: (r) => session!.handlePermission(r),
      onExit: (info) => session?.handleAgentExit(info),
    });
    session = new TopicSession({
      agent,
      ui,
      broker: this.#broker,
      threadId,
      cfg: this.#cfg,
    });
    this.#sessions.set(threadId, session);
    return session;
  }

  /** A TopicUi bound to one topic, backed by BotApi (every send carries the thread). */
  #makeUi(threadId: number): TopicUi {
    const botApi = this.#botApi;
    return {
      messageApi(): MessageApi {
        // The three content surfaces (streaming reply, Activity, Plan) deliver
        // Rich Messages; the plain-HTML surfaces (notify/permissions) below stay
        // on sendMessage/editMessageText.
        return {
          send: (html) => botApi.sendRich(threadId, html),
          edit: (messageId, html) => botApi.editRich(messageId, html),
        };
      },
      typing(): void {
        void botApi.sendChatAction(threadId, "typing").catch((e) => logError("typing", e));
      },
      async notify(html: string, keyboard?: InlineKeyboard): Promise<void> {
        await botApi.sendMessage(threadId, html, keyboard);
      },
      async presentPermission(p): Promise<number> {
        return botApi.sendMessage(threadId, p.html, { inline_keyboard: p.keyboard });
      },
      async editPermissionMessage(messageId: number, html: string): Promise<void> {
        await botApi.editMessageText(messageId, html);
      },
    };
  }

  /**
   * Post (or replace) the reconnect-offer notice for a stored-but-disconnected
   * topic. Owns the invariant that AT MOST ONE such notice is ever live in a
   * topic: every bridge restart used to send a fresh one, so topics piled up
   * duplicates. If a previous notice is tracked, it is best-effort deleted
   * first (a >48h-old message can't be deleted; that's fine, just log). Needs
   * the sent message id, so it cannot go through `#send` (which returns void)
   * — sends directly and replicates `#send`'s deleted-topic handling.
   */
  async #offerReconnect(s: SessionState, html: string): Promise<void> {
    if (s.reconnectMsgId !== undefined) {
      await this.#botApi
        .deleteMessage(s.reconnectMsgId)
        .catch((e) => logError("reconnect notice delete failed", e));
    }
    let newId: number;
    try {
      newId = await this.#botApi.sendMessage(s.threadId, html, this.#reconnectKeyboard(s.threadId));
    } catch (e) {
      if (isThreadNotFound(e)) {
        await this.#pruneDeletedTopic(s.threadId);
        return;
      }
      logError("offerReconnect send failed", e);
      return;
    }
    // Re-read the entry: a concurrent upsert may have changed other fields
    // while we were sending (see #mirrorOne for this exact pattern).
    const cur = this.#store.get(s.threadId);
    if (cur) await this.#store.upsert({ ...cur, reconnectMsgId: newId });
  }

  async #send(threadId: number | undefined, html: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.#botApi.sendMessage(threadId, html, keyboard);
    } catch (e) {
      // A send into a topic the user deleted in Telegram is the ONLY signal
      // deletion ever produces (no bot update exists) — reconcile on it.
      if (threadId !== undefined && isThreadNotFound(e)) {
        await this.#pruneDeletedTopic(threadId);
        return;
      }
      logError("send failed", e);
    }
  }

  /**
   * A topic was deleted in the Telegram UI: tear down its live session (if
   * any) and drop its store entry, so the ACP session stops being filtered
   * out of `/sessions` and can be attached into a fresh topic.
   */
  async #pruneDeletedTopic(threadId: number): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (session) {
      this.#sessions.delete(threadId);
      this.#terminals.releaseForSession(session.agentSession.sessionId);
      try {
        await session.dispose();
        await session.agentSession.dispose();
      } catch (e) {
        logError("prune dispose failed", e);
      }
    } else {
      const stored = this.#store.get(threadId);
      if (stored) this.#terminals.releaseForSession(stored.acpSessionId);
    }
    await this.#store.remove(threadId);
    log.info({ threadId }, "[bridge] topic deleted in Telegram; session released for re-attach");
    this.#pokeProjects(); // the session left the overview
  }
}

export type { SessionState };

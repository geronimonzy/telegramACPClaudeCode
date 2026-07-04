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

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import { AgentSession, type AgentSessionOptions } from "./acp/agent-session.js";
import { makeFsHandlers } from "./acp/fs-handlers.js";
import { TerminalRegistry } from "./acp/terminals.js";
import type { Config } from "./config.js";
import { escapeHtml } from "./html.js";
import { log } from "./log.js";
import { StateStore, type SessionState } from "./state.js";
import { TopicSession, type TopicUi } from "./orchestrator.js";
import { MessageDraft } from "./telegram/draft.js";
import {
  renderAgentTurnRich,
  renderUserTurnRich,
  RICH_MAX_LEN,
} from "./telegram/rich-html.js";
import { randomName } from "./telegram/names.js";
import { PermissionBroker } from "./telegram/permissions.js";
import type { MessageApi } from "./telegram/live-message.js";

/** An inline keyboard, in Telegram's `inline_keyboard` shape. */
export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
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
  /** Edit a message in place with new Rich Message content. */
  editRich(messageId: number, html: string): Promise<void>;
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

/** Expand a leading `~` / `~/` to the user's home directory. */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) return path.join(homedir(), p.slice(1));
  return p;
}

/** The command list registered with Telegram (BotCommandScopeChat in bot.ts). */
export const COMMAND_LIST: Array<{ command: string; description: string }> = [
  { command: "new", description: "Start a session topic: /new [folder] [name…]" },
  { command: "sessions", description: "List resumable sessions to attach" },
  { command: "end", description: "End this session and close the topic" },
  { command: "cancel", description: "Cancel the in-flight turn" },
  { command: "mode", description: "Choose the agent mode" },
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

  constructor(
    cfg: Config,
    botApi: BotApi,
    store: StateStore,
    startAgent: AgentStarter = AgentSession.start,
  ) {
    this.#cfg = cfg;
    this.#botApi = botApi;
    this.#store = store;
    this.#startAgent = startAgent;
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
      await this.#send(
        s.threadId,
        `🔌 <b>${escapeHtml(s.title)}</b> — disconnected (bridge restarted). Tap Reconnect to resume.`,
        this.#reconnectKeyboard(s.threadId),
      );
    }
    await this.#botApi.setMyCommands(COMMAND_LIST).catch((e) => logError("setMyCommands", e));
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
      await this.#send(threadId, "💥 could not start the agent — /new to retry.");
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

    const session = this.#sessions.get(threadId);
    if (!session) {
      // A stored-but-disconnected topic (e.g. after a bridge restart) still has
      // persisted state — steer the user to Reconnect rather than /new, which
      // would abandon the session. A topic with no stored state gets the plain
      // "start one" notice.
      if (this.#store.get(threadId)) {
        await this.#send(
          threadId,
          "🔌 This session is disconnected. Tap Reconnect to resume.",
          this.#reconnectKeyboard(threadId),
        );
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
    if (data.startsWith("reconnect:")) return this.#handleReconnectCallback(data);
    if (data.startsWith("compact:")) return this.#handleCompactCallback(data, callbackMessageId);
    if (data.startsWith("continue:")) return this.#handleContinueCallback(data, callbackMessageId);
    if (data.startsWith("restart:")) return this.#handleRestartCallback(data);
    if (data.startsWith("attach:")) return this.#handleAttachCallback(data);
    return undefined;
  }

  /** Dispose every session + agent, kill terminals. Store is persisted eagerly. */
  async shutdown(): Promise<void> {
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
        return { toast: "reconnected" };
      }
      // loadSession failed; AgentSession fell back to a fresh session.
      await this.#store.upsert({ ...stored, acpSessionId: agent.sessionId });
      await this.#send(
        threadId,
        `⚠️ <b>${escapeHtml(stored.title)}</b> — previous session could not be restored; started fresh.`,
      );
      return { toast: "started fresh" };
    } catch (e) {
      logError(`reconnect failed for thread ${threadId}`, e);
      await this.#send(
        threadId,
        `💥 <b>${escapeHtml(stored.title)}</b> — could not reconnect. Tap Reconnect to retry.`,
        this.#reconnectKeyboard(threadId),
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
    let sessions: acp.SessionInfo[];
    try {
      sessions = await this.#fetchSessions();
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
      spawn: { command: this.#cfg.adapterCommand, env: this.#cfg.adapterEnv },
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
    // during session/load, all before #spawnTopic resolves — so the whole
    // history is in `turns` by the time the transcript is posted below.
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

    // Post the transcript ONE MESSAGE PER TURN — far more readable than one
    // rolled-over blob. User turns render as literal bold blockquotes, agent
    // turns as markdown under a 🤖 header; MessageDraft still owns rollover
    // for any single turn that exceeds the rich budget.
    for (const turn of turns) {
      if (turn.text.trim() === "") continue;
      const draft = new MessageDraft(this.#makeUi(threadId).messageApi(), {
        intervalMs: this.#cfg.editIntervalMs,
        maxLen: RICH_MAX_LEN,
        render: turn.role === "user" ? renderUserTurnRich : renderAgentTurnRich,
      });
      draft.append(turn.text);
      await draft.finalize();
    }

    const agent = session.agentSession;
    await this.#store.upsert({
      threadId,
      acpSessionId: agent.sessionId,
      cwd: target.cwd,
      title,
      createdAt: new Date().toISOString(),
    });
    await this.#send(threadId, "📎 attached — full history above; the session is live");
    return { toast: "attached" };
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
      spawn: { command: this.#cfg.adapterCommand, env: this.#cfg.adapterEnv },
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

  async #send(threadId: number | undefined, html: string, keyboard?: InlineKeyboard): Promise<void> {
    try {
      await this.#botApi.sendMessage(threadId, html, keyboard);
    } catch (e) {
      logError("send failed", e);
    }
  }
}

export type { SessionState };

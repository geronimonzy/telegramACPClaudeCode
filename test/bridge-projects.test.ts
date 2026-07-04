import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/acp/agent-session.js";
import { Bridge, type AgentStarter, type InlineKeyboard, type InlineKeyboardButton } from "../src/bridge.js";
import type { Config } from "../src/config.js";
import { StateStore } from "../src/state.js";
import { topicDeepLink } from "../src/projects.js";
import { FakeBotApi } from "./helpers/fake-bot-api.js";
import { wireMockAgent, type MockAgent } from "./helpers/mock-agent.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-proj-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FORUM_CHAT_ID = -1001234567890;

function makeConfig(): Config {
  return {
    botToken: "token",
    forumChatId: FORUM_CHAT_ID,
    allowedUserIds: [1],
    defaultCwd: dir,
    projects: {},
    editIntervalMs: 5,
    typingIntervalMs: 5,
    showThoughts: false,
    adapterCommand: ["fake"],
    adapterEnv: {},
    dataDir: dir,
  };
}

function makeBridge(onAgent?: (a: MockAgent) => void) {
  const cfg = makeConfig();
  const botApi = new FakeBotApi();
  const store = new StateStore(join(dir, "state.json"));
  const mocks: MockAgent[] = [];
  const starter: AgentStarter = async (opts) => {
    const { agent, clientStream } = wireMockAgent();
    mocks.push(agent);
    onAgent?.(agent);
    return AgentSession.start({ ...opts, stream: clientStream, spawn: undefined });
  };
  const bridge = new Bridge(cfg, botApi, store, starter, undefined, dir);
  return { bridge, botApi, store, mocks, cfg };
}

const tick = () => new Promise((r) => setTimeout(r, 15));
const NAME_RE = /^[a-z]{3,8}-[a-z]{3,8}-[a-z]{3,8}$/;

/** Flatten a keyboard to its buttons. */
function buttons(kb: InlineKeyboard | undefined): InlineKeyboardButton[] {
  return (kb?.inline_keyboard ?? []).flat();
}
function cbData(b: InlineKeyboardButton): string | undefined {
  return "callback_data" in b ? b.callback_data : undefined;
}
function urlOf(b: InlineKeyboardButton): string | undefined {
  return "url" in b ? b.url : undefined;
}

function projectsTopic(botApi: FakeBotApi) {
  return botApi.topics.find((t) => /Projects/.test(t.name));
}
/** All (live) messages in the Projects topic, oldest first. */
function projectsMessages(botApi: FakeBotApi) {
  const t = projectsTopic(botApi)!;
  return botApi.messages.filter((m) => m.threadId === t.threadId);
}
/** The pinned header message (the 📁 Projects heading + updated line). */
function projectsHeader(botApi: FakeBotApi) {
  return projectsMessages(botApi).find((m) => /<h3>📁 Projects<\/h3>/.test(m.html))!;
}
/** The per-project message for a given project display name. */
function projectMsg(botApi: FakeBotApi, name: string) {
  return projectsMessages(botApi).find((m) => m.html.includes(`<h4>${name}</h4>`))!;
}
/** The per-project message whose html contains a substring (the header excluded). */
function projectMsgContaining(botApi: FakeBotApi, substr: string) {
  return projectsMessages(botApi).find(
    (m) => m.html.includes(substr) && !/<h3>📁 Projects<\/h3>/.test(m.html),
  )!;
}

describe("/projects panel", () => {
  it("creates + pins a header and one keyboarded message per project; confirms to the caller", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };

    await bridge.handleMessage(undefined, { text: "/projects" });

    const topic = projectsTopic(botApi)!;
    expect(topic).toBeDefined();
    expect(topic.name).toBe("📁 Projects");
    // A pinned header message with the 📁 Projects heading (no per-project h4).
    const header = projectsHeader(botApi);
    expect(header.html).toContain("📁 Projects");
    expect(header.html).not.toContain("<h4>");
    expect(botApi.pins.some((p) => p.messageId === header.messageId)).toBe(true);
    // One message per project, carrying that project's keyboard.
    const panel = projectMsg(botApi, "myproj");
    expect(panel.keyboard).toBeDefined();
    // The header is not pinned-and-keyboarded; the project message holds proj:new.
    expect(buttons(panel.keyboard).map(cbData)).toContain("proj:new:" + 1);
    // Confirmation went to where the command was issued (General).
    expect(botApi.htmlFor(undefined).join("\n")).toContain("projects updated");
  });

  it("a second /projects with nothing changed edits ONLY the header (per-project edit is skipped)", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    await bridge.handleMessage(undefined, { text: "/projects" });
    const topic = projectsTopic(botApi)!;
    const header = projectsHeader(botApi);
    const panel = projectMsg(botApi, "myproj");
    const editsBefore = botApi.edits.length;

    await bridge.handleMessage(undefined, { text: "/projects" });

    // Header is exempt from the skip cache (its "updated …" timestamp always
    // changes) and is edited every render.
    expect(botApi.edits.some((e) => e.messageId === header.messageId)).toBe(true);
    // The per-project message's content is byte-identical to last time, so the
    // in-memory #projLastSent cache skips the Telegram call entirely — exactly
    // one new edit this round, and it targets the header.
    const newEdits = botApi.edits.slice(editsBefore);
    expect(newEdits).toHaveLength(1);
    expect(newEdits[0]!.messageId).toBe(header.messageId);
    expect(newEdits.some((e) => e.messageId === panel.messageId)).toBe(false);
    // Still exactly header + one project message in the topic.
    expect(botApi.messages.filter((m) => m.threadId === topic.threadId)).toHaveLength(2);
  });

  it("a project appearing later gets a new message without disturbing existing ones", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { alpha: join(dir, "alpha") };
    await bridge.handleMessage(undefined, { text: "/projects" });
    const header = projectsHeader(botApi);
    const alpha = projectMsg(botApi, "alpha");
    const beforeCount = projectsMessages(botApi).length;

    // Add a second project and refresh.
    cfg.projects = { alpha: join(dir, "alpha"), beta: join(dir, "beta") };
    await bridge.handleMessage(undefined, { text: "/projects" });

    // The new project got its own fresh message; alpha's is untouched — same
    // id, not resent, and not even re-edited since its content didn't change
    // (the #projLastSent cache skips the no-op edit).
    const beta = projectMsg(botApi, "beta");
    expect(beta).toBeDefined();
    expect(beta.messageId).not.toBe(alpha.messageId);
    expect(projectsMessages(botApi).length).toBe(beforeCount + 1);
    expect(botApi.edits.some((e) => e.messageId === alpha.messageId)).toBe(false);
    expect(botApi.edits.some((e) => e.messageId === header.messageId)).toBe(true);
    // No project message was deleted.
    expect(botApi.deletions).toHaveLength(0);
  });

  it("a project disappearing deletes its message and drops it from the persisted pointer", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { alpha: join(dir, "alpha"), beta: join(dir, "beta") };
    await bridge.handleMessage(undefined, { text: "/projects" });
    const beta = projectMsg(botApi, "beta");
    expect(beta).toBeDefined();

    // Remove beta and refresh.
    cfg.projects = { alpha: join(dir, "alpha") };
    await bridge.handleMessage(undefined, { text: "/projects" });

    // Beta's message was deleted and no longer lives in the topic.
    expect(botApi.deletions).toContain(beta.messageId);
    expect(projectMsg(botApi, "beta")).toBeUndefined();
    // The persisted pointer no longer maps beta's cwd.
    const pointer = JSON.parse(await readFile(join(dir, "projects-topic.json"), "utf-8"));
    expect(Object.keys(pointer.byCwd ?? {})).not.toContain(join(dir, "beta"));
    expect(Object.keys(pointer.byCwd ?? {})).toContain(join(dir, "alpha"));
  });

  it("a legacy {threadId, messageId} pointer is read as the header and upgraded on save", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    // Simulate the deployed single-panel bridge's pointer file + its message.
    const legacyThread = await botApi.createForumTopic("📁 Projects", 0);
    const legacyMsg = await botApi.sendRich(legacyThread, "<h3>📁 Projects</h3><p>old</p>");
    await writeFile(
      join(dir, "projects-topic.json"),
      JSON.stringify({ threadId: legacyThread, messageId: legacyMsg }),
    );

    await bridge.handleMessage(undefined, { text: "/projects" });

    // The old single message became the header, edited (not resent) into header content.
    expect(botApi.edits.some((e) => e.messageId === legacyMsg)).toBe(true);
    // The upgraded pointer carries headerId (the old messageId) + a byCwd map.
    const pointer = JSON.parse(await readFile(join(dir, "projects-topic.json"), "utf-8"));
    expect(pointer.headerId).toBe(legacyMsg);
    expect(pointer.messageId).toBeUndefined();
    expect(Object.keys(pointer.byCwd ?? {})).toContain(dir);
  });

  it("running sessions get a url button deep-linking to their topic", async () => {
    const { bridge, botApi } = makeBridge();
    // A live session in defaultCwd (dir).
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsgContaining(botApi, "🟢");
    expect(panel.html).toContain("🟢");

    const runBtn = buttons(panel.keyboard).find((b) => b.text.startsWith("🟢"))!;
    expect(runBtn).toBeDefined();
    expect(urlOf(runBtn)).toBe(topicDeepLink(FORUM_CHAT_ID, t1));
    expect(urlOf(runBtn)).toBe(`https://t.me/c/1234567890/${t1}`);
  });

  it("proj:new tap creates a topic + session in the mapped cwd", async () => {
    const { bridge, botApi, store, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsg(botApi, "myproj");
    const newData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:new:"))!;

    const res = await bridge.handleCallback(newData, panel.messageId);
    await tick();

    expect(res?.toast).toBe("session created");
    // A fresh (random-named) session topic was created, in the mapped cwd.
    const sessionTopic = botApi.topics.find((t) => NAME_RE.test(t.name));
    expect(sessionTopic).toBeDefined();
    const entry = store.list().find((s) => s.threadId === sessionTopic!.threadId);
    expect(entry?.cwd).toBe(dir);
  });

  it("a stale proj:new tap answers 'no longer listed' and creates nothing", async () => {
    const { bridge, botApi } = makeBridge();
    const res = await bridge.handleCallback("proj:new:9999", 1);
    expect(res?.toast).toMatch(/no longer listed/);
    expect(botApi.topics.some((t) => NAME_RE.test(t.name))).toBe(false);
  });

  it("proj:att tap attaches the resumable session (topic created, store upserted)", async () => {
    const { bridge, botApi, store } = makeBridge((a) => {
      a.listSessionsResponse = [
        {
          sessionId: "sess_mock_1",
          cwd: "/home/kiril/proj",
          title: "Resume me",
          updatedAt: "2026-07-03T18:00:00.000Z",
        },
      ];
    });

    // No live session → manual /projects spawns a throwaway to list; the
    // resumable session's cwd becomes a project with a 💤 attach button.
    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsgContaining(botApi, "💤 <b>Resume me</b>");
    expect(panel.html).toContain("💤 <b>Resume me</b>");
    const attData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:att:"))!;
    expect(attData).toBeDefined();
    expect(attData!.length).toBeLessThanOrEqual(64);

    const before = botApi.topics.length;
    const res = await bridge.handleCallback(attData!, panel.messageId);
    await tick();

    expect(res?.toast).toBe("attached");
    expect(botApi.topics.length).toBe(before + 1);
    const attachedTopic = botApi.topics.at(-1)!;
    expect(attachedTopic.name).toBe("Resume me");
    const entry = store.list().find((s) => s.acpSessionId === "sess_mock_1");
    expect(entry?.cwd).toBe("/home/kiril/proj");
    expect(entry?.title).toBe("Resume me");
  });

  it("a resumable session in a .claude/worktrees cwd folds under its parent project; proj:att carries the real cwd", async () => {
    const worktreeCwd = join(dir, ".claude", "worktrees", "android-app");
    const { bridge, botApi, store } = makeBridge((a) => {
      a.listSessionsResponse = [
        {
          // The mock agent's loadSession only accepts its own hardcoded
          // MOCK_SESSION_ID ("sess_mock_1") — matches the existing "proj:att
          // tap attaches..." test's convention above.
          sessionId: "sess_mock_1",
          cwd: worktreeCwd,
          title: "Resume me",
          updatedAt: "2026-07-03T18:00:00.000Z",
        },
      ];
    });

    await bridge.handleMessage(undefined, { text: "/projects" });

    // No separate top-level project for the raw worktree path — just ONE
    // project message total, keyed by the parent cwd.
    expect(projectsMessages(botApi).filter((m) => /<h4>/.test(m.html))).toHaveLength(1);
    const panel = projectMsgContaining(botApi, "💤 <b>Resume me 🌿android-app</b>");
    expect(panel.html).toContain(`<code>${dir}</code>`);
    expect(botApi.messages.some((m) => m.html.includes(worktreeCwd))).toBe(false);

    const attData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:att:"))!;
    const res = await bridge.handleCallback(attData!, panel.messageId);
    await tick();

    expect(res?.toast).toBe("attached");
    // Attach used the session's REAL (worktree) cwd, not the folded parent —
    // session/load needs the actual path.
    const entry = store.list().find((s) => s.acpSessionId === "sess_mock_1");
    expect(entry?.cwd).toBe(worktreeCwd);
    expect(entry?.title).toBe("Resume me");
  });

  it("proj:new for a project with only folded worktree sessions creates a topic in the PARENT cwd", async () => {
    const worktreeCwd = join(dir, ".claude", "worktrees", "android-app");
    const { bridge, botApi, store } = makeBridge((a) => {
      a.listSessionsResponse = [
        {
          sessionId: "sess_mock_1",
          cwd: worktreeCwd,
          title: "Resume me",
          updatedAt: "2026-07-03T18:00:00.000Z",
        },
      ];
    });

    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsgContaining(botApi, "💤 <b>Resume me 🌿android-app</b>");
    const newData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:new:"))!;

    const res = await bridge.handleCallback(newData!, panel.messageId);
    await tick();

    expect(res?.toast).toBe("session created");
    const sessionTopic = botApi.topics.find((t) => NAME_RE.test(t.name));
    const entry = store.list().find((s) => s.threadId === sessionTopic!.threadId);
    expect(entry?.cwd).toBe(dir); // parent cwd, not the worktree path
  });

  it("a stored (disconnected) session in a worktree cwd folds under its parent project", async () => {
    const { bridge, botApi, store } = makeBridge();
    const worktreeCwd = join(dir, ".claude", "worktrees", "android-app");
    await store.upsert({
      threadId: 555,
      acpSessionId: "sess_stored_wt",
      cwd: worktreeCwd,
      title: "old worktree session",
      createdAt: new Date().toISOString(),
    });

    await bridge.handleMessage(undefined, { text: "/projects" });

    const panel = projectMsgContaining(botApi, "🔌 <b>old worktree session 🌿android-app</b>");
    expect(panel.html).toContain(`<code>${dir}</code>`);
    // No separate top-level project for the raw worktree cwd.
    expect(botApi.messages.some((m) => m.html.includes(worktreeCwd))).toBe(false);
  });

  it("the hourly refresh is edit-only: no new topic, no throwaway agent spawn", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, botApi, mocks } = makeBridge();
      await bridge.init();
      await bridge.handleMessage(undefined, { text: "/projects" });
      // The manual /projects spawned exactly one throwaway to list resumables.
      const mocksAfterManual = mocks.length;
      const topicsAfterManual = botApi.topics.length;
      const panel = botApi.messages.find((m) => /📁 Projects/.test(m.html))!;
      const editsBefore = botApi.edits.length;

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      // Edit-only: the panel was edited, no topic created, no agent spawned.
      expect(botApi.topics.length).toBe(topicsAfterManual);
      expect(mocks.length).toBe(mocksAfterManual);
      expect(
        botApi.edits.slice(editsBefore).some((e) => e.messageId === panel.messageId),
      ).toBe(true);
      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the scheduler never resurrects a deleted projects topic", async () => {
    vi.useFakeTimers();
    try {
      const { bridge, botApi } = makeBridge();
      await bridge.init();
      await bridge.handleMessage(undefined, { text: "/projects" });
      const topic = projectsTopic(botApi)!;
      botApi.deadThreads.add(topic.threadId);

      await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);

      // Still just the one (dead) topic — no recreation from the timer.
      expect(botApi.topics.filter((t) => /Projects/.test(t.name))).toHaveLength(1);
      await bridge.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops resumable sessions older than 30 days; keeps one with no updatedAt", async () => {
    const oldCwd = join(dir, "ancient");
    const undatedCwd = join(dir, "undated");
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const { bridge, botApi } = makeBridge((a) => {
      a.listSessionsResponse = [
        { sessionId: "sess_old", cwd: oldCwd, title: "Ancient", updatedAt: stale },
        { sessionId: "sess_undated", cwd: undatedCwd, title: "Undated" },
      ];
    });

    await bridge.handleMessage(undefined, { text: "/projects" });

    // The stale session's cwd never became a project — no message, no h4 for it.
    expect(botApi.messages.some((m) => m.html.includes(oldCwd))).toBe(false);
    // The session with no updatedAt (never hide what we can't date) IS listed.
    const panel = projectMsgContaining(botApi, "💤 <b>Undated</b>");
    expect(panel).toBeDefined();
    expect(panel.html).toContain(`<code>${undatedCwd}</code>`);
  });
});

describe("/projects edit-skip cache (#projLastSent)", () => {
  it("a second /projects with nothing changed edits only the header", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    await bridge.handleMessage(undefined, { text: "/projects" });
    const header = projectsHeader(botApi);
    const panel = projectMsg(botApi, "myproj");
    const editsBefore = botApi.edits.length;

    await bridge.handleMessage(undefined, { text: "/projects" });

    const newEdits = botApi.edits.slice(editsBefore);
    expect(newEdits).toHaveLength(1);
    expect(newEdits[0]!.messageId).toBe(header.messageId);
    expect(newEdits.some((e) => e.messageId === panel.messageId)).toBe(false);
  });

  it("when one project's content changes, only that project's message (plus the header) is edited", async () => {
    const { bridge, botApi, cfg, store } = makeBridge();
    cfg.projects = { alpha: join(dir, "alpha"), beta: join(dir, "beta") };
    await bridge.handleMessage(undefined, { text: "/projects" });
    const header = projectsHeader(botApi);
    const alphaBefore = projectMsg(botApi, "alpha");
    const betaBefore = projectMsg(botApi, "beta");

    // Give beta a stored (disconnected) session — changes its rendered content;
    // alpha is untouched.
    await store.upsert({
      threadId: 777,
      acpSessionId: "sess_beta_1",
      cwd: join(dir, "beta"),
      title: "beta session",
      createdAt: new Date().toISOString(),
    });
    const editsBefore = botApi.edits.length;

    await bridge.handleMessage(undefined, { text: "/projects" });

    const newEdits = botApi.edits.slice(editsBefore);
    const editedIds = new Set(newEdits.map((e) => e.messageId));
    expect(editedIds.has(header.messageId)).toBe(true);
    expect(editedIds.has(betaBefore.messageId)).toBe(true);
    expect(editedIds.has(alphaBefore.messageId)).toBe(false);
    expect(editedIds.size).toBe(2);
  });

  it("after a 'message is not modified' rejection, the next identical render skips the call", async () => {
    // FakeBotApi doesn't simulate Telegram's "not modified" rejection, so this
    // exercises the equivalent success-path priming instead: #projLastSent is
    // populated on a normal successful edit exactly the same way it would be
    // from a caught "not modified" error (see #reconcileProjects), so a THIRD
    // identical render still finds the cache hit and skips.
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    await bridge.handleMessage(undefined, { text: "/projects" }); // send
    const panel = projectMsg(botApi, "myproj");

    await bridge.handleMessage(undefined, { text: "/projects" }); // primes cache (unchanged, skipped)
    const editsBefore = botApi.edits.length;
    await bridge.handleMessage(undefined, { text: "/projects" }); // still unchanged

    expect(
      botApi.edits.slice(editsBefore).some((e) => e.messageId === panel.messageId),
    ).toBe(false);
  });
});

/** The proj:att key encoded in a keyboard (undefined if it carries none). */
function attKeyIn(kb: InlineKeyboard | undefined): number | undefined {
  const d = buttons(kb).map(cbData).find((x) => x?.startsWith("proj:att:"));
  return d ? Number(d.slice("proj:att:".length)) : undefined;
}
/** All proj: callback_data in a keyboard, sorted for order-independent compare. */
function projData(kb: InlineKeyboard | undefined): string[] {
  return buttons(kb)
    .map(cbData)
    .filter((d): d is string => !!d?.startsWith("proj:"))
    .sort();
}

describe("/projects stable backlink keys", () => {
  const RESUMABLE = {
    sessionId: "sess_mock_1",
    cwd: "/home/kiril/proj",
    title: "Resume me",
    updatedAt: "2026-07-03T18:00:00.000Z",
  };

  it("consecutive renders keep identical callback_data on unchanged targets (edit skipped, key stays live)", async () => {
    const { bridge, botApi, cfg } = makeBridge((a) => {
      a.listSessionsResponse = [{ ...RESUMABLE, cwd: dir }];
    });
    cfg.projects = { myproj: dir };

    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsg(botApi, "myproj");
    const first = projData(panel.keyboard);
    // Both a resumable-attach and a new-session button are present.
    expect(first.some((d) => d.startsWith("proj:att:"))).toBe(true);
    expect(first.some((d) => d.startsWith("proj:new:"))).toBe(true);
    const editsBefore = botApi.edits.length;

    await bridge.handleMessage(undefined, { text: "/projects" });

    // Content unchanged → the #projLastSent cache skips the per-project edit
    // entirely (only the header is edited every render).
    expect(
      botApi.edits.slice(editsBefore).some((e) => e.messageId === panel.messageId),
    ).toBe(false);
    // The key wasn't reallocated by the skipped render: the ORIGINAL
    // callback_data still resolves.
    const attData = first.find((d) => d.startsWith("proj:att:"))!;
    const res = await bridge.handleCallback(attData, panel.messageId);
    await tick();
    expect(res?.toast).toBe("attached");
  });

  it("survives a restart: a proj:att tap from the pre-restart keyboard still attaches", async () => {
    const first = makeBridge((a) => {
      a.listSessionsResponse = [RESUMABLE];
    });
    await first.bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsgContaining(first.botApi, "💤 <b>Resume me</b>");
    const attData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:att:"))!;

    // Restart: a fresh Bridge over the SAME dataDir, without running /projects.
    const second = makeBridge();
    const before = second.botApi.topics.length;
    const res = await second.bridge.handleCallback(attData!, panel.messageId);
    await tick();

    expect(res?.toast).toBe("attached");
    expect(second.botApi.topics.length).toBe(before + 1);
    expect(second.botApi.topics.at(-1)!.name).toBe("Resume me");
    const entry = second.store.list().find((s) => s.acpSessionId === "sess_mock_1");
    expect(entry?.cwd).toBe("/home/kiril/proj");
  });

  it("survives a restart: a proj:new tap from the pre-restart keyboard still creates a session", async () => {
    const first = makeBridge();
    first.cfg.projects = { myproj: dir };
    await first.bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsg(first.botApi, "myproj");
    const newData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:new:"))!;

    const second = makeBridge();
    const res = await second.bridge.handleCallback(newData!, panel.messageId);
    await tick();

    expect(res?.toast).toBe("session created");
    const sessionTopic = second.botApi.topics.find((t) => NAME_RE.test(t.name));
    expect(sessionTopic).toBeDefined();
    const entry = second.store.list().find((s) => s.threadId === sessionTopic!.threadId);
    expect(entry?.cwd).toBe(dir);
  });

  it("a vanished target is pruned from the persisted file and its old key answers 'no longer listed'", async () => {
    let resumables = [{ ...RESUMABLE, cwd: dir }];
    const { bridge, botApi, cfg } = makeBridge((a) => {
      a.listSessionsResponse = resumables;
    });
    cfg.projects = { myproj: dir };

    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsgContaining(botApi, "💤 <b>Resume me</b>");
    const attData = buttons(panel.keyboard).map(cbData).find((d) => d?.startsWith("proj:att:"))!;
    const persisted = () => JSON.parse(readFileSync(join(dir, "projects-topic.json"), "utf-8"));
    // The att target was persisted on the first delivery.
    const before = Object.values(persisted().targets ?? {}) as Array<{ kind: string }>;
    expect(before.some((t) => t.kind === "att")).toBe(true);

    // The resumable session vanishes; the next render prunes its target.
    resumables = [];
    await bridge.handleMessage(undefined, { text: "/projects" });

    const after = Object.values(persisted().targets ?? {}) as Array<{ kind: string }>;
    expect(after.some((t) => t.kind === "att")).toBe(false);
    const res = await bridge.handleCallback(attData!, panel.messageId);
    expect(res?.toast).toMatch(/no longer listed/);
  });

  it("a re-appearing target gets a fresh key greater than the pruned one (seq never reuses)", async () => {
    let resumables = [{ ...RESUMABLE, cwd: dir }];
    const { bridge, botApi, cfg } = makeBridge((a) => {
      a.listSessionsResponse = resumables;
    });
    cfg.projects = { myproj: dir };

    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectMsg(botApi, "myproj");
    const key1 = attKeyIn(panel.keyboard)!;
    expect(key1).toBeGreaterThan(0);

    // Vanish (prune), then re-appear.
    resumables = [];
    await bridge.handleMessage(undefined, { text: "/projects" });
    resumables = [{ ...RESUMABLE, cwd: dir }];
    await bridge.handleMessage(undefined, { text: "/projects" });

    // The re-render edited the same message with a re-attach button; its key must
    // be a freshly minted one, strictly greater than the pruned key.
    const reEdit = botApi.edits
      .filter((e) => e.messageId === panel.messageId && attKeyIn(e.keyboard) !== undefined)
      .at(-1)!;
    expect(attKeyIn(reEdit.keyboard)!).toBeGreaterThan(key1);
  });
});

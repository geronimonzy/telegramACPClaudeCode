import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
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
function projectsPanel(botApi: FakeBotApi) {
  const t = projectsTopic(botApi)!;
  return botApi.messages.find((m) => m.threadId === t.threadId)!;
}

describe("/projects panel", () => {
  it("creates + pins the topic and a keyboarded message; confirms to the caller", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };

    await bridge.handleMessage(undefined, { text: "/projects" });

    const topic = projectsTopic(botApi)!;
    expect(topic).toBeDefined();
    expect(topic.name).toBe("📁 Projects");
    const panel = projectsPanel(botApi);
    expect(panel.html).toContain("📁 Projects");
    expect(panel.html).toContain("<h4>myproj</h4>");
    expect(panel.keyboard).toBeDefined();
    // Pinned.
    expect(botApi.pins.some((p) => p.messageId === panel.messageId)).toBe(true);
    // A proj:new button for the project.
    expect(buttons(panel.keyboard).map(cbData)).toContain("proj:new:" + 1);
    // Confirmation went to where the command was issued (General).
    expect(botApi.htmlFor(undefined).join("\n")).toContain("projects updated");
  });

  it("a second /projects edits the same message in place, keyboard included", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.handleMessage(undefined, { text: "/projects" });
    const topic = projectsTopic(botApi)!;
    const panel = projectsPanel(botApi);

    await bridge.handleMessage(undefined, { text: "/projects" });

    // Edited, not re-sent; and the edit carries the keyboard (Telegram drops it otherwise).
    const edit = botApi.edits.find((e) => e.messageId === panel.messageId);
    expect(edit).toBeDefined();
    expect(edit!.keyboard).toBeDefined();
    expect(botApi.messages.filter((m) => m.threadId === topic.threadId)).toHaveLength(1);
  });

  it("running sessions get a url button deep-linking to their topic", async () => {
    const { bridge, botApi } = makeBridge();
    // A live session in defaultCwd (dir).
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(undefined, { text: "/projects" });
    const panel = projectsPanel(botApi);
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
    const panel = projectsPanel(botApi);
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
    const panel = projectsPanel(botApi);
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
});

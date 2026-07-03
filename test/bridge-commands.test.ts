import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession } from "../src/acp/agent-session.js";
import { Bridge, type AgentStarter } from "../src/bridge.js";
import type { Config } from "../src/config.js";
import { StateStore, type SessionState } from "../src/state.js";
import { FakeBotApi } from "./helpers/fake-bot-api.js";
import { wireMockAgent, type MockAgent } from "./helpers/mock-agent.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bridge-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    botToken: "token",
    forumChatId: -1000,
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

function makeBridge() {
  const cfg = makeConfig();
  const botApi = new FakeBotApi();
  const store = new StateStore(join(dir, "state.json"));
  const mocks: MockAgent[] = [];
  const starter: AgentStarter = async (opts) => {
    const { agent, clientStream } = wireMockAgent();
    mocks.push(agent);
    return AgentSession.start({ ...opts, stream: clientStream, spawn: undefined });
  };
  const bridge = new Bridge(cfg, botApi, store, starter);
  return { bridge, botApi, store, mocks, cfg };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

function textOf(mock: MockAgent, i = 0): string {
  const b = mock.received[i]?.prompt[0];
  return b && b.type === "text" ? b.text : "";
}

describe("Bridge", () => {
  it("/new creates a topic, posts an intro, and persists a store entry", async () => {
    const { bridge, botApi, store } = makeBridge();
    const replies: string[] = [];
    await bridge.newTopic("myproj", undefined, async (h) => void replies.push(h));

    expect(botApi.topics).toHaveLength(1);
    const threadId = botApi.topics[0]!.threadId;
    expect(botApi.topics[0]!.name).toBe("myproj");

    const intro = botApi.htmlFor(threadId).join("\n");
    expect(intro).toContain("myproj");
    expect(intro).toContain("cwd");
    expect(intro).toContain("/commands");

    const entry = store.get(threadId);
    expect(entry?.title).toBe("myproj");
    expect(entry?.acpSessionId).toBe("sess_mock_1");
    expect(replies.some((r) => /Created/.test(r))).toBe(true);
  });

  it("defaults the topic name to claude-{n} and cycles icon colors", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.newTopic(undefined, undefined, async () => {});
    await bridge.newTopic(undefined, undefined, async () => {});
    expect(botApi.topics[0]!.name).toBe("claude-1");
    expect(botApi.topics[1]!.name).toBe("claude-2");
    expect(botApi.topics[0]!.iconColor).toBe(7322096);
    expect(botApi.topics[1]!.iconColor).toBe(16766590);
  });

  it("routes text to the right TopicSession across two interleaved topics", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic("a", undefined, async () => {});
    await bridge.newTopic("b", undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;
    const t2 = botApi.topics[1]!.threadId;

    // Interleave: topic 2 first, then topic 1.
    await bridge.handleMessage(t2, { text: "for-b" });
    await bridge.handleMessage(t1, { text: "for-a" });

    expect(textOf(mocks[0]!)).toBe("for-a");
    expect(textOf(mocks[1]!)).toBe("for-b");
  });

  it("/mode lists the agent's modes and a mode: callback switches mode", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.newTopic("a", undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/mode" });
    const kb = botApi.messages.find((m) => m.keyboard)?.keyboard;
    expect(kb).toBeDefined();
    const labels = kb!.inline_keyboard.map((row) => row[0]!.text);
    expect(labels).toEqual(["Default", "Plan", "Accept Edits"]);

    // Tap "Plan".
    const planData = kb!.inline_keyboard[1]![0]!.callback_data;
    expect(planData).toBe(`mode:${t1}:plan`);
    const res = await bridge.handleCallback(planData, 4242);
    expect(res?.toast).toContain("Plan");
    expect(botApi.edits.some((e) => /Mode: <b>Plan<\/b>/.test(e.html))).toBe(true);

    // The mock recorded the switch: /status now reports the new mode.
    await tick();
    await bridge.handleMessage(t1, { text: "/status" });
    expect(botApi.allHtml()).toContain("mode: plan");
  });

  it("unknown /frobnicate replies 'Unknown command' and never forwards to the agent", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic("a", undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/frobnicate now" });

    expect(botApi.allHtml()).toContain("Unknown command");
    expect(mocks[0]!.received).toHaveLength(0);
  });

  it("forwards a known agent command verbatim as a single text block", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic("a", undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    // Turn 0 advertises "review" (that is how the bridge learns known slashes);
    // turn 1 is the /review forward itself.
    mocks[0]!.script = [
      [
        {
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "review", description: "review code" }],
          },
        },
      ],
      [],
    ];
    await bridge.handleMessage(t1, { text: "warmup" }); // consumes turn 0, caches command
    await tick();

    await bridge.handleMessage(t1, { text: "/review src/foo.ts" });
    await tick();

    expect(mocks[0]!.received).toHaveLength(2);
    expect(textOf(mocks[0]!, 1)).toBe("/review src/foo.ts");
  });

  it("/end disposes the session, removes the store entry, and closes the topic", async () => {
    const { bridge, botApi, store } = makeBridge();
    await bridge.newTopic("a", undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/end" });

    expect(store.get(t1)).toBeUndefined();
    expect(botApi.closed).toContain(t1);
  });

  it("init() reattaches a stored session via loadSession", async () => {
    const { bridge, botApi, store } = makeBridge();
    const stored: SessionState = {
      threadId: 555,
      acpSessionId: "sess_mock_1",
      cwd: dir,
      title: "restored-one",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "state.json"), JSON.stringify([stored]));

    await bridge.init();

    expect(botApi.htmlFor(555).join("\n")).toContain("restored");
    // Still usable: a text prompt routes into the reattached session.
    await bridge.handleMessage(555, { text: "ping" });
    // Store retained the reattached id.
    expect(store.get(555)?.acpSessionId).toBe("sess_mock_1");
  });

  it("init() falls back with a notice when the stored session id is unknown", async () => {
    const { bridge, botApi, store } = makeBridge();
    const stored: SessionState = {
      threadId: 777,
      acpSessionId: "bad-unknown-id",
      cwd: dir,
      title: "stale-one",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "state.json"), JSON.stringify([stored]));

    await bridge.init();

    expect(botApi.htmlFor(777).join("\n")).toContain("started fresh");
    // The store was updated to the fresh session id.
    expect(store.get(777)?.acpSessionId).toBe("sess_mock_1");
  });

  it("General topic accepts /new but refuses per-session commands", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.handleMessage(undefined, { text: "/status" });
    expect(botApi.htmlFor(undefined).join("\n")).toContain("General topic");

    await bridge.handleMessage(undefined, { text: "/new fromgeneral" });
    expect(botApi.topics.some((t) => t.name === "fromgeneral")).toBe(true);
  });
});

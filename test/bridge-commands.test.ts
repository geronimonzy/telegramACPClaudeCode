import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { AgentSession } from "../src/acp/agent-session.js";
import { TerminalRegistry } from "../src/acp/terminals.js";
import { Bridge, type AgentStarter } from "../src/bridge.js";
import type { Config } from "../src/config.js";
import { StateStore, type SessionState } from "../src/state.js";
import { isAllowedUpdate } from "../src/telegram/bot.js";
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

function makeBridge(onAgent?: (a: MockAgent) => void) {
  const cfg = makeConfig();
  const botApi = new FakeBotApi();
  const store = new StateStore(join(dir, "state.json"));
  const mocks: MockAgent[] = [];
  const agentStreams: import("@agentclientprotocol/sdk").Stream[] = [];
  const starter: AgentStarter = async (opts) => {
    const { agent, clientStream, agentStream } = wireMockAgent();
    mocks.push(agent);
    agentStreams.push(agentStream);
    // Configure the freshly-created mock BEFORE start() runs initialize /
    // loadSession, so scripted listSessions/loadReplay are in place in time.
    onAgent?.(agent);
    return AgentSession.start({ ...opts, stream: clientStream, spawn: undefined });
  };
  const collectUsage = async () => ({
    today: new Map([["claude-opus-4-8", { input: 100, output: 10, cacheRead: 5, cacheWrite: 2, messages: 1 }]]),
    week: new Map([["claude-opus-4-8", { input: 500, output: 50, cacheRead: 25, cacheWrite: 10, messages: 5 }]]),
    sessionsToday: 1,
    sessionsWeek: 3,
  });
  const bridge = new Bridge(cfg, botApi, store, starter, collectUsage);
  return { bridge, botApi, store, mocks, cfg, agentStreams };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

const NAME_RE = /^[a-z]{3,8}-[a-z]{3,8}-[a-z]{3,8}$/;

function textOf(mock: MockAgent, i = 0): string {
  const b = mock.received[i]?.prompt[0];
  return b && b.type === "text" ? b.text : "";
}

describe("Bridge", () => {
  it("/new <project> resolves cwd from cfg.projects, random title, persists entry", async () => {
    const { bridge, botApi, store, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    const replies: string[] = [];
    await bridge.newTopic("myproj", async (h) => void replies.push(h));

    expect(botApi.topics).toHaveLength(1);
    const threadId = botApi.topics[0]!.threadId;
    // Title is a random three-word name (NOT the project arg).
    expect(botApi.topics[0]!.name).toMatch(NAME_RE);

    const intro = botApi.htmlFor(threadId).join("\n");
    expect(intro).toContain(dir); // resolved cwd shown
    expect(intro).toContain("cwd");
    expect(intro).toContain("/commands");

    const entry = store.get(threadId);
    expect(entry?.title).toMatch(NAME_RE);
    expect(entry?.cwd).toBe(dir);
    expect(entry?.acpSessionId).toBe("sess_mock_1");
    expect(replies.some((r) => /Created/.test(r))).toBe(true);
  });

  it("bare /new uses defaultCwd; titles are random and icon colors cycle", async () => {
    const { bridge, botApi, store } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    await bridge.newTopic(undefined, async () => {});
    expect(botApi.topics[0]!.name).toMatch(NAME_RE);
    expect(botApi.topics[1]!.name).toMatch(NAME_RE);
    expect(botApi.topics[0]!.name).not.toBe(botApi.topics[1]!.name);
    expect(botApi.topics[0]!.iconColor).toBe(7322096);
    expect(botApi.topics[1]!.iconColor).toBe(16766590);
    // Both resolved to defaultCwd (dir).
    expect(store.get(botApi.topics[0]!.threadId)?.cwd).toBe(dir);
  });

  it("/new <absolute existing dir> uses it as cwd", async () => {
    const { bridge, botApi, store } = makeBridge();
    const proj = await mkdtemp(join(tmpdir(), "bridge-proj-"));
    await bridge.newTopic(proj, async () => {});
    const t = botApi.topics[0]!.threadId;
    expect(store.get(t)?.cwd).toBe(proj);
    expect(botApi.topics[0]!.name).toMatch(NAME_RE);
    await rm(proj, { recursive: true, force: true });
  });

  it("/new <non-directory path> errors and creates nothing", async () => {
    const { bridge, botApi } = makeBridge();
    const replies: string[] = [];
    await bridge.newTopic("/no/such/dir/here", async (h) => void replies.push(h));
    expect(replies.join("\n")).toContain("not a directory");
    expect(botApi.topics).toHaveLength(0);
  });

  it("/new <project> <name…> uses the words after the folder as the topic title", async () => {
    const { bridge, botApi, store, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    await bridge.newTopic("myproj Design Requirements", async () => {});
    expect(botApi.topics).toHaveLength(1);
    expect(botApi.topics[0]!.name).toBe("Design Requirements");
    const entry = store.get(botApi.topics[0]!.threadId);
    expect(entry?.title).toBe("Design Requirements");
    expect(entry?.cwd).toBe(dir);
  });

  it("/new resolves a bare word as a directory under defaultCwd", async () => {
    const { bridge, botApi, store } = makeBridge();
    await mkdir(join(dir, "receiptSaas"), { recursive: true });
    await bridge.newTopic("receiptSaas DesignRequirements", async () => {});
    expect(botApi.topics).toHaveLength(1);
    expect(botApi.topics[0]!.name).toBe("DesignRequirements");
    expect(store.get(botApi.topics[0]!.threadId)?.cwd).toBe(join(dir, "receiptSaas"));
  });

  it("a project key wins over a same-named defaultCwd subdirectory", async () => {
    const { bridge, botApi, store, cfg } = makeBridge();
    const projDir = await mkdtemp(join(tmpdir(), "bridge-proj-"));
    cfg.projects = { receiptSaas: projDir };
    await mkdir(join(dir, "receiptSaas"), { recursive: true });
    await bridge.newTopic("receiptSaas", async () => {});
    expect(store.get(botApi.topics[0]!.threadId)?.cwd).toBe(projDir);
    await rm(projDir, { recursive: true, force: true });
  });

  it("/new with a path and no title still gets a random three-word name", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.newTopic(dir, async () => {});
    expect(botApi.topics[0]!.name).toMatch(NAME_RE);
  });

  it("an over-long custom title is truncated to the topic-title cap", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { myproj: dir };
    await bridge.newTopic(`myproj ${"t".repeat(200)}`, async () => {});
    expect(botApi.topics[0]!.name.length).toBeLessThanOrEqual(64);
    expect(botApi.topics[0]!.name.endsWith("…")).toBe(true);
  });

  it("an unresolvable folder word errors with the [folder] [name…] usage", async () => {
    const { bridge, botApi } = makeBridge();
    const replies: string[] = [];
    await bridge.newTopic("noSuchThing SomeName", async (h) => void replies.push(h));
    const err = replies.join("\n");
    expect(err).toContain("unknown folder");
    expect(err).toContain("[folder] [name…]");
    expect(botApi.topics).toHaveLength(0);
  });

  it("/new <unknown folder> lists known projects and creates nothing", async () => {
    const { bridge, botApi, cfg } = makeBridge();
    cfg.projects = { alpha: dir, beta: dir };
    const replies: string[] = [];
    await bridge.newTopic("nope", async (h) => void replies.push(h));
    const html = replies.join("\n");
    expect(html).toContain("unknown folder");
    expect(html).toContain("alpha");
    expect(html).toContain("beta");
    expect(botApi.topics).toHaveLength(0);
  });

  it("routes text to the right TopicSession across two interleaved topics", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    await bridge.newTopic(undefined, async () => {});
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
    await bridge.newTopic(undefined, async () => {});
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
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/frobnicate now" });

    expect(botApi.allHtml()).toContain("Unknown command");
    expect(mocks[0]!.received).toHaveLength(0);
  });

  it("forwards a known agent command verbatim as a single text block", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
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

  it("a hyphenated unknown slash command (/pr-comments) is refused, never forwarded", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    // Regression for the parseCommand name-capture bug: `[A-Za-z0-9_:]+`
    // didn't match hyphens, so `/pr-comments` failed the command regex and
    // fell through to a raw prompt forward. It must instead be recognized as
    // a command attempt and refused as unknown.
    await bridge.handleMessage(t1, { text: "/pr-comments" });

    expect(botApi.allHtml()).toContain("Unknown command");
    expect(mocks[0]!.received).toHaveLength(0);
  });

  it("forwards a hyphenated agent command verbatim when it is advertised", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    mocks[0]!.script = [
      [
        {
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "pr-comments", description: "list PR comments" }],
          },
        },
      ],
      [],
    ];
    await bridge.handleMessage(t1, { text: "warmup" });
    await tick();

    await bridge.handleMessage(t1, { text: "/pr-comments 123" });
    await tick();

    expect(mocks[0]!.received).toHaveLength(2);
    expect(textOf(mocks[0]!, 1)).toBe("/pr-comments 123");
  });

  it("/end disposes the session, removes the store entry, and closes the topic", async () => {
    const { bridge, botApi, store } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/end" });

    expect(store.get(t1)).toBeUndefined();
    expect(botApi.closed).toContain(t1);
  });

  it("/new pins the intro message in the new topic", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    // The intro is the first message sent into the new topic; it must be pinned.
    const intro = botApi.messages.find((m) => m.threadId === t1 && /cwd/.test(m.html));
    expect(intro).toBeDefined();
    expect(botApi.pins).toContainEqual({ threadId: t1, messageId: intro!.messageId });
  });

  it("/end releases the session's terminals and removes its uploads dir", async () => {
    const releaseSpy = vi.spyOn(TerminalRegistry.prototype, "releaseForSession");
    const { bridge, botApi, cfg } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;

    // Seed an uploads dir for this topic (as a document upload would).
    const uploadsDir = join(cfg.dataDir, "uploads", String(t1));
    await mkdir(uploadsDir, { recursive: true });
    await writeFile(join(uploadsDir, "f.txt"), "x");

    await bridge.handleMessage(t1, { text: "/end" });

    // Terminals for this session's acp id were released…
    expect(releaseSpy).toHaveBeenCalledWith("sess_mock_1");
    // …and the topic's uploads dir is gone.
    await expect(access(uploadsDir)).rejects.toBeTruthy();
    releaseSpy.mockRestore();
  });

  it("agent death posts a Restart button; tapping it respawns the session", async () => {
    const { bridge, botApi, mocks, agentStreams } = makeBridge();
    await bridge.newTopic(undefined, async () => {});
    const t1 = botApi.topics[0]!.threadId;
    expect(mocks).toHaveLength(1);

    // Kill the agent: closing the agent-side writable ends the client connection,
    // firing onExit → handleAgentExit → the death notice.
    await agentStreams[0]!.writable.close();

    await vi.waitFor(() => {
      const died = botApi.messages.find((m) => m.threadId === t1 && /died/i.test(m.html));
      expect(died).toBeDefined();
      expect(died!.keyboard).toBeDefined();
    });
    const notice = botApi.messages.find((m) => m.threadId === t1 && /died/i.test(m.html))!;
    const restartData = notice.keyboard!.inline_keyboard[0]![0]!.callback_data;
    expect(restartData).toBe(`restart:${t1}`);

    // Tap Restart → a fresh AgentSession (mock) is started and a success notice posts.
    const res = await bridge.handleCallback(restartData, notice.messageId);
    expect(res?.toast).toBe("restarted");
    expect(mocks).toHaveLength(2);
    expect(botApi.htmlFor(t1).join("\n")).toContain("agent restarted");
  });

  it("init() does NOT auto-reattach; it posts a Reconnect button per stored session", async () => {
    const { bridge, botApi, store, mocks } = makeBridge();
    const stored: SessionState = {
      threadId: 555,
      acpSessionId: "sess_mock_1",
      cwd: dir,
      title: "restored-one",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "state.json"), JSON.stringify([stored]));

    await bridge.init();

    // No agent was spawned on boot.
    expect(mocks).toHaveLength(0);
    // A disconnected notice with a Reconnect button landed in the topic.
    const notice = botApi.messages.find((m) => m.threadId === 555 && /disconnected/i.test(m.html));
    expect(notice).toBeDefined();
    expect(notice!.keyboard!.inline_keyboard[0]![0]!.callback_data).toBe("reconnect:555");
    // Store is untouched.
    expect(store.get(555)?.acpSessionId).toBe("sess_mock_1");
  });

  it("tapping Reconnect loads the stored session on demand", async () => {
    const { bridge, botApi, store, mocks } = makeBridge();
    const stored: SessionState = {
      threadId: 555,
      acpSessionId: "sess_mock_1",
      cwd: dir,
      title: "restored-one",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "state.json"), JSON.stringify([stored]));
    await bridge.init();

    const res = await bridge.handleCallback("reconnect:555", undefined);
    expect(res?.toast).toBe("reconnected");
    expect(mocks).toHaveLength(1);
    expect(botApi.htmlFor(555).join("\n")).toContain("reconnected");
    // The reconnected notice offers the compact-or-continue choice.
    const notice = botApi.messages.find((m) => m.threadId === 555 && /reconnected/.test(m.html))!;
    const row = notice.keyboard!.inline_keyboard[0]!;
    expect(row.map((b) => b.callback_data)).toEqual(["compact:555", "continue:555"]);
    // Still usable: a text prompt now routes into the reconnected session.
    await bridge.handleMessage(555, { text: "ping" });
    expect(textOf(mocks[0]!)).toBe("ping");
    expect(store.get(555)?.acpSessionId).toBe("sess_mock_1");
  });

  it("post-reconnect Compact fires /compact into the session; Continue just dismisses", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    const stored: SessionState = {
      threadId: 555,
      acpSessionId: "sess_mock_1",
      cwd: dir,
      title: "restored-one",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "state.json"), JSON.stringify([stored]));
    await bridge.init();
    await bridge.handleCallback("reconnect:555", undefined);
    const notice = botApi.messages.find((m) => m.threadId === 555 && /reconnected/.test(m.html))!;

    // Continue: edits the notice, sends nothing to the agent.
    const cont = await bridge.handleCallback("continue:555", notice.messageId);
    expect(cont?.toast).toBe("continuing");
    expect(
      botApi.edits.some((e) => e.messageId === notice.messageId && /continuing/.test(e.html)),
    ).toBe(true);
    expect(mocks[0]!.received).toHaveLength(0);

    // Compact: edits the notice and forwards /compact as a prompt turn.
    const comp = await bridge.handleCallback("compact:555", notice.messageId);
    expect(comp?.toast).toBe("compacting");
    await tick();
    expect(textOf(mocks[0]!)).toBe("/compact");
    expect(
      botApi.edits.some((e) => e.messageId === notice.messageId && /compacting/.test(e.html)),
    ).toBe(true);
  });

  it("Reconnect falls back to a fresh session when the stored id is unknown", async () => {
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

    const res = await bridge.handleCallback("reconnect:777", undefined);
    expect(res?.toast).toBe("started fresh");
    expect(botApi.htmlFor(777).join("\n")).toContain("started fresh");
    // The store was updated to the fresh session id.
    expect(store.get(777)?.acpSessionId).toBe("sess_mock_1");
  });

  it("a prompt into a disconnected topic offers Reconnect, not /new", async () => {
    const { bridge, botApi } = makeBridge();
    const stored: SessionState = {
      threadId: 888,
      acpSessionId: "sess_mock_1",
      cwd: dir,
      title: "sleeping-one",
      createdAt: new Date().toISOString(),
    };
    await writeFile(join(dir, "state.json"), JSON.stringify([stored]));
    await bridge.init();

    await bridge.handleMessage(888, { text: "hello?" });
    const prompt = botApi.messages.find(
      (m) => m.threadId === 888 && /disconnected/i.test(m.html) && m.keyboard,
    );
    expect(prompt!.keyboard!.inline_keyboard[0]![0]!.callback_data).toBe("reconnect:888");
  });

  describe("/usage", () => {
    it("creates the 📊 topic, posts + pins the stats message, persists across bridges", async () => {
      const { bridge, botApi } = makeBridge();
      await bridge.handleMessage(undefined, { text: "/usage" });

      const topic = botApi.topics.find((t) => /Claude Usage/.test(t.name))!;
      expect(topic).toBeDefined();
      const statsMsg = botApi.messages.find((m) => m.threadId === topic.threadId)!;
      expect(statsMsg.html).toContain("📊 Claude usage");
      expect(statsMsg.html).toContain("<table>");
      expect(statsMsg.html).toContain("opus-4-8");
      expect(botApi.pins.some((p) => p.messageId === statsMsg.messageId)).toBe(true);
      // Confirmation went to where the command was issued (General).
      expect(botApi.htmlFor(undefined).join("\n")).toContain("usage stats updated");

      // Second /usage EDITS the same message instead of sending a new one.
      await bridge.handleMessage(undefined, { text: "/usage" });
      expect(botApi.edits.some((e) => e.messageId === statsMsg.messageId)).toBe(true);
      expect(botApi.messages.filter((m) => m.threadId === topic.threadId)).toHaveLength(1);

      // A NEW bridge over the same dataDir reuses the persisted topic +
      // message id: the stats land as an edit, and NO new topic is created.
      const second = makeBridge();
      await second.bridge.handleMessage(undefined, { text: "/usage" });
      expect(second.botApi.topics.filter((t) => /Claude Usage/.test(t.name))).toHaveLength(0);
      expect(second.botApi.edits.some((e) => e.html.includes("📊 Claude usage"))).toBe(true);
    });

    it("recreates the usage topic when it was deleted in Telegram", async () => {
      const { bridge, botApi } = makeBridge();
      await bridge.handleMessage(undefined, { text: "/usage" });
      const topic = botApi.topics.find((t) => /Claude Usage/.test(t.name))!;
      botApi.deadThreads.add(topic.threadId);

      await bridge.handleMessage(undefined, { text: "/usage" });

      const topics = botApi.topics.filter((t) => /Claude Usage/.test(t.name));
      expect(topics).toHaveLength(2); // recreated
      const fresh = topics[1]!;
      expect(botApi.messages.some((m) => m.threadId === fresh.threadId)).toBe(true);
    });
  });

  it("General topic accepts /new but refuses per-session commands", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.handleMessage(undefined, { text: "/status" });
    expect(botApi.htmlFor(undefined).join("\n")).toContain("General topic");

    await bridge.handleMessage(undefined, { text: "/new" });
    expect(botApi.topics).toHaveLength(1);
    expect(botApi.topics[0]!.name).toMatch(NAME_RE);
  });

  describe("/file containment", () => {
    const scratchDirs: string[] = [];
    afterEach(async () => {
      await Promise.all(
        scratchDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
      );
    });

    it("refuses a relative path that escapes the cwd via ../../", async () => {
      const { bridge, botApi, cfg } = makeBridge();
      const cwd = await mkdtemp(join(tmpdir(), "bridge-file-"));
      scratchDirs.push(cwd);
      cfg.defaultCwd = cwd;
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, { text: "/file ../../etc/passwd" });

      expect(botApi.allHtml()).toContain("escapes the session directory");
      expect(botApi.documents).toHaveLength(0);
    });

    it("refuses a crafted absolute path outside the cwd", async () => {
      const { bridge, botApi, cfg } = makeBridge();
      const cwd = await mkdtemp(join(tmpdir(), "bridge-file-"));
      const outsideDir = await mkdtemp(join(tmpdir(), "bridge-outside-"));
      scratchDirs.push(cwd, outsideDir);
      const outsideFile = join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "top secret");
      cfg.defaultCwd = cwd;
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, { text: `/file ${outsideFile}` });

      expect(botApi.allHtml()).toContain("escapes the session directory");
      expect(botApi.documents).toHaveLength(0);
    });

    it("refuses a sibling directory that merely prefix-matches the cwd", async () => {
      const { bridge, botApi, cfg } = makeBridge();
      const cwd = await mkdtemp(join(tmpdir(), "bridge-file-"));
      scratchDirs.push(cwd);
      // e.g. cwd = /tmp/bridge-file-abc, sibling = /tmp/bridge-file-abc-evil —
      // a naive `resolved.startsWith(base)` check (without the path.sep) would
      // wrongly let this through.
      const siblingDir = `${cwd}-evil`;
      scratchDirs.push(siblingDir);
      await mkdir(siblingDir, { recursive: true });
      const siblingFile = join(siblingDir, "f");
      await writeFile(siblingFile, "nope");
      cfg.defaultCwd = cwd;
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, { text: `/file ${siblingFile}` });

      expect(botApi.allHtml()).toContain("escapes the session directory");
      expect(botApi.documents).toHaveLength(0);
    });

    it("sends a legit relative file inside the cwd", async () => {
      const { bridge, botApi, cfg } = makeBridge();
      const cwd = await mkdtemp(join(tmpdir(), "bridge-file-"));
      scratchDirs.push(cwd);
      const filePath = join(cwd, "note.txt");
      await writeFile(filePath, "hello");
      cfg.defaultCwd = cwd;
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, { text: "/file note.txt" });

      expect(botApi.documents).toHaveLength(1);
      expect(botApi.documents[0]!.filePath).toBe(filePath);
    });
  });

  describe("document uploads", () => {
    it("refuses an oversized document before calling getFile", async () => {
      const cfg = makeConfig();
      class ThrowingGetFileBotApi extends FakeBotApi {
        async getFile(): Promise<{ filePath?: string; fileSize?: number }> {
          throw new Error("getFile must not be called for an oversized document");
        }
      }
      const botApi = new ThrowingGetFileBotApi();
      const store = new StateStore(join(dir, "state.json"));
      const mocks: MockAgent[] = [];
      const starter: AgentStarter = async (opts) => {
        const { agent, clientStream } = wireMockAgent();
        mocks.push(agent);
        return AgentSession.start({ ...opts, stream: clientStream, spawn: undefined });
      };
      const bridge = new Bridge(cfg, botApi, store, starter);
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, {
        document: { fileId: "doc1", fileName: "big.bin", fileSize: 25 * 1024 * 1024 },
      });

      expect(botApi.allHtml()).toContain("larger than 20 MB");
      expect(mocks[0]!.received).toHaveLength(0);
    });

    it("sanitizes a '.'/'..' upload filename to a generated name", async () => {
      const { bridge, botApi, mocks } = makeBridge();
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      botApi.files.set("doc1", { filePath: "server/path/doc1", fileSize: 5 });
      botApi.fileBytes.set("server/path/doc1", Buffer.from("hello"));

      await bridge.handleMessage(t1, {
        document: { fileId: "doc1", fileName: "..", fileSize: 5 },
      });
      await tick();

      expect(mocks[0]!.received).toHaveLength(1);
      const savedLine = textOf(mocks[0]!, 0);
      expect(savedLine).toMatch(/^Attached file saved at: /);
      const absPath = savedLine.replace("Attached file saved at: ", "");
      expect(basename(absPath)).toMatch(/^upload-\d+$/);
      await expect(readFile(absPath, "utf-8")).resolves.toBe("hello");
    });
  });

  describe("/sessions + attach", () => {
    const SESSIONS: import("@agentclientprotocol/sdk").SessionInfo[] = [
      {
        sessionId: "sess_mock_1",
        cwd: "/home/kiril/proj",
        title: "Resume me please",
        updatedAt: "2026-07-03T18:00:00.000Z",
      },
      {
        sessionId: "other-id",
        cwd: "/home/kiril/other",
        title: "Another old session",
        updatedAt: "2026-07-02T10:00:00.000Z",
      },
    ];
    const REPLAY: import("@agentclientprotocol/sdk").SessionUpdate[] = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } },
      // Same-role chunk: merges into the SAME agent message, not a new one.
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " continued" } },
      // User styling chars must render literally, not as markdown.
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "**styled** follow-up" } },
    ];

    it("filters out already-attached ids from the listing", async () => {
      const { bridge, botApi } = makeBridge((a) => {
        a.listSessionsResponse = SESSIONS;
      });
      // Attach an existing topic whose acp id is sess_mock_1 (so it is filtered).
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, { text: "/sessions" });

      const listing = botApi.messages.find((m) => m.keyboard && /Resumable sessions/.test(m.html))!;
      expect(listing).toBeDefined();
      const buttons = listing.keyboard!.inline_keyboard;
      // sess_mock_1 filtered out → only "other-id" remains.
      expect(buttons).toHaveLength(1);
      expect(listing.html).toContain("Another old session");
      expect(listing.html).not.toContain("Resume me please");
    });

    it("attach:{k} creates a topic, streams the transcript, and persists a store entry", async () => {
      const { bridge, botApi, store } = makeBridge((a) => {
        a.listSessionsResponse = SESSIONS;
        a.loadReplay = REPLAY;
      });

      // No existing topic → General /sessions uses a throwaway listing agent.
      await bridge.handleMessage(undefined, { text: "/sessions" });
      const listing = botApi.messages.find((m) => m.keyboard && /Resumable sessions/.test(m.html))!;
      expect(listing).toBeDefined();
      // Pick the button for the loadable session (sess_mock_1 = "Resume me please").
      const idx = listing.html.indexOf("Resume me please");
      const otherIdx = listing.html.indexOf("Another old session");
      expect(idx).toBeGreaterThanOrEqual(0);
      // Its button is the first row (most recent first).
      const attachData = listing.keyboard!.inline_keyboard[0]![0]!.callback_data;
      expect(attachData).toMatch(/^attach:\d+$/);
      expect(attachData.length).toBeLessThanOrEqual(64);
      void otherIdx;

      const before = botApi.topics.length;
      const res = await bridge.handleCallback(attachData, 1);
      await tick();
      expect(res?.toast).toBe("attached");
      expect(botApi.topics.length).toBe(before + 1);
      const attachedThread = botApi.topics.at(-1)!.threadId;
      // Topic title = session title truncated (present) → "Resume me please".
      expect(botApi.topics.at(-1)!.name).toBe("Resume me please");

      // The transcript posts ONE MESSAGE PER SPEAKER TURN: user turns as
      // literal bold blockquotes, agent turns as markdown under a 🤖 header.
      const sendHtml = botApi.messages
        .filter((m) => m.threadId === attachedThread)
        .map((m) => m.html);
      const userMsg = sendHtml.find((h) => h.includes("old question"))!;
      const agentMsg = sendHtml.find((h) => h.includes("old answer"))!;
      expect(userMsg).toBeDefined();
      expect(agentMsg).toBeDefined();
      expect(userMsg).not.toBe(agentMsg); // separate messages per turn
      expect(userMsg).toContain("<blockquote><b>👤 You");
      expect(agentMsg).toContain("🤖");
      // Turns arrive in conversation order.
      expect(sendHtml.indexOf(userMsg)).toBeLessThan(sendHtml.indexOf(agentMsg));
      // Same-role chunks merged into one message.
      expect(agentMsg).toContain("old answer continued");
      // User styling chars stay literal — never rendered as markdown.
      const followUp = sendHtml.find((h) => h.includes("styled"))!;
      expect(followUp).toContain("**styled** follow-up");
      expect(followUp).not.toContain("<b>styled</b>");
      // The attached notice was sent into the thread.
      expect(sendHtml.join("\n")).toContain("attached");

      // Persisted like any topic.
      const entry = store.get(attachedThread);
      expect(entry?.acpSessionId).toBe("sess_mock_1");
      expect(entry?.cwd).toBe("/home/kiril/proj");
      expect(entry?.title).toBe("Resume me please");
    });

    it("a topic deleted in Telegram is pruned by /sessions and its session re-listed", async () => {
      const { bridge, botApi, store, mocks } = makeBridge((a) => {
        a.listSessionsResponse = SESSIONS;
      });
      // A live topic bound to sess_mock_1 (normally filtered from the listing).
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;
      expect(store.get(t1)?.acpSessionId).toBe("sess_mock_1");

      // The user deletes the topic in the Telegram UI (no bot update exists).
      botApi.deadThreads.add(t1);

      await bridge.handleMessage(undefined, { text: "/sessions" });

      // Probe noticed the dead thread: store entry pruned.
      expect(store.get(t1)).toBeUndefined();
      // The freed session is offered again in the listing.
      const listing = botApi.messages.filter((m) => m.keyboard && /Resumable sessions/.test(m.html)).at(-1)!;
      expect(listing.html).toContain("Resume me please");
      // And a prompt into the dead topic no longer routes anywhere.
      await bridge.handleMessage(t1, { text: "hello?" });
      expect(mocks[0]!.received).toHaveLength(0);
    });

    it("a failing send into a deleted stored topic prunes it (restart-notice path)", async () => {
      const { bridge, botApi, store } = makeBridge();
      const stored: SessionState = {
        threadId: 999,
        acpSessionId: "gone-topic-session",
        cwd: dir,
        title: "deleted-one",
        createdAt: new Date().toISOString(),
      };
      await writeFile(join(dir, "state.json"), JSON.stringify([stored]));
      botApi.deadThreads.add(999);

      await bridge.init(); // posts the disconnect notice → thread not found → prune

      expect(store.get(999)).toBeUndefined();
    });

    it("a stale/unknown attach:{k} toasts and does not crash or create a topic", async () => {
      const { bridge, botApi } = makeBridge();
      const res = await bridge.handleCallback("attach:9999", 1);
      expect(res?.toast).toMatch(/no longer listed/);
      expect(botApi.topics).toHaveLength(0);
    });

    it("/sessions with no resumable sessions replies with a notice", async () => {
      const { bridge, botApi } = makeBridge((a) => {
        a.listSessionsResponse = [];
      });
      await bridge.newTopic(undefined, async () => {});
      const t1 = botApi.topics[0]!.threadId;
      await bridge.handleMessage(t1, { text: "/sessions" });
      expect(botApi.htmlFor(t1).join("\n")).toContain("No resumable sessions");
    });
  });
});

describe("isAllowedUpdate", () => {
  const cfg = { allowedUserIds: [1, 2], forumChatId: -1000 };

  it("allows an allowlisted user in the configured forum chat", () => {
    expect(isAllowedUpdate(cfg, { id: 1 }, -1000)).toBe(true);
  });

  it("refuses a user who is not on the allowlist", () => {
    expect(isAllowedUpdate(cfg, { id: 99 }, -1000)).toBe(false);
  });

  it("refuses the right user in the wrong chat", () => {
    expect(isAllowedUpdate(cfg, { id: 1 }, -2000)).toBe(false);
  });

  it("refuses when `from` is missing", () => {
    expect(isAllowedUpdate(cfg, undefined, -1000)).toBe(false);
  });

  it("refuses when the chat id is missing", () => {
    expect(isAllowedUpdate(cfg, { id: 1 }, undefined)).toBe(false);
  });
});

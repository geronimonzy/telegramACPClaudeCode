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

function makeBridge() {
  const cfg = makeConfig();
  const botApi = new FakeBotApi();
  const store = new StateStore(join(dir, "state.json"));
  const mocks: MockAgent[] = [];
  const agentStreams: import("@agentclientprotocol/sdk").Stream[] = [];
  const starter: AgentStarter = async (opts) => {
    const { agent, clientStream, agentStream } = wireMockAgent();
    mocks.push(agent);
    agentStreams.push(agentStream);
    return AgentSession.start({ ...opts, stream: clientStream, spawn: undefined });
  };
  const bridge = new Bridge(cfg, botApi, store, starter);
  return { bridge, botApi, store, mocks, cfg, agentStreams };
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
    await bridge.newTopic("myproj", async (h) => void replies.push(h));

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
    await bridge.newTopic(undefined, async () => {});
    await bridge.newTopic(undefined, async () => {});
    expect(botApi.topics[0]!.name).toBe("claude-1");
    expect(botApi.topics[1]!.name).toBe("claude-2");
    expect(botApi.topics[0]!.iconColor).toBe(7322096);
    expect(botApi.topics[1]!.iconColor).toBe(16766590);
  });

  it("routes text to the right TopicSession across two interleaved topics", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic("a", async () => {});
    await bridge.newTopic("b", async () => {});
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
    await bridge.newTopic("a", async () => {});
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
    await bridge.newTopic("a", async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/frobnicate now" });

    expect(botApi.allHtml()).toContain("Unknown command");
    expect(mocks[0]!.received).toHaveLength(0);
  });

  it("forwards a known agent command verbatim as a single text block", async () => {
    const { bridge, botApi, mocks } = makeBridge();
    await bridge.newTopic("a", async () => {});
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
    await bridge.newTopic("a", async () => {});
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
    await bridge.newTopic("a", async () => {});
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
    await bridge.newTopic("a", async () => {});
    const t1 = botApi.topics[0]!.threadId;

    await bridge.handleMessage(t1, { text: "/end" });

    expect(store.get(t1)).toBeUndefined();
    expect(botApi.closed).toContain(t1);
  });

  it("/new pins the intro message in the new topic", async () => {
    const { bridge, botApi } = makeBridge();
    await bridge.newTopic("pinme", async () => {});
    const t1 = botApi.topics[0]!.threadId;

    // The intro is the first message sent into the new topic; it must be pinned.
    const intro = botApi.messages.find((m) => m.threadId === t1 && /pinme/.test(m.html));
    expect(intro).toBeDefined();
    expect(botApi.pins).toContainEqual({ threadId: t1, messageId: intro!.messageId });
  });

  it("/end releases the session's terminals and removes its uploads dir", async () => {
    const releaseSpy = vi.spyOn(TerminalRegistry.prototype, "releaseForSession");
    const { bridge, botApi, cfg } = makeBridge();
    await bridge.newTopic("a", async () => {});
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
    await bridge.newTopic("dies", async () => {});
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
      await bridge.newTopic("f", async () => {});
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
      await bridge.newTopic("f", async () => {});
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
      await bridge.newTopic("f", async () => {});
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
      await bridge.newTopic("f", async () => {});
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
      await bridge.newTopic("a", async () => {});
      const t1 = botApi.topics[0]!.threadId;

      await bridge.handleMessage(t1, {
        document: { fileId: "doc1", fileName: "big.bin", fileSize: 25 * 1024 * 1024 },
      });

      expect(botApi.allHtml()).toContain("larger than 20 MB");
      expect(mocks[0]!.received).toHaveLength(0);
    });

    it("sanitizes a '.'/'..' upload filename to a generated name", async () => {
      const { bridge, botApi, mocks } = makeBridge();
      await bridge.newTopic("a", async () => {});
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

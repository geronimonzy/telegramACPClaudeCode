import { describe, it, expect, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { wireMockAgent, type TurnScript } from "./helpers/mock-agent.js";
import { AgentSession } from "../src/acp/agent-session.js";
import { PermissionBroker, type PermissionPrompt } from "../src/telegram/permissions.js";
import { FakeApi } from "./helpers/fake-api.js";
import { TopicSession, type TopicUi } from "../src/orchestrator.js";
import type { InlineKeyboard } from "../src/bridge.js";

const CFG = { editIntervalMs: 5, typingIntervalMs: 5, showThoughts: true };

/** A recording TopicUi backed by FakeApi message senders. */
class FakeUi implements TopicUi {
  apis: FakeApi[] = [];
  typingCount = 0;
  notifications: string[] = [];
  notifyKeyboards: Array<InlineKeyboard | undefined> = [];
  permissionPrompts: PermissionPrompt[] = [];
  editedPermissions: Array<[number, string]> = [];
  /** When true, every `typing()` call throws instead of recording. */
  typingThrows = false;
  private nextPermMsgId = 1000;

  messageApi(): FakeApi {
    const api = new FakeApi();
    this.apis.push(api);
    return api;
  }
  typing(): void {
    this.typingCount++;
    if (this.typingThrows) throw new Error("typing boom");
  }
  async notify(html: string, keyboard?: InlineKeyboard): Promise<void> {
    this.notifications.push(html);
    this.notifyKeyboards.push(keyboard);
  }
  async presentPermission(p: PermissionPrompt): Promise<number> {
    this.permissionPrompts.push(p);
    return this.nextPermMsgId++;
  }
  async editPermissionMessage(messageId: number, html: string): Promise<void> {
    this.editedPermissions.push([messageId, html]);
  }
}

/** Latest content delivered to a FakeApi (last edit, else the initial send). */
function latest(api: FakeApi): string {
  if (api.edits.length > 0) return api.edits[api.edits.length - 1]![1];
  return api.sends[api.sends.length - 1] ?? "";
}

/** Every html ever delivered to a FakeApi (sends + edits), for substring checks. */
function allContent(api: FakeApi): string {
  return [...api.sends, ...api.edits.map(([, h]) => h)].join("\n");
}

function textOf(req: acp.PromptRequest): string {
  const b = req.prompt[0];
  return b && b.type === "text" ? b.text : "";
}

/** A standalone permission request, for driving `handlePermission` directly. */
function makeRequest(
  overrides: Partial<acp.RequestPermissionRequest> = {},
): acp.RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: { toolCallId: "late", title: "Late tool call" },
    options: allowRejectOptions,
    ...overrides,
  };
}

async function makeTopic(
  script: TurnScript[],
  cfg = CFG,
): Promise<{ topic: TopicSession; agent: import("../src/acp/agent-session.js").AgentSession; ui: FakeUi; broker: PermissionBroker; mock: ReturnType<typeof wireMockAgent>["agent"] }> {
  const { agent: mock, clientStream } = wireMockAgent(script);
  const ui = new FakeUi();
  const broker = new PermissionBroker();
  let topic!: TopicSession;
  const agent = await AgentSession.start({
    cwd: "/tmp",
    stream: clientStream,
    onUpdate: (u) => topic.handleUpdate(u),
    onPermission: (r) => topic.handlePermission(r),
    onExit: (info) => topic.handleAgentExit(info),
  });
  topic = new TopicSession({ agent, ui, broker, threadId: 42, cfg });
  return { topic, agent, ui, broker, mock };
}

const allowRejectOptions: acp.PermissionOption[] = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

describe("TopicSession", () => {
  it("runs a full turn: chunks in order, activity + plan rendered, permission resolved, typing fired", async () => {
    const script: TurnScript[] = [
      [
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } } },
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Read file",
            kind: "read",
            status: "in_progress",
          },
        },
        {
          update: {
            sessionUpdate: "plan",
            entries: [{ content: "Step one", priority: "medium", status: "pending" }],
          },
        },
        { permission: { toolCallId: "t1", options: allowRejectOptions } },
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
      ],
    ];
    const { topic, ui, broker, mock } = await makeTopic(script);

    const p = topic.handleUserPrompt([{ type: "text", text: "hi" }]);
    await vi.waitFor(() => expect(ui.permissionPrompts).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 10)); // let present() backfill the messageId
    broker.resolve(ui.permissionPrompts[0]!.keyboard[0]![0]!.callback_data);
    await p;

    expect(ui.typingCount).toBeGreaterThanOrEqual(1);
    expect(mock.received).toHaveLength(1);

    // apis[0] = draft, apis[1] = activity, apis[2] = plan (creation order).
    expect(latest(ui.apis[0]!)).toContain("Hello world");
    expect(allContent(ui.apis[1]!)).toContain("Read file");
    expect(allContent(ui.apis[1]!)).toContain("Activity");
    expect(allContent(ui.apis[2]!)).toContain("Step one");
    expect(allContent(ui.apis[2]!)).toContain("Plan");

    // Permission resolved as "allow" (option 0) and echoed back to the agent.
    expect(mock.permissionOutcomes[0]?.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    expect(ui.editedPermissions).toHaveLength(1);
  });

  it("queues a second prompt FIFO and runs it after the first (order preserved)", async () => {
    const script: TurnScript[] = [
      [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } } }, { sleepMs: 30 }],
      [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } } }],
    ];
    const { topic, mock } = await makeTopic(script);

    const p1 = topic.handleUserPrompt([{ type: "text", text: "A" }]);
    const p2 = topic.handleUserPrompt([{ type: "text", text: "B" }]); // enqueued while turn 1 active
    await Promise.all([p1, p2]);

    expect(mock.received).toHaveLength(2);
    expect(textOf(mock.received[0]!)).toBe("A");
    expect(textOf(mock.received[1]!)).toBe("B");
  });

  it("drops overflow prompts past the queue cap and notifies 'queue full'", async () => {
    const script: TurnScript[] = [[{ sleepMs: 40 }], [], [], [], [], []];
    const { topic, ui, mock } = await makeTopic(script);

    topic.handleUserPrompt([{ type: "text", text: "A" }]); // running
    // 5 fit in the queue, the 6th overflows.
    for (const t of ["1", "2", "3", "4", "5", "OVERFLOW"]) {
      void topic.handleUserPrompt([{ type: "text", text: t }]);
    }
    await vi.waitFor(() => expect(mock.received.length).toBe(6));

    expect(ui.notifications.some((n) => /queue full/i.test(n))).toBe(true);
    expect(mock.received.map((r) => textOf(r))).toEqual(["A", "1", "2", "3", "4", "5"]);
  });

  it("cancel mid-turn resolves the turn cancelled and settles the pending permission cancelled", async () => {
    const script: TurnScript[] = [
      [
        { permission: { toolCallId: "t1", options: allowRejectOptions } },
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unreached" } } },
      ],
    ];
    const { topic, ui, mock } = await makeTopic(script);

    const p = topic.handleUserPrompt([{ type: "text", text: "go" }]);
    await vi.waitFor(() => expect(ui.permissionPrompts).toHaveLength(1));
    await topic.cancel();
    await p;

    expect(mock.permissionOutcomes[0]?.outcome).toEqual({ outcome: "cancelled" });
    expect(ui.notifications.some((n) => /cancel/i.test(n))).toBe(true);
  });

  it("notifies with 'refusal' when the stop reason is a refusal", async () => {
    const script: TurnScript[] = [
      [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "no" } } }],
    ];
    const { topic, ui, mock } = await makeTopic(script);
    mock.lastStopReason = "refusal";

    await topic.handleUserPrompt([{ type: "text", text: "please" }]);

    expect(ui.notifications.some((n) => /refusal/i.test(n))).toBe(true);
  });

  it("handleAgentExit notifies that the agent process died and offers a Restart button", async () => {
    const { topic, ui } = await makeTopic([]);
    topic.handleAgentExit({ code: 1 });
    await vi.waitFor(() => expect(ui.notifications.length).toBeGreaterThanOrEqual(1));
    const i = ui.notifications.findIndex((n) => /died/i.test(n));
    expect(i).toBeGreaterThanOrEqual(0);
    // The death notice carries the restart keyboard targeting this topic (thread 42).
    const kb = ui.notifyKeyboards[i];
    expect(kb?.inline_keyboard[0]?.[0]?.callback_data).toBe("restart:42");
    expect(kb?.inline_keyboard[0]?.[0]?.text).toContain("Restart");
  });

  it("caches usage updates for /status", async () => {
    const script: TurnScript[] = [
      [{ update: { sessionUpdate: "usage_update", used: 1234, size: 200000 } }],
    ];
    const { topic } = await makeTopic(script);
    await topic.handleUserPrompt([{ type: "text", text: "hi" }]);
    expect(topic.lastUsage?.used).toBe(1234);
    expect(topic.lastUsage?.size).toBe(200000);
  });

  it("renders agent thoughts as a markdown italic one-liner when showThoughts is on", async () => {
    const script: TurnScript[] = [
      [{ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "let me\nthink" } } }],
    ];
    const { topic, ui } = await makeTopic(script);
    await topic.handleUserPrompt([{ type: "text", text: "hi" }]);
    expect(allContent(ui.apis[0]!)).toContain("<i>let me think</i>");
  });

  it("omits thoughts when showThoughts is off", async () => {
    const script: TurnScript[] = [
      [{ update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret" } } }],
    ];
    const { topic, ui } = await makeTopic(script, { ...CFG, showThoughts: false });
    await topic.handleUserPrompt([{ type: "text", text: "hi" }]);
    expect(allContent(ui.apis[0] ?? new FakeApi())).not.toContain("secret");
  });

  it("dispose during an active turn stops the typing heartbeat and clears the queue", async () => {
    const script: TurnScript[] = [[{ sleepMs: 40 }], []];
    const { topic, ui, mock } = await makeTopic(script);

    const p = topic.handleUserPrompt([{ type: "text", text: "A" }]);
    topic.handleUserPrompt([{ type: "text", text: "queued" }]); // enqueued
    await new Promise((r) => setTimeout(r, 10));
    await topic.dispose();
    await p;
    const typingAfterDispose = ui.typingCount;
    await new Promise((r) => setTimeout(r, 30));

    // No further typing after dispose, and the queued prompt never ran.
    expect(ui.typingCount).toBe(typingAfterDispose);
    expect(mock.received).toHaveLength(1);
  });

  it("settles a permission request arriving after cancel() as cancelled without presenting it", async () => {
    const { topic, ui } = await makeTopic([]);

    await topic.cancel(); // no turn running; sets the cancelled-turn flag regardless

    const res = await topic.handlePermission(makeRequest());

    expect(res.outcome).toEqual({ outcome: "cancelled" });
    expect(ui.permissionPrompts).toHaveLength(0);
  });

  it("settles a permission request arriving after dispose() as cancelled without presenting it", async () => {
    const { topic, ui } = await makeTopic([]);

    await topic.dispose();

    const res = await topic.handlePermission(makeRequest());

    expect(res.outcome).toEqual({ outcome: "cancelled" });
    expect(ui.permissionPrompts).toHaveLength(0);
  });

  it("resumes presenting permissions normally once a new turn starts after a cancel", async () => {
    const script: TurnScript[] = [
      [
        { permission: { toolCallId: "t1", options: allowRejectOptions } },
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "unreached" } } },
      ],
      [{ permission: { toolCallId: "t2", options: allowRejectOptions } }],
    ];
    const { topic, ui, broker, mock } = await makeTopic(script);

    // Turn 1: cancel mid-flight.
    const p1 = topic.handleUserPrompt([{ type: "text", text: "go" }]);
    await vi.waitFor(() => expect(ui.permissionPrompts).toHaveLength(1));
    await topic.cancel();
    await p1;
    expect(mock.permissionOutcomes[0]?.outcome).toEqual({ outcome: "cancelled" });

    // A late permission racing the cancel is still short-circuited...
    const lateRes = await topic.handlePermission(makeRequest());
    expect(lateRes.outcome).toEqual({ outcome: "cancelled" });
    expect(ui.permissionPrompts).toHaveLength(1); // unchanged — not presented

    // ...but turn 2 is a fresh consent context: permissions ask normally again.
    const p2 = topic.handleUserPrompt([{ type: "text", text: "again" }]);
    await vi.waitFor(() => expect(ui.permissionPrompts).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 10));
    broker.resolve(ui.permissionPrompts[1]!.keyboard[0]![0]!.callback_data);
    await p2;

    expect(mock.permissionOutcomes[1]?.outcome).toEqual({ outcome: "selected", optionId: "allow" });
  });

  it("a throwing ui.typing() never kills the turn — draft finalizes and the prompt resolves", async () => {
    const script: TurnScript[] = [
      [{ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still works" } } }],
    ];
    const { topic, ui } = await makeTopic(script);
    ui.typingThrows = true;

    await topic.handleUserPrompt([{ type: "text", text: "hi" }]);

    expect(latest(ui.apis[0]!)).toContain("still works");
  });
});

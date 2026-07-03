import { describe, it, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { wireMockAgent, type TurnScript } from "./helpers/mock-agent.js";

describe("MockAgent fixture", () => {
  it("drives a full scripted turn over a raw ClientSideConnection", async () => {
    const collected: acp.SessionUpdate[] = [];

    const script: TurnScript[] = [
      [
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello " },
          },
        },
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "world" },
          },
        },
        {
          permission: {
            toolCallId: "tc_1",
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        },
        {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc_1",
            title: "Run tool",
            status: "completed",
          },
        },
      ],
    ];

    const { agent, clientStream } = wireMockAgent(script);

    const client: acp.Client = {
      sessionUpdate: (params) => {
        collected.push(params.update);
      },
      requestPermission: (params) => ({
        outcome: { outcome: "selected", optionId: params.options[0].optionId },
      }),
    };

    const conn = new acp.ClientSideConnection(() => client, clientStream);

    const init = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    expect(init.protocolVersion).toBe(1);
    expect(init.agentCapabilities?.loadSession).toBe(true);
    expect(init.agentCapabilities?.promptCapabilities).toEqual({
      image: true,
      embeddedContext: true,
    });

    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });
    expect(session.sessionId).toBe("sess_mock_1");
    expect(session.modes?.currentModeId).toBe("default");
    expect(session.modes?.availableModes.map((m) => m.id)).toEqual([
      "default",
      "plan",
      "acceptEdits",
    ]);
    expect(session.configOptions).toBeDefined();
    expect(session.configOptions?.[0]?.id).toBe("mode");

    const res = await conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "hi" }],
    });

    expect(res.stopReason).toBe("end_turn");
    expect(collected.map((u) => u.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "agent_message_chunk",
      "tool_call",
    ]);
    expect(agent.permissionOutcomes).toHaveLength(1);
    expect(agent.permissionOutcomes[0]?.outcome).toEqual({
      outcome: "selected",
      optionId: "allow",
    });
    expect(agent.received).toHaveLength(1);
    expect(agent.received[0]?.sessionId).toBe("sess_mock_1");
  });

  it("resolves an in-flight turn with 'cancelled' when cancel() arrives", async () => {
    const collected: acp.SessionUpdate[] = [];
    const script: TurnScript[] = [
      [
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first" } } },
        { sleepMs: 40 },
        { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second" } } },
      ],
    ];
    const { agent, clientStream } = wireMockAgent(script);
    const client: acp.Client = {
      sessionUpdate: (p) => { collected.push(p.update); },
      requestPermission: (p) => ({ outcome: { outcome: "selected", optionId: p.options[0].optionId } }),
    };
    const conn = new acp.ClientSideConnection(() => client, clientStream);
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    const promptPromise = conn.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "hi" }] });
    // Let the first update flush, then cancel while the turn sleeps.
    await new Promise((r) => setTimeout(r, 10));
    await conn.cancel({ sessionId: session.sessionId });

    const res = await promptPromise;
    expect(res.stopReason).toBe("cancelled");
    expect(agent.cancelled).toBe(true);
    // The update emitted before cancel still arrived; the post-sleep one did not.
    expect(collected.map((u) => u.sessionUpdate)).toEqual(["agent_message_chunk"]);
  });

  it("loadSession succeeds for the mock id and rejects unknown ids", async () => {
    const { clientStream } = wireMockAgent();
    const client: acp.Client = {
      sessionUpdate: () => {},
      requestPermission: (p) => ({ outcome: { outcome: "selected", optionId: p.options[0].optionId } }),
    };
    const conn = new acp.ClientSideConnection(() => client, clientStream);
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });

    const loaded = await conn.loadSession({ sessionId: "sess_mock_1", cwd: "/tmp", mcpServers: [] });
    expect(loaded.modes?.currentModeId).toBe("default");

    await expect(
      conn.loadSession({ sessionId: "nope", cwd: "/tmp", mcpServers: [] }),
    ).rejects.toMatchObject({ code: acp.RequestError.resourceNotFound().code });
  });

  it("setSessionMode / setSessionConfigOption record and emit updates", async () => {
    const collected: acp.SessionUpdate[] = [];
    const { clientStream } = wireMockAgent();
    const client: acp.Client = {
      sessionUpdate: (p) => { collected.push(p.update); },
      requestPermission: (p) => ({ outcome: { outcome: "selected", optionId: p.options[0].optionId } }),
    };
    const conn = new acp.ClientSideConnection(() => client, clientStream);
    await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
    const session = await conn.newSession({ cwd: "/tmp", mcpServers: [] });

    await conn.setSessionMode({ sessionId: session.sessionId, modeId: "plan" });
    const cfgRes = await conn.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "mode",
      value: "acceptEdits",
    });

    expect(cfgRes.configOptions[0]?.type).toBe("select");
    const selectOption = cfgRes.configOptions[0];
    if (selectOption?.type === "select") {
      expect(selectOption.currentValue).toBe("acceptEdits");
    }
    expect(collected.map((u) => u.sessionUpdate)).toEqual([
      "current_mode_update",
      "config_option_update",
    ]);
    const modeUpdate = collected[0];
    if (modeUpdate?.sessionUpdate === "current_mode_update") {
      expect(modeUpdate.currentModeId).toBe("plan");
    }
  });
});

import { describe, it, expect } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { wireMockAgent, type TurnScript } from "./helpers/mock-agent.js";
import { AgentSession } from "../src/acp/agent-session.js";

const noopPermission = async (
  r: acp.RequestPermissionRequest,
): Promise<acp.RequestPermissionResponse> => ({
  outcome: { outcome: "selected", optionId: r.options[0]!.optionId },
});

describe("AgentSession", () => {
  it("start → prompt streams updates and resolves end_turn", async () => {
    const { agent, clientStream } = wireMockAgent([
      [
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hi" },
          },
        },
        {
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [{ name: "review", description: "d" }],
          },
        },
      ],
    ]);
    const updates: acp.SessionUpdate[] = [];
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      onUpdate: (u) => updates.push(u),
      onPermission: noopPermission,
      onExit: () => {},
    });

    expect(s.sessionId).toBe("sess_mock_1");
    expect(s.loaded).toBe(false);
    expect(s.availableModes().map((m) => m.id)).toContain("plan");

    const res = await s.prompt([{ type: "text", text: "hello" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(updates).toHaveLength(2);
    expect(s.availableCommands[0]?.name).toBe("review");
    expect(agent.received).toHaveLength(1);

    await s.dispose();
  });

  it("setMode uses setSessionConfigOption (not setSessionMode) and updates currentModeId", async () => {
    const updates: acp.SessionUpdate[] = [];
    const { clientStream } = wireMockAgent();
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      onUpdate: (u) => updates.push(u),
      onPermission: noopPermission,
      onExit: () => {},
    });

    await s.setMode("plan");

    // The mock emits `config_option_update` for setSessionConfigOption and
    // `current_mode_update` for setSessionMode — asserting the former proves
    // the config-option path was taken.
    expect(updates.map((u) => u.sessionUpdate)).toEqual(["config_option_update"]);
    expect(s.currentModeId).toBe("plan");

    await s.dispose();
  });

  it("cancel mid-turn resolves the prompt with 'cancelled'", async () => {
    const { clientStream } = wireMockAgent([
      [
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "working" },
          },
        },
        { sleepMs: 200 },
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "never" },
          },
        },
      ],
    ]);
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      onUpdate: () => {},
      onPermission: noopPermission,
      onExit: () => {},
    });

    const p = s.prompt([{ type: "text", text: "go" }]);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.turnActive).toBe(true);
    await s.cancel();
    const res = await p;
    expect(res.stopReason).toBe("cancelled");
    expect(s.turnActive).toBe(false);

    await s.dispose();
  });

  it("loadSessionId matching the agent attaches with loaded=true", async () => {
    const { clientStream } = wireMockAgent();
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      loadSessionId: "sess_mock_1",
      onUpdate: () => {},
      onPermission: noopPermission,
      onExit: () => {},
    });

    expect(s.loaded).toBe(true);
    expect(s.sessionId).toBe("sess_mock_1");

    await s.dispose();
  });

  it("unknown loadSessionId falls back to a new session with loaded=false", async () => {
    const { clientStream } = wireMockAgent();
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      loadSessionId: "sess_other",
      onUpdate: () => {},
      onPermission: noopPermission,
      onExit: () => {},
    });

    expect(s.loaded).toBe(false);
    expect(s.sessionId).toBe("sess_mock_1");

    await s.dispose();
  });

  it("suppresses user/agent message chunks during session/load replay but forwards other updates", async () => {
    const { agent, clientStream } = wireMockAgent([
      [
        {
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "post-load reply" },
          },
        },
      ],
    ]);
    agent.loadReplay = [
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "old user msg" },
      },
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "old agent msg" },
      },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "d" }],
      },
    ];

    const updates: acp.SessionUpdate[] = [];
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      loadSessionId: "sess_mock_1",
      onUpdate: (u) => updates.push(u),
      onPermission: noopPermission,
      onExit: () => {},
    });

    expect(s.loaded).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.sessionUpdate).toBe("available_commands_update");
    expect(s.availableCommands[0]?.name).toBe("review");

    const res = await s.prompt([{ type: "text", text: "hello again" }]);
    expect(res.stopReason).toBe("end_turn");
    expect(updates).toHaveLength(2);
    expect(updates[1]?.sessionUpdate).toBe("agent_message_chunk");

    await s.dispose();
  });

  it("with onReplayChunk set, replay chunks route to the callback and NOT to onUpdate", async () => {
    const { agent, clientStream } = wireMockAgent();
    agent.loadReplay = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old user" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old agent" } },
      {
        sessionUpdate: "available_commands_update",
        availableCommands: [{ name: "review", description: "d" }],
      },
    ];

    const updates: acp.SessionUpdate[] = [];
    const replay: acp.SessionUpdate[] = [];
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      loadSessionId: "sess_mock_1",
      onUpdate: (u) => updates.push(u),
      onReplayChunk: (u) => replay.push(u),
      onPermission: noopPermission,
      onExit: () => {},
    });

    expect(s.loaded).toBe(true);
    // Chunks went to onReplayChunk, not onUpdate.
    expect(replay.map((u) => u.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
    // Non-chunk replay update still reaches onUpdate.
    expect(updates.map((u) => u.sessionUpdate)).toEqual(["available_commands_update"]);

    await s.dispose();
  });

  it("listSessions passes through to the agent's session/list", async () => {
    const { agent, clientStream } = wireMockAgent();
    agent.listSessionsResponse = [
      { sessionId: "s1", cwd: "/a", title: "One", updatedAt: "2026-01-01T00:00:00Z" },
      { sessionId: "s2", cwd: "/b", title: "Two", updatedAt: "2026-01-02T00:00:00Z" },
    ];
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      onUpdate: () => {},
      onPermission: noopPermission,
      onExit: () => {},
    });

    const res = await s.listSessions({});
    expect(res.sessions.map((x) => x.sessionId)).toEqual(["s1", "s2"]);

    await s.dispose();
  });

  it("routes permission requests through onPermission", async () => {
    const { agent, clientStream } = wireMockAgent([
      [
        {
          permission: {
            toolCallId: "tc_1",
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        },
      ],
    ]);
    const seen: acp.RequestPermissionRequest[] = [];
    const s = await AgentSession.start({
      cwd: "/tmp",
      stream: clientStream,
      onUpdate: () => {},
      onPermission: async (r) => {
        seen.push(r);
        return { outcome: { outcome: "selected", optionId: r.options[1]!.optionId } };
      },
      onExit: () => {},
    });

    await s.prompt([{ type: "text", text: "do it" }]);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.toolCall.toolCallId).toBe("tc_1");
    expect(agent.permissionOutcomes[0]?.outcome).toEqual({
      outcome: "selected",
      optionId: "reject",
    });

    await s.dispose();
  });
});

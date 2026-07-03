import * as acp from "@agentclientprotocol/sdk";

/**
 * A pair of cross-wired ACP {@link acp.Stream}s for in-process transport.
 *
 * Returns `[agentStream, clientStream]`: whatever the agent side writes is
 * readable by the client side and vice versa. Back the transport with two
 * {@link TransformStream}s and cross-wire their ends.
 */
export function streamPair(): [acp.Stream, acp.Stream] {
  const a = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const b = new TransformStream<acp.AnyMessage, acp.AnyMessage>();
  const agentStream: acp.Stream = { writable: a.writable, readable: b.readable };
  const clientStream: acp.Stream = { writable: b.writable, readable: a.readable };
  return [agentStream, clientStream];
}

/**
 * A scripted single prompt turn. Steps are consumed in order; the mock emits
 * every `update`, asks for every `permission` (recording the client's answer),
 * and pauses for each `sleepMs`. The mock checks for cancellation between steps.
 */
export type TurnScript = Array<
  | { update: acp.SessionUpdate }
  | { permission: { options: acp.PermissionOption[]; toolCallId: string } }
  | { sleepMs: number }
>;

const MOCK_SESSION_ID = "sess_mock_1";

const AVAILABLE_MODES: acp.SessionMode[] = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan" },
  { id: "acceptEdits", name: "Accept Edits" },
];

function buildConfigOptions(currentValue: string): acp.SessionConfigOption[] {
  return [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue,
      options: AVAILABLE_MODES.map((m) => ({ value: m.id, name: m.name })),
    },
  ];
}

/**
 * In-process mock ACP agent driven by a {@link TurnScript} per `prompt()` call.
 *
 * Wire it to a client with {@link wireMockAgent}. The mock records every prompt
 * payload, every permission outcome, and resolves each prompt with
 * {@link MockAgent.lastStopReason} (default `"end_turn"`), or `"cancelled"` if
 * {@link MockAgent.cancel} arrived while the turn was in flight.
 */
export class MockAgent implements acp.Agent {
  /** One entry per `prompt()` call, consumed (shifted) in order. */
  script: TurnScript[] = [];
  /** Every prompt payload received, in order. */
  received: acp.PromptRequest[] = [];
  /** Every permission answer the client returned, in order. */
  permissionOutcomes: acp.RequestPermissionResponse[] = [];
  /** What the next prompt resolves with when not cancelled. */
  lastStopReason: acp.StopReason = "end_turn";
  /** Set true when `cancel()` arrives; an active turn then resolves `"cancelled"`. */
  cancelled = false;
  /**
   * Updates replayed via `sessionUpdate` during a successful `loadSession`
   * call, before the response is returned. Lets tests exercise session/load
   * replay handling (e.g. chunk suppression) without a full prompt turn.
   */
  loadReplay: acp.SessionUpdate[] = [];
  /**
   * Sessions returned by `session/list`. Additive test hook (like
   * {@link loadReplay}) so bridge tests can script a `/sessions` listing.
   */
  listSessionsResponse: acp.SessionInfo[] = [];

  #currentModeId = "default";
  #conn: () => acp.AgentSideConnection;

  constructor(conn: () => acp.AgentSideConnection) {
    this.#conn = conn;
  }

  initialize(params: acp.InitializeRequest): acp.InitializeResponse {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        sessionCapabilities: { list: {} },
      },
    };
  }

  newSession(_params: acp.NewSessionRequest): acp.NewSessionResponse {
    return {
      sessionId: MOCK_SESSION_ID,
      modes: {
        currentModeId: this.#currentModeId,
        availableModes: AVAILABLE_MODES,
      },
      configOptions: buildConfigOptions(this.#currentModeId),
    };
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    if (params.sessionId !== MOCK_SESSION_ID) {
      throw acp.RequestError.resourceNotFound(params.sessionId);
    }
    const conn = this.#conn();
    for (const update of this.loadReplay) {
      await conn.sessionUpdate({ sessionId: params.sessionId, update });
    }
    return {
      modes: {
        currentModeId: this.#currentModeId,
        availableModes: AVAILABLE_MODES,
      },
      configOptions: buildConfigOptions(this.#currentModeId),
    };
  }

  authenticate(_params: acp.AuthenticateRequest): acp.AuthenticateResponse {
    return {};
  }

  listSessions(_params: acp.ListSessionsRequest): acp.ListSessionsResponse {
    return { sessions: this.listSessionsResponse };
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    this.#currentModeId = params.modeId;
    await this.#conn().sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
    });
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (typeof params.value === "string") {
      this.#currentModeId = params.value;
    }
    const configOptions = buildConfigOptions(this.#currentModeId);
    await this.#conn().sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "config_option_update", configOptions },
    });
    return { configOptions };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    this.received.push(params);
    // Each prompt() call starts a fresh turn: cancellation from a prior turn
    // must not leak into this one (a real agent process doesn't stay
    // "cancelled" forever once a turn concludes).
    this.cancelled = false;
    const conn = this.#conn();
    const turn = this.script.shift() ?? [];

    for (const step of turn) {
      if (this.cancelled) return { stopReason: "cancelled" };

      if ("update" in step) {
        await conn.sessionUpdate({ sessionId: params.sessionId, update: step.update });
      } else if ("permission" in step) {
        const outcome = await conn.requestPermission({
          sessionId: params.sessionId,
          toolCall: { toolCallId: step.permission.toolCallId },
          options: step.permission.options,
        });
        this.permissionOutcomes.push(outcome);
      } else {
        await new Promise((resolve) => setTimeout(resolve, step.sleepMs));
      }
    }

    if (this.cancelled) return { stopReason: "cancelled" };
    return { stopReason: this.lastStopReason };
  }

  cancel(_params: acp.CancelNotification): void {
    this.cancelled = true;
  }
}

/**
 * Construct a {@link MockAgent} wired to a fresh in-process transport.
 *
 * Returns the agent (for assertions / driving state) and the `clientStream`
 * to hand to a `ClientSideConnection`.
 */
export function wireMockAgent(script: TurnScript[] = []): {
  agent: MockAgent;
  clientStream: acp.Stream;
  /** The agent side of the transport; closing its writable ends the client's
   * connection (simulating the agent process dying). */
  agentStream: acp.Stream;
} {
  const [agentStream, clientStream] = streamPair();
  let agent!: MockAgent;
  // `toAgent` is invoked synchronously inside the AgentSideConnection ctor.
  new acp.AgentSideConnection((conn) => {
    agent = new MockAgent(() => conn);
    agent.script = script;
    return agent;
  }, agentStream);
  return { agent, clientStream, agentStream };
}

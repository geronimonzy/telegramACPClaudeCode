import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

/**
 * Options for {@link AgentSession.start}.
 *
 * Exactly one of {@link stream} (test injection) or {@link spawn} (production)
 * must be supplied.
 */
export interface AgentSessionOptions {
  cwd: string;
  onUpdate: (u: acp.SessionUpdate) => void;
  onPermission: (
    req: acp.RequestPermissionRequest,
  ) => Promise<acp.RequestPermissionResponse>;
  onExit: (info: { code: number | null }) => void; // fires once on subprocess/connection death
  spawn?: { command: string[]; env?: Record<string, string> }; // production path
  stream?: acp.Stream; // test injection path
  loadSessionId?: string; // if set, try session/load instead of session/new
  client?: Partial<acp.Client>; // extra handlers merged in (fs/terminal from Task 6)
  /**
   * When set, the `user_message_chunk` / `agent_message_chunk` updates that are
   * otherwise SUPPRESSED during `session/load` replay are routed here instead of
   * being dropped. Absent → exactly the restart-recovery behaviour (chunks
   * dropped). Non-chunk replay updates keep their normal `onUpdate` handling
   * either way. Used by `/sessions` attach to stream the full history transcript.
   */
  onReplayChunk?: (u: acp.SessionUpdate) => void;
}

const CLIENT_INFO: acp.Implementation = {
  name: "telegram-acp-bridge",
  version: "0.1.0",
};

const SIGKILL_GRACE_MS = 3000;

/**
 * Wraps a single `claude-agent-acp` connection (one per Telegram topic).
 *
 * Owns the ACP {@link acp.ClientSideConnection}, an optional child process,
 * and the cached session metadata (available commands, current mode, config
 * options). Every later task talks to the agent exclusively through this.
 */
export class AgentSession {
  availableCommands: acp.AvailableCommand[] = [];
  currentModeId: string | undefined;

  #sessionId!: string;
  #loaded = false;
  #conn!: acp.ClientSideConnection;
  #child?: ChildProcess;

  readonly #onUpdate: AgentSessionOptions["onUpdate"];
  readonly #onPermission: AgentSessionOptions["onPermission"];
  readonly #onExit: AgentSessionOptions["onExit"];
  readonly #onReplayChunk: AgentSessionOptions["onReplayChunk"];

  #modes?: acp.SessionModeState;
  #configOptions: acp.SessionConfigOption[] = [];

  #turnActive = false;
  #replaying = false;
  #exitFired = false;
  #disposed = false;

  private constructor(opts: AgentSessionOptions, child?: ChildProcess) {
    this.#onUpdate = opts.onUpdate;
    this.#onPermission = opts.onPermission;
    this.#onExit = opts.onExit;
    this.#onReplayChunk = opts.onReplayChunk;
    this.#child = child;
  }

  /** The ACP session id (from `session/new` or `session/load`). */
  get sessionId(): string {
    return this.#sessionId;
  }

  /** True if this session was attached via `session/load`. */
  get loaded(): boolean {
    return this.#loaded;
  }

  /** True while a `prompt()` turn is in flight. */
  get turnActive(): boolean {
    return this.#turnActive;
  }

  /**
   * Spawn/connect to an agent, initialize the protocol, and open a session
   * (new, or loaded when {@link AgentSessionOptions.loadSessionId} is set and
   * the agent advertises `loadSession`).
   */
  static async start(opts: AgentSessionOptions): Promise<AgentSession> {
    let child: ChildProcess | undefined;
    let stream: acp.Stream;

    if (opts.stream) {
      stream = opts.stream;
    } else if (opts.spawn) {
      const [command, ...args] = opts.spawn.command;
      if (!command) {
        throw new Error("AgentSession.start: spawn.command must not be empty");
      }
      child = spawn(command, args, {
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, ...opts.spawn.env },
      });
      stream = acp.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      );
    } else {
      throw new Error("AgentSession.start: either `stream` or `spawn` is required");
    }

    const session = new AgentSession(opts, child);

    const clientImpl: acp.Client = {
      sessionUpdate: (n: acp.SessionNotification) => {
        session.#ingest(n.update);
      },
      requestPermission: (r: acp.RequestPermissionRequest) =>
        session.#onPermission(r),
      ...opts.client,
    };

    const conn = new acp.ClientSideConnection(() => clientImpl, stream);
    session.#conn = conn;

    // Fire onExit once on whichever comes first: connection close or child exit.
    conn.closed.then(
      () => session.#fireExit(child?.exitCode ?? null),
      () => session.#fireExit(child?.exitCode ?? null),
    );
    child?.on("exit", (code) => session.#fireExit(code));

    const init = await conn.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: CLIENT_INFO,
    });

    let modes: acp.SessionModeState | null | undefined;
    let configOptions: acp.SessionConfigOption[] | null | undefined;

    if (opts.loadSessionId && init.agentCapabilities?.loadSession) {
      session.#replaying = true;
      try {
        const loaded = await conn.loadSession({
          sessionId: opts.loadSessionId,
          cwd: opts.cwd,
          mcpServers: [],
        });
        session.#sessionId = opts.loadSessionId;
        session.#loaded = true;
        modes = loaded.modes;
        configOptions = loaded.configOptions;
      } catch {
        // Session id no longer known to the agent — fall back to a fresh one.
      } finally {
        session.#replaying = false;
      }
    }

    if (!session.#loaded) {
      const created = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });
      session.#sessionId = created.sessionId;
      modes = created.modes;
      configOptions = created.configOptions;
    }

    session.#applyInitialState(modes, configOptions);
    return session;
  }

  /** Send a user prompt and resolve when the turn completes. */
  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse> {
    this.#turnActive = true;
    try {
      return await this.#conn.prompt({
        sessionId: this.#sessionId,
        prompt: blocks,
      });
    } finally {
      this.#turnActive = false;
    }
  }

  /** Cancel the in-flight turn (`session/cancel` notification). */
  async cancel(): Promise<void> {
    await this.#conn.cancel({ sessionId: this.#sessionId });
  }

  /**
   * List the agent's known sessions (`session/list`). Only meaningful when the
   * agent advertises the `sessionCapabilities.list` capability (Claude Code
   * does). A thin passthrough — the caller filters/paginates.
   */
  async listSessions(
    params: acp.ListSessionsRequest = {},
  ): Promise<acp.ListSessionsResponse> {
    return this.#conn.listSessions(params);
  }

  /**
   * Switch the agent's mode. Uses `session/set_config_option` when a config
   * option with category `"mode"` exists, otherwise `session/set_mode`.
   */
  async setMode(modeId: string): Promise<void> {
    const modeOption = this.#modeConfigOption();
    if (modeOption) {
      await this.#conn.setSessionConfigOption({
        sessionId: this.#sessionId,
        configId: modeOption.id,
        value: modeId,
      });
    } else {
      await this.#conn.setSessionMode({ sessionId: this.#sessionId, modeId });
    }
  }

  /**
   * The modes the agent can operate in. Prefers the config option with
   * category `"mode"`; falls back to the legacy `modes` state.
   */
  availableModes(): Array<{ id: string; name: string }> {
    const modeOption = this.#modeConfigOption();
    if (modeOption) {
      return flattenSelectOptions(modeOption.options).map((o) => ({
        id: o.value,
        name: o.name,
      }));
    }
    if (this.#modes) {
      return this.#modes.availableModes.map((m) => ({ id: m.id, name: m.name }));
    }
    return [];
  }

  /**
   * The selectable values of a select config option, addressed by category OR
   * id (`"model"`, `"effort"`/`"thought_level"`, …). Empty when the agent does
   * not advertise such an option.
   */
  availableConfigValues(key: string): Array<{ id: string; name: string }> {
    const opt = this.#selectConfigOption(key);
    if (!opt) return [];
    return flattenSelectOptions(opt.options).map((o) => ({ id: o.value, name: o.name }));
  }

  /** The current value of a select config option (by category or id). */
  currentConfigValue(key: string): string | undefined {
    return this.#selectConfigOption(key)?.currentValue;
  }

  /** Set a select config option (by category or id); throws when unknown. */
  async setConfigValue(key: string, value: string): Promise<void> {
    const opt = this.#selectConfigOption(key);
    if (!opt) throw new Error(`agent does not advertise a "${key}" config option`);
    await this.#conn.setSessionConfigOption({
      sessionId: this.#sessionId,
      configId: opt.id,
      value,
    });
  }

  /**
   * Terminate the subprocess (SIGTERM, then SIGKILL after a grace period) and
   * release resources. Safe when there is no subprocess (stream-injected mode).
   */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;

    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }, SIGKILL_GRACE_MS);
      timer.unref?.();

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }

  // --- internals ---------------------------------------------------------

  #ingest(update: acp.SessionUpdate): void {
    // Cache metadata regardless of replay suppression.
    switch (update.sessionUpdate) {
      case "available_commands_update":
        this.availableCommands = update.availableCommands;
        break;
      case "current_mode_update":
        this.currentModeId = update.currentModeId;
        break;
      case "config_option_update":
        this.#configOptions = update.configOptions;
        this.#syncModeFromConfig();
        break;
      default:
        break;
    }

    // During session/load replay, the historical message chunks are NOT sent to
    // onUpdate: on restart recovery they'd re-spam the Telegram topic. When an
    // onReplayChunk sink is provided (the /sessions attach flow), route them
    // there to build a transcript; otherwise drop them (restart-recovery path).
    if (
      this.#replaying &&
      (update.sessionUpdate === "user_message_chunk" ||
        update.sessionUpdate === "agent_message_chunk")
    ) {
      this.#onReplayChunk?.(update);
      return;
    }

    this.#onUpdate(update);
  }

  #applyInitialState(
    modes: acp.SessionModeState | null | undefined,
    configOptions: acp.SessionConfigOption[] | null | undefined,
  ): void {
    if (modes) {
      this.#modes = modes;
      this.currentModeId = modes.currentModeId;
    }
    if (configOptions) {
      this.#configOptions = configOptions;
    }
    // Config option (if present) is the authoritative source of the mode.
    this.#syncModeFromConfig();
  }

  #modeConfigOption():
    | (acp.SessionConfigOption & { type: "select" })
    | undefined {
    return this.#selectConfigOption("mode");
  }

  /** A select config option matched by category first, then by id. */
  #selectConfigOption(key: string): (acp.SessionConfigOption & { type: "select" }) | undefined {
    const opt =
      this.#configOptions.find((o) => o.category === key) ??
      this.#configOptions.find((o) => o.id === key);
    return opt && opt.type === "select" ? opt : undefined;
  }

  #syncModeFromConfig(): void {
    const modeOption = this.#modeConfigOption();
    if (modeOption) {
      this.currentModeId = modeOption.currentValue;
    }
  }

  #fireExit(code: number | null): void {
    if (this.#exitFired) return;
    this.#exitFired = true;
    this.#onExit({ code });
  }
}

/** Flatten a select option list, which may be flat options or grouped. */
function flattenSelectOptions(
  options: acp.SessionConfigSelectOptions,
): acp.SessionConfigSelectOption[] {
  const flat: acp.SessionConfigSelectOption[] = [];
  for (const entry of options) {
    if ("group" in entry) {
      flat.push(...entry.options);
    } else {
      flat.push(entry);
    }
  }
  return flat;
}

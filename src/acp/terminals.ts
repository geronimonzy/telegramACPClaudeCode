import { spawn, type ChildProcess } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";

interface TerminalEntry {
  child: ChildProcess;
  output: string;
  outputByteLimit?: number;
  truncated: boolean;
  exitStatus?: acp.TerminalExitStatus;
  exited: Promise<acp.TerminalExitStatus>;
}

/**
 * Owns every live `terminal/*` subprocess spawned on behalf of the agent for
 * a bridge process's lifetime; produces the corresponding slice of the ACP
 * `Client` implementation.
 */
export class TerminalRegistry {
  readonly #terminals = new Map<string, TerminalEntry>();
  #nextId = 1;

  handlers(): Pick<
    acp.Client,
    | "createTerminal"
    | "terminalOutput"
    | "waitForTerminalExit"
    | "killTerminal"
    | "releaseTerminal"
  > {
    return {
      createTerminal: (params) => this.#createTerminal(params),
      terminalOutput: (params) => this.#terminalOutput(params),
      waitForTerminalExit: (params) => this.#waitForTerminalExit(params),
      killTerminal: (params) => this.#killTerminal(params),
      releaseTerminal: (params) => this.#releaseTerminal(params),
    };
  }

  /** SIGKILL every still-running child (bridge shutdown). */
  disposeAll(): void {
    for (const entry of this.#terminals.values()) {
      if (entry.exitStatus === undefined) {
        killEntry(entry);
      }
    }
  }

  async #createTerminal(
    params: acp.CreateTerminalRequest,
  ): Promise<acp.CreateTerminalResponse> {
    const env = { ...process.env };
    for (const v of params.env ?? []) {
      env[v.name] = v.value;
    }

    const child = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? undefined,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // New process group (leader = this child) so killing the group also
      // reaches grandchildren (e.g. `sh -c "sleep 30"` forks `sleep`; a
      // SIGKILL to just the `sh` pid would otherwise orphan it).
      detached: true,
    });

    const terminalId = `term-${this.#nextId++}`;
    const entry: TerminalEntry = {
      child,
      output: "",
      outputByteLimit: params.outputByteLimit ?? undefined,
      truncated: false,
      exited: undefined as unknown as Promise<acp.TerminalExitStatus>,
    };

    const append = (chunk: Buffer) => {
      entry.output += chunk.toString("utf8");
      const limit = entry.outputByteLimit;
      if (limit != null && Buffer.byteLength(entry.output, "utf8") > limit) {
        entry.truncated = true;
        entry.output = trimToLastBytes(entry.output, limit);
      }
    };

    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    entry.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        const status: acp.TerminalExitStatus = {
          exitCode: code,
          signal: signal ?? null,
        };
        entry.exitStatus = status;
        resolve(status);
      });
    });

    this.#terminals.set(terminalId, entry);
    return { terminalId };
  }

  async #terminalOutput(
    params: acp.TerminalOutputRequest,
  ): Promise<acp.TerminalOutputResponse> {
    const entry = this.#requireEntry(params.terminalId);
    return {
      output: entry.output,
      truncated: entry.truncated,
      exitStatus: entry.exitStatus ?? null,
    };
  }

  async #waitForTerminalExit(
    params: acp.WaitForTerminalExitRequest,
  ): Promise<acp.WaitForTerminalExitResponse> {
    const entry = this.#requireEntry(params.terminalId);
    const status = await entry.exited;
    return { exitCode: status.exitCode, signal: status.signal };
  }

  async #killTerminal(
    params: acp.KillTerminalRequest,
  ): Promise<acp.KillTerminalResponse> {
    const entry = this.#requireEntry(params.terminalId);
    if (entry.exitStatus === undefined) {
      killEntry(entry);
    }
    return {};
  }

  async #releaseTerminal(
    params: acp.ReleaseTerminalRequest,
  ): Promise<acp.ReleaseTerminalResponse> {
    const entry = this.#requireEntry(params.terminalId);
    if (entry.exitStatus === undefined) {
      killEntry(entry);
    }
    this.#terminals.delete(params.terminalId);
    return {};
  }

  #requireEntry(terminalId: string): TerminalEntry {
    const entry = this.#terminals.get(terminalId);
    if (!entry) {
      throw acp.RequestError.invalidParams(
        `unknown terminal id: ${terminalId}`,
      );
    }
    return entry;
  }
}

/**
 * SIGKILL an entry's whole process group (it was spawned `detached: true`,
 * making it its own group leader), so shell-forked grandchildren die too.
 * Falls back to killing just the child if the group signal fails (e.g. the
 * process already reaped).
 */
function killEntry(entry: TerminalEntry): void {
  const pid = entry.child.pid;
  if (pid == null) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    entry.child.kill("SIGKILL");
  }
}

/** Keep only the last `limit` bytes of `s` (UTF-8), cut at a char boundary. */
function trimToLastBytes(s: string, limit: number): string {
  let result = s;
  while (Buffer.byteLength(result, "utf8") > limit) {
    result = result.slice(1);
  }
  return result;
}

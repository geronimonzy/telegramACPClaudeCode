import { describe, it, expect, afterEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { TerminalRegistry } from "../src/acp/terminals.js";

describe("TerminalRegistry", () => {
  let registry: TerminalRegistry;

  afterEach(() => {
    // Guarantee no zombie children survive past this test file.
    registry?.disposeAll();
  });

  it("captures interleaved stdout+stderr and reports exit status", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    const { terminalId } = await handlers.createTerminal!({
      sessionId: "s1",
      command: "sh",
      args: ["-c", "printf 'out'; printf 'err' 1>&2"],
    });

    await handlers.waitForTerminalExit!({ sessionId: "s1", terminalId });

    const output = await handlers.terminalOutput!({ sessionId: "s1", terminalId });
    expect(output.output).toContain("out");
    expect(output.output).toContain("err");
    expect(output.exitStatus).toEqual({ exitCode: 0, signal: null });
    expect(output.truncated).toBe(false);
  });

  it("truncates from the front once outputByteLimit is exceeded", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    // 10 bytes total: "0123456789"
    const { terminalId } = await handlers.createTerminal!({
      sessionId: "s1",
      command: "sh",
      args: ["-c", "printf '0123456789'"],
      outputByteLimit: 4,
    });

    await handlers.waitForTerminalExit!({ sessionId: "s1", terminalId });

    const output = await handlers.terminalOutput!({ sessionId: "s1", terminalId });
    expect(output.truncated).toBe(true);
    expect(output.output).toBe("6789");
  });

  it("killTerminal terminates the process with a signal; id stays queryable", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    const { terminalId } = await handlers.createTerminal!({
      sessionId: "s1",
      command: "sh",
      args: ["-c", "sleep 30"],
    });

    await handlers.killTerminal!({ sessionId: "s1", terminalId });
    const exit = await handlers.waitForTerminalExit!({ sessionId: "s1", terminalId });
    expect(exit.signal).toBeTruthy();

    // id still valid after kill
    const output = await handlers.terminalOutput!({ sessionId: "s1", terminalId });
    expect(output.exitStatus).toBeTruthy();
  });

  it("releaseTerminal kills a running process and invalidates the id", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    const { terminalId } = await handlers.createTerminal!({
      sessionId: "s1",
      command: "sh",
      args: ["-c", "sleep 30"],
    });

    await handlers.releaseTerminal!({ sessionId: "s1", terminalId });

    await expect(
      handlers.terminalOutput!({ sessionId: "s1", terminalId }),
    ).rejects.toBeInstanceOf(acp.RequestError);
  });

  it("rejects subsequent calls with an unknown terminal id", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    await expect(
      handlers.terminalOutput!({ sessionId: "s1", terminalId: "does-not-exist" }),
    ).rejects.toBeInstanceOf(acp.RequestError);
    await expect(
      handlers.killTerminal!({ sessionId: "s1", terminalId: "does-not-exist" }),
    ).rejects.toBeInstanceOf(acp.RequestError);
    await expect(
      handlers.waitForTerminalExit!({ sessionId: "s1", terminalId: "does-not-exist" }),
    ).rejects.toBeInstanceOf(acp.RequestError);
  });

  it("disposeAll kills every live child", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    const { terminalId } = await handlers.createTerminal!({
      sessionId: "s1",
      command: "sh",
      args: ["-c", "sleep 30"],
    });

    registry.disposeAll();

    const exit = await handlers.waitForTerminalExit!({ sessionId: "s1", terminalId });
    expect(exit.signal).toBeTruthy();
  });
});

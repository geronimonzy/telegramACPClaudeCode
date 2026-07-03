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

  it("truncates at a code-point boundary, never splitting an astral emoji", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    // "x\u{1F600}y" is 6 UTF-8 bytes: 'x' (1) + 😀 (4, a surrogate pair in
    // UTF-16) + 'y' (1). A limit of 4 forces trimming through the middle of
    // the emoji's surrogate pair if trimming is done one UTF-16 code unit at
    // a time instead of one code point at a time.
    const { terminalId } = await handlers.createTerminal!({
      sessionId: "s1",
      command: process.execPath,
      args: ["-e", "process.stdout.write('x\\u{1F600}y')"],
      outputByteLimit: 4,
    });

    await handlers.waitForTerminalExit!({ sessionId: "s1", terminalId });

    const output = await handlers.terminalOutput!({ sessionId: "s1", terminalId });
    expect(output.truncated).toBe(true);
    // No lone (unpaired) surrogates: every high surrogate must be
    // immediately followed by a low surrogate, and vice versa.
    expect(output.output).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(output.output).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // The emoji is either wholly present or wholly absent, never split.
    const emojiCount = (output.output.match(/\u{1F600}/gu) ?? []).length;
    expect(emojiCount === 0 || emojiCount === 1).toBe(true);
    if (emojiCount === 0) {
      expect(output.output).toBe("y");
    } else {
      expect(output.output).toBe("\u{1F600}y");
    }
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

  it("releaseForSession kills and removes only the named session's terminals", async () => {
    registry = new TerminalRegistry();
    const handlers = registry.handlers();

    const a = await handlers.createTerminal!({
      sessionId: "A",
      command: "sh",
      args: ["-c", "sleep 30"],
    });
    const b = await handlers.createTerminal!({
      sessionId: "B",
      command: "sh",
      args: ["-c", "sleep 30"],
    });

    registry.releaseForSession("A");

    // A's terminal is killed and its id invalidated…
    await expect(
      handlers.terminalOutput!({ sessionId: "A", terminalId: a.terminalId }),
    ).rejects.toBeInstanceOf(acp.RequestError);
    // …while B's is untouched and still running/queryable.
    const bOut = await handlers.terminalOutput!({ sessionId: "B", terminalId: b.terminalId });
    expect(bOut.exitStatus).toBeNull();
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

import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PermissionBroker, type PermissionPrompt } from "../src/telegram/permissions.js";

function makeRequest(overrides: Partial<acp.RequestPermissionRequest> = {}): acp.RequestPermissionRequest {
  return {
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "tc-1",
      title: "Run shell command",
      rawInput: { command: "rm -rf /tmp/x" },
    },
    options: [
      { optionId: "opt-allow", name: "Allow", kind: "allow_once" },
      { optionId: "opt-allow-always", name: "Always Allow", kind: "allow_always" },
      { optionId: "opt-reject", name: "Reject", kind: "reject_once" },
    ],
    ...overrides,
  };
}

/** Waits for pending microtasks + macrotasks to drain. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("PermissionBroker", () => {
  it("ask() presents a prompt with one row per option and perm: callback data", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 42);
    const req = makeRequest();

    const askPromise = broker.ask(7, req, present);
    await flush();

    expect(present).toHaveBeenCalledTimes(1);
    const prompt = present.mock.calls[0]![0];
    expect(prompt.html).toContain("Run shell command");
    expect(prompt.html).toContain("rm -rf /tmp/x");
    expect(prompt.keyboard).toHaveLength(3);
    expect(prompt.keyboard[0]).toHaveLength(1);
    expect(prompt.keyboard[0]![0]!.callback_data).toMatch(/^perm:\d+:0$/);
    expect(prompt.keyboard[1]![0]!.callback_data).toMatch(/^perm:\d+:1$/);
    expect(prompt.keyboard[2]![0]!.callback_data).toMatch(/^perm:\d+:2$/);

    // settle so the test doesn't leave a dangling unresolved promise
    broker.resolve(prompt.keyboard[0]![0]!.callback_data);
    await askPromise;
  });

  it("button label carries the kind emoji + truncated name", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 1);
    const req = makeRequest({
      options: [
        { optionId: "opt-a", name: "Allow", kind: "allow_once" },
        { optionId: "opt-b", name: "Always", kind: "allow_always" },
        { optionId: "opt-c", name: "Deny", kind: "reject_once" },
        { optionId: "opt-d", name: "Never", kind: "reject_always" },
      ],
    });

    const askPromise = broker.ask(1, req, present);
    await flush();
    const prompt = present.mock.calls[0]![0];
    expect(prompt.keyboard[0]![0]!.text).toBe("✅ Allow");
    expect(prompt.keyboard[1]![0]!.text).toBe("♻️ Always");
    expect(prompt.keyboard[2]![0]!.text).toBe("❌ Deny");
    expect(prompt.keyboard[3]![0]!.text).toBe("🚫 Never");

    broker.resolve(prompt.keyboard[0]![0]!.callback_data);
    await askPromise;
  });

  it("resolve() with the second button's data resolves ask() as selected with the real optionId, and returns threadId/messageId/label", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 42);
    const req = makeRequest();

    const askPromise = broker.ask(7, req, present);
    await flush();
    const prompt = present.mock.calls[0]![0];
    const secondData = prompt.keyboard[1]![0]!.callback_data;

    const result = broker.resolve(secondData);
    expect(result).toEqual({ threadId: 7, messageId: 42, label: "♻️ Always Allow" });

    const response = await askPromise;
    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "opt-allow-always" } });
  });

  it("unknown callback_data returns undefined", () => {
    const broker = new PermissionBroker();
    expect(broker.resolve("garbage")).toBeUndefined();
    expect(broker.resolve("perm:0:0")).toBeUndefined(); // no pending ask at all
    expect(broker.resolve("perm:abc:0")).toBeUndefined();
  });

  it("resolving twice: the second call returns undefined and does not re-settle", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 1);
    const req = makeRequest();

    const askPromise = broker.ask(1, req, present);
    await flush();
    const data = present.mock.calls[0]![0].keyboard[0]![0]!.callback_data;

    expect(broker.resolve(data)).toBeDefined();
    expect(broker.resolve(data)).toBeUndefined();

    await askPromise; // still settles exactly once, from the first resolve()
  });

  it("cancelThread settles all pending asks for that thread as cancelled, leaving other threads untouched", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 1);

    const askA1 = broker.ask(1, makeRequest(), present);
    const askA2 = broker.ask(1, makeRequest(), present);
    const askB1 = broker.ask(2, makeRequest(), present);
    await flush();

    broker.cancelThread(1);

    await expect(askA1).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(askA2).resolves.toEqual({ outcome: { outcome: "cancelled" } });

    // thread 2's ask must remain pending (not cancelled)
    const sentinel = Symbol("pending");
    const raced = await Promise.race([askB1, Promise.resolve(sentinel)]);
    expect(raced).toBe(sentinel);

    // clean up: settle it so nothing dangles past the test
    broker.cancelThread(2);
    await askB1;
  });

  it("truncate() is code-point aware and does not split a surrogate-pair emoji at the boundary", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 1);
    const emoji = "😀"; // U+1F600 — a surrogate pair in UTF-16
    // 31 plain chars + the emoji lands the emoji exactly as the 32nd code
    // point (OPTION_NAME_MAX_LEN); a naive UTF-16 .slice(0, 32) would instead
    // cut after 32 *code units*, splitting the emoji's surrogate pair.
    const name = "a".repeat(31) + emoji + "tail-that-gets-cut";
    const req = makeRequest({
      options: [{ optionId: "opt-emoji", name, kind: "allow_once" }],
    });

    const askPromise = broker.ask(1, req, present);
    await flush();
    const prompt = present.mock.calls[0]![0];
    const label = prompt.keyboard[0]![0]!.text;

    expect(label).toBe(`✅ ${"a".repeat(31)}${emoji}…`);
    // the emoji must survive intact, not as a lone (unpaired) surrogate
    expect(Array.from(label)).toContain(emoji);

    broker.resolve(prompt.keyboard[0]![0]!.callback_data);
    await askPromise;
  });

  it("regression: a tap arriving before present() resolves is not dropped (fast tap, slow send)", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(
      (_p: PermissionPrompt) => new Promise<number>((resolve) => setTimeout(() => resolve(42), 50)),
    );
    const req = makeRequest();

    const askPromise = broker.ask(7, req, present);
    // present() is invoked synchronously inside ask()'s Promise executor, so
    // its mock call (and thus the callback_data) is available immediately.
    const data = present.mock.calls[0]![0].keyboard[0]![0]!.callback_data;

    // tap arrives at 10ms, well before present() resolves at 50ms
    await new Promise((r) => setTimeout(r, 10));
    const result = broker.resolve(data);

    expect(result).toEqual({ threadId: 7, messageId: undefined, label: "✅ Allow" });

    const response = await askPromise;
    expect(response).toEqual({ outcome: { outcome: "selected", optionId: "opt-allow" } });

    // entry must have been removed by resolve(); a second tap is a no-op
    expect(broker.resolve(data)).toBeUndefined();

    // let present() actually resolve so nothing dangles past the test
    await new Promise((r) => setTimeout(r, 60));
  });

  it("regression: present() rejecting with no early tap rejects ask() and leaves no pending entry", async () => {
    const broker = new PermissionBroker();
    const err = new Error("telegram sendMessage failed");
    const present = vi.fn(async (_p: PermissionPrompt) => {
      throw err;
    });
    const req = makeRequest();

    const askPromise = broker.ask(3, req, present);
    const data = present.mock.calls[0]![0].keyboard[0]![0]!.callback_data;

    await expect(askPromise).rejects.toBe(err);

    // no leaked entry: resolving the (never-sent) prompt's callback_data is a no-op
    expect(broker.resolve(data)).toBeUndefined();
  });

  it("regression: present() rejecting after an early tap already settled ask() logs and swallows the error — the tap's outcome stands", async () => {
    const broker = new PermissionBroker();
    const err = new Error("telegram sendMessage failed (late)");
    let rejectPresent!: (e: unknown) => void;
    const present = vi.fn(
      (_p: PermissionPrompt) =>
        new Promise<number>((_resolve, reject) => {
          rejectPresent = reject;
        }),
    );
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const req = makeRequest();

    const askPromise = broker.ask(5, req, present);
    const data = present.mock.calls[0]![0].keyboard[0]![0]!.callback_data;

    // tap settles the ask well before present() ever settles
    const result = broker.resolve(data);
    expect(result).toEqual({ threadId: 5, messageId: undefined, label: "✅ Allow" });

    // ask() is already resolved with the tap's outcome, independent of present()
    await expect(askPromise).resolves.toEqual({ outcome: { outcome: "selected", optionId: "opt-allow" } });

    // present() rejects late: must not throw/reject anywhere, just get logged
    rejectPresent(err);
    await flush();

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy.mock.calls[0]).toContain(err);

    consoleErrorSpy.mockRestore();
  });

  it("falls back to an empty rawInput section when no known field is present", async () => {
    const broker = new PermissionBroker();
    const present = vi.fn(async (_p: PermissionPrompt) => 1);
    const req = makeRequest({
      toolCall: { toolCallId: "tc-2", title: "Do a thing", rawInput: { unrelated: 123 } },
    });

    const askPromise = broker.ask(1, req, present);
    await flush();
    const prompt = present.mock.calls[0]![0];
    expect(prompt.html).not.toContain("<code>");

    broker.resolve(prompt.keyboard[0]![0]!.callback_data);
    await askPromise;
  });
});

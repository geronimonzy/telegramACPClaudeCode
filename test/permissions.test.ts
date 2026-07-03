import { describe, it, expect, vi } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PermissionBroker, type PermissionPrompt } from "../src/telegram/permissions.js";
import { deferred } from "./helpers/fake-api.js";

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

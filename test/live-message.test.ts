import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveMessage } from "../src/telegram/live-message.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("LiveMessage", () => {
  it("first set sends immediately (leading edge)", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    lm.set("A");
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sends).toEqual(["A"]);
    expect(api.edits).toEqual([]);
    expect(lm.messageId).toBe(1);
  });

  it("two rapid sets → exactly one send then one trailing edit after intervalMs", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    lm.set("A");
    lm.set("B");
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(api.sends).toEqual(["A"]);
    expect(api.edits).toEqual([[1, "B"]]);
  });

  it("identical content produces no second edit", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    lm.set("A");
    await vi.advanceTimersByTimeAsync(0);
    lm.set("A"); // same content
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(api.sends).toEqual(["A"]);
    expect(api.edits).toEqual([]);
  });

  it("never runs two edits concurrently: in-flight edit + new set defers the next edit", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    lm.set("A");
    await vi.advanceTimersByTimeAsync(1); // deliver + settle initial send
    expect(api.sends).toEqual(["A"]);

    const gate = api.gate();
    lm.set("B"); // leading-edge edit, held in flight by the gate
    await vi.advanceTimersByTimeAsync(0);
    lm.set("C"); // arrives while the "B" edit is in flight
    await vi.advanceTimersByTimeAsync(INTERVAL); // gate still closed → no 2nd edit
    expect(api.edits).toEqual([[1, "B"]]);

    gate.resolve();
    await vi.advanceTimersByTimeAsync(INTERVAL); // now the trailing "C" edit fires
    expect(api.edits).toEqual([
      [1, "B"],
      [1, "C"],
    ]);
  });

  it("truncates content longer than 4000 chars with an ellipsis", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    lm.set("x".repeat(5000));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sends).toHaveLength(1);
    const sent = api.sends[0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent.endsWith("…")).toBe(true);
  });

  it("flushNow bypasses the debounce interval", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    lm.set("A");
    await vi.advanceTimersByTimeAsync(1);
    lm.set("B");
    await lm.flushNow(); // no timer advance
    expect(api.edits).toEqual([[1, "B"]]);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LiveMessage, truncateHtmlSafe } from "../src/telegram/live-message.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

// Same balance checker as test/html.test.ts: every open tag must nest and close.
function isBalanced(html: string): boolean {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const full = m[0];
    const name = m[1];
    if (full.startsWith("</")) {
      if (stack.pop() !== name) return false;
    } else if (!full.endsWith("/>")) {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

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

  it("tag-safe truncation keeps the header + newest rows and inserts an '… N earlier' indicator", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    // A header line plus many independently-balanced rows exceeding 4000 chars.
    const rows = Array.from(
      { length: 300 },
      (_, i) => `✅ 🔧 <b>tool call number ${i}</b>`,
    );
    const content = ["<b>Activity</b>", ...rows].join("\n");
    expect(content.length).toBeGreaterThan(4000);
    lm.set(content);
    await vi.advanceTimersByTimeAsync(0);

    expect(api.sends).toHaveLength(1);
    const sent = api.sends[0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent.startsWith("<b>Activity</b>\n")).toBe(true); // header kept
    expect(sent).toMatch(/<i>… \d+ earlier<\/i>/); // dropped-rows indicator
    expect(isBalanced(sent)).toBe(true); // Telegram would reject otherwise
    // Specifically: no dangling <b> (the live bug's failure mode).
    const opens = (sent.match(/<b>/g) ?? []).length;
    const closes = (sent.match(/<\/b>/g) ?? []).length;
    expect(opens).toBe(closes);
    // The newest rows survive; the oldest are dropped.
    expect(sent).toContain("tool call number 299");
    expect(sent).not.toContain("tool call number 0<");
  });

  it("truncateHtmlSafe closes a tag left open by a mid-line char cut", () => {
    const line = `✅ 🔧 <b>${"x".repeat(200)}</b>`;
    const out = truncateHtmlSafe(line, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith("</b>…")).toBe(true); // reopened <b> is closed before the …
    expect(isBalanced(out)).toBe(true);
  });

  it("a single over-long row is char-truncated safely, keeping balanced HTML", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    const content = `<b>Activity</b>\n✅ 🔧 <b>${"y".repeat(5000)}</b>`;
    lm.set(content);
    await vi.advanceTimersByTimeAsync(0);
    const sent = api.sends[0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(isBalanced(sent)).toBe(true);
    expect(sent.startsWith("<b>Activity</b>\n")).toBe(true);
    expect(sent.endsWith("…")).toBe(true);
  });

  it("leaves already-short content untouched", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    const content = "<b>Activity</b>\n✅ 🔧 <b>one</b>";
    lm.set(content);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.sends).toEqual([content]);
  });

  // Regression: activity.ts emits a diff row as `<b>title</b>\n<pre>{multi-line
  // diff}</pre>` — the <pre> body contains RAW newlines. The old truncate()
  // split on every "\n" as if each physical line were an independently
  // balanced unit, so it could keep the tail "...</pre>" while dropping the
  // "<pre>" opener that preceded it → orphan </pre> → Telegram 400. Truncation
  // must operate on logical (tag-balanced) lines instead.
  it("truncates multi-line <pre> diff rows on logical lines, keeping HTML balanced", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    const rows = Array.from(
      { length: 60 },
      (_, i) =>
        `✅ ✏️ <b>edit foo ${i}</b>\n<pre>@@ -1 +1 @@\n-old line ${i}\n+new line ${i}</pre>`,
    );
    const content = ["<b>Activity</b>", ...rows].join("\n");
    expect(content.length).toBeGreaterThan(4000);
    lm.set(content);
    await vi.advanceTimersByTimeAsync(0);

    expect(api.sends).toHaveLength(1);
    const sent = api.sends[0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(sent.startsWith("<b>Activity</b>\n")).toBe(true); // header kept
    expect(sent).toMatch(/<i>… \d+ earlier<\/i>/); // dropped-rows indicator
    expect(isBalanced(sent)).toBe(true); // Telegram would reject otherwise

    const preOpens = (sent.match(/<pre>/g) ?? []).length;
    const preCloses = (sent.match(/<\/pre>/g) ?? []).length;
    expect(preOpens).toBe(preCloses); // no orphan </pre> from the old bug

    const bOpens = (sent.match(/<b>/g) ?? []).length;
    const bCloses = (sent.match(/<\/b>/g) ?? []).length;
    expect(bOpens).toBe(bCloses);

    expect(sent).toContain("edit foo 59"); // newest row survives
  });

  it("a single <pre> diff row alone exceeding the budget is closed safely by truncateHtmlSafe", async () => {
    const api = new FakeApi();
    const lm = new LiveMessage(api, INTERVAL);
    const diffLines = Array.from(
      { length: 300 },
      (_, i) => `-old line ${i}\n+new line ${i}`,
    ).join("\n");
    const content = `<b>Activity</b>\n✅ ✏️ <b>edit foo</b>\n<pre>${diffLines}</pre>`;
    expect(content.length).toBeGreaterThan(4000);
    lm.set(content);
    await vi.advanceTimersByTimeAsync(0);

    expect(api.sends).toHaveLength(1);
    const sent = api.sends[0];
    expect(sent.length).toBeLessThanOrEqual(4000);
    expect(isBalanced(sent)).toBe(true);
    expect(sent.startsWith("<b>Activity</b>\n")).toBe(true);
    expect(sent.endsWith("…")).toBe(true);
    const preOpens = (sent.match(/<pre>/g) ?? []).length;
    const preCloses = (sent.match(/<\/pre>/g) ?? []).length;
    expect(preOpens).toBe(preCloses);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MessageDraft, splitForRollover, chooseCut } from "../src/telegram/draft.js";
import { escapeHtml, mdToTelegramHtml } from "../src/html.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("MessageDraft", () => {
  it("accumulates chunks into a single progressively-edited message", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL });
    d.append("Hello ");
    await vi.advanceTimersByTimeAsync(0); // leading send
    d.append("world");
    await vi.advanceTimersByTimeAsync(INTERVAL); // trailing edit
    await d.finalize();
    expect(api.sends).toEqual(["Hello "]);
    expect(api.edits.at(-1)).toEqual([1, "Hello world"]);
  });

  it("rolls a 9000-char input over into exactly 3 messages, none over 4000 rendered", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL });
    // 100 lines * (89 chars + newline) = 9000 chars, plain text renders ~1:1.
    const line = "a".repeat(89);
    const text = Array.from({ length: 100 }, () => line).join("\n");
    expect(text.length).toBe(100 * 89 + 99); // 8999
    d.append(text);
    await d.finalize();
    expect(api.sends).toHaveLength(3);
    expect(api.edits).toEqual([]); // each rollover target is a fresh send
    for (const html of api.sends) {
      expect(html.length).toBeLessThanOrEqual(4000);
    }
  });

  it("closes and re-opens a code fence that spans a rollover boundary", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL, maxLen: 80 });
    const code = Array.from({ length: 12 }, (_, i) => `fn${i}();`).join("\n");
    d.append("```ts\n" + code + "\n```");
    await d.finalize();
    expect(api.sends.length).toBeGreaterThanOrEqual(2);
    // First (finalized) message: a complete, closed <pre> block.
    expect(api.sends[0].endsWith("</code></pre>")).toBe(true);
    // Second message: the fence was re-opened with the same ts language.
    expect(api.sends[1].startsWith('<pre><code class="language-ts">')).toBe(true);
    // Nothing rendered over the limit.
    for (const html of api.sends) expect(html.length).toBeLessThanOrEqual(80);
  });

  it("finalize flushes a pending trailing remainder immediately (no timer advance)", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL });
    d.append("a");
    await vi.advanceTimersByTimeAsync(0); // leading send("a")
    d.append("b"); // arms a trailing edit INTERVAL away
    await d.finalize(); // must flush "ab" now, without advancing the timer
    expect(api.edits.at(-1)).toEqual([1, "ab"]);
  });

  it("finalize is idempotent", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL });
    d.append("hello");
    await d.finalize();
    const before = api.sends.length + api.edits.length;
    await d.finalize();
    expect(api.sends.length + api.edits.length).toBe(before);
  });

  it("on a 400 parse error, retries once with escaped plain text", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL });
    const raw = "a < b **x**";
    const rendered = "a &lt; b <b>x</b>";
    api.failOnce(rendered, 400);
    d.append(raw);
    await d.finalize();
    expect(api.sends).toEqual([rendered, escapeHtml(raw)]);
    expect(api.sends[1]).toBe("a &lt; b **x**");
  });

  it("splitForRollover on a trailing-newline overflow yields an empty remainder", () => {
    // Regression fixture for the empty-remainder spurious-send bug: the cut
    // lands on the buffer's trailing newline, so there is nothing left over.
    const { prefix, remainder } = splitForRollover("a<>&*e*<>&```ts\n", 40);
    expect(remainder).toBe("");
    expect(prefix.length).toBeGreaterThan(0);
  });

  it("never sends an empty string and never starts a new message when the rollover remainder is empty", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL, maxLen: 40 });
    d.append("a<>&*e*<>&```ts\n");
    await d.finalize();
    // Exactly one message: no retarget happened because remainder was empty.
    expect(api.sends).toHaveLength(1);
    expect(api.edits).toEqual([]);
    for (const html of [...api.sends, ...api.edits.map(([, h]) => h)]) {
      expect(html).not.toBe("");
    }
  });

  it("a normal rollover (non-empty remainder) still starts a fresh message", async () => {
    const api = new FakeApi();
    const d = new MessageDraft(api, { intervalMs: INTERVAL, maxLen: 80 });
    const code = Array.from({ length: 12 }, (_, i) => `fn${i}();`).join("\n");
    d.append("```ts\n" + code + "\n```");
    await d.finalize();
    expect(api.sends.length).toBeGreaterThanOrEqual(2);
    for (const html of api.sends) {
      expect(html).not.toBe("");
      expect(html.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("splitForRollover cut selection", () => {
  it("prefers a paragraph separator over a later mid-paragraph line break", () => {
    const para1 = "A".repeat(60);
    const para2 = Array.from({ length: 20 }, () => "xxxx").join("\n");
    const buffer = para1 + "\n\n" + para2;
    const { prefix, remainder } = splitForRollover(buffer, 100);
    expect(prefix).toContain(para1);
    expect(prefix).not.toContain("xxxx"); // did not spill into para2
    expect(remainder.startsWith("xxxx")).toBe(true); // remainder begins at para2
  });

  it("falls back to a line break when no in-range paragraph separator exists", () => {
    const buffer = Array.from({ length: 50 }, () => "word").join("\n");
    const cut = chooseCut(buffer, buffer.length, 100);
    expect(buffer[cut]).toBe("\n"); // a clean line boundary, not a hard char cut
    const { remainder } = splitForRollover(buffer, 100);
    expect(remainder.startsWith("word")).toBe(true);
  });

  it("keeps a straddling table whole: prefix ends before it, remainder starts with the full table", () => {
    const head = "H".repeat(70);
    const rows = [
      "| aaaa | bbbb |",
      "| ---- | ---- |",
      "| 1111 | 2222 |",
      "| 3333 | 4444 |",
      "| 5555 | 6666 |",
      "| 7777 | 8888 |",
    ];
    const buffer = head + "\n" + rows.join("\n") + "\ntrailing";
    const { prefix, remainder } = splitForRollover(buffer, 120);
    expect(prefix).toBe(head); // whole table rolled over, none of it in the prefix
    expect(remainder.startsWith("| aaaa | bbbb |")).toBe(true);
    for (const r of rows) expect(remainder).toContain(r);
  });

  it("splits a table larger than maxLen at a row boundary, never mid-row", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| r${i}a | r${i}b |`);
    const buffer = rows.join("\n");
    const { prefix, remainder } = splitForRollover(buffer, 80);
    // Prefix ends on a complete row; remainder resumes on a complete row.
    const lastPrefixLine = prefix.split("\n").at(-1)!;
    expect(/^\| r\d+a \| r\d+b \|$/.test(lastPrefixLine)).toBe(true);
    expect(remainder.startsWith("| r")).toBe(true);
    expect(remainder.split("\n")[0]).toMatch(/^\| r\d+a \| r\d+b \|$/);
  });

  it("splits a long list between items (remainder begins at a list marker)", () => {
    const buffer = Array.from({ length: 40 }, (_, i) => `- item number ${i}`).join("\n");
    const { prefix, remainder } = splitForRollover(buffer, 120);
    expect(remainder.startsWith("- item number ")).toBe(true);
    for (const line of prefix.split("\n")) {
      expect(line.startsWith("- item number ")).toBe(true); // no partial item
    }
  });

  it("re-opens a code fence across the new cut logic", () => {
    const code = Array.from({ length: 12 }, (_, i) => `fn${i}();`).join("\n");
    const buffer = "```ts\n" + code + "\n```";
    const { prefix, remainder } = splitForRollover(buffer, 80);
    expect(prefix.endsWith("\n```")).toBe(true); // fence closed in prefix
    expect(remainder.startsWith("```ts\n")).toBe(true); // and re-opened
    expect(mdToTelegramHtml(prefix).length).toBeLessThanOrEqual(80);
  });

  it("hard-cuts a single line longer than maxLen", () => {
    const buffer = "Z".repeat(500);
    const { prefix, remainder } = splitForRollover(buffer, 100);
    expect(prefix.length).toBeGreaterThan(0);
    expect(remainder.length).toBeGreaterThan(0);
    expect(prefix + remainder).toBe(buffer); // hard cut loses nothing
    expect(mdToTelegramHtml(prefix).length).toBeLessThanOrEqual(100);
  });
});

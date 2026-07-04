import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsageStats, fmtTokens, renderUsageRich } from "../src/usage.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "usage-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOW = new Date("2026-07-04T12:00:00.000Z");

function entry(opts: {
  id: string;
  model?: string;
  ts: string;
  input?: number;
  output?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: opts.ts,
    message: {
      id: opts.id,
      model: opts.model ?? "claude-opus-4-8",
      usage: {
        input_tokens: opts.input ?? 100,
        output_tokens: opts.output ?? 10,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    },
  });
}

describe("collectUsageStats", () => {
  it("dedupes streaming entries by message.id and buckets today vs week", async () => {
    const proj = join(dir, "-home-x-proj");
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, "s1.jsonl"),
      [
        // three streamed entries of the SAME message → counted once
        entry({ id: "m1", ts: "2026-07-04T10:00:00.000Z", input: 100, output: 10 }),
        entry({ id: "m1", ts: "2026-07-04T10:00:00.000Z", input: 100, output: 10 }),
        entry({ id: "m1", ts: "2026-07-04T10:00:00.000Z", input: 100, output: 10 }),
        // earlier this week, different model
        entry({ id: "m2", ts: "2026-07-01T10:00:00.000Z", model: "claude-sonnet-5", output: 50 }),
        // older than 7 days by timestamp → excluded
        entry({ id: "m3", ts: "2026-06-20T10:00:00.000Z", output: 999 }),
        // non-assistant noise
        JSON.stringify({ type: "user", message: { content: "hi" } }),
        "{broken",
      ].join("\n"),
    );

    const stats = await collectUsageStats(dir, NOW);
    const opusToday = stats.today.get("claude-opus-4-8")!;
    expect(opusToday.messages).toBe(1); // deduped
    expect(opusToday.input).toBe(100);
    expect(opusToday.output).toBe(10);
    expect(stats.today.get("claude-sonnet-5")).toBeUndefined();
    expect(stats.week.get("claude-sonnet-5")!.output).toBe(50);
    // m3 excluded from both windows
    const weekOpus = stats.week.get("claude-opus-4-8")!;
    expect(weekOpus.output).toBe(10);
    expect(stats.sessionsToday).toBe(1);
    expect(stats.sessionsWeek).toBe(1);
  });

  it("returns empty stats when the projects dir does not exist", async () => {
    const stats = await collectUsageStats(join(dir, "nope"), NOW);
    expect(stats.week.size).toBe(0);
    expect(stats.sessionsWeek).toBe(0);
  });
});

describe("fmtTokens", () => {
  it("formats k/M with exact small numbers", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(12345)).toBe("12.3k");
    expect(fmtTokens(1234567)).toBe("1.2M");
  });
});

describe("renderUsageRich", () => {
  const isBalanced = (html: string): boolean => {
    const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
    const stack: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html))) {
      if (m[0].startsWith("</")) {
        if (stack.pop() !== m[1]) return false;
      } else if (!m[0].endsWith("/>") && !["br", "hr"].includes(m[1]!)) {
        stack.push(m[1]!);
      }
    }
    return stack.length === 0;
  };

  it("renders tables for both windows and a live-sessions list, balanced", async () => {
    const proj = join(dir, "-p");
    await mkdir(proj, { recursive: true });
    await writeFile(join(proj, "s.jsonl"), entry({ id: "m1", ts: "2026-07-04T10:00:00.000Z" }));
    const stats = await collectUsageStats(dir, NOW);
    const html = renderUsageRich(
      stats,
      [
        { title: "bridge-work", used: 63000, size: 200000 },
        { title: "no-usage-yet" },
      ],
      NOW,
    );
    expect(html).toContain("<h3>📊 Claude usage</h3>");
    expect(html).toContain("<table>");
    expect(html).toContain("opus-4-8"); // claude- prefix stripped
    expect(html).toContain("63.0k/200.0k");
    expect(html).toContain("context unknown");
    expect(isBalanced(html)).toBe(true);
  });

  it("renders 'no usage' for empty windows", () => {
    const html = renderUsageRich(
      { today: new Map(), week: new Map(), sessionsToday: 0, sessionsWeek: 0 },
      [],
      NOW,
    );
    expect(html).toContain("no usage");
    expect(isBalanced(html)).toBe(true);
  });
});

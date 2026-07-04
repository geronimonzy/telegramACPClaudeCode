import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectUsageStats, fmtTokens, lastContextUsed, renderUsageRich } from "../src/usage.js";

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

describe("lastContextUsed", () => {
  it("returns input+cache tokens of the LAST assistant entry, skipping sidechains", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(
      f,
      [
        entry({ id: "m1", ts: "2026-07-04T09:00:00.000Z", input: 1000 }),
        // sidechain traffic after it must not win
        JSON.stringify({
          type: "assistant",
          isSidechain: true,
          timestamp: "2026-07-04T11:00:00.000Z",
          message: { id: "side", usage: { input_tokens: 999999 } },
        }),
        entry({ id: "m2", ts: "2026-07-04T10:00:00.000Z", input: 60000 }),
      ].join("\n"),
    );
    // m2: 60000 input + 5 cacheRead + 2 cacheWrite (entry() defaults)
    expect(await lastContextUsed(f)).toBe(60007);
  });

  it("returns undefined for a file with no usable usage", async () => {
    const f = join(dir, "empty.jsonl");
    await writeFile(f, JSON.stringify({ type: "user", message: { content: "hi" } }));
    expect(await lastContextUsed(f)).toBeUndefined();
  });

  it("throws for a missing file", async () => {
    await expect(lastContextUsed(join(dir, "nope.jsonl"))).rejects.toBeTruthy();
  });
});

describe("fmtTokens", () => {
  it("formats k/M with exact small numbers", () => {
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(12345)).toBe("12.3k");
    expect(fmtTokens(1234567)).toBe("1.2M");
  });

  it("drops the decimal from three-digit mantissas (table width)", () => {
    expect(fmtTokens(460_900_000)).toBe("461M");
    expect(fmtTokens(123_400)).toBe("123k");
    expect(fmtTokens(99_940)).toBe("99.9k");
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
        { title: "bridge-work", connected: true, used: 63000, size: 200000 },
        { title: "asleep-one", connected: false, fileUsed: 112000 },
        { title: "no-usage-yet", connected: false },
      ],
      NOW,
    );
    expect(html).toContain("<h3>📊 Claude usage</h3>");
    expect(html).toContain("<table>");
    // 3 columns: model | in/out | msgs (wider layouts overflowed on phones).
    expect(html).toContain("<tr><th>model</th><th>in/out</th><th>msgs</th></tr>");
    expect(html).toContain("opus-4-8"); // claude- prefix stripped
    expect(html).toContain("<td>100/10</td>"); // merged in/out cell
    expect(html).toContain("🟢 <b>bridge-work</b> — 63.0k/200k");
    expect(html).toContain("🔌 <b>asleep-one</b> — ~112k ctx"); // recovered from file
    expect(html).toContain("🔌 <b>no-usage-yet</b> — –");
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readNewTurns, readSessionTurns, sessionFilePath } from "../src/acp/session-file.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "session-file-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const L = (o: unknown): string => JSON.stringify(o);

/** A fixture mirroring the observed Claude Code session JSONL structure. */
function fixtureLines(): string[] {
  return [
    // metadata noise interleaved through the file
    L({ type: "last-prompt" }),
    L({ type: "mode" }),
    L({ type: "attachment", isSidechain: false }),
    L({ type: "file-history-snapshot" }),
    // turn 1: plain-string user message
    L({ type: "user", isSidechain: false, message: { role: "user", content: "first question" } }),
    L({ type: "ai-title" }),
    // assistant: thinking + text + tool_use blocks (only text is prose)
    L({
      type: "assistant",
      isSidechain: false,
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "Read", input: {} },
        ],
      },
    }),
    // tool_result carrier: no prose
    L({
      type: "user",
      isSidechain: false,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "…" }] },
    }),
    // consecutive assistant text → merges into the SAME agent turn
    L({
      type: "assistant",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "found it; here is the answer" }] },
    }),
    // sidechain (subagent) traffic → skipped
    L({
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "SIDECHAIN NOISE" }] },
    }),
    // meta user message (session-naming system-reminder) → skipped
    L({
      type: "user",
      isMeta: true,
      message: { role: "user", content: '<system-reminder> The user named this session "X".' },
    }),
    // an unparseable line → skipped without failing the file
    "{not json",
    // turn 2
    L({ type: "user", isSidechain: false, message: { role: "user", content: "second question" } }),
    L({
      type: "assistant",
      isSidechain: false,
      message: { role: "assistant", content: [{ type: "text", text: "second answer" }] },
    }),
  ];
}

describe("readSessionTurns", () => {
  it("extracts prose turns in order; a tool burst between them prevents the merge", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(f, fixtureLines().join("\n"));
    const turns = await readSessionTurns(f);
    // "let me check" and "found it; here is the answer" no longer merge:
    // the tool_use burst between them is real chronology, not noise.
    expect(turns).toEqual([
      { role: "user", text: "first question" },
      { role: "agent", text: "let me check" },
      { role: "tools", calls: [{ title: "Read", failed: false }] },
      { role: "agent", text: "found it; here is the answer" },
      { role: "user", text: "second question" },
      { role: "agent", text: "second answer" },
    ]);
  });

  it("drops harness wrapper texts even inside real messages", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(
      f,
      [
        L({
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>injected</system-reminder>" },
              { type: "text", text: "real question" },
            ],
          },
        }),
      ].join("\n"),
    );
    const turns = await readSessionTurns(f);
    expect(turns).toEqual([{ role: "user", text: "real question" }]);
  });

  it("throws when the file does not exist (caller falls back to replay)", async () => {
    await expect(readSessionTurns(join(dir, "missing.jsonl"))).rejects.toBeTruthy();
  });
});

describe("readSessionTurns — tool-call bursts", () => {
  const assistantToolUse = (
    calls: Array<{ id: string; name: string; input?: unknown }>,
    opts: { isSidechain?: boolean } = {},
  ): string =>
    L({
      type: "assistant",
      ...(opts.isSidechain !== undefined ? { isSidechain: opts.isSidechain } : {}),
      message: {
        role: "assistant",
        content: calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.input ?? {} })),
      },
    });
  const userToolResult = (
    results: Array<{ tool_use_id: string; is_error?: boolean }>,
    opts: { isMeta?: boolean } = {},
  ): string =>
    L({
      type: "user",
      ...(opts.isMeta !== undefined ? { isMeta: opts.isMeta } : {}),
      message: {
        role: "user",
        content: results.map((r) => ({ type: "tool_result", tool_use_id: r.tool_use_id, is_error: r.is_error })),
      },
    });
  const assistantText = (text: string): string =>
    L({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

  it("folds consecutive tool_use blocks across multiple entries into ONE burst", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(
      f,
      [
        assistantToolUse([{ id: "a", name: "Read", input: { file_path: "/x.ts" } }]),
        userToolResult([{ tool_use_id: "a" }]), // ok, no is_error
        assistantToolUse([{ id: "b", name: "Bash", input: { command: "ls -la /tmp" } }]),
        userToolResult([{ tool_use_id: "b", is_error: true }]),
        assistantText("done"),
      ].join("\n"),
    );
    const turns = await readSessionTurns(f);
    expect(turns).toEqual([
      {
        role: "tools",
        calls: [
          { title: "Read: /x.ts", failed: false },
          { title: "Bash: ls -la /tmp", failed: true },
        ],
      },
      { role: "agent", text: "done" },
    ]);
  });

  it("derives titles from the first present input hint, collapsing whitespace and truncating", async () => {
    const f = join(dir, "s.jsonl");
    const longCmd = "x".repeat(80);
    await writeFile(
      f,
      [
        assistantToolUse([
          { id: "1", name: "Read", input: { file_path: "/a.ts", path: "/should-not-win" } },
          { id: "2", name: "Grep", input: { pattern: "foo" } },
          { id: "3", name: "Task", input: { description: "explore  the\ncodebase" } },
          { id: "4", name: "WebFetch", input: { url: "https://example.com" } },
          { id: "5", name: "Glob", input: {} }, // no hint → name only
          { id: "6", name: "Bash", input: { command: longCmd } },
        ]),
      ].join("\n"),
    );
    const turns = await readSessionTurns(f);
    expect(turns).toEqual([
      {
        role: "tools",
        calls: [
          { title: "Read: /a.ts", failed: false },
          { title: "Grep: foo", failed: false },
          { title: "Task: explore the codebase", failed: false },
          { title: "WebFetch: https://example.com", failed: false },
          { title: "Glob", failed: false },
          { title: `Bash: ${longCmd.slice(0, 60)}…`, failed: false },
        ],
      },
    ]);
  });

  it("marks a call failed only when its tool_result carries is_error; unmatched ids are ignored", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(
      f,
      [
        assistantToolUse([
          { id: "ok", name: "Read", input: { file_path: "/a" } },
          { id: "bad", name: "Read", input: { file_path: "/b" } },
        ]),
        userToolResult([
          { tool_use_id: "bad", is_error: true },
          { tool_use_id: "unknown-id", is_error: true }, // no matching tool_use — silently ignored
        ]),
      ].join("\n"),
    );
    const turns = await readSessionTurns(f);
    expect(turns).toEqual([
      {
        role: "tools",
        calls: [
          { title: "Read: /a", failed: false },
          { title: "Read: /b", failed: true },
        ],
      },
    ]);
  });

  it("skips tool activity from sidechain/meta entries", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(
      f,
      [
        assistantToolUse([{ id: "s1", name: "Read", input: { file_path: "/hidden" } }], {
          isSidechain: true,
        }),
        userToolResult([{ tool_use_id: "s1", is_error: true }], { isMeta: true }),
        assistantText("visible answer"),
      ].join("\n"),
    );
    const turns = await readSessionTurns(f);
    expect(turns).toEqual([{ role: "agent", text: "visible answer" }]);
  });
});

describe("readNewTurns", () => {
  const userLine = (text: string, entrypoint = "cli"): string =>
    L({ type: "user", entrypoint, message: { role: "user", content: text } });
  const agentLine = (text: string, entrypoint = "cli"): string =>
    L({
      type: "assistant",
      entrypoint,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });

  it("reads only past the offset and filters excluded entrypoints", async () => {
    const f = join(dir, "s.jsonl");
    const old = userLine("already seen") + "\n";
    await writeFile(f, old);
    const offset = Buffer.byteLength(old);
    await writeFile(
      f,
      old +
        userLine("from cli") +
        "\n" +
        agentLine("cli answer") +
        "\n" +
        agentLine("bridge echo", "telegram-acp-bridge") +
        "\n",
    );

    const { turns, nextOffset } = await readNewTurns(
      f,
      offset,
      new Set(["telegram-acp-bridge", "sdk-ts"]),
    );
    expect(turns).toEqual([
      { role: "user", text: "from cli" },
      { role: "agent", text: "cli answer" },
    ]);
    // Cursor advanced past the excluded line too.
    const { turns: again } = await readNewTurns(f, nextOffset, new Set(["telegram-acp-bridge"]));
    expect(again).toEqual([]);
  });

  it("never consumes a trailing incomplete line", async () => {
    const f = join(dir, "s.jsonl");
    const complete = userLine("done") + "\n";
    const partial = '{"type":"assistant","entrypoint":"cli","message":{"role":"assis'; // mid-write
    await writeFile(f, complete + partial);

    const r1 = await readNewTurns(f, 0);
    expect(r1.turns).toEqual([{ role: "user", text: "done" }]);
    expect(r1.nextOffset).toBe(Buffer.byteLength(complete));

    // The writer finishes the line → the next poll picks it up.
    await writeFile(f, complete + partial + 'tant","content":[{"type":"text","text":"late"}]}}\n');
    const r2 = await readNewTurns(f, r1.nextOffset);
    expect(r2.turns).toEqual([{ role: "agent", text: "late" }]);
  });

  it("returns empty with unchanged offset when nothing was appended", async () => {
    const f = join(dir, "s.jsonl");
    const content = userLine("x") + "\n";
    await writeFile(f, content);
    const size = Buffer.byteLength(content);
    expect(await readNewTurns(f, size)).toEqual({ turns: [], nextOffset: size });
  });

  it("a tool burst spanning polls: each poll parses independently, a result landing in a LATER poll than its call cannot retroactively flip it", async () => {
    const f = join(dir, "s.jsonl");
    const toolUseLine = (id: string, name: string): string =>
      L({
        type: "assistant",
        entrypoint: "cli",
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] },
      });
    const toolResultLine = (id: string, isError: boolean): string =>
      L({
        type: "user",
        entrypoint: "cli",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
      });

    // Poll 1 catches the tool_use for "a" mid-burst — no result yet in this
    // file slice — so it renders as an unresolved (ok) call, per design.
    await writeFile(f, toolUseLine("a", "Read") + "\n");
    const r1 = await readNewTurns(f, 0);
    expect(r1.turns).toEqual([{ role: "tools", calls: [{ title: "Read", failed: false }] }]);

    // Poll 2: the writer appends "a"'s result plus a fresh call "b" and its
    // result. "a"'s result is orphaned across the poll boundary (its call
    // isn't in THIS parse's id map) and is silently ignored — "a" was already
    // reported ok in poll 1 and stays that way forever.
    await appendFile(
      f,
      [toolResultLine("a", true), toolUseLine("b", "Bash"), toolResultLine("b", true)].join("\n") + "\n",
    );
    const r2 = await readNewTurns(f, r1.nextOffset);
    expect(r2.turns).toEqual([{ role: "tools", calls: [{ title: "Bash", failed: true }] }]);
  });
});

describe("sessionFilePath", () => {
  it("munges every non-alphanumeric cwd char to '-' and appends the id", () => {
    const p = sessionFilePath("/home/kiril/audio_Switcher.app", "abc-123", "/base");
    expect(p).toBe("/base/-home-kiril-audio-Switcher-app/abc-123.jsonl");
  });
});

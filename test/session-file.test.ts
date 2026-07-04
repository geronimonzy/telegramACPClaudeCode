import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionTurns, sessionFilePath } from "../src/acp/session-file.js";

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
  it("extracts prose turns in order, merging consecutive same-role texts", async () => {
    const f = join(dir, "s.jsonl");
    await writeFile(f, fixtureLines().join("\n"));
    const turns = await readSessionTurns(f);
    expect(turns).toEqual([
      { role: "user", text: "first question" },
      { role: "agent", text: "let me check\n\nfound it; here is the answer" },
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

describe("sessionFilePath", () => {
  it("munges every non-alphanumeric cwd char to '-' and appends the id", () => {
    const p = sessionFilePath("/home/kiril/audio_Switcher.app", "abc-123", "/base");
    expect(p).toBe("/base/-home-kiril-audio-Switcher-app/abc-123.jsonl");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
});

describe("sessionFilePath", () => {
  it("munges every non-alphanumeric cwd char to '-' and appends the id", () => {
    const p = sessionFilePath("/home/kiril/audio_Switcher.app", "abc-123", "/base");
    expect(p).toBe("/base/-home-kiril-audio-Switcher-app/abc-123.jsonl");
  });
});

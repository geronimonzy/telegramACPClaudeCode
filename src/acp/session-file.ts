// Reads a Claude Code session transcript straight from its on-disk JSONL.
//
// Why not the adapter's session/load replay? The SDK call behind it
// (`getSessionMessages`) stops after the FIRST turn for some sessions
// (verified against SDK 0.3.198 and 0.3.201 with a session whose file holds
// 4 turns — both return only the first user+assistant exchange). The file
// itself is local and authoritative, so the /sessions attach transcript is
// built from it directly; the adapter replay stays as a fallback for when
// the file can't be located or parsed (see bridge.ts #attachTarget).
//
// File format (observed): one JSON object per line. Conversation entries have
// `type: "user" | "assistant"` and `message.content` (a string for plain user
// messages, or an array of blocks — only `{type:"text"}` blocks are prose;
// `thinking` / `tool_use` / `tool_result` are skipped). Noise is flagged:
// `isMeta: true` (system-reminders, command echoes) and `isSidechain: true`
// (subagent traffic). Everything else (`last-prompt`, `mode`, `attachment`,
// `file-history-snapshot`, …) is metadata with no transcript value.

import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

export interface TranscriptTurn {
  role: "user" | "agent";
  text: string;
}

/**
 * The session file for `sessionId` under `cwd`'s project directory.
 * Claude Code munges the project path by replacing every non-alphanumeric
 * character with `-` (`/home/kiril/audio_Switcher` → `-home-kiril-audio-Switcher`).
 * `base` overrides the `~/.claude/projects` root (tests).
 */
export function sessionFilePath(cwd: string, sessionId: string, base?: string): string {
  const munged = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const root = base ?? path.join(homedir(), ".claude", "projects");
  return path.join(root, munged, `${sessionId}.jsonl`);
}

// Text blocks that are harness plumbing, not conversation — dropped even when
// they appear inside an otherwise-real message.
const SKIP_PREFIXES = [
  "<system-reminder>",
  "<local-command",
  "<command-name>",
  "Caveat: The messages below",
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** Extract the prose text blocks from a message `content` value. */
function textsOf(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const b of content) {
    if (isRecord(b) && b.type === "text" && typeof b.text === "string") out.push(b.text);
  }
  return out;
}

/**
 * Extract speaker turns from raw JSONL text: real user/assistant prose in
 * file order, noise filtered (meta, sidechains, tool traffic, harness
 * wrappers), consecutive same-role texts merged into one turn. Entries whose
 * `entrypoint` is in `excludeEntrypoints` are dropped — the CLI-mirror uses
 * this to skip entries the bridge itself produced. Unparseable lines are
 * skipped.
 */
function extractTurns(raw: string, excludeEntrypoints?: Set<string>): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o)) continue;
    if (o.type !== "user" && o.type !== "assistant") continue;
    if (o.isSidechain === true || o.isMeta === true) continue;
    if (
      excludeEntrypoints &&
      typeof o.entrypoint === "string" &&
      excludeEntrypoints.has(o.entrypoint)
    )
      continue;
    const msg = isRecord(o.message) ? o.message : undefined;
    for (const t of textsOf(msg?.content)) {
      const trimmed = t.trim();
      if (trimmed === "") continue;
      if (SKIP_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
      const role = o.type === "user" ? "user" : "agent";
      const last = turns[turns.length - 1];
      if (last && last.role === role) last.text += `\n\n${trimmed}`;
      else turns.push({ role, text: trimmed });
    }
  }
  return turns;
}

/**
 * Parse a whole session JSONL into speaker turns. Throws if the file can't
 * be read.
 */
export async function readSessionTurns(filePath: string): Promise<TranscriptTurn[]> {
  return extractTurns(await readFile(filePath, "utf-8"));
}

/**
 * Incremental read for the CLI-mirror: parse the turns appended since byte
 * `offset`, never consuming a trailing incomplete line (a writer may be
 * mid-append — those bytes stay for the next poll). `nextOffset` advances to
 * the end of the last complete line even when every entry was filtered out,
 * so already-seen bytes are never re-read.
 */
export async function readNewTurns(
  filePath: string,
  offset: number,
  excludeEntrypoints?: Set<string>,
): Promise<{ turns: TranscriptTurn[]; nextOffset: number }> {
  const fh = await open(filePath, "r");
  try {
    const size = (await fh.stat()).size;
    if (size <= offset) return { turns: [], nextOffset: offset };
    const buf = Buffer.alloc(size - offset);
    await fh.read(buf, 0, buf.length, offset);
    const lastNl = buf.lastIndexOf(0x0a); // "\n" is a self-synchronizing byte in UTF-8
    if (lastNl === -1) return { turns: [], nextOffset: offset };
    const raw = buf.subarray(0, lastNl + 1).toString("utf-8");
    return { turns: extractTurns(raw, excludeEntrypoints), nextOffset: offset + lastNl + 1 };
  } finally {
    await fh.close();
  }
}

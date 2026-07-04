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
// messages, or an array of blocks): `{type:"text"}` is prose; `{type:"thinking"}`
// is skipped; `{type:"tool_use", id, name, input}` (assistant entries) and
// `{type:"tool_result", tool_use_id, is_error?}` (user entries) describe tool
// activity, folded into "tools" turns — see extractTurns below. Noise is
// flagged: `isMeta: true` (system-reminders, command echoes) and
// `isSidechain: true` (subagent traffic). Everything else (`last-prompt`,
// `mode`, `attachment`, `file-history-snapshot`, …) is metadata with no
// transcript value.

import { open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

/** One tool call folded into a "tools" turn; `failed` reflects its matching `tool_result`. */
export interface ToolCallSummary {
  title: string;
  failed: boolean;
}

/**
 * A speaker turn extracted from a session JSONL. Prose turns are user/agent
 * text; a "tools" turn is a burst of consecutive tool calls between prose
 * (see extractTurns) rendered as a static Activity-style panel.
 */
export type TranscriptTurn =
  | { role: "user" | "agent"; text: string }
  | { role: "tools"; calls: ToolCallSummary[] };

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

/** Normalize a message `content` value to its block list (a plain string is one text block). */
function blocksOf(content: unknown): Record<string, unknown>[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

// Keys checked, in order, for a short hint to append to a tool_use title —
// the first one present in `input` wins. Covers the common tools (Read/Edit/
// Write via file_path, Bash via command, Grep via pattern, Task via
// description, WebFetch via url); anything else falls back to just the name.
const TITLE_HINT_KEYS = ["file_path", "path", "command", "pattern", "description", "url"];
const TITLE_HINT_MAX_LEN = 60;

/** Derive a static Activity-row title from a tool_use block: `name` + a short input hint. */
function toolTitle(name: unknown, input: unknown): string {
  const label = typeof name === "string" && name !== "" ? name : "tool";
  if (!isRecord(input)) return label;
  for (const key of TITLE_HINT_KEYS) {
    const v = input[key];
    if (v === undefined || v === null) continue;
    const hint = String(v).replace(/\s+/g, " ").trim();
    if (hint === "") continue;
    const truncated = hint.length > TITLE_HINT_MAX_LEN ? hint.slice(0, TITLE_HINT_MAX_LEN) + "…" : hint;
    return `${label}: ${truncated}`;
  }
  return label;
}

/**
 * Extract speaker turns from raw JSONL text: real user/assistant prose and
 * tool-call bursts in file order, noise filtered (meta, sidechains, harness
 * wrappers), consecutive same-role texts merged into one turn.
 *
 * Tool activity folds into "tools" turns: a `tool_use` block (assistant
 * entries) opens a burst or extends the current one if the last turn is
 * already a "tools" turn — so consecutive tool_use blocks across MULTIPLE
 * entries stay one burst as long as no real prose lands between them. Real
 * prose text ends the burst (a new prose turn is pushed — the existing
 * same-role merge no longer applies once a burst sits between two prose
 * turns, which is correct chronology). A `tool_result` block (user entries)
 * never creates a turn; it looks up its `tool_use_id` in a same-parse map and
 * flips the matching call's `failed` to `!!is_error` — results can arrive in
 * a later entry than their call, anywhere in this same raw text.
 *
 * Entries whose `entrypoint` is in `excludeEntrypoints` are dropped — the
 * CLI-mirror uses this to skip entries the bridge itself produced.
 * Unparseable lines are skipped.
 */
function extractTurns(raw: string, excludeEntrypoints?: Set<string>): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  // tool_use id -> its row, scoped to this single parse. A tool_result whose
  // id was never seen in this parse (e.g. its tool_use fell before the
  // CLI-mirror's read offset) is silently ignored — nothing to flip.
  const callsById = new Map<string, ToolCallSummary>();

  const openBurst = (): ToolCallSummary[] => {
    const last = turns[turns.length - 1];
    if (last && last.role === "tools") return last.calls;
    const calls: ToolCallSummary[] = [];
    turns.push({ role: "tools", calls });
    return calls;
  };

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
    const role = o.type === "user" ? "user" : "agent";
    for (const b of blocksOf(msg?.content)) {
      if (b.type === "text" && typeof b.text === "string") {
        const trimmed = b.text.trim();
        if (trimmed === "") continue;
        if (SKIP_PREFIXES.some((p) => trimmed.startsWith(p))) continue;
        const last = turns[turns.length - 1];
        if (last && last.role === role) last.text += `\n\n${trimmed}`;
        else turns.push({ role, text: trimmed });
      } else if (b.type === "tool_use") {
        const call: ToolCallSummary = { title: toolTitle(b.name, b.input), failed: false };
        if (typeof b.id === "string") callsById.set(b.id, call);
        openBurst().push(call);
      } else if (b.type === "tool_result") {
        if (typeof b.tool_use_id === "string") {
          const call = callsById.get(b.tool_use_id);
          if (call) call.failed = !!b.is_error;
        }
      }
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

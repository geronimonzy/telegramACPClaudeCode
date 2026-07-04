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

import { readFile } from "node:fs/promises";
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
 * Parse a session JSONL into speaker turns: real user/assistant prose in file
 * order, noise filtered (meta, sidechains, tool traffic, harness wrappers),
 * consecutive same-role texts merged into one turn. Throws if the file can't
 * be read; unparseable individual lines are skipped.
 */
export async function readSessionTurns(filePath: string): Promise<TranscriptTurn[]> {
  const raw = await readFile(filePath, "utf-8");
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

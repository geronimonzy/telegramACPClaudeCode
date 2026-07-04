// Aggregates Claude Code token usage from the local session JSONLs
// (~/.claude/projects/*/*.jsonl) for the bridge's /usage command.
//
// Every assistant entry carries `message.usage` (input/output/cache tokens)
// and `message.model`, but streaming writes SEVERAL entries per API message
// (one per content block), each repeating the SAME usage — summing naively
// overcounts ~3-4x. Entries are deduped by `message.id` (first wins).
// Sidechain (subagent) entries are included: their tokens are real usage.

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { escapeRich } from "./telegram/rich-html.js";

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
}

export interface UsageStats {
  /** Per-model tokens since local midnight. */
  today: Map<string, ModelUsage>;
  /** Per-model tokens for the last 7 days (including today). */
  week: Map<string, ModelUsage>;
  sessionsToday: number;
  sessionsWeek: number;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bump(map: Map<string, ModelUsage>, model: string, u: Record<string, unknown>): void {
  let m = map.get(model);
  if (!m) {
    m = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
    map.set(model, m);
  }
  m.input += num(u.input_tokens);
  m.output += num(u.output_tokens);
  m.cacheRead += num(u.cache_read_input_tokens);
  m.cacheWrite += num(u.cache_creation_input_tokens);
  m.messages += 1;
}

/**
 * Scan the projects dir and aggregate per-model usage for today / the last
 * 7 days. Files untouched for >7 days are skipped by mtime without being
 * read; unreadable files and unparseable lines are skipped silently.
 */
export async function collectUsageStats(
  projectsDir: string = path.join(homedir(), ".claude", "projects"),
  now: Date = new Date(),
): Promise<UsageStats> {
  const stats: UsageStats = {
    today: new Map(),
    week: new Map(),
    sessionsToday: 0,
    sessionsWeek: 0,
  };
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = now.getTime() - WEEK_MS;
  const seen = new Set<string>();

  let dirs: string[];
  try {
    dirs = await readdir(projectsDir);
  } catch {
    return stats; // no projects dir → empty stats
  }

  for (const d of dirs) {
    let files: string[];
    const dirPath = path.join(projectsDir, d);
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const filePath = path.join(dirPath, f);
      try {
        const st = await stat(filePath);
        if (st.mtimeMs < weekStart) continue; // untouched for a week → skip unread
      } catch {
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      let touchedToday = false;
      let touchedWeek = false;
      for (const line of raw.split("\n")) {
        if (line === "" || !line.includes('"usage"')) continue;
        let o: unknown;
        try {
          o = JSON.parse(line);
        } catch {
          continue;
        }
        if (!isRecord(o) || o.type !== "assistant") continue;
        if (!isRecord(o.message)) continue;
        const msg = o.message;
        const usage = isRecord(msg.usage) ? msg.usage : undefined;
        if (!usage) continue;
        const id = typeof msg.id === "string" ? msg.id : undefined;
        if (id) {
          if (seen.has(id)) continue; // streaming writes dupes; first wins
          seen.add(id);
        }
        const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
        if (!Number.isFinite(ts) || ts < weekStart) continue;
        // Zero-usage placeholder entries (model "<synthetic>") are noise.
        if (
          num(usage.input_tokens) +
            num(usage.output_tokens) +
            num(usage.cache_read_input_tokens) +
            num(usage.cache_creation_input_tokens) ===
          0
        )
          continue;
        const model = typeof msg.model === "string" ? msg.model : "unknown";
        bump(stats.week, model, usage);
        touchedWeek = true;
        if (ts >= dayStart) {
          bump(stats.today, model, usage);
          touchedToday = true;
        }
      }
      if (touchedWeek) stats.sessionsWeek += 1;
      if (touchedToday) stats.sessionsToday += 1;
    }
  }
  return stats;
}

/**
 * 12345 → "12.3k", 1234567 → "1.2M", 460900000 → "461M"; exact below 1000.
 * The decimal is dropped from three-digit mantissas — Telegram renders rich
 * tables at their natural width with horizontal scroll, so every char of the
 * widest cell costs real screen estate.
 */
export function fmtTokens(n: number): string {
  const scale = (v: number, suffix: string): string =>
    `${v >= 100 ? Math.round(v) : v.toFixed(1)}${suffix}`;
  if (n >= 1_000_000) return scale(n / 1_000_000, "M");
  if (n >= 1_000) return scale(n / 1_000, "k");
  return String(n);
}

/**
 * The context-at-last-turn for a session, from its JSONL: the LAST assistant
 * entry's `input + cache_read + cache_creation` tokens ≈ what the model saw.
 * Survives bridge restarts (unlike the in-memory usage_update cache), so
 * disconnected sessions still show a real number. Throws if the file can't
 * be read.
 */
export async function lastContextUsed(filePath: string): Promise<number | undefined> {
  const raw = await readFile(filePath, "utf-8");
  let last: number | undefined;
  for (const line of raw.split("\n")) {
    if (line === "" || !line.includes('"usage"')) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o) || o.type !== "assistant" || o.isSidechain === true) continue;
    if (!isRecord(o.message) || !isRecord(o.message.usage)) continue;
    const u = o.message.usage;
    const used =
      num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    if (used > 0) last = used;
  }
  return last;
}

/** An attached session's line in the stats panel. */
export interface LiveSessionUsage {
  title: string;
  /** Live agent subprocess attached right now (vs waiting for Reconnect). */
  connected: boolean;
  /** Context from a live usage_update (has the window size too). */
  used?: number;
  size?: number;
  /** Context recovered from the session file when no live data exists. */
  fileUsed?: number;
}

// Three columns: Telegram renders rich tables at natural width and cuts into
// horizontal scroll past the client width — 5 columns overflowed on phones,
// and the cache column was dropped next (live feedback). cacheRead/cacheWrite
// stay in ModelUsage for anyone who wants them back.
function usageTable(map: Map<string, ModelUsage>): string {
  if (map.size === 0) return "<p>no usage</p>";
  const rows = [...map.entries()].sort((a, b) => b[1].output - a[1].output);
  let t = "<table><tr><th>model</th><th>in/out</th><th>msgs</th></tr>";
  for (const [model, u] of rows) {
    t +=
      `<tr><td>${escapeRich(model.replace(/^claude-/, ""))}</td>` +
      `<td>${fmtTokens(u.input)}/${fmtTokens(u.output)}</td>` +
      `<td>${u.messages}</td></tr>`;
  }
  return t + "</table>";
}

/** Render the whole stats panel as Rich HTML. */
export function renderUsageRich(
  stats: UsageStats,
  live: LiveSessionUsage[],
  now: Date = new Date(),
): string {
  const parts: string[] = [];
  const when = now.toISOString().slice(0, 16).replace("T", " ");
  parts.push(`<h3>📊 Claude usage</h3><p>updated ${when} UTC</p>`);
  parts.push(`<h4>Today — ${stats.sessionsToday} session${stats.sessionsToday === 1 ? "" : "s"}</h4>`);
  parts.push(usageTable(stats.today));
  parts.push(`<h4>Last 7 days — ${stats.sessionsWeek} session${stats.sessionsWeek === 1 ? "" : "s"}</h4>`);
  parts.push(usageTable(stats.week));
  if (live.length > 0) {
    const items = live
      .map((s) => {
        let ctx: string;
        if (s.used !== undefined && s.size !== undefined) {
          ctx = `${fmtTokens(s.used)}/${fmtTokens(s.size)}`;
        } else if (s.fileUsed !== undefined) {
          ctx = `~${fmtTokens(s.fileUsed)} ctx`;
        } else {
          ctx = "–";
        }
        const state = s.connected ? "🟢" : "🔌";
        return `<li>${state} <b>${escapeRich(s.title)}</b> — ${ctx}</li>`;
      })
      .join("");
    parts.push(`<h4>Sessions</h4><ul>${items}</ul>`);
  }
  return parts.join("\n");
}

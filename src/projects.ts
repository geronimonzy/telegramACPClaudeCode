// Renders the 📁 Projects overview panel — every project and, under each, its
// sessions grouped by state (🟢 running, 🔌 disconnected, 💤 resumable). Mirrors
// src/usage.ts: pure, side-effect-free data types + render/keyboard helpers, so
// the whole panel is unit-testable without a Bridge or a real bot. The Bridge
// (bridge.ts) owns collection (which projects/sessions exist) and the callback
// key allocation; this module only turns that already-shaped data into Rich
// HTML + an inline keyboard.

import { homedir } from "node:os";
import * as path from "node:path";
import { escapeRich } from "./telegram/rich-html.js";
import type { InlineKeyboard } from "./bridge.js";

/** At most this many sessions are shown per state group; the rest collapse to a "…and N more" line. */
export const PROJECTS_MAX_PER_GROUP = 6;

/** Longest button label we render (Telegram truncates long labels anyway). */
const BUTTON_LABEL_MAX = 40;

/** One session line under a project, already resolved to its display shape. */
export interface ProjectSession {
  title: string;
  /** Running / disconnected sessions carry the Telegram thread id for the deep-link. */
  threadId?: number;
  /** Resumable sessions carry the callback key for their `proj:att:{k}` button. */
  attachKey?: number;
  /** Resumable sessions may show a last-activity date (like `/sessions` does). */
  date?: string;
}

/** One project block: its display name, cwd, its `proj:new:{k}` key and grouped sessions. */
export interface ProjectView {
  name: string;
  cwd: string;
  /** Callback key for this project's `➕ {name}` (proj:new) button. */
  newKey: number;
  running: ProjectSession[];
  disconnected: ProjectSession[];
  resumable: ProjectSession[];
}

/** Truncate to `max` chars, appending an ellipsis when cut (matches bridge.ts). */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

/**
 * Shorten a leading home-directory prefix to `~` for display (the reverse of
 * bridge.ts' expandHome). `home` is injectable for tests.
 */
export function shortenHome(p: string, home: string = homedir()): string {
  if (p === home) return "~";
  if (p.startsWith(home + path.sep)) return "~" + p.slice(home.length);
  return p;
}

/**
 * The Telegram deep-link to a forum topic: `https://t.me/c/{internal}/{threadId}`
 * where `internal` is the supergroup chat id with its leading `-100` stripped.
 *
 * ⚠️ The exact link format for forum topics in a PRIVATE supergroup needs live
 * verification (docs/BACKLOG.md flags this) — `t.me/c/{internal}/{threadId}`
 * opens the message with `message_thread_id === threadId`, which for a forum is
 * that topic's root; confirm it lands in the topic and not just the message.
 */
export function topicDeepLink(forumChatId: number | string, threadId: number): string {
  const internal = String(forumChatId).replace(/^-100/, "");
  return `https://t.me/c/${internal}/${threadId}`;
}

/** Render one project block (heading + cwd + grouped session list) as Rich HTML. */
function projectBlock(p: ProjectView): string {
  const parts: string[] = [
    `<h4>${escapeRich(p.name)}</h4>`,
    `<p><code>${escapeRich(p.cwd)}</code></p>`,
  ];
  const groups: Array<{ emoji: string; list: ProjectSession[] }> = [
    { emoji: "🟢", list: p.running },
    { emoji: "🔌", list: p.disconnected },
    { emoji: "💤", list: p.resumable },
  ];
  const items: string[] = [];
  const mores: string[] = [];
  for (const g of groups) {
    const shown = g.list.slice(0, PROJECTS_MAX_PER_GROUP);
    for (const s of shown) {
      const date = s.date ? ` · ${escapeRich(s.date)}` : "";
      items.push(`<li>${g.emoji} <b>${escapeRich(s.title)}</b>${date}</li>`);
    }
    const extra = g.list.length - shown.length;
    if (extra > 0) mores.push(`<p>${g.emoji} …and ${extra} more</p>`);
  }
  parts.push(items.length > 0 ? `<ul>${items.join("")}</ul>` : `<p><i>no sessions</i></p>`);
  parts.push(...mores);
  return parts.join("");
}

/** Render the whole Projects panel as Rich HTML. */
export function renderProjectsRich(projects: ProjectView[], now: Date = new Date()): string {
  const when = now.toISOString().slice(0, 16).replace("T", " ");
  const parts: string[] = [`<h3>📁 Projects</h3><p>updated ${when} UTC</p>`];
  if (projects.length === 0) {
    parts.push("<p>No projects yet.</p>");
    return parts.join("\n");
  }
  for (const p of projects) parts.push(projectBlock(p));
  return parts.join("\n");
}

/**
 * Build the panel's inline keyboard (all rows single-button):
 *   - `➕ {name}` → `proj:new:{newKey}` per project;
 *   - a URL button deep-linking to each 🟢/🔌 session's topic;
 *   - `{title}` → `proj:att:{attachKey}` per 💤 resumable session.
 * Capped at {@link PROJECTS_MAX_PER_GROUP} sessions per state group, matching
 * what {@link renderProjectsRich} shows.
 */
export function buildProjectsKeyboard(
  projects: ProjectView[],
  forumChatId: number | string,
): InlineKeyboard {
  const rows: InlineKeyboard["inline_keyboard"] = [];
  for (const p of projects) {
    rows.push([{ text: truncate(`➕ ${p.name}`, BUTTON_LABEL_MAX), callback_data: `proj:new:${p.newKey}` }]);
    for (const s of p.running.slice(0, PROJECTS_MAX_PER_GROUP)) {
      if (s.threadId !== undefined) {
        rows.push([{ text: truncate(`🟢 ${s.title}`, BUTTON_LABEL_MAX), url: topicDeepLink(forumChatId, s.threadId) }]);
      }
    }
    for (const s of p.disconnected.slice(0, PROJECTS_MAX_PER_GROUP)) {
      if (s.threadId !== undefined) {
        rows.push([{ text: truncate(`🔌 ${s.title}`, BUTTON_LABEL_MAX), url: topicDeepLink(forumChatId, s.threadId) }]);
      }
    }
    for (const s of p.resumable.slice(0, PROJECTS_MAX_PER_GROUP)) {
      if (s.attachKey !== undefined) {
        rows.push([{ text: truncate(`💤 ${s.title}`, BUTTON_LABEL_MAX), callback_data: `proj:att:${s.attachKey}` }]);
      }
    }
  }
  return { inline_keyboard: rows };
}

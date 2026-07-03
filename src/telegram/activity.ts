// Renders ACP tool_call / tool_call_update session updates into a single,
// live-edited "Activity" Telegram message.
//
// Rows are keyed by toolCallId. A tool_call_update may arrive for an id we've
// never seen (the protocol allows updates before/without the initial
// tool_call reaching us) — that CREATES the row rather than being dropped.
// ToolCallUpdate fields are `T | null`; only a non-null field overwrites the
// existing value, so e.g. `title: null` in an update leaves the prior title
// in place. This class only builds HTML strings and calls `live.set(...)` —
// no api calls or throttling of its own (LiveMessage/Throttle own that).

import type * as acp from "@agentclientprotocol/sdk";
import type { LiveMessage } from "./live-message.js";
import { escapeRich, fitDetailsList } from "./rich-html.js";

/** Fit budget for the Activity panel body, kept under the LiveMessage rich budget. */
const RICH_FIT_LEN = 30000;

const STATUS_EMOJI: Record<acp.ToolCallStatus, string> = {
  pending: "⏳",
  in_progress: "🔄",
  completed: "✅",
  failed: "❌",
};

const KIND_EMOJI: Record<acp.ToolKind, string> = {
  read: "📖",
  edit: "✏️",
  delete: "🗑",
  move: "📦",
  search: "🔍",
  execute: "💻",
  think: "💭",
  fetch: "🌐",
  switch_mode: "🔀",
  other: "🔧",
};

const DIFF_MAX_LEN = 600;
// Tool titles come from the agent and are unbounded; an uncapped title can
// singlehandedly blow the fit budget and force truncateHtmlSafe onto the whole
// panel. Cap it well under any budget — no legitimate title needs more.
const TITLE_MAX_LEN = 300;

interface Row {
  toolCallId: string;
  title: string;
  kind: acp.ToolKind;
  status: acp.ToolCallStatus;
  content: acp.ToolCallContent[];
}

function truncateDiff(text: string): string {
  if (text.length <= DIFF_MAX_LEN) return text;
  return text.slice(0, DIFF_MAX_LEN) + "…";
}

function truncateTitle(text: string): string {
  if (text.length <= TITLE_MAX_LEN) return text;
  return text.slice(0, TITLE_MAX_LEN) + "…";
}

/** Render one tool-call row as a self-contained Rich `<li>` (diff → `<pre><code>`). */
function renderRow(row: Row): string {
  let inner = `${STATUS_EMOJI[row.status]} ${KIND_EMOJI[row.kind]} <b>${escapeRich(truncateTitle(row.title))}</b>`;
  for (const item of row.content) {
    if (item.type === "diff") {
      inner += `<pre><code>${escapeRich(truncateDiff(item.newText))}</code></pre>`;
    }
  }
  return `<li>${inner}</li>`;
}

export class ActivityRenderer {
  private readonly rows = new Map<string, Row>();
  private readonly order: string[] = [];

  constructor(private readonly live: LiveMessage) {}

  onToolCall(tc: acp.ToolCall & { sessionUpdate: "tool_call" }): void {
    const row: Row = {
      toolCallId: tc.toolCallId,
      title: tc.title,
      kind: tc.kind ?? "other",
      status: tc.status ?? "pending",
      content: tc.content ?? [],
    };
    if (!this.rows.has(row.toolCallId)) this.order.push(row.toolCallId);
    this.rows.set(row.toolCallId, row);
    this.render();
  }

  onToolCallUpdate(u: acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }): void {
    const existing = this.rows.get(u.toolCallId);
    if (existing) {
      if (u.title != null) existing.title = u.title;
      if (u.kind != null) existing.kind = u.kind;
      if (u.status != null) existing.status = u.status;
      if (u.content != null) existing.content = u.content;
    } else {
      // Unknown id: protocol allows an update to arrive before/without the
      // initial tool_call, so this creates the row.
      this.order.push(u.toolCallId);
      this.rows.set(u.toolCallId, {
        toolCallId: u.toolCallId,
        title: u.title ?? "",
        kind: u.kind ?? "other",
        status: u.status ?? "pending",
        content: u.content ?? [],
      });
    }
    this.render();
  }

  async finalizeTurn(): Promise<void> {
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (row && row.status === "in_progress") row.status = "failed";
    }
    this.render();
    await this.live.flushNow();
  }

  private render(): void {
    const rows: string[] = [];
    let running = 0;
    for (const id of this.order) {
      const row = this.rows.get(id);
      if (!row) continue;
      if (row.status === "in_progress") running++;
      rows.push(renderRow(row));
    }
    const n = rows.length;
    const summary =
      `⚙️ Activity — ${n} call${n === 1 ? "" : "s"}` + (running > 0 ? ` · ${running} running` : "");
    this.live.set(fitDetailsList({ summary, rows, max: RICH_FIT_LEN, open: true }));
  }
}

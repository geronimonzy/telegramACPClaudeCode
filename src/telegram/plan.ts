// Renders ACP `plan` session updates into a single, live-edited "Plan"
// Telegram message. Per the protocol, plan updates are a FULL REPLACE —
// each `onPlan` call discards any previously rendered entries rather than
// merging them. This class only builds HTML strings and calls
// `live.set(...)` — no api calls or throttling of its own.

import type * as acp from "@agentclientprotocol/sdk";
import type { LiveMessage } from "./live-message.js";
import { escapeRich, fitDetailsList } from "./rich-html.js";

/** Fit budget for the Plan panel body, kept under the LiveMessage rich budget. */
const RICH_FIT_LEN = 30000;

const STATUS_EMOJI: Record<acp.PlanEntryStatus, string> = {
  pending: "☐",
  in_progress: "🔄",
  completed: "☑",
};

// Plan entry text comes from the agent and is unbounded; cap it so a single
// pathological entry can't blow the fit budget (mirrors activity.ts's title cap).
const ENTRY_MAX_LEN = 500;

/** Render one plan entry as a self-contained Rich `<li>`. */
function renderEntry(entry: acp.PlanEntry): string {
  const suffix = entry.priority === "high" ? " ‼️" : "";
  const content =
    entry.content.length <= ENTRY_MAX_LEN
      ? entry.content
      : entry.content.slice(0, ENTRY_MAX_LEN) + "…";
  return `<li>${STATUS_EMOJI[entry.status]} ${escapeRich(content)}${suffix}</li>`;
}

export class PlanRenderer {
  private entries: acp.PlanEntry[] = [];

  constructor(private readonly live: LiveMessage) {}

  onPlan(p: { entries: acp.PlanEntry[] }): void {
    this.entries = p.entries; // full replace, never merge
    this.render();
  }

  async finalizeTurn(): Promise<void> {
    await this.live.flushNow();
  }

  private render(): void {
    const done = this.entries.filter((e) => e.status === "completed").length;
    const total = this.entries.length;
    const summary = `📋 Plan — ${done}/${total} done`;
    const rows = this.entries.map(renderEntry);
    this.live.set(fitDetailsList({ summary, rows, max: RICH_FIT_LEN, open: true }));
  }
}

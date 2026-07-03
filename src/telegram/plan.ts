// Renders ACP `plan` session updates into a single, live-edited "Plan"
// Telegram message. Per the protocol, plan updates are a FULL REPLACE —
// each `onPlan` call discards any previously rendered entries rather than
// merging them. This class only builds HTML strings and calls
// `live.set(...)` — no api calls or throttling of its own.

import type * as acp from "@agentclientprotocol/sdk";
import { escapeHtml } from "../html.js";
import type { LiveMessage } from "./live-message.js";

const STATUS_EMOJI: Record<acp.PlanEntryStatus, string> = {
  pending: "☐",
  in_progress: "🔄",
  completed: "☑",
};

function renderEntry(entry: acp.PlanEntry): string {
  const suffix = entry.priority === "high" ? " ‼️" : "";
  return `${STATUS_EMOJI[entry.status]} ${escapeHtml(entry.content)}${suffix}`;
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
    const lines = ["<b>Plan</b>", ...this.entries.map(renderEntry)];
    this.live.set(lines.join("\n"));
  }
}

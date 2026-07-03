import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PlanRenderer } from "../src/telegram/plan.js";
import { LiveMessage } from "../src/telegram/live-message.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

const VOID_TAGS = new Set(["br", "hr", "img", "input"]);
function isBalanced(html: string): boolean {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const full = m[0];
    const name = m[1].toLowerCase();
    if (full.startsWith("</")) {
      if (stack.pop() !== name) return false;
    } else if (!full.endsWith("/>") && !VOID_TAGS.has(name)) {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function entry(overrides: Partial<acp.PlanEntry> = {}): acp.PlanEntry {
  return { content: "Do the thing", priority: "medium", status: "pending", ...overrides };
}

function latest(api: FakeApi): string {
  return api.edits.length > 0 ? api.edits[api.edits.length - 1][1] : api.sends[api.sends.length - 1];
}

describe("PlanRenderer (Rich)", () => {
  it("renders a collapsible details panel with a done/total summary and one <li> per entry", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new PlanRenderer(live);
    r.onPlan({
      entries: [
        entry({ content: "First", status: "pending" }),
        entry({ content: "Second", status: "in_progress" }),
        entry({ content: "Third", status: "completed" }),
      ],
    });
    await live.flushNow();
    const html = api.sends[0];
    expect(html.startsWith("<details open><summary>")).toBe(true);
    expect(html).toContain("📋 Plan — 1/3 done");
    expect(html).toContain("<ul>");
    expect(html).toContain("☐");
    expect(html).toContain("🔄");
    expect(html).toContain("☑");
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).toContain("Third");
    expect(html.endsWith("</details>")).toBe(true);
    expect(isBalanced(html)).toBe(true);
  });

  it("high priority entries get a ‼️ suffix", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new PlanRenderer(live);
    r.onPlan({ entries: [entry({ content: "Urgent", priority: "high" })] });
    await live.flushNow();
    expect(api.sends[0]).toContain("‼️");
  });

  it("Rich-escapes entry content", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new PlanRenderer(live);
    r.onPlan({ entries: [entry({ content: "<b>evil</b> & co" })] });
    await live.flushNow();
    const html = api.sends[0];
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;b&gt;evil&lt;/b&gt; &amp; co");
  });

  it("a second onPlan fully replaces the entries (no merge)", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new PlanRenderer(live);
    r.onPlan({
      entries: [entry({ content: "One" }), entry({ content: "Two" }), entry({ content: "Three" })],
    });
    r.onPlan({ entries: [entry({ content: "Only" })] });
    await live.flushNow();
    const html = latest(api);
    expect(html).toContain("Only");
    expect(html).not.toContain("One");
    expect(html).not.toContain("Two");
    expect(html).not.toContain("Three");
    const liCount = (html.match(/<li>/g) ?? []).length;
    expect(liCount).toBe(1);
    expect(html).toContain("📋 Plan — 0/1 done");
  });

  it("finalizeTurn flushes pending content", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new PlanRenderer(live);
    r.onPlan({ entries: [entry({ content: "Wrap up" })] });
    await r.finalizeTurn();
    expect(api.sends).toHaveLength(1);
    expect(api.sends[0]).toContain("Wrap up");
  });
});

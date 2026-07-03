import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type * as acp from "@agentclientprotocol/sdk";
import { PlanRenderer } from "../src/telegram/plan.js";
import { LiveMessage } from "../src/telegram/live-message.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function entry(overrides: Partial<acp.PlanEntry> = {}): acp.PlanEntry {
  return { content: "Do the thing", priority: "medium", status: "pending", ...overrides };
}

describe("PlanRenderer", () => {
  it("renders header + one line per entry with status glyphs", async () => {
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
    expect(html).toContain("<b>Plan</b>");
    expect(html).toContain("☐");
    expect(html).toContain("🔄");
    expect(html).toContain("☑");
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html).toContain("Third");
  });

  it("high priority entries get a ‼️ suffix", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new PlanRenderer(live);
    r.onPlan({ entries: [entry({ content: "Urgent", priority: "high" })] });
    await live.flushNow();
    expect(api.sends[0]).toContain("‼️");
  });

  it("escapes entry content", async () => {
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
    const html = api.edits.length > 0 ? api.edits[api.edits.length - 1][1] : api.sends[api.sends.length - 1];
    expect(html).toContain("Only");
    expect(html).not.toContain("One");
    expect(html).not.toContain("Two");
    expect(html).not.toContain("Three");
    const lineCount = html.split("\n").filter((l) => l.includes("☐") || l.includes("🔄") || l.includes("☑")).length;
    expect(lineCount).toBe(1);
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

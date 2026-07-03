import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { ActivityRenderer } from "../src/telegram/activity.js";
import { LiveMessage } from "../src/telegram/live-message.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

// Void-aware balance checker: Rich Messages 400 on unbalanced markup.
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

function toolCall(overrides: Partial<acp.ToolCall> = {}): acp.ToolCall & { sessionUpdate: "tool_call" } {
  return {
    toolCallId: "1",
    title: "Reading file",
    kind: "read",
    status: "pending",
    sessionUpdate: "tool_call",
    ...overrides,
  };
}

function toolCallUpdate(
  overrides: Partial<acp.ToolCallUpdate> = {},
): acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" } {
  return {
    toolCallId: "1",
    sessionUpdate: "tool_call_update",
    ...overrides,
  };
}

function latest(api: FakeApi): string {
  return api.edits.length > 0 ? api.edits[api.edits.length - 1][1] : api.sends[api.sends.length - 1];
}

describe("ActivityRenderer (Rich)", () => {
  it("renders a collapsible details panel with a counter summary and a row per tool_call", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ title: "Reading foo.ts", kind: "read", status: "in_progress" }));
    await live.flushNow();
    expect(api.sends).toHaveLength(1);
    const html = api.sends[0];
    expect(html.startsWith("<details open><summary>")).toBe(true);
    expect(html).toContain("⚙️ Activity — 1 call · 1 running");
    expect(html).toContain("<ul>");
    expect(html).toContain("<li>");
    expect(html).toContain("🔄");
    expect(html).toContain("📖");
    expect(html).toContain("<b>Reading foo.ts</b>");
    expect(html.endsWith("</details>")).toBe(true);
    expect(isBalanced(html)).toBe(true);
  });

  it("update merges by toolCallId and keeps title on null (status → completed ✅)", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ toolCallId: "42", title: "Editing bar.ts", kind: "edit", status: "in_progress" }));
    r.onToolCallUpdate(toolCallUpdate({ toolCallId: "42", status: "completed", title: null }));
    await live.flushNow();
    const html = latest(api);
    expect(html).toContain("✅");
    expect(html).toContain("<b>Editing bar.ts</b>");
    expect(html).not.toContain("🔄");
    expect(html).toContain("⚙️ Activity — 1 call"); // no running count once completed
    expect(html).not.toContain("running");
  });

  it("tool_call_update with unknown toolCallId creates the row", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCallUpdate(
      toolCallUpdate({ toolCallId: "unseen", title: "Fetching url", kind: "fetch", status: "pending" }),
    );
    await live.flushNow();
    const html = api.sends[0];
    expect(html).toContain("⏳");
    expect(html).toContain("🌐");
    expect(html).toContain("<b>Fetching url</b>");
  });

  it("missing status defaults to pending", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ toolCallId: "5", title: "No status", status: undefined }));
    await live.flushNow();
    expect(api.sends[0]).toContain("⏳");
  });

  it("a diff content item appends a <pre><code> block truncated at 600 chars", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    const longText = "x".repeat(1000);
    r.onToolCall(
      toolCall({
        toolCallId: "9",
        title: "Editing big.ts",
        kind: "edit",
        content: [{ type: "diff", path: "big.ts", newText: longText }],
      }),
    );
    await live.flushNow();
    const html = api.sends[0];
    expect(html).toContain("<pre><code>");
    const preMatch = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(html);
    expect(preMatch).not.toBeNull();
    const inner = preMatch![1];
    expect(inner.length).toBeLessThanOrEqual(601); // 600 chars + ellipsis
    expect(inner.endsWith("…")).toBe(true);
    expect(isBalanced(html)).toBe(true);
  });

  it("diff content is Rich-escaped", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(
      toolCall({
        toolCallId: "10",
        title: "<script>evil</script>",
        kind: "edit",
        content: [{ type: "diff", path: "x.ts", newText: "<b>bold</b> & stuff" }],
      }),
    );
    await live.flushNow();
    const html = api.sends[0];
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; stuff");
  });

  it("finalizeTurn flushes and marks a still in_progress call as ❌ cancelled", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ toolCallId: "7", title: "Running command", kind: "execute", status: "in_progress" }));
    await r.finalizeTurn();
    const html = latest(api);
    expect(html).toContain("❌");
    expect(html).not.toContain("🔄");
  });

  it("finalizeTurn does not touch already-completed/failed calls", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ toolCallId: "1", title: "Done thing", kind: "read", status: "completed" }));
    await r.finalizeTurn();
    const html = api.sends[api.sends.length - 1];
    expect(html).toContain("✅");
  });

  // Regression (T17 review, Critical): tool titles come from the agent and were
  // uncapped — a pathological title alone could blow the whole panel past the
  // rich budget and force lossy whole-payload truncation. Titles are capped at
  // the source so the panel stays comfortably within budget.
  it("caps a pathological tool title; the panel stays balanced and within budget", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(
      toolCall({ toolCallId: "big", title: "T".repeat(40000), kind: "read", status: "in_progress" }),
    );
    await live.flushNow();
    const html = latest(api);
    expect(html.length).toBeLessThan(1000); // capped title, not 40k
    expect(html).toContain("…"); // cap indicator
    expect(html.endsWith("</details>")).toBe(true); // wrappers intact
    expect(isBalanced(html)).toBe(true);
  });

  it("the running counter reflects multiple concurrent calls", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ toolCallId: "a", status: "in_progress" }));
    r.onToolCall(toolCall({ toolCallId: "b", status: "in_progress" }));
    r.onToolCall(toolCall({ toolCallId: "c", status: "completed" }));
    await live.flushNow();
    expect(latest(api)).toContain("⚙️ Activity — 3 calls · 2 running");
  });
});

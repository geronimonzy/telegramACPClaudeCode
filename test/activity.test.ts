import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import { ActivityRenderer } from "../src/telegram/activity.js";
import { LiveMessage } from "../src/telegram/live-message.js";
import { FakeApi } from "./helpers/fake-api.js";

const INTERVAL = 1000;

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

describe("ActivityRenderer", () => {
  it("renders header + status/kind/title for a tool_call", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ title: "Reading foo.ts", kind: "read", status: "in_progress" }));
    await live.flushNow();
    expect(api.sends).toHaveLength(1);
    const html = api.sends[0];
    expect(html).toContain("<b>Activity</b>");
    expect(html).toContain("🔄");
    expect(html).toContain("📖");
    expect(html).toContain("<b>Reading foo.ts</b>");
  });

  it("update merges by toolCallId and keeps title on null (status → completed ✅)", async () => {
    const api = new FakeApi();
    const live = new LiveMessage(api, INTERVAL);
    const r = new ActivityRenderer(live);
    r.onToolCall(toolCall({ toolCallId: "42", title: "Editing bar.ts", kind: "edit", status: "in_progress" }));
    r.onToolCallUpdate(toolCallUpdate({ toolCallId: "42", status: "completed", title: null }));
    await live.flushNow();
    const html = api.edits.length > 0 ? api.edits[api.edits.length - 1][1] : api.sends[api.sends.length - 1];
    expect(html).toContain("✅");
    expect(html).toContain("<b>Editing bar.ts</b>");
    expect(html).not.toContain("🔄");
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

  it("a diff content item appends a <pre> block truncated at 600 chars", async () => {
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
    expect(html).toContain("<pre>");
    const preMatch = /<pre>([\s\S]*?)<\/pre>/.exec(html);
    expect(preMatch).not.toBeNull();
    const inner = preMatch![1];
    expect(inner.length).toBeLessThanOrEqual(601); // 600 chars + ellipsis
    expect(inner.endsWith("…")).toBe(true);
  });

  it("diff content is HTML-escaped", async () => {
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
    const html = api.edits.length > 0 ? api.edits[api.edits.length - 1][1] : api.sends[api.sends.length - 1];
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
});

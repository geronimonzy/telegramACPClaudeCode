import { describe, it, expect } from "vitest";
import { escapeHtml, mdToTelegramHtml, fenceState } from "../src/html.js";

// Minimal tag-balance checker: walks every <tag> / </tag> in the rendered
// HTML and verifies opens/closes nest correctly with nothing left open.
// Self-closing tags (ending in "/>") are ignored (none of ours are, but
// keeps this generic). This is the guard the brief calls for: Telegram
// rejects a message edit outright if the HTML isn't well-formed, so any
// pathological markdown input must still produce a balanced tag stream.
function isBalanced(html: string): boolean {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    const full = m[0];
    const name = m[1];
    if (full.startsWith("</")) {
      if (stack.pop() !== name) return false;
    } else if (!full.endsWith("/>")) {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

describe("escapeHtml", () => {
  it("escapes <, >, and & in plain text", () => {
    expect(escapeHtml("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });
});

describe("mdToTelegramHtml", () => {
  it("escapes <, >, & literally in plain text with no markdown", () => {
    expect(mdToTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d");
  });

  it("renders a fenced code block with a language tag, escaping contents", () => {
    const md = "```ts\nconst x = 1 < 2;\n```";
    expect(mdToTelegramHtml(md)).toBe(
      '<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>',
    );
  });

  it("renders a fenced code block with no language", () => {
    const md = "```\nplain\n```";
    expect(mdToTelegramHtml(md)).toBe("<pre><code>plain</code></pre>");
  });

  it("renders inline code, escaping contents and not processing markdown inside it", () => {
    const md = "Use `**not bold**` here";
    expect(mdToTelegramHtml(md)).toBe("Use <code>**not bold**</code> here");
  });

  it("renders bold text", () => {
    expect(mdToTelegramHtml("**bold**")).toBe("<b>bold</b>");
  });

  it("renders italic text with asterisks", () => {
    expect(mdToTelegramHtml("*italic*")).toBe("<i>italic</i>");
  });

  it("renders italic text with underscores", () => {
    expect(mdToTelegramHtml("_italic_")).toBe("<i>italic</i>");
  });

  it("renders a markdown link", () => {
    expect(mdToTelegramHtml("[text](https://example.com)")).toBe(
      '<a href="https://example.com">text</a>',
    );
  });

  it("renders a heading as bold", () => {
    expect(mdToTelegramHtml("## Title")).toBe("<b>Title</b>");
  });

  it("does not double-wrap a heading whose body is already bold", () => {
    expect(mdToTelegramHtml("## **Title** with `code`")).toBe(
      "<b>Title with <code>code</code></b>",
    );
  });

  it("never emits unbalanced or nested-invalid tags for pathological input", () => {
    const html = mdToTelegramHtml("**a`u`b**");
    expect(isBalanced(html)).toBe(true);
  });

  it("escapes a quote in a link href instead of breaking out of the attribute", () => {
    const html = mdToTelegramHtml('[text](https://example.com/"onmouseover="x)');
    expect(html).toContain("&quot;");
    expect(isBalanced(html)).toBe(true);
  });

  // Documented v1 limitation: bold markers that span an inline code run
  // (e.g. **bold `code` text**) are not recognized as bold, because the
  // bold and code regexes are applied to disjoint, already-split token
  // ranges (see splitInlineCode / renderInlineFormatting). The markers
  // fall through as literal, escaped asterisks — safe, just unstyled.
  it("leaves bold markers spanning inline code as literal, unstyled asterisks (v1 limitation)", () => {
    const html = mdToTelegramHtml("**bold `code` text**");
    expect(html).toContain("**bold ");
    expect(html).toContain(" text**");
    expect(html).not.toContain("<b>");
    expect(isBalanced(html)).toBe(true);
  });

  it("renders a fenced code block with a C++-style language tag", () => {
    const md = "```c++\nint x = 1;\n```";
    expect(mdToTelegramHtml(md)).toBe(
      '<pre><code class="language-c++">int x = 1;</code></pre>',
    );
  });

  it("tolerates CRLF line endings around a fence", () => {
    const md = "```ts\r\nconst x = 1;\r\n```";
    const html = mdToTelegramHtml(md);
    expect(html).toContain('<pre><code class="language-ts">');
    expect(isBalanced(html)).toBe(true);
  });
});

describe("fenceState", () => {
  it("returns the open fence's language when the text ends mid-fence", () => {
    expect(fenceState("a\n```ts\nx")).toBe("ts");
  });

  it('returns "" when the open fence has no language', () => {
    expect(fenceState("a\n```\nx")).toBe("");
  });

  it("returns null once the fence is closed", () => {
    expect(fenceState("a\n```ts\nx\n```\nmore text")).toBeNull();
  });

  it("returns null when there is no fence at all", () => {
    expect(fenceState("just text")).toBeNull();
  });

  it("returns a C++-style language tag containing a non-word character", () => {
    expect(fenceState("```c++\nx")).toBe("c++");
  });
});

import { describe, it, expect } from "vitest";
import {
  escapeRich,
  mdToRichHtml,
  richDetails,
  fitDetailsList,
} from "../src/telegram/rich-html.js";

// Void elements that legitimately have no closing tag in Rich HTML.
const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

// Tag-balance checker: every open tag must nest and close, ignoring void tags
// and self-closing (`/>`) tags. Rich Messages 400 on unbalanced markup, so this
// is the structural guard every emitted fragment must pass.
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

// The only named entities Rich HTML accepts; escaping must never emit any other.
const ALLOWED_NAMED_ENTITIES = new Set([
  "lt", "gt", "amp", "quot", "apos", "nbsp", "hellip",
  "mdash", "ndash", "lsquo", "rsquo", "ldquo", "rdquo",
]);

function onlyAllowedEntities(html: string): boolean {
  const re = /&([a-zA-Z]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (!ALLOWED_NAMED_ENTITIES.has(m[1])) return false;
  }
  return true;
}

describe("escapeRich", () => {
  it("escapes <, >, and & in plain text", () => {
    expect(escapeRich("<a & b>")).toBe("&lt;a &amp; b&gt;");
  });

  it("never emits an unsupported named entity", () => {
    const out = escapeRich('quotes "here" & <angles> © ™');
    expect(onlyAllowedEntities(out)).toBe(true);
  });

  it("does not double-escape", () => {
    expect(escapeRich("a & b")).toBe("a &amp; b");
    expect(escapeRich("a &amp; b")).toBe("a &amp;amp; b"); // literal &amp; is just text
  });
});

describe("mdToRichHtml — block types", () => {
  it("renders headings h1..h6", () => {
    for (let n = 1; n <= 6; n++) {
      const md = `${"#".repeat(n)} Title`;
      expect(mdToRichHtml(md)).toBe(`<h${n}>Title</h${n}>`);
    }
  });

  it("bold, italic, strikethrough, inline code", () => {
    expect(mdToRichHtml("**b**")).toContain("<b>b</b>");
    expect(mdToRichHtml("*i*")).toContain("<i>i</i>");
    expect(mdToRichHtml("_i_")).toContain("<i>i</i>");
    expect(mdToRichHtml("~~s~~")).toContain("<s>s</s>");
    expect(mdToRichHtml("`code`")).toContain("<code>code</code>");
  });

  it("fenced code block with language → nested pre>code with language class", () => {
    const md = "```ts\nconst x = 1 < 2;\n```";
    expect(mdToRichHtml(md)).toBe(
      '<pre><code class="language-ts">const x = 1 &lt; 2;</code></pre>',
    );
  });

  it("fenced code block without language → bare pre>code", () => {
    const md = "```\nplain\n```";
    expect(mdToRichHtml(md)).toBe("<pre><code>plain</code></pre>");
  });

  it("link → <a href> with escaped attribute", () => {
    const out = mdToRichHtml("see [docs](https://t.me/)");
    expect(out).toContain('<a href="https://t.me/">docs</a>');
  });

  it("blockquote → <blockquote>", () => {
    const out = mdToRichHtml("> quoted line");
    expect(out).toBe("<blockquote>quoted line</blockquote>");
    expect(isBalanced(out)).toBe(true);
  });

  it("bulleted list → <ul><li>", () => {
    const out = mdToRichHtml("- one\n- two\n- three");
    expect(out).toBe("<ul><li>one</li><li>two</li><li>three</li></ul>");
    expect(isBalanced(out)).toBe(true);
  });

  it("numbered list → <ol><li>", () => {
    const out = mdToRichHtml("1. first\n2. second");
    expect(out).toBe("<ol><li>first</li><li>second</li></ol>");
    expect(isBalanced(out)).toBe(true);
  });

  it("markdown table → <table> with <th> header row and <td> body cells", () => {
    const md = ["| Name | Age |", "| --- | --- |", "| Alice | 30 |", "| Bob | 25 |"].join("\n");
    const out = mdToRichHtml(md);
    expect(out).toContain("<table>");
    expect(out).toContain("<tr><th>Name</th><th>Age</th></tr>");
    expect(out).toContain("<tr><td>Alice</td><td>30</td></tr>");
    expect(out).toContain("<tr><td>Bob</td><td>25</td></tr>");
    expect(out).toContain("</table>");
    expect(isBalanced(out)).toBe(true);
  });

  it("table cells render inline formatting only", () => {
    const md = ["| a | b |", "| --- | --- |", "| **bold** | `code` |"].join("\n");
    const out = mdToRichHtml(md);
    expect(out).toContain("<td><b>bold</b></td>");
    expect(out).toContain("<td><code>code</code></td>");
  });

  // Regression (T17 review, Major): a `|` inside an inline code span was
  // treated as a cell boundary, producing phantom columns.
  it("a | inside an inline code span is cell content, not a boundary", () => {
    const md = ["| a | b |", "| --- | --- |", "| `x|y` | c |"].join("\n");
    const out = mdToRichHtml(md);
    expect(out).toContain("<td><code>x|y</code></td>");
    expect(out).toContain("<tr><td><code>x|y</code></td><td>c</td></tr>");
    expect(isBalanced(out)).toBe(true);
  });

  it("\\| is a GFM-escaped literal pipe, not a boundary", () => {
    const md = ["| a | b |", "| --- | --- |", "| x\\|y | c |"].join("\n");
    const out = mdToRichHtml(md);
    expect(out).toContain("<tr><td>x|y</td><td>c</td></tr>");
    expect(isBalanced(out)).toBe(true);
  });

  // Regression (T17 review, Major): ragged body rows shifted the column grid.
  it("ragged body rows are normalized to the header width", () => {
    const md = ["| a | b |", "| --- | --- |", "| 1 | 2 | 3 |", "| only |"].join("\n");
    const out = mdToRichHtml(md);
    // Extra cell dropped, short row padded — every row has exactly 2 cells.
    expect(out).toContain("<tr><td>1</td><td>2</td></tr>");
    expect(out).toContain("<tr><td>only</td><td></td></tr>");
    expect(isBalanced(out)).toBe(true);
  });

  it("horizontal rule → <hr/>", () => {
    expect(mdToRichHtml("---")).toBe("<hr/>");
  });

  it("plain paragraph → <p>", () => {
    expect(mdToRichHtml("just some text")).toBe("<p>just some text</p>");
  });

  it("escapes <, >, & in paragraph text", () => {
    const out = mdToRichHtml("a < b & c > d");
    expect(out).toContain("a &lt; b &amp; c &gt; d");
    expect(onlyAllowedEntities(out)).toBe(true);
  });
});

describe("mdToRichHtml — balance & safety", () => {
  const samples = [
    "**unbalanced",
    "a *b _c ~~d",
    "`open code",
    "[text](http://x.com/a\"b)",
    "# heading with <tag> & ampersand",
    "> quote with **bold** and `code`",
    "```js\nlet x = a < b && c > d;\n```",
    "| a | b\n| - | -\n| **x | `y |",
    "1. one\n2. two\n- mixed\n\npara\n\n## h2",
    "",
    "\n\n\n",
  ];

  it("every sample renders balanced HTML with only allowed entities", () => {
    for (const md of samples) {
      const out = mdToRichHtml(md);
      expect(isBalanced(out), `unbalanced for: ${JSON.stringify(md)}`).toBe(true);
      expect(onlyAllowedEntities(out), `bad entity for: ${JSON.stringify(md)}`).toBe(true);
    }
  });

  it("a URL containing a double quote stays a well-formed attribute", () => {
    const out = mdToRichHtml('[t](http://x.com/a"b)');
    expect(out).not.toMatch(/href="[^"]*"[^>]*"/); // no stray quote breaking the attr
    expect(out).toContain("&quot;");
    expect(isBalanced(out)).toBe(true);
  });
});

describe("richDetails", () => {
  it("wraps summary + body, open by default", () => {
    expect(richDetails("Sum", "<p>body</p>")).toBe(
      "<details open><summary>Sum</summary><p>body</p></details>",
    );
  });

  it("omits the open attribute when open=false", () => {
    expect(richDetails("Sum", "x", false)).toBe(
      "<details><summary>Sum</summary>x</details>",
    );
  });
});

describe("fitDetailsList", () => {
  it("wraps rows in <details><summary><ul>…</ul></details>", () => {
    const out = fitDetailsList({
      summary: "S",
      rows: ["<li>a</li>", "<li>b</li>"],
      max: 30000,
    });
    expect(out).toBe(
      "<details open><summary>S</summary><ul><li>a</li><li>b</li></ul></details>",
    );
    expect(isBalanced(out)).toBe(true);
  });

  it("empty rows → just the details/summary, no <ul>", () => {
    const out = fitDetailsList({ summary: "S", rows: [], max: 30000 });
    expect(out).toBe("<details open><summary>S</summary></details>");
    expect(isBalanced(out)).toBe(true);
  });

  it("drops the OLDEST rows past budget, inserts an indicator, keeps wrappers", () => {
    const rows = Array.from({ length: 200 }, (_, i) => `<li>row number ${i}</li>`);
    const out = fitDetailsList({ summary: "S", rows, max: 400 });
    expect(out.length).toBeLessThanOrEqual(400);
    expect(isBalanced(out)).toBe(true);
    expect(out.startsWith("<details open><summary>S</summary><ul>")).toBe(true);
    expect(out.endsWith("</ul></details>")).toBe(true);
    expect(out).toMatch(/<li><i>… \d+ earlier<\/i><\/li>/);
    expect(out).toContain("row number 199"); // newest survives
    expect(out).not.toContain("row number 0<"); // oldest dropped
  });
});

// Converts the markdown subset Claude emits into Telegram **Rich Message** HTML
// (Bot API 10.1 `rich_message.html`). Unlike classic Telegram HTML (see
// ../html.ts) Rich HTML natively supports headings, paragraphs, lists, tables,
// block quotes and collapsible `<details>` blocks, with a 32768-char budget.
//
// The same core invariant as the plain renderer holds: every tag is emitted as
// a complete open+close pair sourced from a single match, with its *contents*
// escaped rather than recursively re-parsed — so "no unbalanced/nested tags" is
// structurally true, not merely tested for. Only tags and named entities the
// research doc lists as supported are ever emitted; anything else is a 400.

/** Rich budget for a single message (Bot API 10.1: 32768 UTF-8 chars). */
export const RICH_MAX_LEN = 31000;

// Language tag may contain any non-whitespace, non-backtick characters; an
// optional trailing \r tolerates CRLF-terminated input.
const FENCE_RE = /^```([^\s`]*)\r?$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const ULIST_RE = /^\s*[-*+]\s+(.*)$/;
const OLIST_RE = /^\s*\d+\.\s+(.*)$/;
// A markdown table separator row: `| --- | :--: |` etc. (only dashes/colons).
const TABLE_SEP_RE = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * Escapes text for Rich HTML. Emits only entities the research doc lists as
 * supported (`&lt; &gt; &amp;`), so it can never introduce a rejected named
 * entity. A literal `"` is left as-is: it is a valid text character and only
 * needs escaping inside an attribute (see {@link escapeRichAttr}).
 */
export function escapeRich(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escapes a value for a double-quoted Rich HTML attribute (e.g. `href`). A
 * literal `"` would close the attribute early and break the markup, so it is
 * escaped to `&quot;` — one of the doc's allowed named entities.
 */
function escapeRichAttr(s: string): string {
  return escapeRich(s).replace(/"/g, "&quot;");
}

/** Splits inline text on `` `code` `` spans, preserving which parts are code. */
function splitInlineCode(text: string): Array<{ code: boolean; value: string }> {
  const tokens: Array<{ code: boolean; value: string }> = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) tokens.push({ code: false, value: text.slice(last, m.index) });
    tokens.push({ code: true, value: m[1] });
    last = re.lastIndex;
  }
  if (last < text.length) tokens.push({ code: false, value: text.slice(last) });
  return tokens;
}

// Link, bold, strikethrough, italic(*), italic(_) — checked in this order so
// `[x](y)` isn't mistaken for emphasis and `**x**` isn't split as two `*`.
const INLINE_RE =
  /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;

/** Applies link/bold/strike/italic to a non-code run, escaping literal text in between. */
function renderInlineFormatting(text: string): string {
  const re = new RegExp(INLINE_RE);
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += escapeRich(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += `<a href="${escapeRichAttr(m[2])}">${escapeRich(m[1])}</a>`;
    } else if (m[3] !== undefined) {
      out += `<b>${escapeRich(m[3])}</b>`;
    } else if (m[4] !== undefined) {
      out += `<s>${escapeRich(m[4])}</s>`;
    } else if (m[5] !== undefined) {
      out += `<i>${escapeRich(m[5])}</i>`;
    } else {
      out += `<i>${escapeRich(m[6])}</i>`;
    }
    last = re.lastIndex;
  }
  out += escapeRich(text.slice(last));
  return out;
}

/** Renders one line of inline content: code spans first, then link/bold/strike/italic. */
function renderInline(line: string): string {
  return splitInlineCode(line)
    .map((tok) => (tok.code ? `<code>${escapeRich(tok.value)}</code>` : renderInlineFormatting(tok.value)))
    .join("");
}

/** A markdown table row: a line whose trimmed text begins with `|`. */
function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/** True if `line` starts any block construct (used to bound paragraph runs). */
function isBlockStart(line: string): boolean {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    isTableRow(line) ||
    BLOCKQUOTE_RE.test(line) ||
    ULIST_RE.test(line) ||
    OLIST_RE.test(line)
  );
}

/** Split a `| a | b |` row into trimmed cell strings (outer pipes stripped). */
function splitCells(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/**
 * Converts the markdown subset Claude emits to Rich HTML: headings, paragraphs,
 * bold/italic/strikethrough/inline-code, fenced code blocks (with language),
 * links, block quotes, bulleted/numbered lists, tables, and horizontal rules.
 * Everything else is escaped and passed through as paragraph text. The result
 * is always a balanced sequence of supported tags.
 */
export function mdToRichHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block → nested <pre><code[ class=language-x]>.
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1];
      i++;
      const code: string[] = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence, if present
      const classAttr = lang ? ` class="language-${escapeRichAttr(lang)}"` : "";
      out.push(`<pre><code${classAttr}>${escapeRich(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Blank line: paragraph separator, nothing to emit.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Heading.
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (HR_RE.test(line)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // Table: a row followed by a separator row.
    if (isTableRow(line) && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const header = splitCells(line);
      i += 2; // consume header + separator
      const rows: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        rows.push(lines[i]);
        i++;
      }
      let table = "<table>";
      table += `<tr>${header.map((c) => `<th>${renderInline(c)}</th>`).join("")}</tr>`;
      for (const r of rows) {
        table += `<tr>${splitCells(r).map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`;
      }
      table += "</table>";
      out.push(table);
      continue;
    }

    // Block quote (consecutive `> ` lines).
    if (BLOCKQUOTE_RE.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length) {
        const m = BLOCKQUOTE_RE.exec(lines[i]);
        if (!m) break;
        quoted.push(renderInline(m[1]));
        i++;
      }
      out.push(`<blockquote>${quoted.join("<br/>")}</blockquote>`);
      continue;
    }

    // Unordered list.
    if (ULIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = ULIST_RE.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${renderInline(m[1])}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (OLIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = OLIST_RE.exec(lines[i]);
        if (!m) break;
        items.push(`<li>${renderInline(m[1])}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Paragraph: a run of consecutive plain lines, joined with <br/>.
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${para.map(renderInline).join("<br/>")}</p>`);
  }
  return out.join("\n");
}

/** Wrap `bodyHtml` in a collapsible `<details>` with a `<summary>` title. */
export function richDetails(summary: string, bodyHtml: string, open = true): string {
  return `<details${open ? " open" : ""}><summary>${summary}</summary>${bodyHtml}</details>`;
}

/**
 * Render a live status panel as `<details><summary>…</summary><ul>…rows…</ul></details>`,
 * keeping the whole payload within `max`. Rows are the panel body (each a
 * self-contained `<li>…</li>`); when they overflow the budget the OLDEST rows
 * are dropped and a `<li><i>… N earlier</i></li>` indicator takes their place.
 * The `<details>`/`<ul>` wrappers live outside the row set and are never
 * dropped, so the output is always balanced regardless of how many rows fit.
 */
export function fitDetailsList(opts: {
  summary: string;
  rows: string[];
  max: number;
  open?: boolean;
}): string {
  const { summary, rows, max } = opts;
  const open = opts.open ?? true;
  const openTag = `<details${open ? " open" : ""}><summary>${summary}</summary>`;
  const close = "</details>";
  if (rows.length === 0) return openTag + close;

  const indicator = (n: number): string => `<li><i>… ${n} earlier</i></li>`;
  const fixed = openTag.length + "<ul>".length + "</ul>".length + close.length;

  // Greedily keep the newest rows that fit, budgeting for the indicator once
  // anything is dropped.
  let runningLen = fixed;
  let kept = 0;
  for (let idx = rows.length - 1; idx >= 0; idx--) {
    const dropped = idx; // keeping idx..end drops rows 0..idx-1
    const withRow = runningLen + rows[idx].length;
    const indLen = dropped > 0 ? indicator(dropped).length : 0;
    if (withRow + indLen <= max) {
      runningLen = withRow;
      kept++;
    } else {
      break;
    }
  }
  // Even the single newest row overflows: keep it whole anyway — a slightly
  // over-budget but *balanced* payload beats a corrupted wrapper (renderers cap
  // row size well under budget, so this is a pathological last resort).
  if (kept === 0) kept = 1;

  const dropped = rows.length - kept;
  const body: string[] = [];
  if (dropped > 0) body.push(indicator(dropped));
  for (const r of rows.slice(rows.length - kept)) body.push(r);
  return `${openTag}<ul>${body.join("")}</ul>${close}`;
}

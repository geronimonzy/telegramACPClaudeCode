// Converts the markdown subset Claude emits into Telegram-safe HTML.
//
// Telegram's HTML parse mode only understands a handful of tags and is
// strict about them being well-formed (an unbalanced tag 400s the whole
// sendMessage/editMessageText call). So rather than pull in a general
// markdown parser (which would happily emit tags Telegram doesn't support,
// or nest tags Telegram rejects), this hand-rolls just the subset we need:
// fenced code blocks, inline code, bold, italic, links, and headings.
//
// The core invariant every code path here must preserve: every tag we
// write is emitted as a complete, non-nested open+close pair sourced from
// a single regex match, with its *contents* escaped rather than recursively
// re-parsed. That's what makes "no unbalanced/nested tags" structurally
// true instead of merely tested-for.

const FENCE_RE = /^```(\w*)$/;

/** Escapes the only three characters Telegram's HTML mode requires escaped. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Reports the language of a code fence left open at the end of `md`
 * ("" if the fence has no language tag), or null if `md` has no
 * unclosed fence. Used by the streaming splitter to re-open a fence
 * that got cut across a Telegram message boundary.
 */
export function fenceState(md: string): string | null {
  let open = false;
  let lang = "";
  for (const line of md.split("\n")) {
    const m = FENCE_RE.exec(line);
    if (m) {
      open = !open;
      if (open) lang = m[1];
    }
  }
  return open ? lang : null;
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

// Link, bold, italic(*), italic(_) — checked in this order so `[x](y)` isn't
// mistaken for `*`-flanked emphasis. Each alternative captures its own
// group; whichever group is defined identifies which construct matched.
const INLINE_RE = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_/g;

/** Applies link/bold/italic to a non-code run of text, escaping literal runs in between. */
function renderInlineFormatting(text: string): string {
  const re = new RegExp(INLINE_RE);
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out += `<a href="${escapeHtml(m[2])}">${escapeHtml(m[1])}</a>`;
    } else if (m[3] !== undefined) {
      out += `<b>${escapeHtml(m[3])}</b>`;
    } else if (m[4] !== undefined) {
      out += `<i>${escapeHtml(m[4])}</i>`;
    } else {
      out += `<i>${escapeHtml(m[5])}</i>`;
    }
    last = re.lastIndex;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

/** Renders one non-fence line: inline code spans first, then bold/italic/link on the rest. */
function renderLine(line: string): string {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  const body = heading ? heading[2] : line;
  const rendered = splitInlineCode(body)
    .map((tok) => (tok.code ? `<code>${escapeHtml(tok.value)}</code>` : renderInlineFormatting(tok.value)))
    .join("");
  return heading ? `<b>${rendered}</b>` : rendered;
}

/**
 * Converts the markdown subset Claude emits to Telegram HTML:
 * fenced code blocks, inline code, bold, italic, links, and headings.
 * Everything else is escaped and passed through literally.
 */
export function mdToTelegramHtml(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const fence = FENCE_RE.exec(lines[i]);
    if (fence) {
      const lang = fence[1];
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++; // consume closing fence line, if present
      const classAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${classAttr}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    } else {
      out.push(renderLine(lines[i]));
      i++;
    }
  }
  return out.join("\n");
}

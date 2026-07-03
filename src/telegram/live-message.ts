// Throttled Telegram message primitives.
//
// These classes are the only path between streamed agent output and Telegram's
// editMessageText API, so they exist to enforce three hard-won invariants:
//   1. At most one send/edit is ever in flight (two concurrent edits race and
//      produce out-of-order text — the OpenACP lesson).
//   2. We never edit a message to content it already shows (Telegram bills an
//      API call and briefly flickers the message for a no-op).
//   3. A malformed-HTML 400 never loses text: we retry once with the raw text
//      escaped as plain, and if even that fails we drop the flush and keep
//      buffering rather than throw into the streaming loop.
//
// The shared timing/reentrancy machinery lives in `Throttle`; `LiveMessage`
// and `MessageDraft` (draft.ts) just supply what to render and how to split.

import { escapeHtml } from "../html.js";
import { log } from "../log.js";

export interface MessageApi {
  send(html: string): Promise<number>; // sendMessage(HTML) → message_id
  edit(messageId: number, html: string): Promise<void>; // throws TgApiError on 4xx
}

/** Error the grammY-backed MessageApi (Task 10) throws for Telegram API errors. */
export class TgApiError extends Error {
  constructor(
    public readonly code: number,
    message = "",
  ) {
    super(message);
    this.name = "TgApiError";
  }
}

function isParseError(e: unknown): boolean {
  return e instanceof TgApiError && e.code === 400;
}

function logDrop(context: string, e: unknown): void {
  log.error({ err: e }, `[telegram] dropped ${context} flush after fallback failed`);
}

/**
 * Serializes send/edit delivery for one logical Telegram message stream.
 *
 * Timing model: leading-edge + trailing debounce. The first change after an
 * idle period is delivered immediately (so the user sees activity at once);
 * any change that lands while a delivery is in flight is coalesced and
 * delivered once, `intervalMs` after the in-flight delivery *settles*. This is
 * what guarantees invariant (1): a flush only ever launches from `notify`
 * (idle), from the trailing timer (idle), or from `flushNow` (after awaiting
 * the current flight) — never while one is already running.
 *
 * State (per the task brief): inflight, dirty, timer, lastDelivered.
 */
export class Throttle {
  private inflight: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** Last HTML actually delivered for the *current* message id (skip guard). */
  lastDelivered: string | undefined = undefined;
  /** Telegram message id once the first send resolves. */
  messageId: number | undefined = undefined;

  constructor(
    private readonly api: MessageApi,
    private readonly intervalMs: number,
    private readonly flushFn: (t: Throttle) => Promise<void>,
  ) {}

  /** Signal that content changed; delivers now if idle, else schedules trailing. */
  notify(): void {
    this.dirty = true;
    if (this.inflight || this.timer) return; // trailing path will pick it up
    this.launch(); // idle → leading edge
  }

  /** Mark more work pending from *inside* a flush (rollover continuation). */
  markDirty(): void {
    this.dirty = true;
  }

  private launch(): void {
    if (this.inflight || !this.dirty) return;
    this.dirty = false;
    this.inflight = (async () => {
      try {
        await this.flushFn(this);
      } finally {
        this.inflight = null;
        if (this.dirty) this.arm(); // changed during flight → trailing after interval
      }
    })();
  }

  private arm(): void {
    if (this.timer || this.inflight) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.launch();
    }, this.intervalMs);
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Deliver everything pending right now, bypassing the debounce interval.
   * Awaits any in-flight delivery, then drives flushes until nothing is dirty
   * (a rollover flush re-marks dirty via markDirty, so this drains all the
   * messages a finalize needs to emit). Idempotent: a no-op when idle+clean.
   */
  async flushNow(): Promise<void> {
    this.cancelTimer();
    while (this.inflight || this.dirty) {
      if (this.inflight) {
        await this.inflight;
        continue;
      }
      this.launch(); // idle + dirty
      await this.inflight;
    }
    // A flush that settled during the drain may have armed a trailing timer
    // whose work we already did; cancel it so nothing dangles.
    this.cancelTimer();
  }

  /**
   * The shared delivery primitive: skip-if-empty, skip-if-unchanged, then send
   * (no message yet) or edit, with a one-shot escaped-plain fallback on a 400
   * parse error. `rawFallback` is the un-rendered source so the fallback can
   * show the text literally instead of losing it. Empty `html` is always a
   * no-op — Telegram rejects an empty send/edit, and callers should never have
   * content to deliver that renders to nothing.
   */
  async push(html: string, rawFallback: string): Promise<void> {
    if (html === "") return; // belt-and-braces: never emit an empty send/edit
    if (html === this.lastDelivered) return; // invariant (2)
    try {
      await this.deliver(html);
      this.lastDelivered = html;
    } catch (e) {
      if (!isParseError(e)) {
        logDrop("message", e); // invariant (3): drop, keep buffering
        return;
      }
      const safe = escapeHtml(rawFallback);
      try {
        await this.deliver(safe);
        this.lastDelivered = safe;
      } catch (e2) {
        logDrop("message", e2);
      }
    }
  }

  private async deliver(html: string): Promise<void> {
    if (html === "") return; // belt-and-braces: never emit an empty send/edit
    if (this.messageId === undefined) {
      this.messageId = await this.api.send(html);
    } else {
      await this.api.edit(this.messageId, html);
    }
  }
}

const LIVE_MAX_LEN = 4000;

// The only tags the line-based renderers (activity.ts / plan.ts / permission
// prompts) ever emit. `truncateHtmlSafe` tracks these so a mid-line char cut
// can re-close whatever was left open.
const OPENABLE_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "a", "blockquote"]);

/**
 * Char-truncate a single balanced-HTML line to at most `max` characters
 * without ever cutting inside a `<...>` tag and without leaving a tag open:
 * any tags still open at the cut are closed (innermost first) before the
 * trailing ellipsis. Used only for an individual line that alone overflows
 * the budget; whole lines are kept verbatim by {@link truncate}.
 */
export function truncateHtmlSafe(line: string, max: number): string {
  if (line.length <= max) return line;
  const ELL = "…";
  const closersFor = (st: string[]): string =>
    [...st].reverse().map((t) => `</${t}>`).join("");

  let cutPos = 0;
  let cutClosers = "";
  const stack: string[] = [];
  let i = 0;
  while (i < line.length) {
    let next: number;
    const nextStack = stack.slice();
    if (line[i] === "<") {
      const end = line.indexOf(">", i);
      if (end === -1) {
        next = i + 1; // malformed '<' with no '>' → treat as a literal char
      } else {
        const tag = line.slice(i, end + 1);
        next = end + 1;
        const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
        if (m) {
          const name = m[2];
          if (m[1] === "/") {
            if (nextStack[nextStack.length - 1] === name) nextStack.pop();
          } else if (!tag.endsWith("/>") && OPENABLE_TAGS.has(name)) {
            nextStack.push(name);
          }
        }
      }
    } else {
      // Advance by 2 over a surrogate pair (e.g. the emoji rows start with,
      // "✅ 🔧 …") so we never cut between a high/low surrogate.
      const code = line.charCodeAt(i);
      const isHigh = code >= 0xd800 && code <= 0xdbff;
      const nextCode = isHigh ? line.charCodeAt(i + 1) : undefined;
      const isLow = nextCode !== undefined && nextCode >= 0xdc00 && nextCode <= 0xdfff;
      next = i + (isHigh && isLow ? 2 : 1);
    }
    const closers = closersFor(nextStack);
    if (next + closers.length + ELL.length <= max) {
      cutPos = next;
      cutClosers = closers;
      stack.length = 0;
      for (const t of nextStack) stack.push(t);
      i = next;
    } else {
      break;
    }
  }
  return line.slice(0, cutPos) + cutClosers + ELL;
}

// Tags whose raw `\n` content must never be treated as a line break: their
// content (e.g. a multi-line diff inside <pre>) is only balanced as a whole.
const LINE_PROTECTING_TAGS = new Set(["pre", "blockquote"]);

/**
 * Split HTML into *logical* lines: `\n` is a line break everywhere except
 * inside a `<pre>…</pre>` or `<blockquote>…</blockquote>` block, where the
 * raw newlines (e.g. a multi-line diff) are part of one balanced unit. A
 * depth counter (incremented/decremented on open/close of either tag) tracks
 * this; a `\n` only ends a logical line when depth === 0. Each returned
 * string is therefore an independently balanced HTML fragment, which is the
 * invariant {@link truncate} relies on to keep/drop whole lines safely.
 */
function splitLogicalLines(html: string): string[] {
  const lines: string[] = [];
  let current = "";
  let depth = 0;
  let i = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end !== -1) {
        const tag = html.slice(i, end + 1);
        const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(tag);
        if (m && LINE_PROTECTING_TAGS.has(m[2].toLowerCase())) {
          if (m[1] === "/") depth = Math.max(0, depth - 1);
          else if (!tag.endsWith("/>")) depth++;
        }
        current += tag;
        i = end + 1;
        continue;
      }
    }
    if (html[i] === "\n" && depth === 0) {
      lines.push(current);
      current = "";
      i++;
      continue;
    }
    current += html[i];
    i++;
  }
  lines.push(current);
  return lines;
}

/**
 * Tag-safe, line-aware truncation of LiveMessage content to `LIVE_MAX_LEN`.
 *
 * The content is a header line followed by one *independently balanced* HTML
 * line per row (see activity.ts / plan.ts) — where "line" means a *logical*
 * line per {@link splitLogicalLines}: a diff row's `<pre>…</pre>` can itself
 * span many raw newlines, and those stay glued to their `<pre>` as one unit.
 * When it overflows we keep the header and as many of the *newest* body
 * lines as fit whole (the newest rows matter most for a live feed), dropping
 * the oldest. If any were dropped an `<i>… N earlier</i>` indicator is
 * inserted right after the header. Whole lines are never cut, so every kept
 * line stays balanced; only an individual line that alone overflows is
 * char-truncated via {@link truncateHtmlSafe}.
 */
function truncate(html: string): string {
  if (html.length <= LIVE_MAX_LEN) return html;
  const lines = splitLogicalLines(html);
  const rawHeader = lines[0];
  const body = lines.slice(1);
  const total = body.length;
  if (total === 0) return truncateHtmlSafe(rawHeader, LIVE_MAX_LEN);
  // Guard: a header alone at/over the budget would otherwise be emitted
  // un-truncated (only the total===0 path truncated it before this fix).
  const header =
    rawHeader.length >= LIVE_MAX_LEN ? truncateHtmlSafe(rawHeader, LIVE_MAX_LEN) : rawHeader;

  const indicatorFor = (n: number): string => `<i>… ${n} earlier</i>`;

  // Greedily keep the newest body lines that fit whole, budgeting for the
  // header and (once anything is dropped) the indicator line.
  let runningLen = header.length;
  let kept = 0;
  for (let idx = total - 1; idx >= 0; idx--) {
    const dropped = idx; // keeping idx..end drops lines 0..idx-1
    const withLine = runningLen + 1 + body[idx].length; // "\n" + line
    const indicatorLen = dropped > 0 ? 1 + indicatorFor(dropped).length : 0;
    if (withLine + indicatorLen <= LIVE_MAX_LEN) {
      runningLen = withLine;
      kept++;
    } else {
      break;
    }
  }

  if (kept === 0) {
    // Even the newest single line doesn't fit whole → keep it, char-truncated.
    const dropped = total - 1;
    let overhead = header.length + 1; // header + "\n"
    if (dropped > 0) overhead += indicatorFor(dropped).length + 1;
    const budget = Math.max(1, LIVE_MAX_LEN - overhead);
    const parts = [header];
    if (dropped > 0) parts.push(indicatorFor(dropped));
    parts.push(truncateHtmlSafe(body[total - 1], budget));
    return parts.join("\n");
  }

  const dropped = total - kept;
  const parts = [header];
  if (dropped > 0) parts.push(indicatorFor(dropped));
  for (const l of body.slice(total - kept)) parts.push(l);
  return parts.join("\n");
}

/**
 * A single, latest-wins, editable Telegram message — used for status surfaces
 * (activity line, plan, permission prompt) where only the newest content
 * matters. `set` replaces the whole content; older sets in the same debounce
 * window are simply overwritten.
 */
export class LiveMessage {
  private content = "";
  private readonly t: Throttle;

  constructor(api: MessageApi, intervalMs: number) {
    this.t = new Throttle(api, intervalMs, async (t) => {
      await t.push(this.content, this.content);
    });
  }

  set(html: string): void {
    this.content = truncate(html);
    this.t.notify();
  }

  async flushNow(): Promise<void> {
    await this.t.flushNow();
  }

  get messageId(): number | undefined {
    return this.t.messageId;
  }
}

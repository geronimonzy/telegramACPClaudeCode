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

/* eslint-disable no-console */
function logDrop(context: string, e: unknown): void {
  console.error(`[telegram] dropped ${context} flush after fallback failed:`, e);
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
   * The shared delivery primitive: skip-if-unchanged, then send (no message
   * yet) or edit, with a one-shot escaped-plain fallback on a 400 parse error.
   * `rawFallback` is the un-rendered source so the fallback can show the text
   * literally instead of losing it.
   */
  async push(html: string, rawFallback: string): Promise<void> {
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
    if (this.messageId === undefined) {
      this.messageId = await this.api.send(html);
    } else {
      await this.api.edit(this.messageId, html);
    }
  }
}

const LIVE_MAX_LEN = 4000;

/** Truncates to `LIVE_MAX_LEN` graphemes-ish (chars) with a trailing ellipsis. */
function truncate(html: string): string {
  if (html.length <= LIVE_MAX_LEN) return html;
  return html.slice(0, LIVE_MAX_LEN - 1) + "…";
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

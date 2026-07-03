// Streaming agent text with rollover across Telegram's message-length limit.
//
// The buffer holds raw markdown (never rendered HTML) so we can re-measure and
// re-split it as it grows. When the rendered HTML would exceed `maxLen`, we
// finalize a prefix into the current message and start a fresh message for the
// remainder — closing and re-opening any code fence that straddled the cut so
// neither half is a syntactically broken ``` block.

import { mdToTelegramHtml, fenceState } from "../html.js";
import { type MessageApi, Throttle } from "./live-message.js";

const DEFAULT_MAX_LEN = 4000;

/**
 * Split a raw-markdown buffer whose render exceeds `maxLen` into a `prefix`
 * (renders ≤ maxLen, becomes the finalized message) and a `remainder` (the new
 * buffer). Cuts at the last newline whose prefix still fits; falls back to a
 * hard character cut when a single line overflows. If the prefix ends inside an
 * open code fence, the fence is closed in the prefix and re-opened at the top
 * of the remainder with the same language.
 */
export function splitForRollover(
  buffer: string,
  maxLen: number,
): { prefix: string; remainder: string } {
  // Binary search for the largest character count whose render still fits.
  // Render length is *not* monotone in raw length in general (closing a fence
  // can shorten output), but that's harmless here: `best` is only ever
  // assigned on the `<= maxLen` branch, so a later non-monotone dip can only
  // cause us to (safely) keep searching longer prefixes, never to accept one
  // that doesn't fit. And reopening a fence across the cut adds no net
  // rendered length, since an open fence is already auto-closed by
  // mdToTelegramHtml.
  let lo = 1;
  let hi = buffer.length;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (mdToTelegramHtml(buffer.slice(0, mid)).length <= maxLen) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  best = Math.max(best, 1); // always make progress, even if one char overflows

  // Prefer to cut on a line boundary at or before `best`.
  const nl = buffer.lastIndexOf("\n", best);
  let prefix: string;
  let remainder: string;
  if (nl > 0) {
    prefix = buffer.slice(0, nl);
    remainder = buffer.slice(nl + 1); // consume the boundary newline
  } else {
    // No usable newline in range → hard character cut.
    prefix = buffer.slice(0, best);
    remainder = buffer.slice(best);
  }

  const openLang = fenceState(prefix);
  if (openLang !== null) {
    prefix = prefix + "\n```";
    remainder = "```" + openLang + "\n" + remainder;
  }
  return { prefix, remainder };
}

/**
 * A growing agent-text message that rolls over into additional messages once it
 * would exceed Telegram's length limit. `append` adds raw markdown; delivery is
 * throttled and coalesced by the shared {@link Throttle}.
 */
export class MessageDraft {
  private buffer = "";
  private readonly maxLen: number;
  private readonly t: Throttle;

  constructor(api: MessageApi, opts: { intervalMs: number; maxLen?: number }) {
    this.maxLen = opts.maxLen ?? DEFAULT_MAX_LEN;
    this.t = new Throttle(api, opts.intervalMs, (t) => this.flushStep(t));
  }

  append(mdText: string): void {
    this.buffer += mdText;
    this.t.notify();
  }

  /** Cancel the pending timer and flush every remaining message immediately. */
  async finalize(): Promise<void> {
    // flushNow cancels the pending trailing timer, then drains all remaining
    // rollover messages without waiting on the debounce interval.
    await this.t.flushNow();
  }

  /**
   * One flush step: if the buffer fits, edit/send the current message; if it
   * overflows, finalize a prefix into the current message and hand the
   * remainder to a *new* message (delivered on the next flush — or immediately,
   * when draining inside finalize, since a rollover re-marks the throttle dirty).
   */
  private async flushStep(t: Throttle): Promise<void> {
    const rendered = mdToTelegramHtml(this.buffer);
    if (rendered.length <= this.maxLen) {
      await t.push(rendered, this.buffer);
      return;
    }
    const { prefix, remainder } = splitForRollover(this.buffer, this.maxLen);
    if (remainder === "") {
      // The cut landed exactly on trailing content (e.g. a boundary newline)
      // that contributed nothing to the next message — there is nothing to
      // roll over. Deliver the prefix into the *current* message and don't
      // retarget, or the next flush would send an empty string to a brand-new
      // message id.
      await t.push(mdToTelegramHtml(prefix), prefix);
      return;
    }
    await t.push(mdToTelegramHtml(prefix), prefix); // finalize current message
    // Retarget a brand-new message for the remainder.
    t.messageId = undefined;
    t.lastDelivered = undefined;
    this.buffer = remainder;
    t.markDirty(); // more to deliver
  }
}

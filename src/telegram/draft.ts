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

/** A markdown table row: a line whose trimmed text begins with `|`. */
function isTableRow(line: string): boolean {
  return line.trim().startsWith("|");
}

/** A line that begins a markdown list item (`- `, `* `, `+ `, or `1.`). */
function isListItem(line: string): boolean {
  return /^\s*([-*+]|\d+\.)\s/.test(line);
}

/**
 * Choose the raw index at which {@link splitForRollover} should cut, given the
 * binary-search `best` (largest raw index whose rendered prefix ≤ `maxLen`).
 * Returns a newline index (the boundary is consumed) or, when no usable newline
 * exists at/before `best`, `best` itself for a hard character cut.
 *
 * Priority (searching at/before `best`): (1) the closest paragraph separator
 * (`\n\s*\n`) whose prefix is ≥ a floor of `maxLen/2`; (2) the closest
 * block-boundary newline (table↔non-table, list↔non-list, or between two list
 * items), preferring ≥ floor but ignoring the floor if nothing qualifies;
 * (3) the last newline at/before `best`; (4) a hard char cut. Tiers 1–2 never
 * cut inside a code fence; tiers 2–3 never end the prefix mid-table — a
 * straddling table is rolled whole into the next message, unless that would
 * drop below the floor or the table alone exceeds `maxLen`, in which case the
 * cut falls on a table *row* boundary (never mid-row).
 */
export function chooseCut(buffer: string, best: number, maxLen: number): number {
  const floor = maxLen * 0.5;
  const lines = buffer.split("\n");
  const lineStart: number[] = [];
  {
    let off = 0;
    for (const ln of lines) {
      lineStart.push(off);
      off += ln.length + 1;
    }
  }
  const nlAfter = (i: number): number => lineStart[i] + lines[i].length;
  const insideFence = (idx: number): boolean => fenceState(buffer.slice(0, idx)) !== null;
  const renderedLen = (idx: number): number => mdToTelegramHtml(buffer.slice(0, idx)).length;

  // If a chosen newline falls in the middle of a table block, move the cut to
  // just before the table so the whole table rolls over — unless that drops
  // below the floor or the table alone won't fit, in which case keep the cut on
  // the row boundary (the `\n` guarantees it is never mid-row).
  const protectTable = (cut: number, i: number): number => {
    if (!(isTableRow(lines[i]) && isTableRow(lines[i + 1]))) return cut;
    let s = i;
    while (s > 0 && isTableRow(lines[s - 1])) s--;
    let e = i + 1;
    while (e + 1 < lines.length && isTableRow(lines[e + 1])) e++;
    if (s >= 1) {
      const before = lineStart[s] - 1; // newline ending line s-1
      const tableRendered = mdToTelegramHtml(lines.slice(s, e + 1).join("\n")).length;
      if (before > 0 && renderedLen(before) >= floor && tableRendered <= maxLen) {
        return before;
      }
    }
    return cut; // fall back to the row boundary
  };

  // Tier 1: paragraph separator — a blank (whitespace-only) line with content
  // before and after, closest to `best`, outside any fence, prefix ≥ floor.
  for (let i = lines.length - 2; i >= 1; i--) {
    if (lines[i].trim() !== "") continue;
    const cut = nlAfter(i);
    if (cut <= 0 || cut > best) continue;
    if (insideFence(cut)) continue;
    if (renderedLen(cut) < floor) continue;
    return cut;
  }

  // Tier 2: block-boundary newline (table/list edges, inter-item breaks).
  let blockFallback = -1;
  for (let i = lines.length - 2; i >= 0; i--) {
    const cut = nlAfter(i);
    if (cut <= 0 || cut > best) continue;
    if (insideFence(cut)) continue;
    const a = lines[i];
    const b = lines[i + 1];
    const listEdge = isListItem(a) || isListItem(b);
    const tableEdge = isTableRow(a) !== isTableRow(b);
    if (!listEdge && !tableEdge) continue;
    if (blockFallback === -1) blockFallback = cut; // closest block boundary ≤ best
    if (renderedLen(cut) >= floor) return protectTable(cut, i);
  }
  if (blockFallback !== -1) {
    // Recover the line index for the fallback boundary to apply table protection.
    const i = lineStart.findIndex((_, k) => nlAfter(k) === blockFallback);
    return protectTable(blockFallback, i);
  }

  // Tier 3: the last newline at/before best (current behaviour). Cuts inside a
  // fence are allowed here — the fence is re-opened across the boundary.
  const nl = buffer.lastIndexOf("\n", best);
  if (nl > 0) {
    if (insideFence(nl)) return nl;
    const i = lineStart.findIndex((_, k) => nlAfter(k) === nl);
    return i >= 0 ? protectTable(nl, i) : nl;
  }

  // Tier 4: no usable newline → hard character cut at `best`.
  return best;
}

/**
 * Split a raw-markdown buffer whose render exceeds `maxLen` into a `prefix`
 * (renders ≤ maxLen, becomes the finalized message) and a `remainder` (the new
 * buffer). The cut point is chosen by {@link chooseCut} — preferring paragraph,
 * then table/list, then any line boundary — and falls back to a hard character
 * cut when a single line overflows. If the prefix ends inside an open code
 * fence, the fence is closed in the prefix and re-opened at the top of the
 * remainder with the same language.
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

  // Choose a meaningful cut point (paragraph → table/list → any line → hard).
  const cut = chooseCut(buffer, best, maxLen);
  let prefix: string;
  let remainder: string;
  if (buffer[cut] === "\n") {
    prefix = buffer.slice(0, cut);
    remainder = buffer.slice(cut + 1); // consume the boundary newline
  } else {
    // No usable newline in range → hard character cut.
    prefix = buffer.slice(0, cut);
    remainder = buffer.slice(cut);
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

// Bridges ACP `session/request_permission` calls to Telegram inline keyboards.
//
// One PermissionBroker is shared per-process (not per-topic): `ask()` is
// called from AgentSession.onPermission (one call per pending tool-call
// authorization), and `resolve()` is called from the bot's callback_query
// handler once the user taps a button. The two sides are connected only by
// the compact `perm:{seq}:{optIndex}` callback_data — small enough to always
// fit Telegram's 64-byte callback_data limit regardless of option count.
//
// Protocol requirement: on session/cancel, every pending ask for that
// session's Telegram topic MUST settle as `{outcome:{outcome:"cancelled"}}`
// rather than being left to hang — that's what `cancelThread` is for.

import type * as acp from "@agentclientprotocol/sdk";
import { escapeHtml } from "../html.js";

export interface PermissionPrompt {
  html: string; // message text: 🔐 <b>Permission</b>: tool title + salient rawInput in <code>
  keyboard: Array<Array<{ text: string; callback_data: string }>>; // one row per option
}

const KIND_EMOJI: Record<acp.PermissionOptionKind, string> = {
  allow_once: "✅",
  allow_always: "♻️",
  reject_once: "❌",
  reject_always: "🚫",
};

const RAW_INPUT_TEXT_FIELDS = ["command", "cmd", "path", "file_path"];
const RAW_INPUT_MAX_LEN = 300;
const OPTION_NAME_MAX_LEN = 32;

interface PendingAsk {
  threadId: number;
  // Backfilled once `present()` resolves; stays undefined if a `resolve()`
  // (or `cancelThread()`) settles this entry before `present()` returns —
  // i.e. the tap won the race against the prompt actually being sent.
  messageId: number | undefined;
  options: acp.PermissionOption[];
  resolve: (r: acp.RequestPermissionResponse) => void;
}

/**
 * Truncates `s` to `max` Unicode code points (not UTF-16 code units),
 * appending an ellipsis if it was cut. Code-point aware so it never splits
 * a surrogate pair (e.g. an emoji) sitting at the boundary.
 */
function truncate(s: string, max: number): string {
  const codePoints = Array.from(s);
  return codePoints.length > max ? codePoints.slice(0, max).join("") + "…" : s;
}

/**
 * Best-effort extraction of the "salient" part of an unknown `rawInput`:
 * the first of a few conventionally-named string fields (a shell command or
 * a file path), or "" if none is present / rawInput isn't an object.
 */
function extractSalientInput(rawInput: unknown): string {
  if (rawInput === null || typeof rawInput !== "object") return "";
  const obj = rawInput as Record<string, unknown>;
  for (const key of RAW_INPUT_TEXT_FIELDS) {
    const value = obj[key];
    if (typeof value === "string") return value;
  }
  return "";
}

/** Button label for a permission option: kind emoji + name, truncated. */
function optionLabel(option: acp.PermissionOption): string {
  return `${KIND_EMOJI[option.kind]} ${truncate(option.name, OPTION_NAME_MAX_LEN)}`;
}

function buildPrompt(req: acp.RequestPermissionRequest, seq: number): PermissionPrompt {
  const title = req.toolCall.title ?? "";
  const salient = extractSalientInput(req.toolCall.rawInput);
  let html = `🔐 <b>Permission</b>: ${escapeHtml(title)}`;
  if (salient) {
    html += `\n<code>${escapeHtml(truncate(salient, RAW_INPUT_MAX_LEN))}</code>`;
  }
  const keyboard = req.options.map((option, idx) => [
    { text: optionLabel(option), callback_data: `perm:${seq}:${idx}` },
  ]);
  return { html, keyboard };
}

/**
 * Routes permission requests between AgentSession and Telegram inline
 * keyboards. Pending asks are keyed by a broker-global `seq` counter (never
 * reused), so collisions across topics/sessions are impossible for the
 * lifetime of the process.
 */
export class PermissionBroker {
  #seq = 0;
  #pending = new Map<number, PendingAsk>();

  /**
   * Registers the pending entry *before* calling `present` (so a fast tap
   * racing a slow `present()` can never find the map empty and be dropped),
   * then hands the prompt to `present` (which sends the Telegram message and
   * returns its message_id). Resolves once `resolve()` or `cancelThread()`
   * settles the matching pending entry.
   *
   * If `present()` rejects: when the entry is still unsettled, the entry is
   * removed and the rejection propagates to the caller. When an early tap
   * (or `cancelThread`) already settled the entry, the rejection is logged
   * and swallowed instead — the permission decision already stands, and only
   * the prompt message failed to render.
   */
  async ask(
    threadId: number,
    req: acp.RequestPermissionRequest,
    present: (p: PermissionPrompt) => Promise<number>,
  ): Promise<acp.RequestPermissionResponse> {
    const seq = this.#seq++;
    const prompt = buildPrompt(req, seq);

    return new Promise<acp.RequestPermissionResponse>((resolve, reject) => {
      const entry: PendingAsk = { threadId, messageId: undefined, options: req.options, resolve };
      this.#pending.set(seq, entry);

      present(prompt).then(
        (messageId) => {
          // Backfill only if still pending — an early tap/cancel may have
          // already settled (and deleted) this entry.
          if (this.#pending.has(seq)) {
            entry.messageId = messageId;
          }
        },
        (err: unknown) => {
          if (this.#pending.has(seq)) {
            this.#pending.delete(seq);
            reject(err);
          } else {
            // Already settled by an early tap or cancelThread(): the
            // permission decision stands, the prompt just failed to render.
            console.error(
              `permissions: present() failed for seq=${seq} after it was already settled by an early resolve/cancel`,
              err,
            );
          }
        },
      );
    });
  }

  /**
   * Called from the bot's callback_query handler with the tapped button's
   * `callback_data`. Returns undefined for malformed/unknown/already-settled
   * data (double-resolve is a no-op, not an error — Telegram can deliver a
   * duplicate callback_query on retry).
   *
   * `messageId` may be undefined when this tap won the race against the
   * still-in-flight `present()` call for the same ask (fast tap, slow send):
   * the caller should fall back to the callback query's own message id in
   * that case.
   */
  resolve(callbackData: string): { threadId: number; messageId: number | undefined; label: string } | undefined {
    const m = /^perm:(\d+):(\d+)$/.exec(callbackData);
    if (!m) return undefined;
    const seq = Number(m[1]);
    const idx = Number(m[2]);
    const entry = this.#pending.get(seq);
    if (!entry) return undefined;
    const option = entry.options[idx];
    if (!option) return undefined;

    this.#pending.delete(seq);
    entry.resolve({ outcome: { outcome: "selected", optionId: option.optionId } });
    return { threadId: entry.threadId, messageId: entry.messageId, label: optionLabel(option) };
  }

  /**
   * Settles every pending ask for `threadId` as cancelled. Required on
   * session/cancel so no ask()'s promise is left hanging forever.
   */
  cancelThread(threadId: number): void {
    for (const [seq, entry] of this.#pending) {
      if (entry.threadId !== threadId) continue;
      this.#pending.delete(seq);
      entry.resolve({ outcome: { outcome: "cancelled" } });
    }
  }
}

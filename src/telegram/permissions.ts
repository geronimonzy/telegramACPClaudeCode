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
  messageId: number;
  options: acp.PermissionOption[];
  resolve: (r: acp.RequestPermissionResponse) => void;
}

/** Truncates `s` to `max` chars, appending an ellipsis if it was cut. */
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
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
   * Builds the prompt, hands it to `present` (which sends the Telegram
   * message and returns its message_id), and resolves once `resolve()` or
   * `cancelThread()` settles the matching pending entry.
   */
  async ask(
    threadId: number,
    req: acp.RequestPermissionRequest,
    present: (p: PermissionPrompt) => Promise<number>,
  ): Promise<acp.RequestPermissionResponse> {
    const seq = this.#seq++;
    const prompt = buildPrompt(req, seq);
    const messageId = await present(prompt);
    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      this.#pending.set(seq, { threadId, messageId, options: req.options, resolve });
    });
  }

  /**
   * Called from the bot's callback_query handler with the tapped button's
   * `callback_data`. Returns undefined for malformed/unknown/already-settled
   * data (double-resolve is a no-op, not an error — Telegram can deliver a
   * duplicate callback_query on retry).
   */
  resolve(callbackData: string): { threadId: number; messageId: number; label: string } | undefined {
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

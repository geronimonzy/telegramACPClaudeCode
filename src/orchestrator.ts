// Per-topic turn orchestrator: the single place that owns one Telegram topic's
// conversation turn lifecycle.
//
// One TopicSession wraps one already-started {@link AgentSession}. The
// composition root wires the AgentSession's `onUpdate` / `onPermission` /
// `onExit` callbacks to call INTO this object's public
// {@link TopicSession.handleUpdate}, {@link TopicSession.handlePermission} and
// {@link TopicSession.handleAgentExit} methods — that is the only way agent
// events reach the orchestrator.
//
// Responsibilities, per turn:
//   - one turn runs at a time; extra prompts queue FIFO (cap 5, overflow drops
//     with a "queue full" notice);
//   - a typing heartbeat keeps Telegram's "typing…" indicator alive while the
//     turn is active;
//   - a fresh {@link MessageDraft} streams the agent's reply; Activity and Plan
//     renderers are created lazily on the first relevant update, each on its own
//     {@link LiveMessage};
//   - session updates are routed to the right surface;
//   - on settle the heartbeat stops, everything is flushed, and a non-`end_turn`
//     stop reason is surfaced as a one-off notice;
//   - a mid-turn agent death or a rejected `prompt()` never escapes unhandled —
//     it is caught, logged, and turned into a notice.

import type * as acp from "@agentclientprotocol/sdk";
import type { AgentSession } from "./acp/agent-session.js";
import type { InlineKeyboard } from "./bridge.js";
import type { Config } from "./config.js";
import { escapeHtml } from "./html.js";
import { log } from "./log.js";
import { MessageDraft } from "./telegram/draft.js";
import { LiveMessage, type MessageApi } from "./telegram/live-message.js";
import { mdToRichHtml, RICH_MAX_LEN } from "./telegram/rich-html.js";
import { ActivityRenderer } from "./telegram/activity.js";
import { PlanRenderer } from "./telegram/plan.js";
import type { PermissionBroker, PermissionPrompt } from "./telegram/permissions.js";

/**
 * The Telegram-topic-facing surface the orchestrator drives. Implemented over
 * grammY in Task 11; faked in tests. Every method targets the single topic this
 * TopicSession belongs to.
 */
export interface TopicUi {
  /** A fresh message sender bound to this topic (one per live surface). */
  messageApi(): MessageApi;
  /** Emit one `sendChatAction("typing")` for this topic. */
  typing(): void;
  /** Send a one-off message (errors, stop reasons, queue-full notices), optionally with an inline keyboard. */
  notify(html: string, keyboard?: InlineKeyboard): Promise<void>;
  /** Present a permission prompt; resolves with the sent message id. */
  presentPermission(p: PermissionPrompt): Promise<number>;
  /** Edit a previously-sent permission message (e.g. to show the decision). */
  editPermissionMessage(messageId: number, html: string): Promise<void>;
}

/** A cached usage snapshot for `/status`. */
export type UsageSnapshot = acp.UsageUpdate;

const MAX_QUEUED = 5;

function logError(context: string, e: unknown): void {
  log.error({ err: e }, `[orchestrator] ${context}`);
}

/** Human-readable notice for a non-`end_turn` stop reason. */
function stopReasonNotice(reason: acp.StopReason): string {
  switch (reason) {
    case "cancelled":
      return "⏹ cancelled";
    case "refusal":
      return "⚠️ refusal";
    case "max_tokens":
      return "⚠️ max tokens reached";
    case "max_turn_requests":
      return "⚠️ max turn requests reached";
    default:
      return `⚠️ ${reason}`;
  }
}

/** Collapse whitespace and strip markdown emphasis so a thought stays a clean one-liner. */
function oneLineThought(text: string): string {
  return text.replace(/\s+/g, " ").replace(/[*_`]/g, "").trim();
}

export interface TopicSessionDeps {
  agent: AgentSession;
  ui: TopicUi;
  broker: PermissionBroker;
  threadId: number;
  cfg: Pick<Config, "editIntervalMs" | "typingIntervalMs" | "showThoughts">;
}

export class TopicSession {
  /** Latest usage snapshot, cached for `/status`. */
  lastUsage: UsageSnapshot | undefined;

  readonly #agent: AgentSession;
  readonly #ui: TopicUi;
  readonly #broker: PermissionBroker;
  readonly #threadId: number;
  readonly #cfg: TopicSessionDeps["cfg"];

  #turnRunning = false;
  #disposed = false;
  #agentExited = false;
  // Set by cancel(), cleared at the start of the next turn (each prompt is a
  // fresh consent context). Guards against a permission request that arrives
  // after cancel()/dispose() registering a fresh pending ask nobody will ever
  // settle (broker.cancelThread only settles asks already pending at the time
  // it runs).
  #cancelledTurn = false;
  readonly #queue: acp.ContentBlock[][] = [];

  // Per-turn surfaces (undefined between turns).
  #draft: MessageDraft | undefined;
  #activity: ActivityRenderer | undefined;
  #plan: PlanRenderer | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(deps: TopicSessionDeps) {
    this.#agent = deps.agent;
    this.#ui = deps.ui;
    this.#broker = deps.broker;
    this.#threadId = deps.threadId;
    this.#cfg = deps.cfg;
  }

  /** The wrapped agent session (for mode/command queries by higher layers). */
  get agentSession(): AgentSession {
    return this.#agent;
  }

  /**
   * Enqueue a user prompt. If no turn is running it starts one (and drains any
   * prompts queued while it runs). If a turn is running the prompt joins the
   * FIFO queue (cap {@link MAX_QUEUED}); overflow is dropped with a notice.
   *
   * Resolves when the turn it started (and everything queued behind it) has
   * settled; resolves immediately when it merely enqueued behind a running turn.
   */
  async handleUserPrompt(blocks: acp.ContentBlock[]): Promise<void> {
    if (this.#disposed) return;
    if (this.#turnRunning) {
      if (this.#queue.length >= MAX_QUEUED) {
        await this.#ui.notify("⚠️ queue full — dropped a queued prompt");
        return;
      }
      this.#queue.push(blocks);
      return;
    }
    await this.#runTurnLoop(blocks);
  }

  /** Cancel the in-flight turn: tell the agent, then settle pending permissions. */
  async cancel(): Promise<void> {
    this.#cancelledTurn = true;
    await this.#agent.cancel();
    this.#broker.cancelThread(this.#threadId);
  }

  /**
   * Tear down: stop the heartbeat, drop any queued prompts, and settle pending
   * permissions. Does not cancel the agent itself — the composition root owns
   * the AgentSession's lifecycle.
   */
  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#stopHeartbeat();
    this.#queue.length = 0;
    this.#broker.cancelThread(this.#threadId);
  }

  // --- agent-event entry points (wired by the composition root) ------------

  /** Route one session update to the right live surface. */
  handleUpdate(u: acp.SessionUpdate): void {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") this.#draft?.append(u.content.text);
        break;
      case "agent_thought_chunk":
        if (this.#cfg.showThoughts && u.content.type === "text") {
          const line = oneLineThought(u.content.text);
          if (line) this.#draft?.append(`\n*${line}*\n`);
        }
        break;
      case "tool_call":
        this.#activityRenderer().onToolCall(u);
        break;
      case "tool_call_update":
        this.#activityRenderer().onToolCallUpdate(u);
        break;
      case "plan":
        this.#planRenderer().onPlan(u);
        break;
      case "usage_update":
        this.lastUsage = u;
        break;
      default:
        // Modes/commands/etc. are cached by AgentSession; nothing to render.
        break;
    }
  }

  /**
   * Bridge an agent permission request to Telegram via the broker. Captures the
   * prompt's message id from `present`; once the ask settles with a selection
   * and the id is known, reflects the decision back into the prompt message.
   * When the id is still unknown (a fast tap beat the send), the bot layer edits
   * the message via the callback context instead.
   */
  async handlePermission(
    req: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    // A permission request can race a cancel()/dispose() that already fired:
    // the agent may still emit `session/request_permission` for a tool call
    // in flight when the cancel was issued. Registering a fresh pending ask
    // at that point would leak it (broker.cancelThread only settles asks that
    // were already pending when it ran) and would put up an orphaned
    // Telegram prompt the agent may then block waiting on. Short-circuit
    // instead: settle as cancelled without ever calling broker.ask.
    if (this.#disposed || this.#cancelledTurn) {
      return { outcome: { outcome: "cancelled" } };
    }
    let messageId: number | undefined;
    const res = await this.#broker.ask(this.#threadId, req, async (p) => {
      messageId = await this.#ui.presentPermission(p);
      return messageId;
    });
    if (res.outcome.outcome === "selected" && messageId !== undefined) {
      const label = this.#optionLabel(req, res.outcome.optionId);
      await this.#ui.editPermissionMessage(
        messageId,
        `🔐 <b>Permission</b>: ${escapeHtml(req.toolCall.title ?? "")} — ${escapeHtml(label)}`,
      );
    }
    return res;
  }

  /** The agent process died: surface it. Also suppresses the turn-error notice. */
  handleAgentExit(_info: { code: number | null }): void {
    this.#agentExited = true;
    const keyboard: InlineKeyboard = {
      inline_keyboard: [[{ text: "🔄 Restart", callback_data: `restart:${this.#threadId}` }]],
    };
    void this.#ui
      .notify("💥 agent process died — /new to restart or tap Restart", keyboard)
      .catch((e) => logError("agent-exit notify failed", e));
  }

  // --- internals -----------------------------------------------------------

  async #runTurnLoop(first: acp.ContentBlock[]): Promise<void> {
    this.#turnRunning = true;
    try {
      let blocks: acp.ContentBlock[] | undefined = first;
      while (blocks) {
        await this.#runOneTurn(blocks);
        blocks = this.#queue.shift();
      }
    } finally {
      this.#turnRunning = false;
    }
  }

  async #runOneTurn(blocks: acp.ContentBlock[]): Promise<void> {
    // Each new turn is a fresh consent context: a cancel() from a prior turn
    // must not shadow permission requests belonging to this one.
    this.#cancelledTurn = false;
    this.#draft = new MessageDraft(this.#ui.messageApi(), {
      intervalMs: this.#cfg.editIntervalMs,
      maxLen: RICH_MAX_LEN,
      render: mdToRichHtml,
    });
    this.#activity = undefined;
    this.#plan = undefined;
    this.#startHeartbeat();

    try {
      const res = await this.#agent.prompt(blocks);
      this.#stopHeartbeat();
      await this.#finalizeRenderers();
      if (res.stopReason !== "end_turn") {
        await this.#ui.notify(stopReasonNotice(res.stopReason));
      }
    } catch (e) {
      // prompt() rejects with a raw error if the agent process dies mid-turn.
      // Never let that escape: log, flush what we have, and notify — unless the
      // dedicated agent-exit notice already fired for the same death.
      this.#stopHeartbeat();
      logError("turn failed", e);
      await this.#finalizeRenderers();
      if (!this.#agentExited) {
        await this.#ui.notify("⚠️ turn failed — see logs");
      }
    } finally {
      this.#stopHeartbeat();
      this.#draft = undefined;
      this.#activity = undefined;
      this.#plan = undefined;
    }
  }

  async #finalizeRenderers(): Promise<void> {
    try {
      await this.#draft?.finalize();
      await this.#activity?.finalizeTurn();
      await this.#plan?.finalizeTurn();
    } catch (e) {
      logError("finalize failed", e);
    }
  }

  #activityRenderer(): ActivityRenderer {
    if (!this.#activity) {
      this.#activity = new ActivityRenderer(
        new LiveMessage(this.#ui.messageApi(), this.#cfg.editIntervalMs, RICH_MAX_LEN),
      );
    }
    return this.#activity;
  }

  #planRenderer(): PlanRenderer {
    if (!this.#plan) {
      this.#plan = new PlanRenderer(
        new LiveMessage(this.#ui.messageApi(), this.#cfg.editIntervalMs, RICH_MAX_LEN),
      );
    }
    return this.#plan;
  }

  #startHeartbeat(): void {
    this.#typingSafe();
    this.#heartbeat = setInterval(() => this.#typingSafe(), this.#cfg.typingIntervalMs);
    this.#heartbeat.unref?.();
  }

  /**
   * `ui.typing()` is a best-effort heartbeat; per the brief it must never be
   * allowed to kill a turn. A synchronous throw at turn start would otherwise
   * propagate out of `#runOneTurn` before the try/catch is entered, and a
   * throw from inside the `setInterval` callback would become an uncaught
   * exception (timer callbacks aren't covered by any surrounding try/catch).
   * Guard both call sites here: log and continue.
   */
  #typingSafe(): void {
    try {
      this.#ui.typing();
    } catch (e) {
      logError("typing failed", e);
    }
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
  }

  #optionLabel(req: acp.RequestPermissionRequest, optionId: string): string {
    return req.options.find((o) => o.optionId === optionId)?.name ?? optionId;
  }
}

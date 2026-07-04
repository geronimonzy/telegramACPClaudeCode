// grammY glue: the only Telegram-transport-aware module.
//
// Kept deliberately thin — it (1) installs auto-retry, (2) enforces the
// security guards (allowlist + forum-chat) BEFORE any routing, for both
// messages and callback queries, (3) adapts grammY's Api to the transport-
// agnostic {@link BotApi} the Bridge depends on, and (4) normalizes inbound
// updates and hands them to the Bridge. All behaviour lives in bridge.ts.

import { Bot, GrammyError, InputFile, type Context } from "grammy";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Message } from "@grammyjs/types";
import type { Config } from "../config.js";
import { log } from "../log.js";
import { StateStore } from "../state.js";
import { TgApiError } from "./live-message.js";
import { Bridge, type BotApi, type IncomingMsg, type InlineKeyboard } from "../bridge.js";

/** Hard-exit grace period: if graceful shutdown hasn't finished by then, force exit. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The exact literal union grammY types `icon_color` as; our palette is a subset. */
type IconColor = 0x6fb9f0 | 0xffd67e | 0xcb86db | 0x8eee98 | 0xff93b2 | 0xfb6f5f;

/**
 * Re-throw a grammY API error as the transport-agnostic {@link TgApiError} the
 * Throttle/Bridge layers inspect (parse-error 400 fallback, deleted-topic
 * detection). Without this translation every GrammyError fails their
 * `instanceof TgApiError` checks and the structured handling never fires.
 */
async function tgCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof GrammyError) throw new TgApiError(e.error_code, e.description);
    throw e;
  }
}

/** Build the {@link BotApi} adapter over a grammY Bot bound to the forum chat. */
function makeBotApi(bot: Bot, cfg: Config): BotApi {
  const chatId = cfg.forumChatId;
  const HTML = {
    parse_mode: "HTML" as const,
    link_preview_options: { is_disabled: true },
  };
  return {
    async createForumTopic(name, iconColor): Promise<number> {
      const topic = await bot.api.createForumTopic(chatId, name, {
        icon_color: iconColor as IconColor,
      });
      return topic.message_thread_id;
    },
    async sendMessage(threadId, html, keyboard?: InlineKeyboard): Promise<number> {
      const m = await tgCall(() =>
        bot.api.sendMessage(chatId, html, {
          ...HTML,
          message_thread_id: threadId,
          reply_markup: keyboard,
        }),
      );
      return m.message_id;
    },
    async editMessageText(messageId, html): Promise<void> {
      await tgCall(() => bot.api.editMessageText(chatId, messageId, html, HTML));
    },
    async sendRich(threadId, html, keyboard?: InlineKeyboard): Promise<number> {
      // Low-level object form to sidestep grammY's positional-wrapper trap for
      // sendRichMessage (see scripts/spike-rich.ts / rich-messages.md).
      const m = await tgCall(() =>
        bot.api.raw.sendRichMessage({
          chat_id: chatId,
          message_thread_id: threadId,
          rich_message: { html },
          reply_markup: keyboard,
        }),
      );
      return m.message_id;
    },
    async editRich(messageId, html): Promise<void> {
      await tgCall(() =>
        bot.api.raw.editMessageText({
          chat_id: chatId,
          message_id: messageId,
          rich_message: { html },
        }),
      );
    },
    async sendChatAction(threadId, action): Promise<void> {
      await tgCall(() =>
        bot.api.sendChatAction(chatId, action as "typing", {
          message_thread_id: threadId,
        }),
      );
    },
    async sendDocument(threadId, filePath, caption?: string): Promise<void> {
      await bot.api.sendDocument(chatId, new InputFile(filePath), {
        message_thread_id: threadId,
        caption,
      });
    },
    async getFile(fileId): Promise<{ filePath?: string; fileSize?: number }> {
      const f = await bot.api.getFile(fileId);
      return { filePath: f.file_path, fileSize: f.file_size };
    },
    async downloadFile(filePath): Promise<Buffer> {
      const url = `https://api.telegram.org/file/bot${cfg.botToken}/${filePath}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`download failed: HTTP ${resp.status}`);
      return Buffer.from(await resp.arrayBuffer());
    },
    async pinChatMessage(_threadId, messageId): Promise<void> {
      await bot.api.pinChatMessage(chatId, messageId);
    },
    async setMyCommands(commands): Promise<void> {
      await bot.api.setMyCommands(commands, {
        scope: { type: "chat", chat_id: chatId },
      });
    },
    async closeForumTopic(threadId): Promise<void> {
      await bot.api.closeForumTopic(chatId, threadId);
    },
  };
}

/** Normalize a grammY message into the transport-agnostic {@link IncomingMsg}. */
function normalize(m: Message): IncomingMsg {
  const out: IncomingMsg = {};
  if (m.text) out.text = m.text;
  if (m.caption) out.caption = m.caption;
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1]!;
    out.photo = { fileId: largest.file_id, fileSize: largest.file_size };
  }
  if (m.document) {
    out.document = {
      fileId: m.document.file_id,
      fileName: m.document.file_name ?? "file",
      fileSize: m.document.file_size,
      mimeType: m.document.mime_type,
    };
  }
  return out;
}

/** A message's session-topic id, or undefined for the General topic. */
function threadOf(m: Message): number | undefined {
  return m.is_topic_message ? m.message_thread_id : undefined;
}

/**
 * The security guard predicate: allowlisted sender AND the configured forum
 * chat, for both messages and callback queries. Pure so it's unit-testable
 * without a grammY `Context`; the bot.ts middleware is a thin wrapper around
 * it.
 */
export function isAllowedUpdate(
  cfg: Pick<Config, "allowedUserIds" | "forumChatId">,
  from: { id: number } | undefined,
  chatId: number | undefined,
): boolean {
  if (from === undefined || !cfg.allowedUserIds.includes(from.id)) return false;
  if (chatId !== cfg.forumChatId) return false;
  return true;
}

/**
 * Boot the bot: build the Bridge, wire security guards + routing, register the
 * command list, reattach persisted sessions, and start long polling. Resolves
 * when polling stops (SIGINT/SIGTERM trigger a graceful shutdown).
 */
export async function runBot(cfg: Config): Promise<void> {
  const bot = new Bot(cfg.botToken);
  bot.api.config.use(autoRetry());

  const store = new StateStore(`${cfg.dataDir}/state.json`);
  const bridge = new Bridge(cfg, makeBotApi(bot, cfg), store);

  // SECURITY FIRST: allowlist + forum-chat guard run before any routing, for
  // messages AND callback queries. Non-matching updates are ignored silently.
  bot.use(async (ctx: Context, next) => {
    if (!isAllowedUpdate(cfg, ctx.from, ctx.chat?.id)) {
      log.debug(
        { chatId: ctx.chat?.id, fromId: ctx.from?.id },
        "update rejected by allowlist/chat guard",
      );
      return;
    }
    await next();
  });

  bot.on("message", async (ctx) => {
    try {
      await bridge.handleMessage(threadOf(ctx.message), normalize(ctx.message));
    } catch (e) {
      log.error({ err: e }, "[bot] handleMessage failed");
    }
  });

  bot.on("callback_query:data", async (ctx) => {
    let toast = "";
    try {
      const res = await bridge.handleCallback(
        ctx.callbackQuery.data,
        ctx.callbackQuery.message?.message_id,
      );
      toast = res?.toast ?? "";
    } catch (e) {
      log.error({ err: e }, "[bot] handleCallback failed");
    } finally {
      // Always answer a handled callback so the client's spinner clears.
      await ctx.answerCallbackQuery(toast ? { text: toast } : {}).catch(() => {});
    }
  });

  await bridge.init();
  log.info(
    { forumChatId: cfg.forumChatId, sessionCount: store.list().length },
    "bridge ready",
  );

  const stop = async (signal: string): Promise<void> => {
    log.info({ signal }, "shutting down");
    // Hard-exit safety net: if graceful shutdown hangs, force the process down
    // rather than leaving it stuck. unref'd so it never itself keeps the
    // process alive if shutdown finishes first.
    const hardExit = setTimeout(() => {
      log.error("shutdown did not complete in time; forcing exit");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    hardExit.unref();
    try {
      await runner.stop();
      await bridge.shutdown();
    } catch (e) {
      log.error({ err: e }, "shutdown failed");
    } finally {
      clearTimeout(hardExit);
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  // Use the concurrent runner rather than bot.start(): grammY's built-in
  // long polling handles updates strictly sequentially and will not poll for
  // new updates until the current handler returns. A prompt turn blocks its
  // handler for the whole turn (including while it waits for a permission
  // tap), so under bot.start() the Allow/Reject callback could never be
  // fetched — a hard deadlock on any turn that needs an interactive
  // permission. The runner processes the callback concurrently with the
  // blocked turn handler, which is what lets the tap through. Do NOT add
  // sequentialize keyed by chat/thread here: that would re-serialize a
  // permission callback behind its own topic's in-flight turn and
  // reintroduce the deadlock.
  const runner: RunnerHandle = run(bot);
  await runner.task();
}

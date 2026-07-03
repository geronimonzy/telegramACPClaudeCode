// grammY glue: the only Telegram-transport-aware module.
//
// Kept deliberately thin — it (1) installs auto-retry, (2) enforces the
// security guards (allowlist + forum-chat) BEFORE any routing, for both
// messages and callback queries, (3) adapts grammY's Api to the transport-
// agnostic {@link BotApi} the Bridge depends on, and (4) normalizes inbound
// updates and hands them to the Bridge. All behaviour lives in bridge.ts.

import { Bot, InputFile, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { Message } from "@grammyjs/types";
import type { Config } from "../config.js";
import { StateStore } from "../state.js";
import { Bridge, type BotApi, type IncomingMsg, type InlineKeyboard } from "../bridge.js";

/** The exact literal union grammY types `icon_color` as; our palette is a subset. */
type IconColor = 0x6fb9f0 | 0xffd67e | 0xcb86db | 0x8eee98 | 0xff93b2 | 0xfb6f5f;

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
      const m = await bot.api.sendMessage(chatId, html, {
        ...HTML,
        message_thread_id: threadId,
        reply_markup: keyboard,
      });
      return m.message_id;
    },
    async editMessageText(messageId, html): Promise<void> {
      await bot.api.editMessageText(chatId, messageId, html, HTML);
    },
    async sendChatAction(threadId, action): Promise<void> {
      await bot.api.sendChatAction(chatId, action as "typing", {
        message_thread_id: threadId,
      });
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
    const fromId = ctx.from?.id;
    if (fromId === undefined || !cfg.allowedUserIds.includes(fromId)) return;
    if (ctx.chat?.id !== cfg.forumChatId) return;
    await next();
  });

  bot.on("message", async (ctx) => {
    try {
      await bridge.handleMessage(threadOf(ctx.message), normalize(ctx.message));
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[bot] handleMessage failed:", e);
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
      // eslint-disable-next-line no-console
      console.error("[bot] handleCallback failed:", e);
    } finally {
      // Always answer a handled callback so the client's spinner clears.
      await ctx.answerCallbackQuery(toast ? { text: toast } : {}).catch(() => {});
    }
  });

  await bridge.init();

  const stop = async (): Promise<void> => {
    await bot.stop();
    await bridge.shutdown();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  await bot.start();
}

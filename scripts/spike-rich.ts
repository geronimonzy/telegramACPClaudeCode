// THROWAWAY SPIKE — proves Bot API 10.1 "Rich Messages" (sendRichMessage /
// editMessageText with rich_message) work live against our bot + forum group.
//
// Run: npx tsx scripts/spike-rich.ts
//
// IMPORTANT: this script only calls send/edit API methods. It never calls
// bot.start() or getUpdates — the production bridge is long-polling this
// same token right now, and a second poller would 409-conflict with it.
//
// If a human taps the inline button in the sent message, the running bridge
// will receive `spike:noop` as an unrecognized callback_data and answer it
// harmlessly. That's expected, not a bug.

import { homedir } from "node:os";
import { join } from "node:path";
import { Bot, GrammyError } from "grammy";
import { loadConfig } from "../src/config.js";

// Same resolution as src/index.ts: optional argv[2], else the default location.
const CONFIG_PATH =
  process.argv[2] ?? join(homedir(), ".config", "telegram-acp-bridge", "config.json");

function describeError(err: unknown): string {
  if (err instanceof GrammyError) {
    return `GrammyError ${err.error_code}: ${err.description} (method=${err.method})`;
  }
  if (err instanceof Error) {
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

// --- Part A grammar, exercised live ---

const SEND_HTML = `
<h2>Spike: Rich Message Prototype</h2>
<p>This paragraph has <b>bold</b>, <i>italic</i>, and <code>inline_code()</code> all in one line.</p>
<table>
<tr><th>Metric</th><th>Value</th><th>Status</th></tr>
<tr><td>Attempt</td><td>1</td><td align="center">running</td></tr>
<tr><td>Blocks used</td><td>5</td><td align="center">ok</td></tr>
</table>
<ul>
<li>First bullet point</li>
<li>Second bullet point</li>
<li>Third bullet point</li>
</ul>
<details>
<summary>Tap to expand: implementation notes</summary>
<p>This content is hidden by default and proves the <code>&lt;details&gt;</code> block renders as collapsible.</p>
</details>
<hr/>
<p>Sent by scripts/spike-rich.ts — safe to delete.</p>
`.trim();

const EDIT_HTML = `
<h2>Spike: Rich Message Prototype (EDITED)</h2>
<p>This paragraph has <b>bold</b>, <i>italic</i>, and <code>inline_code()</code> all in one line.</p>
<table>
<tr><th>Metric</th><th>Value</th><th>Status</th></tr>
<tr><td>Attempt</td><td>1</td><td align="center">running</td></tr>
<tr><td>Blocks used</td><td>5</td><td align="center">ok</td></tr>
<tr><td>Edit proof</td><td>appended</td><td align="center">done</td></tr>
</table>
<ul>
<li>First bullet point</li>
<li>Second bullet point</li>
<li>Third bullet point</li>
</ul>
<details>
<summary>Tap to expand: implementation notes</summary>
<p>This content is hidden by default and proves the <code>&lt;details&gt;</code> block renders as collapsible.</p>
</details>
<hr/>
<p>Edited in place by scripts/spike-rich.ts — proves streaming-style edits work with rich_message.</p>
`.trim();

async function main(): Promise<void> {
  const cfg = loadConfig(CONFIG_PATH);
  const bot = new Bot(cfg.botToken);

  console.log(`[spike-rich] target chat_id=${cfg.forumChatId} (General topic, no message_thread_id)`);

  // --- 1. sendRichMessage ---
  // NOTE: bot.api.sendRichMessage is a positional convenience wrapper —
  // (chat_id, rich_message, other, signal) — NOT a single args object.
  // (Passing a single object, as the raw `Api` method table in
  // @grammyjs/types/methods.d.ts suggests, silently lands the whole object
  // in the chat_id slot and Telegram replies 400 "rich message must be
  // non-empty". Use bot.api.raw.sendRichMessage({...}) if you want the
  // single-object shape instead.)
  let messageId: number;
  try {
    const sent = await bot.api.sendRichMessage(cfg.forumChatId, { html: SEND_HTML }, {
      reply_markup: {
        inline_keyboard: [[{ text: "Spike OK", callback_data: "spike:noop" }]],
      },
    });
    messageId = sent.message_id;
    console.log(`[spike-rich] sendRichMessage OK — message_id=${messageId}`);
  } catch (err) {
    console.error(`[spike-rich] sendRichMessage FAILED: ${describeError(err)}`);
    if (err instanceof GrammyError) {
      console.error(`[spike-rich] full payload sent: ${JSON.stringify(err.payload)}`);
    }
    process.exitCode = 1;
    return;
  }

  // --- 2. editMessageText with rich_message (edit-in-place, streaming proof) ---
  // Same convenience-wrapper caveat: editMessageText(chat_id, message_id,
  // text_or_rich_message, other, signal) — passing an object as the third
  // positional arg maps it straight to `rich_message`.
  try {
    await bot.api.editMessageText(cfg.forumChatId, messageId, { html: EDIT_HTML });
    console.log(`[spike-rich] editMessageText(rich_message) OK — message_id=${messageId}`);
  } catch (err) {
    console.error(`[spike-rich] editMessageText FAILED: ${describeError(err)}`);
    if (err instanceof GrammyError) {
      console.error(`[spike-rich] full payload sent: ${JSON.stringify(err.payload)}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("[spike-rich] DONE — both calls returned 200. Check Telegram for visual rendering.");
}

main().catch((err) => {
  console.error(`[spike-rich] unexpected error: ${describeError(err)}`);
  process.exitCode = 1;
});

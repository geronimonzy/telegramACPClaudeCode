import type { BotApi, InlineKeyboard } from "../../src/bridge.js";

/** A recording BotApi for driving the Bridge without a real Telegram connection. */
export class FakeBotApi implements BotApi {
  topics: Array<{ threadId: number; name: string; iconColor: number }> = [];
  messages: Array<{
    threadId: number | undefined;
    html: string;
    keyboard?: InlineKeyboard;
    messageId: number;
  }> = [];
  edits: Array<{ messageId: number; html: string }> = [];
  chatActions: Array<{ threadId: number | undefined; action: string }> = [];
  documents: Array<{ threadId: number; filePath: string; caption?: string }> = [];
  pins: Array<{ threadId: number | undefined; messageId: number }> = [];
  closed: number[] = [];
  commands: Array<{ command: string; description: string }> | undefined;

  /** Preloaded file metadata + bytes, keyed by file id / server path. */
  files = new Map<string, { filePath: string; fileSize: number }>();
  fileBytes = new Map<string, Buffer>();

  #nextThreadId = 100;
  #nextMessageId = 1;

  async createForumTopic(name: string, iconColor: number): Promise<number> {
    const threadId = this.#nextThreadId++;
    this.topics.push({ threadId, name, iconColor });
    return threadId;
  }

  async sendMessage(
    threadId: number | undefined,
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<number> {
    const messageId = this.#nextMessageId++;
    this.messages.push({ threadId, html, keyboard, messageId });
    return messageId;
  }

  async editMessageText(messageId: number, html: string): Promise<void> {
    this.edits.push({ messageId, html });
  }

  async sendChatAction(threadId: number | undefined, action: string): Promise<void> {
    this.chatActions.push({ threadId, action });
  }

  async sendDocument(threadId: number, filePath: string, caption?: string): Promise<void> {
    this.documents.push({ threadId, filePath, caption });
  }

  async getFile(fileId: string): Promise<{ filePath?: string; fileSize?: number }> {
    const f = this.files.get(fileId);
    return { filePath: f?.filePath, fileSize: f?.fileSize };
  }

  async downloadFile(filePath: string): Promise<Buffer> {
    return this.fileBytes.get(filePath) ?? Buffer.alloc(0);
  }

  async pinChatMessage(threadId: number | undefined, messageId: number): Promise<void> {
    this.pins.push({ threadId, messageId });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    this.commands = commands;
  }

  async closeForumTopic(threadId: number): Promise<void> {
    this.closed.push(threadId);
  }

  // --- test conveniences ---------------------------------------------------

  /** All message html sent to a topic (undefined = General), oldest first. */
  htmlFor(threadId: number | undefined): string[] {
    return this.messages.filter((m) => m.threadId === threadId).map((m) => m.html);
  }

  /** Every message html across all topics joined, for substring checks. */
  allHtml(): string {
    return this.messages.map((m) => m.html).join("\n");
  }
}

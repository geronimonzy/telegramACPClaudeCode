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
  edits: Array<{ messageId: number; html: string; keyboard?: InlineKeyboard }> = [];
  chatActions: Array<{ threadId: number | undefined; action: string }> = [];
  documents: Array<{ threadId: number; filePath: string; caption?: string }> = [];
  pins: Array<{ threadId: number | undefined; messageId: number }> = [];
  closed: number[] = [];
  commands: Array<{ command: string; description: string }> | undefined;

  /** Preloaded file metadata + bytes, keyed by file id / server path. */
  files = new Map<string, { filePath: string; fileSize: number }>();
  fileBytes = new Map<string, Buffer>();

  /** Thread ids whose topic was "deleted": thread-scoped calls throw. */
  deadThreads = new Set<number>();

  #nextThreadId = 100;
  #nextMessageId = 1;

  #throwIfDead(threadId: number | undefined): void {
    if (threadId !== undefined && this.deadThreads.has(threadId)) {
      throw new Error("Bad Request: message thread not found");
    }
  }

  /** Deleting a topic deletes its messages: edits to them fail like Telegram's. */
  #throwIfMessageDead(messageId: number): void {
    const m = this.messages.find((x) => x.messageId === messageId);
    if (m && m.threadId !== undefined && this.deadThreads.has(m.threadId)) {
      throw new Error("Bad Request: message to edit not found");
    }
  }

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
    this.#throwIfDead(threadId);
    const messageId = this.#nextMessageId++;
    this.messages.push({ threadId, html, keyboard, messageId });
    return messageId;
  }

  async editMessageText(messageId: number, html: string): Promise<void> {
    this.#throwIfMessageDead(messageId);
    this.edits.push({ messageId, html });
  }

  // Rich Messages share the same recording arrays as their plain counterparts so
  // existing content assertions apply regardless of dialect.
  async sendRich(
    threadId: number | undefined,
    html: string,
    keyboard?: InlineKeyboard,
  ): Promise<number> {
    this.#throwIfDead(threadId);
    const messageId = this.#nextMessageId++;
    this.messages.push({ threadId, html, keyboard, messageId });
    return messageId;
  }

  async editRich(messageId: number, html: string, keyboard?: InlineKeyboard): Promise<void> {
    this.#throwIfMessageDead(messageId);
    this.edits.push({ messageId, html, keyboard });
  }

  async sendChatAction(threadId: number | undefined, action: string): Promise<void> {
    this.#throwIfDead(threadId);
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

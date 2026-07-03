import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface SessionState {
  threadId: number; // Telegram message_thread_id
  acpSessionId: string;
  cwd: string;
  title: string;
  createdAt: string; // ISO
}

export class StateStore {
  private readonly filePath: string;
  private sessions = new Map<number, SessionState>();

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.sessions = new Map();
        return;
      }
      throw err;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`state: failed to parse JSON in ${this.filePath}`);
    }

    if (!Array.isArray(parsed)) {
      throw new Error(`state: expected a JSON array in ${this.filePath}`);
    }

    this.sessions = new Map(parsed.map((s: SessionState) => [s.threadId, s]));
  }

  get(threadId: number): SessionState | undefined {
    return this.sessions.get(threadId);
  }

  list(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  async upsert(s: SessionState): Promise<void> {
    this.sessions.set(s.threadId, s);
    await this.persist();
  }

  async remove(threadId: number): Promise<void> {
    this.sessions.delete(threadId);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.list(), null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }
}

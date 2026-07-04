import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export interface SessionState {
  threadId: number; // Telegram message_thread_id
  acpSessionId: string;
  cwd: string;
  title: string;
  createdAt: string; // ISO
  /**
   * How many bytes of the session's JSONL are already reflected in the topic
   * (CLI-mirroring cursor). Absent until the first mirror poll baselines it.
   */
  mirrorOffset?: number;
}

export class StateStore {
  private readonly filePath: string;
  private sessions = new Map<number, SessionState>();
  // Chain that serializes all persist() calls so concurrent upsert/remove
  // calls never race on the temp-file write/rename. Kept always-resolved
  // (errors are caught and swallowed here) so one failed persist doesn't
  // permanently wedge the queue for subsequent calls; the error is still
  // propagated to the caller that triggered it via the returned promise.
  private writeQueue: Promise<void> = Promise.resolve();

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
    // Link this call onto the shared queue so writes never overlap. The
    // queue itself must never reject (or every later call would inherit a
    // rejected promise and immediately fail), so failures are swallowed
    // inside the chain and re-thrown only to this call's own awaiter.
    const result = this.writeQueue.then(() => this.doPersist());
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
  }

  private async doPersist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.list(), null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }
}

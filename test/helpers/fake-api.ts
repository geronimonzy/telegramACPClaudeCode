import type { MessageApi } from "../../src/telegram/live-message.js";
import { TgApiError } from "../../src/telegram/live-message.js";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Records every send/edit and lets tests drive failures and in-flight gating.
 * - `failOnce(code)` makes the *next* send/edit for a given html reject once,
 *   then succeed (models Telegram's 400 parse error → escaped-plain retry).
 * - `gate()` returns a Deferred the next edit will await, so a test can hold an
 *   edit "in flight" and assert nothing else fires until it resolves.
 */
export class FakeApi implements MessageApi {
  sends: string[] = [];
  edits: Array<[number, string]> = [];
  private nextId = 1;

  /** html values that should reject with the given code exactly once. */
  private failOnceFor = new Map<string, number>();
  /** if set, the next edit awaits this before recording success. */
  private editGate: Deferred<void> | null = null;

  failOnce(html: string, code = 400): void {
    this.failOnceFor.set(html, code);
  }

  gate(): Deferred<void> {
    const d = deferred<void>();
    this.editGate = d;
    return d;
  }

  private maybeThrow(html: string): void {
    const code = this.failOnceFor.get(html);
    if (code !== undefined) {
      this.failOnceFor.delete(html);
      throw new TgApiError(code, `fake ${code}`);
    }
  }

  async send(html: string): Promise<number> {
    this.sends.push(html);
    this.maybeThrow(html);
    return this.nextId++;
  }

  async edit(messageId: number, html: string): Promise<void> {
    this.edits.push([messageId, html]);
    if (this.editGate) {
      const g = this.editGate;
      this.editGate = null;
      await g.promise;
    }
    this.maybeThrow(html);
  }
}

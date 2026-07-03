import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore, type SessionState } from "../src/state.js";

function tmpPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "state-"));
  return join(dir, "sessions.json");
}

const session1: SessionState = {
  threadId: 1,
  acpSessionId: "acp-1",
  cwd: "/tmp/proj1",
  title: "Session One",
  createdAt: "2026-07-03T00:00:00.000Z",
};

const session2: SessionState = {
  threadId: 2,
  acpSessionId: "acp-2",
  cwd: "/tmp/proj2",
  title: "Session Two",
  createdAt: "2026-07-03T00:01:00.000Z",
};

describe("StateStore", () => {
  it("round-trips upserted sessions across store instances", async () => {
    const path = tmpPath();
    const store = new StateStore(path);
    await store.load();
    await store.upsert(session1);
    await store.upsert(session2);

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.get(1)).toEqual(session1);
    expect(reloaded.get(2)).toEqual(session2);
    expect(reloaded.list()).toHaveLength(2);
    expect(reloaded.list()).toEqual(expect.arrayContaining([session1, session2]));
  });

  it("persists removal so a fresh store no longer sees it", async () => {
    const path = tmpPath();
    const store = new StateStore(path);
    await store.load();
    await store.upsert(session1);
    await store.upsert(session2);
    await store.remove(1);

    expect(store.get(1)).toBeUndefined();
    expect(store.list()).toHaveLength(1);

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.get(1)).toBeUndefined();
    expect(reloaded.get(2)).toEqual(session2);
    expect(reloaded.list()).toHaveLength(1);
  });

  it("load() on a nonexistent path yields an empty store", async () => {
    const path = tmpPath();
    const store = new StateStore(path);
    await store.load();
    expect(store.list()).toEqual([]);
    expect(store.get(1)).toBeUndefined();
  });

  it("load() throws with the file path in the message when JSON is corrupt", async () => {
    const path = tmpPath();
    writeFileSync(path, "{ not valid json");
    const store = new StateStore(path);
    await expect(store.load()).rejects.toThrow(path);
  });

  it("serializes concurrent upserts without rejection and persists all entries", async () => {
    const path = tmpPath();
    const store = new StateStore(path);
    await store.load();

    const sessions: SessionState[] = Array.from({ length: 10 }, (_, i) => ({
      threadId: i,
      acpSessionId: `acp-${i}`,
      cwd: `/tmp/proj${i}`,
      title: `Session ${i}`,
      createdAt: "2026-07-03T00:00:00.000Z",
    }));

    await expect(
      Promise.all(sessions.map((s) => store.upsert(s))),
    ).resolves.not.toThrow();

    const reloaded = new StateStore(path);
    await reloaded.load();
    expect(reloaded.list()).toHaveLength(10);
    for (const s of sessions) {
      expect(reloaded.get(s.threadId)).toEqual(s);
    }
  });
});

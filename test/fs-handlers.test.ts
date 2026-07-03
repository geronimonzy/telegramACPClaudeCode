import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as acp from "@agentclientprotocol/sdk";
import { makeFsHandlers } from "../src/acp/fs-handlers.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "fs-handlers-"));
}

describe("makeFsHandlers", () => {
  it("round-trips a write then a read", async () => {
    const handlers = makeFsHandlers();
    const dir = tmpDir();
    const path = join(dir, "note.txt");

    const writeResult = await handlers.writeTextFile!({
      sessionId: "s1",
      path,
      content: "hello\nworld\n",
    });
    expect(writeResult).toEqual({});

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("hello\nworld\n");

    const readResult = await handlers.readTextFile!({
      sessionId: "s1",
      path,
    });
    expect(readResult.content).toBe("hello\nworld\n");
  });

  it("mkdir -p's the parent directory before writing", async () => {
    const handlers = makeFsHandlers();
    const dir = tmpDir();
    const path = join(dir, "nested", "deeper", "note.txt");

    await handlers.writeTextFile!({ sessionId: "s1", path, content: "x" });

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("x");
  });

  it("overwrites an existing file", async () => {
    const handlers = makeFsHandlers();
    const dir = tmpDir();
    const path = join(dir, "note.txt");

    await handlers.writeTextFile!({ sessionId: "s1", path, content: "first" });
    await handlers.writeTextFile!({ sessionId: "s1", path, content: "second" });

    const onDisk = await readFile(path, "utf8");
    expect(onDisk).toBe("second");
  });

  it("slices by line (1-based) and limit (line count)", async () => {
    const handlers = makeFsHandlers();
    const dir = tmpDir();
    const path = join(dir, "lines.txt");
    const lines = ["one", "two", "three", "four", "five"];
    await handlers.writeTextFile!({
      sessionId: "s1",
      path,
      content: lines.join("\n") + "\n",
    });

    const result = await handlers.readTextFile!({
      sessionId: "s1",
      path,
      line: 2,
      limit: 2,
    });
    expect(result.content).toBe("two\nthree\n");
  });

  it("reads from a start line to EOF when limit is omitted", async () => {
    const handlers = makeFsHandlers();
    const dir = tmpDir();
    const path = join(dir, "lines.txt");
    const lines = ["one", "two", "three"];
    await handlers.writeTextFile!({
      sessionId: "s1",
      path,
      content: lines.join("\n") + "\n",
    });

    const result = await handlers.readTextFile!({
      sessionId: "s1",
      path,
      line: 2,
    });
    expect(result.content).toBe("two\nthree\n");
  });

  it("rejects with RequestError.resourceNotFound for a missing file", async () => {
    const handlers = makeFsHandlers();
    const dir = tmpDir();
    const path = join(dir, "missing.txt");

    await expect(
      handlers.readTextFile!({ sessionId: "s1", path }),
    ).rejects.toBeInstanceOf(acp.RequestError);
  });
});

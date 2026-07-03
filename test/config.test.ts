import { describe, it, expect } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

const valid = {
  botToken: "123:abc", forumChatId: -1001234567890, allowedUserIds: [42],
  defaultCwd: "/tmp",
};

function writeCfg(obj: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadConfig", () => {
  it("applies defaults for optional fields", () => {
    const cfg = loadConfig(writeCfg(valid));
    expect(cfg.editIntervalMs).toBe(1500);
    expect(cfg.typingIntervalMs).toBe(4500);
    expect(cfg.showThoughts).toBe(false);
    expect(cfg.adapterCommand).toHaveLength(1);
    expect(cfg.adapterCommand[0]).toMatch(/node_modules[/\\]\.bin[/\\]claude-agent-acp$/);
    expect(cfg.projects).toEqual({});
    expect(cfg.dataDir).toMatch(/telegram-acp-bridge/);
  });
  it("rejects missing/invalid fields, naming them", () => {
    expect(() => loadConfig(writeCfg({ botToken: 5 }))).toThrow(/botToken/);
    expect(() => loadConfig(writeCfg({ ...valid, allowedUserIds: [] }))).toThrow(/allowedUserIds/);
  });
});

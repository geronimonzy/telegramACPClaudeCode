#!/usr/bin/env node
// Process entry point: resolve the config path, load it, and hand off to the
// bot's composition root (runBot). Kept minimal — all wiring (Bridge,
// StateStore, signal handling, shutdown) lives in telegram/bot.ts.

import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { log } from "./log.js";
import { runBot } from "./telegram/bot.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "telegram-acp-bridge", "config.json");

function resolveConfigPath(argv: string[]): string {
  return argv[2] ?? DEFAULT_CONFIG_PATH;
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath(process.argv);

  let cfg: Config;
  try {
    cfg = loadConfig(configPath);
  } catch (e) {
    // Clean, one-line error — no stack trace — for a misconfigured/missing file.
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }

  log.info({ configPath }, "config loaded");

  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled rejection");
  });

  await runBot(cfg);
}

main().catch((e) => {
  log.error({ err: e }, "fatal error");
  process.exit(1);
});

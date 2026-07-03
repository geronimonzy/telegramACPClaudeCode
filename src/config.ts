import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  botToken: string;
  forumChatId: number;
  allowedUserIds: number[];
  defaultCwd: string;
  projects: Record<string, string>;
  editIntervalMs: number;
  typingIntervalMs: number;
  showThoughts: boolean;
  adapterCommand: string[];
  adapterEnv: Record<string, string>;
  dataDir: string;
}

const DEFAULT_EDIT_INTERVAL_MS = 1500;
const DEFAULT_TYPING_INTERVAL_MS = 4500;
const DEFAULT_SHOW_THOUGHTS = false;
const DEFAULT_ADAPTER_COMMAND = ["npx", "-y", "claude-agent-acp"];
const DEFAULT_DATA_DIR = "~/.local/share/telegram-acp-bridge";

function expandHome(path: string): string {
  if (path === "~" || path.startsWith("~/")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && !Number.isNaN(x));
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === "string")
  );
}

export function loadConfig(path: string): Config {
  const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("config: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (!isString(obj.botToken) || obj.botToken.length === 0) {
    errors.push("botToken must be a non-empty string");
  }

  if (!isNumber(obj.forumChatId)) {
    errors.push("forumChatId must be a number");
  }

  if (
    obj.allowedUserIds === undefined ||
    !isNumberArray(obj.allowedUserIds) ||
    obj.allowedUserIds.length === 0
  ) {
    errors.push("allowedUserIds must be a non-empty array of numbers");
  }

  if (!isString(obj.defaultCwd) || obj.defaultCwd.length === 0) {
    errors.push("defaultCwd must be a non-empty string");
  }

  if (obj.projects !== undefined && !isStringRecord(obj.projects)) {
    errors.push("projects must be an object mapping strings to strings");
  }

  if (obj.editIntervalMs !== undefined && !isNumber(obj.editIntervalMs)) {
    errors.push("editIntervalMs must be a number");
  }

  if (obj.typingIntervalMs !== undefined && !isNumber(obj.typingIntervalMs)) {
    errors.push("typingIntervalMs must be a number");
  }

  if (obj.showThoughts !== undefined && !isBoolean(obj.showThoughts)) {
    errors.push("showThoughts must be a boolean");
  }

  if (obj.adapterCommand !== undefined && (!isStringArray(obj.adapterCommand) || obj.adapterCommand.length === 0)) {
    errors.push("adapterCommand must be a non-empty array of strings");
  }

  if (obj.adapterEnv !== undefined && !isStringRecord(obj.adapterEnv)) {
    errors.push("adapterEnv must be an object mapping strings to strings");
  }

  if (obj.dataDir !== undefined && !isString(obj.dataDir)) {
    errors.push("dataDir must be a string");
  }

  if (errors.length > 0) {
    throw new Error("config: " + errors.join("; "));
  }

  return {
    botToken: obj.botToken as string,
    forumChatId: obj.forumChatId as number,
    allowedUserIds: obj.allowedUserIds as number[],
    defaultCwd: obj.defaultCwd as string,
    projects: (obj.projects as Record<string, string> | undefined) ?? {},
    editIntervalMs: (obj.editIntervalMs as number | undefined) ?? DEFAULT_EDIT_INTERVAL_MS,
    typingIntervalMs: (obj.typingIntervalMs as number | undefined) ?? DEFAULT_TYPING_INTERVAL_MS,
    showThoughts: (obj.showThoughts as boolean | undefined) ?? DEFAULT_SHOW_THOUGHTS,
    adapterCommand: (obj.adapterCommand as string[] | undefined) ?? DEFAULT_ADAPTER_COMMAND,
    adapterEnv: (obj.adapterEnv as Record<string, string> | undefined) ?? {},
    dataDir: expandHome((obj.dataDir as string | undefined) ?? DEFAULT_DATA_DIR),
  };
}

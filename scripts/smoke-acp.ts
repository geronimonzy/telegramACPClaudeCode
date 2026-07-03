// Live smoke test against the REAL claude-agent-acp adapter (no mocks).
//
// Run: npx tsx scripts/smoke-acp.ts
//
// Spawns the actual adapter binary, wires the real fs/terminal client
// handlers, sends one prompt, and prints what comes back. This exists to
// catch drift between our AgentSession usage and the real ACP wire
// protocol before any Telegram traffic touches it.

import { mkdir, writeFile } from "node:fs/promises";
import * as acp from "@agentclientprotocol/sdk";
import { AgentSession } from "../src/acp/agent-session.js";
import { makeFsHandlers } from "../src/acp/fs-handlers.js";
import { TerminalRegistry } from "../src/acp/terminals.js";

const SCRATCH_CWD =
  "/tmp/claude-1000/-home-kiril-telegramACPClaudeCode/f7209117-c9e5-4f5b-a3af-24b425e9a637/scratchpad/smoke-cwd";
const TIMEOUT_MS = 120_000;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function describeUpdate(u: acp.SessionUpdate): string {
  if (u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk" || u.sessionUpdate === "agent_thought_chunk") {
    const text = u.content.type === "text" ? truncate(u.content.text, 80) : `<${u.content.type}>`;
    return `${u.sessionUpdate}: ${text}`;
  }
  return u.sessionUpdate;
}

let activeSession: AgentSession | undefined;

async function main(): Promise<void> {
  await mkdir(SCRATCH_CWD, { recursive: true });
  await writeFile(`${SCRATCH_CWD}/hello.txt`, "hello from the smoke test\n", "utf8");

  const terminals = new TerminalRegistry();

  console.log(`[smoke] cwd=${SCRATCH_CWD}`);
  console.log("[smoke] spawning npx claude-agent-acp ...");

  const session = await AgentSession.start({
    cwd: SCRATCH_CWD,
    spawn: { command: ["npx", "claude-agent-acp"] },
    client: { ...makeFsHandlers(), ...terminals.handlers() },
    onUpdate: (u) => console.log(`[update] ${describeUpdate(u)}`),
    onPermission: async (req) => {
      console.log(`[permission] ${req.toolCall.title ?? "(no title)"}`);
      const rejectOpt =
        req.options.find((o) => o.kind.startsWith("reject_")) ?? req.options[0]!;
      console.log(`[permission] auto-selecting: ${rejectOpt.name} (${rejectOpt.kind})`);
      return { outcome: { outcome: "selected", optionId: rejectOpt.optionId } };
    },
    onExit: (info) => console.log(`[exit] code=${info.code}`),
  });

  activeSession = session;
  console.log(`[smoke] session started: ${session.sessionId}`);

  const res = await session.prompt([
    { type: "text", text: "Say hello and list the files in this directory." },
  ]);

  console.log(`[smoke] stopReason=${res.stopReason}`);
  console.log(`[smoke] availableCommands=${session.availableCommands.length}`);
  console.log(`[smoke] availableModes=${JSON.stringify(session.availableModes())}`);

  await session.dispose();
  terminals.disposeAll();
  console.log("[smoke] OK");
}

const timeout = setTimeout(() => {
  console.error("[smoke] TIMEOUT after 120s — killing");
  void activeSession?.dispose().finally(() => process.exit(1));
  // Belt-and-suspenders: force exit even if dispose() hangs.
  setTimeout(() => process.exit(1), 5000).unref?.();
}, TIMEOUT_MS);
timeout.unref?.();

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[smoke] FAILED:", err);
    process.exit(1);
  });

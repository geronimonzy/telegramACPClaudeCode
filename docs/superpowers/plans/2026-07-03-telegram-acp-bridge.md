# Telegram ↔ Claude Code ACP Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Linux systemd service that bridges Telegram forum topics to Claude Code sessions over ACP — streaming replies, live tool-call/plan progress, inline permission buttons, full slash-command and mode support.

**Architecture:** The bridge is a headless ACP *client*. Each forum topic owns one `claude-agent-acp` subprocess (JSON-RPC over stdio via `@agentclientprotocol/sdk`'s `ClientSideConnection`). A per-topic orchestrator routes `session/update` notifications to Telegram renderers (streamed draft message, activity message, plan message) and answers `session/request_permission` via inline keyboards. State (topic↔session map) persists to a JSON file so sessions reattach via `session/load` after restart.

**Tech Stack:** TypeScript (strict), Node ≥ 22, `@agentclientprotocol/sdk@1.1.0` (pinned), `@agentclientprotocol/claude-agent-acp` (pinned minor), `grammy` + `@grammyjs/auto-retry`, `pino`, `vitest`.

**Reference material (read before your task if it touches that area):**
- `.frugal-fable/research/sdk-client-api.md` — exact SDK signatures (Client interface, connection methods, all SessionUpdate variants). **Ground truth for all ACP types.**
- `.frugal-fable/research/telegram.md` — exact Bot API contracts (forum topics, rate limits, HTML parse mode).
- `.frugal-fable/research/acp.md` — protocol semantics (permission flow, plan replace semantics, dual mode APIs).
- `docs/superpowers/specs/2026-07-03-telegram-acp-bridge-design.md` — the approved spec.

## Global Constraints

- Node ≥ 22 (needs stable `Writable.toWeb`/`Readable.toWeb`). `"type": "module"`, TS `strict: true`.
- Pin `@agentclientprotocol/sdk` to exact `1.1.0`; `@agentclientprotocol/claude-agent-acp` to `~0.55.0`. Do NOT use the deprecated `@zed-industries/*` packages.
- Telegram: HTML parse mode everywhere (never MarkdownV2). Escape only `< > &` in text runs. `link_preview_options: { is_disabled: true }` on all sends/edits.
- Every Telegram send/edit/action for a session carries `message_thread_id`.
- Message edits per chat debounced to ≥ 1500 ms (`editIntervalMs` config). Text per message capped at 4000 rendered chars (rollover before Telegram's 4096 hard cap).
- Every incoming update (messages AND callback queries) is rejected unless `from.id` is in `allowedUserIds` and the chat is `forumChatId`. No default-open mode.
- License: MIT. No code copied from OpenACP (design reference only).
- Tests: vitest, fake timers for all throttle logic, no network in tests. Every task ends with `npm test` green and a commit.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Project scaffold + config loader

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` (extend), `src/config.ts`, `config.example.json`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `interface Config { botToken: string; forumChatId: number; allowedUserIds: number[]; defaultCwd: string; projects: Record<string, string>; editIntervalMs: number; typingIntervalMs: number; showThoughts: boolean; adapterCommand: string[]; adapterEnv: Record<string, string>; dataDir: string; }` and `function loadConfig(path: string): Config` (throws `Error` with a message naming every invalid/missing field).

- [ ] **Step 1: Scaffold**

```jsonc
// package.json
{
  "name": "telegram-acp-bridge",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@agentclientprotocol/sdk": "1.1.0",
    "@agentclientprotocol/claude-agent-acp": "~0.55.0",
    "grammy": "^1.44.0",
    "@grammyjs/auto-retry": "^2.0.2",
    "pino": "^9.0.0"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "^4.0.0",
    "vitest": "^3.0.0",
    "@types/node": "^22.0.0"
  }
}
```

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "outDir": "dist", "rootDir": "src",
    "declaration": false, "sourceMap": true, "skipLibCheck": true
  },
  "include": ["src"]
}
```

`vitest.config.ts`: `export default { test: { include: ["test/**/*.test.ts"] } }` (typed via `vitest/config` `defineConfig`). Append to `.gitignore`: `data/`, `config.json`.

Run: `npm install` — Expected: lockfile created, no errors.

- [ ] **Step 2: Write the failing test**

```ts
// test/config.test.ts
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
    expect(cfg.adapterCommand).toEqual(["npx", "-y", "claude-agent-acp"]);
    expect(cfg.projects).toEqual({});
    expect(cfg.dataDir).toMatch(/telegram-acp-bridge/);
  });
  it("rejects missing/invalid fields, naming them", () => {
    expect(() => loadConfig(writeCfg({ botToken: 5 }))).toThrow(/botToken/);
    expect(() => loadConfig(writeCfg({ ...valid, allowedUserIds: [] }))).toThrow(/allowedUserIds/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails** — `npx vitest run test/config.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 4: Implement `src/config.ts`** — plain hand-rolled validation (no schema dep): read file, `JSON.parse`, validate each field's type, collect all error strings, throw `new Error("config: " + errors.join("; "))` if any; fill defaults exactly as tested (`dataDir` default `~/.local/share/telegram-acp-bridge`, expand leading `~` via `os.homedir()`). `allowedUserIds` must be a non-empty number array. Also write `config.example.json` with all fields + comments-as-`_comment` keys.

- [ ] **Step 5: Run test to verify it passes** — `npx vitest run test/config.test.ts` — Expected: PASS.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: scaffold project and config loader"`

---

### Task 2: Session state store (JSON, atomic)

**Files:**
- Create: `src/state.ts`
- Test: `test/state.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SessionState {
  threadId: number;        // Telegram message_thread_id
  acpSessionId: string;
  cwd: string;
  title: string;
  createdAt: string;       // ISO
}
export class StateStore {
  constructor(filePath: string);
  async load(): Promise<void>;                 // missing file => empty store
  get(threadId: number): SessionState | undefined;
  async upsert(s: SessionState): Promise<void>;   // persists (write temp + rename)
  async remove(threadId: number): Promise<void>;  // persists
  list(): SessionState[];
}
```

- [ ] **Step 1: Write the failing test** — round-trip: `upsert` two sessions, new `StateStore` on same path, `load()`, `get`/`list` return them; `remove` persists; `load()` on nonexistent path yields empty; corrupt JSON file → `load()` throws with file path in message.
- [ ] **Step 2: Run** `npx vitest run test/state.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** — in-memory `Map<number, SessionState>`; persist whole map as JSON array via `writeFile(tmp)` + `rename(tmp, filePath)` (atomic on same fs); `mkdir -p` parent dir on first persist.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: session state store with atomic JSON persistence"`

---

### Task 3: HTML rendering (`escapeHtml`, `mdToTelegramHtml`)

**Files:**
- Create: `src/html.ts`
- Test: `test/html.test.ts`

**Interfaces:**
- Produces: `escapeHtml(s: string): string`; `mdToTelegramHtml(md: string): string` — converts the markdown subset Claude emits to Telegram-HTML: fenced code blocks → `<pre><code class="language-x">` (escaped contents, language optional), inline `` `code` `` → `<code>`, `**bold**` → `<b>`, `*italic*`/`_italic_` → `<i>`, `[text](url)` → `<a href="url">`, headings (`#`..`######`) → `<b>line</b>`, everything else escaped literally. Also `fenceState(md: string): string | null` — returns the open fence's language ("" if none) when `md` ends inside an unclosed ``` fence, else `null` (used by the draft splitter to re-open fences across message rollovers).

- [ ] **Step 1: Write the failing test** — cases: escapes `<>&` in plain text; fenced block with language produces `<pre><code class="language-ts">` and escapes `<` inside; inline code escapes contents and does NOT process `**` inside it; bold/italic/links; heading; `fenceState("a\n\`\`\`ts\nx")` → `"ts"`, closed fence → `null`; no nested-tag output for `**a`ub`b**`-style pathological input (assert output parses: balanced tags via a simple tag-stack check helper in the test).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — single pass: split on fence delimiters first (```` /^```(\w*)$/m ````), render code segments verbatim-escaped; for text segments, tokenize inline code spans first, then apply bold/italic/link/heading regexes to non-code tokens; escape every literal run. Keep it ~120 lines; no external markdown dep (YAGNI — Telegram supports so few tags that a real parser buys nothing).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: markdown-to-Telegram-HTML renderer"`

---

### Task 4: Mock ACP agent test fixture

**Files:**
- Create: `test/helpers/mock-agent.ts`
- Test: `test/mock-agent.test.ts`

**Interfaces:**
- Produces (test-only):
```ts
import * as acp from "@agentclientprotocol/sdk";
export function streamPair(): [acp.Stream, acp.Stream]; // cross-wired TransformStreams
export type TurnScript = Array<
  | { update: acp.SessionUpdate }                                  // emit session/update
  | { permission: { options: acp.PermissionOption[]; toolCallId: string } } // ask permission, record outcome
  | { sleepMs: number }
>;
export class MockAgent implements acp.Agent {
  constructor(conn: () => acp.AgentSideConnection);   // set post-construction via wireMockAgent
  script: TurnScript[];                 // one entry per prompt() call, consumed in order
  received: acp.PromptRequest[];        // every prompt payload
  permissionOutcomes: acp.RequestPermissionResponse[];
  lastStopReason: acp.StopReason;       // what the next prompt resolves with (default "end_turn")
  cancelled: boolean;                   // set when cancel() arrives; active turn resolves "cancelled"
  // initialize() returns loadSession:true, promptCapabilities {image:true, embeddedContext:true};
  // newSession() returns sessionId "sess_mock_1", modes {currentModeId:"default", availableModes:[default,plan,acceptEdits]},
  //   and configOptions [{id:"mode",category:"mode",type:"select",currentValue:"default",options:[...same three]}];
  // setSessionMode/setSessionConfigOption record the value and emit current_mode_update + config_option_update;
  // loadSession() succeeds for sessionId "sess_mock_1", else throws RequestError.resourceNotFound().
}
export function wireMockAgent(script?: TurnScript[]): { agent: MockAgent; clientStream: acp.Stream };
```
- Consumes: `@agentclientprotocol/sdk` — `AgentSideConnection`, exact `Agent` interface from `.frugal-fable/research/sdk-client-api.md` §6.

- [ ] **Step 1: Write the failing test** — wire a raw `acp.ClientSideConnection` (inline minimal `Client`: `sessionUpdate` collects, `requestPermission` picks `options[0]`) to `wireMockAgent(...)`'s clientStream; script one turn: two `agent_message_chunk` updates + one permission + a `tool_call`; assert: `initialize()` echoes protocol v1 and `loadSession: true`; `newSession` returns modes AND configOptions; after `prompt()` resolves `end_turn`, the client collected 3 updates in order and the mock recorded the `selected/optionId` outcome.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement `mock-agent.ts`** — `streamPair` = two `TransformStream<acp.AnyMessage>`s cross-wired (`{writable: a.writable, readable: b.readable}` / `{writable: b.writable, readable: a.readable}`); `prompt()` walks the script entry: for `update` → `conn.sessionUpdate({sessionId, update})`; for `permission` → `await conn.requestPermission(...)` push outcome; for `sleepMs` → setTimeout promise; checks `this.cancelled` between steps and resolves `{stopReason:"cancelled"}`. `cancel()` sets the flag.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "test: in-process mock ACP agent fixture"`

---

### Task 5: `AgentSession` (ACP client core)

**Files:**
- Create: `src/acp/agent-session.ts`
- Test: `test/agent-session.test.ts` (uses mock agent)

**Interfaces:**
- Consumes: `wireMockAgent` (Task 4); SDK types per cheat-sheet.
- Produces:
```ts
export interface AgentSessionOptions {
  cwd: string;
  onUpdate: (u: acp.SessionUpdate) => void;
  onPermission: (req: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
  onExit: (info: { code: number | null }) => void;   // fires once on subprocess/connection death
  spawn?: { command: string[]; env?: Record<string, string> }; // production path
  stream?: acp.Stream;                                          // test injection path
  loadSessionId?: string;                             // if set, try session/load instead of session/new
  client?: Partial<acp.Client>;                       // extra handlers merged in (fs/terminal from Task 6)
}
export class AgentSession {
  static async start(opts: AgentSessionOptions): Promise<AgentSession>; // spawn/connect + initialize + new-or-load
  readonly sessionId: string;
  readonly loaded: boolean;                    // true if attached via session/load
  availableCommands: acp.AvailableCommand[];   // kept current from available_commands_update
  currentModeId: string | undefined;           // kept current from current_mode_update / config_option_update
  availableModes(): Array<{ id: string; name: string }>; // configOptions category "mode" preferred, modes fallback
  async prompt(blocks: acp.ContentBlock[]): Promise<acp.PromptResponse>;
  get turnActive(): boolean;
  async cancel(): Promise<void>;               // session/cancel notification
  async setMode(modeId: string): Promise<void>; // setSessionConfigOption(configId:"mode") if config option exists, else setSessionMode
  async dispose(): Promise<void>;              // kill subprocess (SIGTERM, SIGKILL after 3s), close connection
}
```

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-session.test.ts — core cases
it("start → prompt streams updates and resolves end_turn", async () => {
  const { agent, clientStream } = wireMockAgent([[
    { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } },
    { update: { sessionUpdate: "available_commands_update", availableCommands: [{ name: "review", description: "d" }] } },
  ]]);
  const updates: acp.SessionUpdate[] = [];
  const s = await AgentSession.start({ cwd: "/tmp", stream: clientStream,
    onUpdate: (u) => updates.push(u), onPermission: async (r) => ({ outcome: { outcome: "selected", optionId: r.options[0].optionId } }), onExit: () => {} });
  expect(s.sessionId).toBe("sess_mock_1");
  expect(s.availableModes().map(m => m.id)).toContain("plan");
  const res = await s.prompt([{ type: "text", text: "hello" }]);
  expect(res.stopReason).toBe("end_turn");
  expect(updates).toHaveLength(2);
  expect(s.availableCommands[0].name).toBe("review");   // cached from update
});
```
Plus: `setMode("plan")` → mock recorded a `setSessionConfigOption` (NOT `setSessionMode`, since mock advertises configOptions) and `currentModeId` becomes `"plan"` after the emitted update; `cancel()` mid-turn (script `sleepMs: 200`) → prompt resolves `"cancelled"`; `loadSessionId: "sess_mock_1"` → `loaded === true`; `loadSessionId: "sess_other"` → falls back to `session/new`, `loaded === false`; permission request routed through `onPermission`.

- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — build stream: injected, or `spawn(command[0], command.slice(1), { stdio: ["pipe","pipe","inherit"], env: {...process.env, ...env} })` + `acp.ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!))`. Construct `new acp.ClientSideConnection(() => clientImpl, stream)` where `clientImpl` = `{ sessionUpdate: (n) => { this.ingest(n.update); }, requestPermission: (r) => opts.onPermission(r), ...opts.client }`. `initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: "telegram-acp-bridge", version: "0.1.0" } })`. If `loadSessionId` && init result `agentCapabilities?.loadSession` → try `loadSession({ sessionId, cwd, mcpServers: [] })` (catch → fall back to `newSession`); during load-replay, **suppress** `user_message_chunk`/`agent_message_chunk` from `onUpdate` (replay flag until loadSession resolves). `ingest` switch: cache `available_commands_update` / `current_mode_update` / `config_option_update` (update `currentModeId` from the option with `category === "mode"`), always forward to `onUpdate`. Wire `connection.closed.then(...)` + child `"exit"` → single `onExit` fire. `dispose`: child SIGTERM, 3s timer → SIGKILL.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: AgentSession ACP client core with load/new, modes, cancel"`

---

### Task 6: fs + terminal client handlers

**Files:**
- Create: `src/acp/fs-handlers.ts`, `src/acp/terminals.ts`
- Test: `test/fs-handlers.test.ts`, `test/terminals.test.ts`

**Interfaces:**
- Produces:
```ts
// fs-handlers.ts
export function makeFsHandlers(): Pick<acp.Client, "readTextFile" | "writeTextFile">;
// readTextFile: real fs, honors params.line (1-based start line) + params.limit (line count); ENOENT → throw acp.RequestError.resourceNotFound(path)
// writeTextFile: mkdir -p parent, write; returns {}

// terminals.ts
export class TerminalRegistry {
  handlers(): Pick<acp.Client, "createTerminal" | "terminalOutput" | "waitForTerminalExit" | "killTerminal" | "releaseTerminal">;
  disposeAll(): void;   // SIGKILL every live child (bridge shutdown)
}
```
- `createTerminal`: `spawn(command, args, { cwd, env: merged })`, capture stdout+stderr interleaved into a buffer; enforce `outputByteLimit` by trimming from the FRONT at char boundary, set `truncated`. `terminalOutput`: current buffer + `exitStatus` (`{ exitCode, signal }`) if exited. `waitForTerminalExit`: promise resolved on exit. `killTerminal`: SIGKILL, id stays valid. `releaseTerminal`: kill if running + delete id; subsequent calls with that id → `RequestError.invalidParams`.

- [ ] **Step 1: Write the failing tests** — fs: write-then-read round-trip in a tmpdir; `line`/`limit` slicing; missing file → rejects with `RequestError`. terminals: `createTerminal({command:"sh",args:["-c","printf 'out'; printf 'err' 1>&2"]})` → `waitForTerminalExit` → `terminalOutput` contains both `out` and `err`, `exitCode 0`; `outputByteLimit: 4` on a 10-byte output → `truncated: true`, buffer is the LAST 4 bytes; `killTerminal` on `sh -c "sleep 30"` → exit with signal; `releaseTerminal` then `terminalOutput` → rejects.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** both modules (~60 lines fs, ~110 lines terminals).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: fs and terminal ACP client handlers"`

---

### Task 7: Throttled Telegram messages — `LiveMessage` + `MessageDraft`

**Files:**
- Create: `src/telegram/live-message.ts`, `src/telegram/draft.ts`
- Test: `test/live-message.test.ts`, `test/draft.test.ts`

**Interfaces:**
- Consumes: `mdToTelegramHtml`, `escapeHtml`, `fenceState` (Task 3).
- Produces:
```ts
export interface MessageApi {                      // implemented over grammY in Task 10; faked in tests
  send(html: string): Promise<number>;             // sendMessage(HTML, thread) → message_id
  edit(messageId: number, html: string): Promise<void>; // throws TgApiError{code:400|429,...}
}
export class LiveMessage {                          // single latest-wins editable message (activity/plan/permission text)
  constructor(api: MessageApi, intervalMs: number);
  set(html: string): void;                          // replaces content; truncates to 4000 with "…"
  async flushNow(): Promise<void>;                  // bypass debounce (final states)
  get messageId(): number | undefined;
}
export class MessageDraft {                          // streaming agent text with rollover
  constructor(api: MessageApi, opts: { intervalMs: number; maxLen?: number /*default 4000*/ });
  append(mdText: string): void;
  async finalize(): Promise<void>;                  // cancel timer, flush remainder
}
```
- Shared behavior (both classes): at most one edit in flight; if content changed during flight, schedule next flush `intervalMs` after the previous one settled; skip edit when rendered HTML equals last delivered; on 400 (parse error) retry once with `escapeHtml(raw)` plain fallback; 429s are the auto-retry plugin's job in prod — treat api errors after fallback as: log-and-continue (drop that flush, keep buffering).
- `MessageDraft` rollover: buffer is raw markdown; before flush, render; if rendered length > `maxLen`, cut raw buffer at the last `\n` whose prefix renders ≤ `maxLen` (fall back to hard character cut if a single line overflows); flush+finalize prefix into current message; if `fenceState(prefix)` is open, append closing ``` to prefix and prepend ```` ```lang\n ```` to the remainder; remainder becomes the new buffer targeting a NEW message (`send` on next flush).

- [ ] **Step 1: Write the failing tests** — with `vi.useFakeTimers()` and a `FakeApi` that records `send`/`edit` calls and can be told to reject:
  - LiveMessage: two rapid `set`s → exactly one `send` then one `edit` after `intervalMs`; identical content → no second edit; in-flight edit + new `set` → second edit fires only after first resolves + interval.
  - Draft: chunks accumulate, single message edited progressively; 9000-char input (with newlines) → exactly 3 messages via rollover, none over 4000 rendered; rollover inside a ```ts fence → message N ends with ```` ``` ```` and message N+1 starts with ```` ```ts ````; `finalize()` flushes pending remainder immediately; 400-error path falls back to escaped plain text.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — share the flush loop via a small internal `Throttle` helper class in `live-message.ts` (state: `inflight`, `dirty`, `lastDelivered`, `timer`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: throttled LiveMessage and streaming MessageDraft with rollover"`

---

### Task 8: Activity + Plan renderers

**Files:**
- Create: `src/telegram/activity.ts`, `src/telegram/plan.ts`
- Test: `test/activity.test.ts`, `test/plan.test.ts`

**Interfaces:**
- Consumes: `LiveMessage` (Task 7); `ToolCall`/`ToolCallUpdate`/`PlanEntry` types.
- Produces:
```ts
export class ActivityRenderer {
  constructor(live: LiveMessage);
  onToolCall(tc: acp.ToolCall & { sessionUpdate: "tool_call" }): void;
  onToolCallUpdate(u: acp.ToolCallUpdate & { sessionUpdate: "tool_call_update" }): void;
  async finalizeTurn(): Promise<void>;   // flushNow; marks still-running calls as ❌ cancelled
}
export class PlanRenderer {
  constructor(live: LiveMessage);
  onPlan(p: { entries: acp.PlanEntry[] }): void;  // full-replace semantics (protocol rule)
  async finalizeTurn(): Promise<void>;
}
```
- Activity line format (HTML): `{statusEmoji} {kindIcon} <b>{escaped title}</b>` — status: pending ⏳ / in_progress 🔄 / completed ✅ / failed ❌; kind icons: read 📖, edit ✏️, delete 🗑, move 📦, search 🔍, execute 💻, think 💭, fetch 🌐, switch_mode 🔀, other 🔧. Merge updates by `toolCallId` (partial fields: only overwrite non-null). A `diff` content item appends a `<pre>` block capped at 600 chars (head+"…"). Header line: `<b>Activity</b>`.
- Plan format: `<b>Plan</b>` header, one line per entry — pending ☐ / in_progress 🔄 / completed ☑ + escaped content; priority `high` appends ‼️.

- [ ] **Step 1: Write the failing tests** — feed tool_call then tool_call_update(completed) → rendered text shows ✅ and keeps the original title (update had `title: null`); unknown toolCallId in update → creates the row (protocol allows it); diff content renders truncated `<pre>`; plan: full replace (second `onPlan` with 1 entry shows exactly 1); finalizeTurn marks a still-`in_progress` call ❌.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (each ~70 lines; renderers only build strings and call `live.set`).
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: tool-call activity and plan renderers"`

---

### Task 9: Permission broker + inline keyboard mapping

**Files:**
- Create: `src/telegram/permissions.ts`
- Test: `test/permissions.test.ts`

**Interfaces:**
- Consumes: `RequestPermissionRequest/Response`, `PermissionOption` types.
- Produces:
```ts
export interface PermissionPrompt {
  html: string;                                   // message text: 🔐 <b>Permission</b>: tool title + salient rawInput (command/path) in <code>, truncated 300 chars
  keyboard: Array<Array<{ text: string; callback_data: string }>>; // one row per option
}
export class PermissionBroker {
  ask(threadId: number, req: acp.RequestPermissionRequest,
      present: (p: PermissionPrompt) => Promise<number>          // sends message, returns message_id
     ): Promise<acp.RequestPermissionResponse>;
  resolve(callbackData: string): { threadId: number; messageId: number; label: string } | undefined;
     // called from bot callback handler; settles the ask() promise with {outcome:"selected", optionId}
  cancelThread(threadId: number): void;  // settles ALL pending asks for topic as {outcome:{outcome:"cancelled"}} (protocol requirement on session/cancel)
}
```
- `callback_data` format: `perm:{seq}:{optIndex}` (`seq` = broker-global counter; total ≤ 64 bytes). Button text by `kind`: allow_once "✅ {name}", allow_always "♻️ {name}", reject_once "❌ {name}", reject_always "🚫 {name}" (name from the option, truncated to 32 chars).

- [ ] **Step 1: Write the failing test** — `ask()` presents prompt (assert html contains tool title and keyboard has one row per option with `perm:` data); `resolve()` with the second button's data → ask() resolves `selected` with that option's real `optionId` and returns label/messageId for the caller to edit the message; unknown callback_data → `undefined`; `cancelThread` settles two pending asks as `cancelled`; resolving twice → second returns `undefined`.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** — `Map<seq, {threadId, messageId, options, resolve}>`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: permission broker with inline keyboard mapping"`

---

### Task 10: Topic orchestrator (turn lifecycle)

**Files:**
- Create: `src/orchestrator.ts`
- Test: `test/orchestrator.test.ts` (mock agent + fake TopicUi)

**Interfaces:**
- Consumes: `AgentSession` (5), renderers (8), `PermissionBroker` (9), `MessageDraft`/`LiveMessage` (7), `Config` (1).
- Produces:
```ts
export interface TopicUi {                       // implemented over grammY in Task 11; faked in tests
  messageApi(): MessageApi;                       // fresh sender bound to this topic
  typing(): void;                                 // one sendChatAction("typing")
  notify(html: string): Promise<void>;            // one-off message (errors, stop reasons)
  presentPermission(p: PermissionPrompt): Promise<number>;
  editPermissionMessage(messageId: number, html: string): Promise<void>;
}
export class TopicSession {
  constructor(deps: { agent: AgentSession; ui: TopicUi; broker: PermissionBroker; threadId: number; cfg: Pick<Config,"editIntervalMs"|"typingIntervalMs"|"showThoughts"> });
  async handleUserPrompt(blocks: acp.ContentBlock[]): Promise<void>; // queues if turn active (FIFO, max 5 queued → notify "queue full")
  async cancel(): Promise<void>;      // agent.cancel() + broker.cancelThread()
  async dispose(): Promise<void>;
  get agentSession(): AgentSession;
}
```
- Turn flow (single place that owns it): start typing heartbeat `setInterval(typingIntervalMs)`; create per-turn `MessageDraft` + Activity/Plan renderers (each on its own `LiveMessage`, created lazily on first relevant update); route updates — `agent_message_chunk`(text content) → draft.append; `agent_thought_chunk` → draft.append(`<i>…</i>` one-liner) only if `showThoughts`; `tool_call`/`tool_call_update` → activity; `plan` → plan renderer; mode/commands/usage cached by AgentSession already (usage kept on TopicSession for `/status`). On prompt settle: stop heartbeat, `draft.finalize()`, renderers `finalizeTurn()`, if stopReason ≠ `end_turn` → `notify` (e.g. "⏹ cancelled", "⚠️ refusal"). On agent `onExit` mid-turn → notify "💥 agent process died — /new to restart or tap Restart" (restart button wiring is Task 11). All errors inside the turn are caught → `notify` + logged, never unhandled.

- [ ] **Step 1: Write the failing test** — with mock agent scripting chunks+tool_call+plan+permission: full turn produces draft appends in order, activity + plan rendered, permission auto-resolved via broker `resolve()` simulation, typing called ≥1, queue: second `handleUserPrompt` during turn runs after the first (mock `received` length 2, order preserved); `cancel()` mid-turn → prompt resolves cancelled AND pending permission settled cancelled; stopReason "refusal" → notify contains "refusal".
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** (~150 lines).
- [ ] **Step 4: Run** — Expected: PASS. Full suite: `npm test` — Expected: all green.
- [ ] **Step 5: Commit** — `git commit -m "feat: topic orchestrator owning the turn lifecycle"`

---

### Task 11: Telegram bot wiring (router, commands, uploads, callbacks)

**Files:**
- Create: `src/telegram/bot.ts`, `src/bridge.ts`
- Test: `test/bridge-commands.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
```ts
// bridge.ts — composition root, holds Map<threadId, TopicSession>
export class Bridge {
  constructor(cfg: Config, botApi: BotApi, store: StateStore);  // BotApi = thin interface over grammY Api (createForumTopic, sendMessage, editMessageText, sendChatAction, sendDocument, getFile, downloadFile, pinChatMessage, setMyCommands, closeForumTopic) — faked in tests
  async init(): Promise<void>;   // load store; for each persisted session spawn AgentSession with loadSessionId (failures → notify topic, drop from store)
  async newTopic(name: string | undefined, cwdArg: string | undefined, generalThreadReply: (html: string) => Promise<void>): Promise<void>;
  async handleMessage(threadId: number | undefined, msg: IncomingMsg): Promise<void>;  // IncomingMsg = { text?: string; documents/photos metadata }
  async handleCallback(data: string): Promise<{ toast: string } | undefined>;
  async shutdown(): Promise<void>; // dispose all sessions, persist
}
// bot.ts — grammY glue: middleware chain = allowlist filter → chat filter → route to Bridge; installs auto-retry; long polling bot.start(); registers setMyCommands (BotCommandScopeChat on forumChatId)
export function runBot(cfg: Config): Promise<void>;
```
- Command table (checked before ACP passthrough; all replies HTML, in-thread):
  - `/new [name]` (General topic or any) → `createForumTopic` (name default `claude-{n}`, cycle the 6 allowed icon_color values) → AgentSession.start(cwd = `projects[name] ?? defaultCwd`) → store.upsert → intro message in new topic (cwd, mode, "/commands for commands").
  - `/end` → dispose session, store.remove, `closeForumTopic`.
  - `/cancel` → `topicSession.cancel()`.
  - `/mode` → inline keyboard of `availableModes()` (callback `mode:{threadId}:{modeId}`); tap → `setMode`, toast + edit message to "Mode: X".
  - `/yolo` → toggle: if `currentModeId === "bypassPermissions"` → set `"default"`, else try `"bypassPermissions"`, fall back to `"dontAsk"` if unavailable; reply with resulting mode.
  - `/status` → session id (short), cwd, mode, queued prompts, last `usage_update` (tokens used/size, cost if present).
  - `/commands` → list `availableCommands` as `/name — description` (chunked ≤4000).
  - `/cwd` → print session cwd.
  - `/file <path>` → resolve relative to session cwd, must stay under cwd after `path.resolve` (reject `..` escapes), ≤ 50 MB → `sendDocument`.
  - Any other `/xyz [args]`: if `xyz` matches an `availableCommands` name (or `mcp:xyz`) → forward verbatim as a text content block (that IS the ACP invocation mechanism); else reply "Unknown command — /commands lists what the agent supports." (never forward unknown slashes — adapter-hang guard).
  - Plain text → `handleUserPrompt([{type:"text",text}])`.
  - Photo → `getFile`+download (≤20MB) → `{type:"image", data: base64, mimeType}` block + caption text block. Document → download to `{dataDir}/uploads/{threadId}/`, prompt gets caption text block + a text block `Attached file saved at: {absPath}` + `{type:"resource_link", uri:"file://…", name}`.
  - Callbacks: `perm:` → `broker.resolve` → edit permission message to `{html}\n\n➡️ {label}`; `mode:` → setMode; `restart:{threadId}` → respawn AgentSession with `loadSessionId`, notify outcome.
- General-topic detection: `message_thread_id` absent ⇒ General (medium-confidence per research — verify in E2E) — General accepts only `/new` and `/status`-style global commands; per-session commands require a session topic.

- [ ] **Step 1: Write the failing test** — drive `Bridge` with a `FakeBotApi` (records calls) + mock-agent-backed sessions: `/new` creates topic + intro + store entry; text message routes to the right TopicSession (two topics, interleaved); `/mode` keyboard lists mock's three modes and `mode:` callback switches (mock records config option set); unknown `/frobnicate` → "Unknown command" and mock received NO prompt; known `/review args` → forwarded verbatim; `/end` closes topic and removes from store; `init()` with a stored session re-attaches via loadSession (mock `loaded` path) and a bad stored id falls back with a notice.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** `bridge.ts` (~200 lines) and `bot.ts` (~120 lines; grammY: `bot.api.config.use(autoRetry())`, `bot.on("message")`/`bot.on("callback_query:data")` with the allowlist/chat guards FIRST, `answerCallbackQuery` always). Every `AgentSession.start` call in `Bridge` passes `client: { ...makeFsHandlers(), ...terminalRegistry.handlers() }` (one `TerminalRegistry` per Bridge, `disposeAll()` in `shutdown()`), `spawn: { command: cfg.adapterCommand, env: cfg.adapterEnv }`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat: Telegram bot wiring, commands, uploads, callbacks"`

---

### Task 12: Entry point, graceful shutdown, logging

**Files:**
- Create: `src/index.ts`, `src/log.ts`
- Test: covered by build + existing suite (glue only; no new unit tests)

**Interfaces:**
- Consumes: `runBot` (Task 11), `loadConfig` (Task 1).

- [ ] **Step 1: Implement** — `src/log.ts`: pino to stdout (level from `LOG_LEVEL`, default `info`). `src/index.ts`: config path from `argv[2] ?? ~/.config/telegram-acp-bridge/config.json`; `loadConfig` errors print cleanly and exit 1; `StateStore` at `join(cfg.dataDir, "state.json")`; SIGINT/SIGTERM → `bridge.shutdown()` (dispose agents, persist state, stop bot) with a 10s hard-exit timer; unhandledRejection → log error, keep running.
- [ ] **Step 2: Verify** — `npm run build` — Expected: clean compile. `npm test` — Expected: green. `node dist/index.js /nonexistent.json` — Expected: clean config error, exit 1.
- [ ] **Step 3: Commit** — `git commit -m "feat: entry point with graceful shutdown"`

---

### Task 13: Deployment (systemd unit, install script, README, E2E checklist)

**Files:**
- Create: `deploy/telegram-acp-bridge.service`, `install.sh`, `README.md`, `docs/e2e-checklist.md`, `LICENSE` (MIT)

- [ ] **Step 1: Write deploy assets**

```ini
# deploy/telegram-acp-bridge.service  (systemd USER unit)
[Unit]
Description=Telegram ACP bridge for Claude Code
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=%h/.local/opt/telegram-acp-bridge/bin/telegram-acp-bridge
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
```

`install.sh`: verify `node --version` ≥ 22 and `command -v claude` (warn if missing: adapter needs Claude Code installed + logged in); `npm ci && npm run build`; copy `dist/` + `node_modules` + a `bin/telegram-acp-bridge` launcher (`#!/usr/bin/env sh\nexec node "$(dirname "$0")/../dist/index.js" "$@"`) to `~/.local/opt/telegram-acp-bridge/`; create `~/.config/telegram-acp-bridge/config.json` from `config.example.json` if absent (then tell user to edit it); `systemctl --user daemon-reload && systemctl --user enable --now telegram-acp-bridge`; suggest `loginctl enable-linger $USER`.

README: BotFather setup (create bot, **disable nothing — admin covers privacy**), create group → enable Topics → add bot as admin with `can_manage_topics` + `can_pin_messages` + `can_delete_messages`, get chat id (bot logs it on first message), config reference table, command reference, troubleshooting (429s, adapter needs `claude login`, root-user bypassPermissions caveat).

`docs/e2e-checklist.md` — manual verification: /new creates visibly distinct topic; streaming edits feel live; typing indicator persists through long turns; permission buttons round-trip (test with `default` mode: ask agent to run a command); /mode plan → plan message renders; /cancel mid-turn; kill -9 the adapter → crash notice + Restart button reattaches with history; systemd restart → sessions reattach; two topics streaming concurrently; General-topic `message_thread_id` assumption verified.

- [ ] **Step 2: Verify** — `bash -n install.sh` (syntax); `systemd-analyze --user verify deploy/telegram-acp-bridge.service` (ignore missing-binary warning on dev box). Expected: no syntax errors.
- [ ] **Step 3: Commit** — `git commit -m "feat: systemd deployment, installer, README, E2E checklist"`

---

### Task 14: Live smoke test (real adapter, no Telegram)

**Files:**
- Create: `scripts/smoke-acp.ts` (dev-only, run via `tsx`)

- [ ] **Step 1: Write** a ~60-line script: `AgentSession.start` with real `spawn: {command: cfg.adapterCommand}` in a scratch cwd, `onUpdate` pretty-prints update types, `onPermission` auto-selects the first `reject_*` option (safe), prompt `"Say hello and list files in this directory"`, print stopReason, dispose.
- [ ] **Step 2: Run** — `npx tsx scripts/smoke-acp.ts` on the dev machine (requires `claude login` done). Expected: initialize/newSession succeed, message chunks stream to console, turn ends `end_turn`. **This validates our SDK usage against the real adapter before any Telegram traffic.** If method/shape mismatches appear, fix `AgentSession` here (and its tests) — this step exists to catch cheat-sheet drift.
- [ ] **Step 3: Commit** — `git commit -m "test: live ACP smoke script against real adapter"`

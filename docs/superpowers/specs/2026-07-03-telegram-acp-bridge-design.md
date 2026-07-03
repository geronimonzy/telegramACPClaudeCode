# Telegram ↔ Claude Code ACP Bridge — Design

Date: 2026-07-03
Status: awaiting user review

## Goal

A Linux-deployable service that lets the user talk to Claude Code running on their machine from Telegram, with the fidelity of a real ACP client (like Zed): full slash commands, session modes, permission prompts, streaming output, plan/progress display. Multiple parallel conversations, each in its own Telegram forum topic.

## Decisions already made (with user)

- **Stack:** TypeScript / Node ≥ 22, npm. Telegram via **grammY**; ACP via **`@agentclientprotocol/sdk`** (v1.x) driving the canonical adapter **`@agentclientprotocol/claude-agent-acp`**.
- **Build fresh**, MIT-licensed. Existing bridges were evaluated (see `.frugal-fable/research/existing-bridges.md`) and rejected: best fit (OpenACP) has contradictory license terms (AGPL in package.json vs MIT in README/site, no LICENSE file), a suspended GitHub org, and ~93 lines of tests for 49K LOC; the Rust one auto-approves all permissions; the others miss forum topics or are stalling.
- **OpenACP as design reference (not code):** its full TS source was recovered from npm sourcemaps into `.frugal-fable/research/openacp-src/` (report: `openacp-deep.md`). We adopt four of its proven patterns as ideas, reimplemented cleanly: (1) an edit-in-place streaming draft class with throttle + overlapping-edit race handling; (2) generic mapping of ACP permission option `kind`s to inline keyboards; (3) stripping unrecognized `/` prefixes before forwarding prompts, to avoid adapter hangs; (4) shimming the legacy `session/set_mode` API behind `session/set_config_option`. No code is copied.
- **Deployment:** systemd (user) service. Long polling, no webhook, no open ports.
- **Conversations:** one Telegram **forum supergroup**; one topic = one ACP session = one dedicated `claude-agent-acp` subprocess (crash isolation, trivial cleanup).
- **Permissions:** inline buttons by default; per-topic mode switching (`/mode`, `/yolo`).

## Architecture

```
Telegram cloud ⇄ (long poll) ⇄ Bridge (Node service, systemd)
                                   ├── telegram/  grammY bot + renderers
                                   ├── sessions/  topic ↔ session registry (JSON state file)
                                   └── acp/       one claude-agent-acp subprocess per topic
                                                    ⇅ JSON-RPC over stdio (ACP v1)
                                                    → Claude Agent SDK → claude binary
                                                      (reuses existing `claude login` / API key)
```

The bridge is an ACP **client**: it spawns the adapter, sends `initialize` (advertising `fs` + `terminal` capabilities), creates sessions with a per-topic `cwd`, sends prompts, consumes `session/update` streams, and answers `session/request_permission`, `fs/*`, and `terminal/*` callbacks.

## Components

### `src/acp/` — ACP client layer
- **`AgentProcess`** — spawns `claude-agent-acp` (from our own `node_modules`, version-pinned) with stdio pipes; wraps `ClientSideConnection`. Env passthrough plus optional overrides (`CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CONFIG_DIR`, `ANTHROPIC_API_KEY`) from config. Watches process exit → emits `crashed`.
- **Client callbacks:**
  - `session/update` → typed events to the renderer (chunks, tool calls, plan, modes, commands, usage).
  - `session/request_permission` → forwarded to permission UI; on turn cancel, auto-respond `{outcome: "cancelled"}`.
  - `fs/read_text_file` / `fs/write_text_file` → real filesystem (absolute paths, create-on-write). No unsaved-buffer concept here.
  - `terminal/create|output|wait_for_exit|kill|release` → real `child_process.spawn` registry with `outputByteLimit` front-truncation. This is the largest single implementation lift; it buys Zed-parity execute-tool streaming.
- **Modes & commands:** cache `availableCommands` per session (`available_commands_update`); support **both** mode APIs — prefer `configOptions`/`session/set_config_option`, fall back to `modes`/`session/set_mode`; track `current_mode_update`/`config_option_update`.
- **Session lifecycle:** `session/new {cwd}`; on bridge restart, attempt `session/load` if `agentCapabilities.loadSession` (replay suppressed from Telegram — state only), else start a fresh session and say so in the topic.

### `src/sessions/` — registry & persistence
- Map `message_thread_id` → `{ acpSessionId, cwd, permissionMode, activeTurn, lastMessageIds }`.
- Persisted to a single JSON state file (atomic write via temp+rename) in the config dir. Small scale (≤ dozens of topics) — no database.

### `src/telegram/` — bot & renderers
- **Plugins:** `@grammyjs/runner` (concurrency), `@grammyjs/auto-retry` (429/5xx), throttler, `parse-mode` with **HTML** (only 3 escapes; MarkdownV2 rejected).
- **Router:** only the configured forum chat + allowlisted user IDs are honored; everything else is ignored (this bot is remote code execution by design — allowlist is mandatory, no default-open mode). Messages carry `message_thread_id` → session lookup. Documents/photos ≤ 20 MB are downloaded to a per-topic uploads dir and attached as `resource`/`image` content blocks (adapter advertises image + embeddedContext support).
- **Bridge commands** (take precedence): `/new [name] [cwd]` (creates forum topic + session), `/end`, `/cancel` (→ `session/cancel`), `/mode` (inline keyboard from availableModes/configOptions), `/yolo` (toggle bypassPermissions⇄default; falls back to dontAsk where bypass is unavailable, e.g. root), `/cwd`, `/status` (session, mode, token usage from `usage_update`), `/commands` (list ACP slash commands), `/file <path>` (send a file from cwd to the topic).
- **ACP slash commands:** any other `/xyz` message is passed through verbatim as prompt text — that is exactly how ACP invokes agent commands (no separate RPC). Unknown commands thus degrade gracefully to the agent's own handling.
- **Streamer** (per topic, per turn):
  - `sendChatAction("typing", thread)` heartbeat every ~4.5 s while a turn is active.
  - `agent_message_chunk`s accumulate into a buffer; one Telegram message is progressively updated via `editMessageText`, **debounced to ≥ 1.5 s between edits** per chat; final flush on turn end. At 4096 chars: finalize current message at a paragraph/code-fence boundary and continue in a new one. Code fences → `<pre><code>`; thought chunks (`agent_thought_chunk`) rendered collapsed as an italic one-liner (toggleable in config).
  - **Activity message:** one compact live-edited message per turn listing tool calls — status emoji (⏳ pending / 🔄 running / ✅ done / ❌ failed) + kind icon + title; diffs shown truncated in `<pre>`; terminal-embedded tool calls stream the tail of output.
  - **Plan message:** `plan` updates fully replace state (protocol semantics) → one edited message per turn: ☐ / 🔄 / ☑ per entry with priority markers. (Telegram checklists are business-accounts-only — verified — so an edited text message is the mechanism.)
- **Permission UI:** `session/request_permission` → inline keyboard, one button per option (`allow_once`/`allow_always`/`reject_once`/`reject_always` kinds mapped to ✅ Allow / ✅ Always allow / ❌ Deny / 🚫 Never), with the tool-call title and salient input (command line, file path) in the message. Callback → `answerCallbackQuery` + respond to the ACP request + edit the message to show the choice. Only allowlisted users' callbacks accepted. Plan-mode-exit uses the same mechanism (options double as target modes) and needs no special casing.

### Config & deployment
- Config file `~/.config/telegram-acp-bridge/config.json`: `botToken`, `forumChatId`, `allowedUserIds[]`, `defaultCwd`, `projects{name→path}` (for `/new name`), throttle/heartbeat tunables, adapter env overrides, `showThoughts`.
- `install.sh`: checks Node ≥ 22 and `claude` binary, `npm ci && npm run build`, writes a **systemd user unit** (`Restart=on-failure`, `WantedBy=default.target`, journald logging via pino→stdout), `loginctl enable-linger`. A `/setup` DM flow prints the chat ID when the bot is added to a forum group, to ease first-run config.

## Error handling
- **Adapter crash:** notify topic + "Restart session" inline button → respawn, `session/load` if supported.
- **Telegram 429:** auto-retry plugin honors `retry_after`; streamer additionally collapses pending edits (latest-wins) so backpressure never queues unbounded edits.
- **Oversize/failed edits:** parse-mode errors fall back to plain text; oversize handled by the splitting rule.
- **Cancellation:** `/cancel` → `session/cancel`; pending permission keyboards resolved as cancelled and edited to say so; turn ends when prompt resolves with `stopReason: "cancelled"`.
- **Unknown update types:** logged and ignored (protocol is additive).

## Testing
- **Unit (vitest):** streamer (chunk accumulation, debounce, 4096 splitting, HTML escaping), permission option→keyboard mapping, session registry persistence, ACP event parsing.
- **Integration:** a **mock ACP agent** (small stdio script speaking ACP v1) driven through the real `AgentProcess` + renderers with a stubbed Telegram transport — covers the full loop: prompt → chunks → tool calls → permission round-trip → plan → cancel, without network.
- **Manual E2E checklist:** real bot + real adapter on the target machine (streaming feel, topic creation, permission buttons, mode switching, restart recovery).

## Out of scope (v1)
- Webhook mode, Docker, multi-user/multi-group support, voice messages, `terminal` input injection (interactive stdin to running commands), Telegram checklist messages (impossible for bots), audio content blocks.

## Key risks
- `ClientSideConnection` exact API surface unverified (research §14.1) — first implementation task reads the SDK's TypeDoc/examples before coding against it.
- Adapter `session/load` support unverified — restart-recovery degrades to fresh session if absent.
- ACP v2 track exists but v1 is stable and the adapter targets it; build on v1.

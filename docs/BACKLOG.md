# Backlog

Open items, in rough priority order. Nothing here is started; each entry
carries the context needed to pick it up cold. History of what already
shipped lives in git log and `docs/e2e-checklist.md`.

## Features

### 1. 📁 Projects topic — all projects + their sessions

A dedicated pinned topic (same pattern as the 📊 Claude Usage topic: created
on first use, ONE message edited in place, pointer persisted in `dataDir`,
recreated only by the manual command) listing every project and, under each,
its sessions grouped by state:

- 🟢 running — attached topic with a live agent subprocess;
- 🔌 disconnected — stored topic waiting for its Reconnect tap;
- 💤 resumable — exists on disk (via `listSessions` / JSONL scan) but not
  attached to any topic.

Projects = union of `cfg.projects` keys, cwds of stored sessions, and cwds
seen in resumable sessions. Reuse the collectors in `src/usage.ts` /
`src/acp/session-file.ts` and the `listSessions` machinery behind
`/sessions`.

### 2. Backlinks in the Projects topic

Make the panel interactive:

- **Tap a project → new session.** Spawns a fresh agent + topic in that
  project's cwd (reuse `newTopic`). Callback data is capped at 64 bytes, so
  map projects through a sequence counter like the `attach:{k}` flow does —
  don't embed paths in `callback_data`.
- **Tap a conversation → jump to its topic.** For attached topics use a
  `t.me/c/{internalChatId}/{threadId}` deep link (⚠️ verify the exact format
  for forum topics in a private supergroup live before relying on it). For
  resumable sessions, the tap attaches first (reuse the attach flow), then
  links.

Depends on item 1.

## Decisions needed from the user

- **Plain-HTML fallback for rich surfaces.** The three rich surfaces
  (streaming reply, Activity, Plan) send `rich_message` only; behavior on
  outdated Telegram clients is unverified. Either verify/accept (won't-fix)
  or add a plain fallback.
- **Migrate pre-entrypoint-fix sessions into `/resume`.** Sessions created
  before commit `2ade9e1` have `entrypoint: sdk-ts` baked into their JSONL
  heads and stay hidden from the CLI's `/resume` picker. A one-time
  migration would rewrite that field in `~/.claude/projects` files — it
  touches Claude Code's own data, so it needs explicit approval.

## Smaller improvements

- **CLI mirror renders prose only.** Turns mirrored from a terminal resume
  show 👤/🤖 text but no ⚙️ Activity panels for their tool calls. Could
  extract tool_use/tool_result entries from the JSONL and render burst
  panels like live turns.
- **`/status` shows only the mode.** Add current model + effort lines (the
  values are already cached on `AgentSession` via the select-config API).
- **Heading inside a blockquote** renders the literal `#`
  (`src/telegram/rich-html.ts`, cosmetic).
- **Giant replay could block the event loop** during rollover (synchronous
  render per flush) — from the T15 review, never observed live.
- **Orphan empty topic** if `createForumTopic` succeeds but the agent spawn
  throws (T15 review; the topic is created before the agent starts).

## Verification debt

- The manual E2E checklist (`docs/e2e-checklist.md`) has not been executed
  end-to-end since the post-v1 feature wave landed.

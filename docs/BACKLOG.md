# Backlog

Open items, in rough priority order. Nothing here is started; each entry
carries the context needed to pick it up cold. History of what already
shipped lives in git log and `docs/e2e-checklist.md`.

## Decisions needed from the user

- **Plain-HTML fallback for rich surfaces.** The rich surfaces (streaming
  reply, Activity, Plan, Usage/Projects panels, transcripts) send
  `rich_message` only; behavior on outdated Telegram clients is unverified.
  Either verify/accept (won't-fix) or add a plain fallback.
- **Migrate pre-entrypoint-fix sessions into `/resume`.** Sessions created
  before commit `2ade9e1` have `entrypoint: sdk-ts` baked into their JSONL
  heads and stay hidden from the CLI's `/resume` picker. A one-time
  migration would rewrite that field in `~/.claude/projects` files — it
  touches Claude Code's own data, so it needs explicit approval.

## Smaller improvements

- **`proj:new` taps route through `/new`'s argument parser**, so a project
  cwd containing whitespace mis-splits into folder + title (same limitation
  as hand-typed `/new`; no real project path hits it today). A clean fix
  would let `newTopic` accept a pre-resolved cwd.
- **Giant replay could block the event loop** during rollover (synchronous
  render per flush) — from the T15 review, never observed live.

## Verification debt

- **The `t.me/c/{internal}/{threadId}` deep link** used by the 📁 Projects
  panel's 🟢/🔌 buttons has NOT been verified live for forum topics in a
  private supergroup (flagged in `src/projects.ts` — confirm a tap lands in
  the topic).
- The manual E2E checklist (`docs/e2e-checklist.md`) has not been executed
  end-to-end since the post-v1 feature wave landed, and it does not yet
  cover the 2026-07-04 additions: 📁 Projects topic + backlinks, transcript
  ⚙️ Activity panels, `/status` model+effort, blockquote headings,
  spawn-failure topic cleanup.

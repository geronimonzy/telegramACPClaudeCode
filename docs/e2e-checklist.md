# E2E checklist

Manual verification to run against a real Telegram forum group and a real
Claude Code ACP adapter before calling a release good. None of this is
automated — work through it by hand after any change that touches the bot
wiring, the orchestrator, or the ACP session lifecycle.

- [ ] `/new` creates a visibly distinct topic (its own name/icon in the forum
      topic list), separate from General and from any other session topics.
- [ ] Streaming edits feel live — the in-progress reply visibly grows/updates
      in near-real-time rather than appearing as one late dump.
- [ ] The typing indicator persists through long turns (it keeps refreshing,
      not just fired once and left to expire).
- [ ] Permission buttons round-trip: with the agent in `default` mode, ask it
      to run a shell command and confirm the inline keyboard appears, tapping
      an option resolves the ACP permission request, and the message reflects
      the decision.
- [ ] `/mode` → switching to `plan` renders a plan message distinctly (not as
      plain prose).
- [ ] `/cancel` mid-turn actually stops the in-flight turn (no further
      streamed output after cancellation).
- [ ] `kill -9` the ACP adapter process: the topic gets a crash notice with a
      Restart button, and tapping Restart reattaches the session with prior
      history intact.
- [ ] `systemctl --user restart telegram-acp-bridge` (or an equivalent process
      restart): every stored topic gets a "🔌 disconnected — Reconnect" notice
      (no auto-reattach); tapping Reconnect resumes the session silently (no
      history re-spam) and offers 🧠 Compact / ▶️ Continue.
- [ ] Two topics can stream concurrently without cross-talk (each topic's
      output only ever appears in its own topic).
- [ ] The General-topic `message_thread_id` assumption is verified: messages
      sent directly in General (not in any topic) are treated as
      `threadId === undefined`, and only `/new`, `/sessions` and `/usage` are
      accepted there — everything else gets the "this is the General topic"
      notice.

Post-v1 features (added 2026-07-04):

- [ ] A tool-heavy turn renders interleaved: text segment → ⚙️ Activity panel
      (collapsible, per burst) → next text segment, in conversation order; a
      table/list in the reply renders natively (Rich Messages).
- [ ] `/new receiptSaas My Name` (a folder under `defaultCwd` + custom title)
      creates the topic with that name and cwd.
- [ ] `/sessions` attach replays the FULL history as separate 👤 You (bold
      quote) / 🤖 (markdown) messages per speaker turn.
- [ ] Deleting a session topic in the Telegram UI: the next `/sessions` lists
      that session as attachable again (stale entry pruned).
- [ ] `/usage` creates/updates the pinned 📊 Claude Usage message (3-column
      tables fit a phone screen; sessions show 🟢/🔌 + context); it refreshes
      hourly on its own.
- [ ] `/model` and `/effort` keyboards show the adapter's advertised values
      with the current one ✅-marked; tapping applies and edits the prompt.
- [ ] A bridge-created session appears in the CLI's `/resume` picker (run
      `claude` in the session's cwd).
- [ ] Resume a bridge session in the terminal, exchange a message: within
      ~15s it mirrors into the Telegram topic under a 💻 notice, with no
      duplicate of bridge-originated traffic.

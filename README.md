# telegram-acp-bridge

A Telegram bot that turns a Telegram **forum** (a supergroup with Topics
enabled) into a multi-session front end for [Claude Code](https://claude.com/claude-code)
via the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Each
Telegram topic is one independent Claude Code session: its own working
directory, its own conversation history, its own permission prompts — running
concurrently with any other topic in the same group.

The bridge itself only speaks Telegram + ACP; it spawns Claude Code's ACP
adapter (`claude-agent-acp`) as a subprocess per session and reuses whatever
credentials `claude login` already set up on the host. It does not implement
its own model access or billing — it drives your existing Claude Code
install.

## How it works, in one paragraph

You talk to the bot in a Telegram group. `/new` opens a forum topic and starts
a Claude Code ACP session with a chosen working directory. Plain text you
send in that topic becomes a prompt; the reply streams back as a live-edited
message. Photos and documents you send are attached to your *next* prompt.
Claude Code's own tool-call activity, plans, and permission requests render
as Telegram messages with inline buttons. Session state (which topic maps to
which ACP session id and cwd) is persisted to disk so a bot restart
reattaches every open topic.

## Setup

### 1. Create the bot with BotFather

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, and follow
   the prompts to get a bot token (`123456:ABC-DEF...`).
2. You do **not** need to run `/setprivacy` or otherwise disable BotFather's
   default group-privacy mode. Once the bot is made a group **admin** (step
   3), Telegram bypasses privacy mode for it entirely — an admin bot sees
   every message in the group regardless of that setting.

### 2. Create a group and enable Topics

1. Create a new Telegram group (a regular group, not a channel).
2. Convert it to a supergroup if prompted (Telegram does this automatically
   the first time it's needed).
3. In the group's settings, enable **Topics** (this is what makes it a
   "forum" — `createForumTopic` and friends only work on forum-enabled
   supergroups).
4. Add your bot to the group.

### 3. Make the bot an admin with topic-management rights

In the group's admin list, promote the bot to admin and grant at least:

- **`can_manage_topics`** — required; the bot creates and closes forum topics
  for every session.
- **`can_pin_messages`** — recommended; used to pin key session messages.
- **`can_delete_messages`** — recommended; keeps topics tidy.

Admin rights are also what makes step 1's privacy-mode note true — an admin
bot always receives full message text.

### 4. Find the chat id

The bridge is locked to exactly one chat via `forumChatId` in the config
(every message from any other chat is silently ignored — this is a security
boundary, not a bug). You need that numeric id, which for a supergroup is
negative and typically prefixed `-100` (e.g. `-1001234567890`).

The simplest way to get it, before the bridge has a correct config to run
with:

1. Send any message in the new group.
2. Fetch pending updates directly from the Bot API:
   ```sh
   curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates"
   ```
3. In the JSON response, read `result[].message.chat.id` — that's your
   `forumChatId`.

(Once the bridge is correctly configured and running, `/status` inside any
session topic is a quick way to sanity-check you're talking to the intended
chat/session — see the command reference below — but it does not itself print
the chat id, so use the `getUpdates` method above for initial discovery.)

### 5. Configure

Copy `config.example.json` (or let `install.sh` do it — see below) to
`~/.config/telegram-acp-bridge/config.json` and fill it in:

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `botToken` | string | yes | — | Bot token from BotFather. |
| `forumChatId` | number | yes | — | The forum supergroup's chat id (see step 4). |
| `allowedUserIds` | number[] | yes (non-empty) | — | Telegram user ids allowed to interact with the bridge. Everyone else is ignored. |
| `defaultCwd` | string | yes | — | Working directory for a new session when `/new` is given no name that maps to a `projects` entry. |
| `projects` | object (string → string) | no | `{}` | Named shortcuts: `/new <name>` uses `projects[name]` as the cwd if present. |
| `editIntervalMs` | number | no | `1500` | Minimum interval between live-message edits while a response streams. |
| `typingIntervalMs` | number | no | `4500` | Interval for refreshing the "typing…" chat action while a turn is in flight. |
| `showThoughts` | boolean | no | `false` | Forward the agent's thinking/reasoning blocks to Telegram. |
| `adapterCommand` | string[] | no | `["npx", "-y", "claude-agent-acp"]` | Command used to spawn the ACP adapter process. |
| `adapterEnv` | object (string → string) | no | `{}` | Extra environment variables passed to the adapter process. |
| `dataDir` | string | no | `~/.local/share/telegram-acp-bridge` | Directory for persisted session state (`state.json`) and uploaded-document storage. `~` is expanded. |

### 6. Get Claude Code itself working

The adapter (`claude-agent-acp`) is a thin ACP wrapper around Claude Code and
authenticates by reusing Claude Code's *own* existing login — it does not
take a separate API key in this bridge's config. On the host that will run
the bridge:

```sh
npm install -g @anthropic-ai/claude-code   # if not already installed
claude login
```

If you skip this, sessions will start but every turn will fail once the
adapter tries to talk to the model.

## Install and run (systemd --user)

```sh
git clone <this repo>
cd telegram-acp-bridge
./install.sh
```

`install.sh`:

1. Checks `node --version` is >= 22, and warns (non-fatally) if `claude`
   isn't on `PATH`.
2. Runs `npm ci && npm run build` in the repo.
3. Installs a production copy into `~/.local/opt/telegram-acp-bridge/`:
   `dist/`, a **production-only** `node_modules` (installed with
   `npm ci --omit=dev` directly in the install directory against the copied
   `package.json`/`package-lock.json` — so `typescript`, `tsx`, `vitest` and
   other dev dependencies never ship to the deployed copy), and a
   `bin/telegram-acp-bridge` launcher script.
4. Seeds `~/.config/telegram-acp-bridge/config.json` from
   `config.example.json` if one doesn't already exist (never overwrites an
   existing one) and tells you to edit it.
5. Installs `deploy/telegram-acp-bridge.service` as a systemd **user** unit
   and runs `systemctl --user daemon-reload && systemctl --user enable --now
   telegram-acp-bridge`.
6. Suggests `loginctl enable-linger $USER` so the service keeps running
   across logout/reboot without an active login session.

Useful commands after install:

```sh
systemctl --user status telegram-acp-bridge
journalctl --user -u telegram-acp-bridge -f
systemctl --user restart telegram-acp-bridge
```

Re-running `install.sh` rebuilds and reinstalls the app in place; it never
touches an existing `config.json`.

## Command reference

Commands run inside a session topic unless noted. `/new` also works from
General or any topic (it always creates a *new* topic).

| Command | Description |
|---|---|
| `/new [name]` | Start a new session topic. `name` also selects a `projects` cwd if configured. |
| `/end` | End this session and close the topic. |
| `/cancel` | Cancel the in-flight turn. |
| `/mode` | Choose the agent mode (inline keyboard of modes the agent advertises). |
| `/yolo` | Toggle bypass-permissions mode on/off for this session. |
| `/status` | Show session status: session id, cwd, mode, and token/cost usage if available. |
| `/commands` | List the commands *this agent* (Claude Code) advertises beyond the bridge's own. |
| `/cwd` | Show the session's working directory. |
| `/file <path>` | Send a file from the session's cwd back into the topic (path must resolve inside the cwd; capped at 50 MB). |

Anything else starting with `/` is checked against the commands the running
Claude Code session advertises (via `/commands`) and forwarded verbatim if
known; otherwise the bridge replies that it's unknown. Plain text (no leading
`/`) is always a prompt. Photos and documents attach to whatever prompt you
send next in that topic (a photo/document with no accompanying text is held
until you do).

General topic behavior: messages sent outside any topic only accept `/new`;
anything else gets a short reminder to use `/new` or to talk inside a session
topic.

## Troubleshooting

- **429 / rate-limited errors from Telegram.** The bot uses
  `@grammyjs/auto-retry`, which automatically retries `retry_after`
  responses, so brief 429s should self-heal. Persistent 429s usually mean
  too many edits per second — raise `editIntervalMs` (and, if it's the typing
  indicator, `typingIntervalMs`) in your config.
- **Turns fail immediately / adapter errors on every prompt.** The ACP
  adapter reuses Claude Code's own login; if `claude login` hasn't been run
  (or its credentials expired) on the host running the bridge, every turn
  will fail once it reaches the model. Run `claude login` as the same user
  the systemd unit runs as, then restart the service.
- **`bypassPermissions` mode (`/yolo`) unavailable / doesn't stick.** Claude
  Code disallows bypass-permissions mode when running as **root** — run the
  bridge (and thus the adapter subprocess it spawns) as a normal, non-root
  user.
- **Running under WSL:** `systemd --user` requires systemd support enabled in
  WSL (`/etc/wsl.conf`: `[boot]\nsystemd=true`, then `wsl --shutdown` from
  Windows and restart the distro). Without an active login/session, a
  `systemctl --user` service normally stops when you log out — run
  `loginctl enable-linger $USER` (as `install.sh` suggests) so it keeps
  running in the background, including across WSL/Windows restarts, without
  a session open.
- **Bot doesn't respond at all.** Confirm `forumChatId` matches the group
  (see setup step 4), that your Telegram user id is in `allowedUserIds`, and
  that the bot is still an admin with `can_manage_topics`.

## License

MIT — see `LICENSE`.

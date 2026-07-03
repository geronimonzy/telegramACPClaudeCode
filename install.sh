#!/usr/bin/env bash
# install.sh — build and install the Telegram ACP bridge as a systemd --user
# service.
#
# What this does:
#   1. Verifies prerequisites: node >= 22, and warns (non-fatal) if `claude`
#      isn't on PATH — the ACP adapter needs Claude Code installed and logged
#      in (`claude login`) on this host, since it reuses those credentials.
#   2. Builds the project (`npm ci && npm run build`) from the repo you're
#      running this script from.
#   3. Installs a production copy into ~/.local/opt/telegram-acp-bridge/:
#      dist/, a production-only node_modules (installed via
#      `npm ci --omit=dev` directly into the install dir, so no dev
#      dependencies — typescript, vitest, tsx — ship to the runtime copy),
#      and a bin/telegram-acp-bridge launcher script.
#   4. Seeds ~/.config/telegram-acp-bridge/config.json from
#      config.example.json if one doesn't already exist, and tells you to
#      edit it.
#   5. Registers and starts the systemd --user unit (deploy/telegram-acp-bridge.service).
#   6. Suggests `loginctl enable-linger $USER` so the service keeps running
#      after you log out / over reboots.
#
# Safe to re-run: it reinstalls the app bits but never overwrites an existing
# config.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${HOME}/.local/opt/telegram-acp-bridge"
CONFIG_DIR="${HOME}/.config/telegram-acp-bridge"
CONFIG_PATH="${CONFIG_DIR}/config.json"
UNIT_NAME="telegram-acp-bridge.service"
UNIT_DIR="${HOME}/.config/systemd/user"

log() { printf '[install] %s\n' "$1"; }
warn() { printf '[install] WARNING: %s\n' "$1" >&2; }
die() { printf '[install] ERROR: %s\n' "$1" >&2; exit 1; }

# --- 1. Prerequisites -------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  die "node is not on PATH — install Node.js >= 22 first."
fi

NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  die "node >= 22 is required (found $(node --version))."
fi
log "node $(node --version) OK"

if ! command -v claude >/dev/null 2>&1; then
  warn "the 'claude' CLI was not found on PATH."
  warn "The ACP adapter (claude-agent-acp) shells out to Claude Code and reuses"
  warn "its existing login — install Claude Code and run 'claude login' before"
  warn "starting the bridge, or it will fail to authenticate."
else
  log "claude CLI found: $(command -v claude)"
fi

# --- 2. Build ----------------------------------------------------------------

log "building in ${SCRIPT_DIR} (npm ci && npm run build)"
(cd "${SCRIPT_DIR}" && npm ci && npm run build)

# --- 3. Install a production copy -------------------------------------------

log "installing into ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}/bin"

rm -rf "${INSTALL_DIR}/dist"
cp -R "${SCRIPT_DIR}/dist" "${INSTALL_DIR}/dist"

cp "${SCRIPT_DIR}/package.json" "${INSTALL_DIR}/package.json"
cp "${SCRIPT_DIR}/package-lock.json" "${INSTALL_DIR}/package-lock.json"

# Production-only node_modules: `npm ci --omit=dev` run directly inside the
# install dir (against the copied package.json/package-lock.json), rather than
# copying+pruning the dev copy. This keeps typescript/tsx/vitest out of the
# deployed tree and guarantees a clean, lockfile-exact install.
log "installing production dependencies (npm ci --omit=dev)"
(cd "${INSTALL_DIR}" && npm ci --omit=dev)

cat > "${INSTALL_DIR}/bin/telegram-acp-bridge" <<'LAUNCHER'
#!/usr/bin/env sh
exec node "$(dirname "$0")/../dist/index.js" "$@"
LAUNCHER
chmod +x "${INSTALL_DIR}/bin/telegram-acp-bridge"

# --- 4. Seed config ----------------------------------------------------------

mkdir -p "${CONFIG_DIR}"
if [ ! -f "${CONFIG_PATH}" ]; then
  cp "${SCRIPT_DIR}/config.example.json" "${CONFIG_PATH}"
  warn "created ${CONFIG_PATH} from config.example.json — edit it (botToken,"
  warn "forumChatId, allowedUserIds, defaultCwd) before the service will run."
else
  log "config already exists at ${CONFIG_PATH} — leaving it untouched"
fi

# --- 5. systemd --user unit --------------------------------------------------

mkdir -p "${UNIT_DIR}"
cp "${SCRIPT_DIR}/deploy/${UNIT_NAME}" "${UNIT_DIR}/${UNIT_NAME}"

log "reloading and enabling the systemd --user unit"
systemctl --user daemon-reload
systemctl --user enable --now "${UNIT_NAME}"

log "done. Check status with: systemctl --user status ${UNIT_NAME}"
log "Check logs with: journalctl --user -u ${UNIT_NAME} -f"

# --- 6. Linger ---------------------------------------------------------------

if command -v loginctl >/dev/null 2>&1; then
  log "to keep the bridge running after logout/reboot without an active"
  log "session, run: loginctl enable-linger \$USER"
fi

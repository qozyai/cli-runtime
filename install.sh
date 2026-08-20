#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${CLI_RUNTIME_REPO_URL:-https://github.com/qozyai/cli-runtime.git}"
DEFAULT_INSTALL_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/qozyai-cli-runtime"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/qozyai-cli-runtime"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/qozyai-cli-runtime"
ENV_FILE="$CONFIG_DIR/runtime.env"
BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/cli-runtime"

PROMPT_IS_TTY=0
if [[ "${CLI_RUNTIME_INSTALL_INPUT:-tty}" != "stdin" ]] && (: </dev/tty) 2>/dev/null; then
  exec 3</dev/tty
  PROMPT_FD=3
  PROMPT_IS_TTY=1
else
  PROMPT_FD=0
fi

say() { printf '%s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }

prompt() {
  local label=$1 default=$2 result
  read -r -u "$PROMPT_FD" -p "$label [$default]: " result || die "input closed"
  printf '%s' "${result:-$default}"
}

read_secret_tty() {
  local label=$1 hint=$2 result="" char stty_state
  stty_state=$(stty -g <&"$PROMPT_FD")
  restore_secret_tty() { stty "$stty_state" <&"$PROMPT_FD"; }
  interrupt_secret_tty() { restore_secret_tty; printf '\n' >&2; exit 130; }
  trap restore_secret_tty EXIT
  trap interrupt_secret_tty INT TERM
  stty -echo -icanon min 1 time 0 <&"$PROMPT_FD"
  printf '%s%s: ' "$label" "$hint" >&2
  while IFS= read -r -n 1 -u "$PROMPT_FD" char; do
    [[ -n "$char" ]] || break
    case "$char" in
      $'\177'|$'\b')
        if [[ -n "$result" ]]; then
          result=${result%?}
          printf '\b \b' >&2
        fi
        ;;
      $'\025')
        while [[ -n "$result" ]]; do
          result=${result%?}
          printf '\b \b' >&2
        done
        ;;
      *)
        result+=$char
        printf '*' >&2
        ;;
    esac
  done
  if (( ${#result} > 2 )); then
    printf '\b\b%s' "${result: -2}" >&2
  fi
  restore_secret_tty
  trap - EXIT INT TERM
  printf '\n' >&2
  printf '%s' "$result"
}

prompt_secret() {
  local label=$1 current=$2 required=$3 result hint=""
  if [[ -n "$current" && "$required" == "1" ]]; then
    hint=" (blank keeps current)"
  elif [[ -n "$current" ]]; then
    hint=" (blank keeps current; - clears)"
  fi
  if [[ "$PROMPT_IS_TTY" == "1" ]]; then
    result=$(read_secret_tty "$label" "$hint")
  else
    read -r -s -u "$PROMPT_FD" -p "$label$hint: " result || die "input closed"
    printf '\n' >&2
  fi
  if [[ "$result" == "-" ]]; then
    result=""
  elif [[ -z "$result" ]]; then
    result=$current
  fi
  [[ "$required" != "1" || -n "$result" ]] || die "$label is required"
  printf '%s' "$result"
}

yes_no() {
  local label=$1 default=$2 result suffix="[y/N]"
  [[ "$default" == "1" ]] && suffix="[Y/n]"
  read -r -u "$PROMPT_FD" -p "$label $suffix: " result || die "input closed"
  result=${result,,}
  if [[ -z "$result" ]]; then
    printf '%s' "$default"
  elif [[ "$result" == "y" || "$result" == "yes" ]]; then
    printf '1'
  else
    printf '0'
  fi
}

env_line() {
  local key=$1 value=$2
  printf '%s=%q\n' "$key" "$value"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

command_available() {
  local value=$1
  if [[ "$value" == */* ]]; then
    [[ -x "$value" ]]
  else
    command -v "$value" >/dev/null 2>&1
  fi
}

expand_path() {
  local value=$1
  if [[ "$value" == "~" ]]; then
    value=$HOME
  elif [[ "$value" == "~/"* ]]; then
    value="$HOME/${value:2}"
  fi
  node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$value"
}

for command_name in git node stty tmux; do require_command "$command_name"; done
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
(( NODE_MAJOR >= 22 )) || die "Node.js 22 or newer is required (found $(node --version))"

mkdir -p "$CONFIG_DIR" "$STATE_DIR"
chmod 700 "$CONFIG_DIR" "$STATE_DIR"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

INSTALL_DIR=$(prompt "Install directory" "${CLI_RUNTIME_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}")
PROJECTS_ROOT=$(prompt "Projects root directory" "${CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT:-$HOME/qozyai-projects}")
DEFAULT_DRIVER=$(prompt "Default driver (claude or codex)" "${CLI_RUNTIME_TELEGRAM_DRIVER:-claude}")
DEFAULT_DRIVER=${DEFAULT_DRIVER,,}
[[ "$DEFAULT_DRIVER" == "claude" || "$DEFAULT_DRIVER" == "codex" ]] || die "default driver must be claude or codex"

DETECTED_CLAUDE=$(command -v claude 2>/dev/null || true)
DETECTED_CODEX=$(command -v codex 2>/dev/null || true)
CLAUDE_COMMAND=$(prompt "Claude command" "${CLI_RUNTIME_CLAUDE_COMMAND:-${DETECTED_CLAUDE:-claude}}")
CODEX_COMMAND=$(prompt "Codex command" "${CLI_RUNTIME_CODEX_COMMAND:-${DETECTED_CODEX:-codex}}")
[[ "$CLAUDE_COMMAND" != "~/"* ]] || CLAUDE_COMMAND="$HOME/${CLAUDE_COMMAND:2}"
[[ "$CODEX_COMMAND" != "~/"* ]] || CODEX_COMMAND="$HOME/${CODEX_COMMAND:2}"
SELECTED_COMMAND=$CLAUDE_COMMAND
[[ "$DEFAULT_DRIVER" == "codex" ]] && SELECTED_COMMAND=$CODEX_COMMAND

# Carried through rather than prompted: this file is rebuilt from scratch on every run,
# so a pin set by hand would be erased by the next upgrade — silently un-pinning the
# deployment the pin exists to protect. Sourced above, written below, unchanged here.
CLAUDE_VERSION=${CLI_RUNTIME_CLAUDE_VERSION:-}
CODEX_VERSION=${CLI_RUNTIME_CODEX_VERSION:-}
VERSION_ENFORCE=${CLI_RUNTIME_DRIVER_VERSION_ENFORCE:-warn}
# Carried for the same reason as the pins above: this file is rebuilt from scratch on
# every run, and these two decide when a terminal submission record — the surface a
# caller polls to collect its reply — may be deleted. An upgrade that reset them would
# silently change that and then act on it. Unset is written as an empty value, exactly
# as the pins are, and config.js treats empty as "use the default". The workspace age
# floors are deliberately absent: spec 0018 moved them out of the runtime entirely.
OPERATIONAL_RECORD_KEEP=${CLI_RUNTIME_OPERATIONAL_RECORD_KEEP:-}
OPERATIONAL_RECORD_GRACE_MS=${CLI_RUNTIME_OPERATIONAL_RECORD_GRACE_MS:-}
[[ "$VERSION_ENFORCE" == "warn" || "$VERSION_ENFORCE" == "block" ]] \
  || die "driver version enforcement must be warn or block"
command_available "$SELECTED_COMMAND" || die "$DEFAULT_DRIVER command is not executable: $SELECTED_COMMAND"

TELEGRAM_TOKEN=$(prompt_secret "Telegram bot token" "${TELEGRAM_BOT_TOKEN:-}" 1)
ALLOWED_CHATS=$(prompt "Private chat IDs allowed to enroll the Telegram owner (comma-separated, or *)" "${CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS:-}")
ALLOWED_CHATS=${ALLOWED_CHATS//[[:space:]]/}
[[ -n "$ALLOWED_CHATS" ]] || die "at least one owner-enrollment private chat ID is required"
if [[ "$ALLOWED_CHATS" != "*" && ! "$ALLOWED_CHATS" =~ ^-?[0-9]+(,-?[0-9]+)*$ ]]; then
  die "owner-enrollment chats must be comma-separated numeric IDs or *"
fi

OPENAI_KEY=$(prompt_secret "OpenAI API key for optional audio transcription" "${OPENAI_API_KEY:-}" 0)
OPENAI_NAVIGATOR=0
if [[ -n "$OPENAI_KEY" ]]; then
  OPENAI_NAVIGATOR=$(yes_no "Use OpenAI for unknown terminal navigation states" "${CLI_RUNTIME_OPENAI_NAVIGATOR:-0}")
fi

INSTALL_DIR=$(expand_path "$INSTALL_DIR")
[[ -n "$PROJECTS_ROOT" ]] || die "projects root must not be empty"
PROJECTS_ROOT=$(expand_path "$PROJECTS_ROOT")
[[ "$PROJECTS_ROOT" != "$HOME" ]] || die "projects root must not be the home directory"
[[ "$PROJECTS_ROOT" != "/" ]] || die "projects root must not be the filesystem root"
mkdir -p "$PROJECTS_ROOT" "$BIN_DIR"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]] || die "existing install has local changes: $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin main
  git -C "$INSTALL_DIR" checkout --quiet main
  git -C "$INSTALL_DIR" merge --quiet --ff-only origin/main
elif [[ -e "$INSTALL_DIR" && -n "$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  die "install directory exists and is not an empty Git repository: $INSTALL_DIR"
else
  rm -rf "$INSTALL_DIR"
  git clone --quiet --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

TMP_ENV="$ENV_FILE.tmp.$$"
umask 077
{
  env_line CLI_RUNTIME_STATE_DIR "$STATE_DIR"
  env_line CLI_RUNTIME_SOCKET "$STATE_DIR/runtime.sock"
  env_line CLI_RUNTIME_TMUX_SOCKET "qozyai-cli-runtime-drivers"
  env_line CLI_RUNTIME_CLAUDE_COMMAND "$CLAUDE_COMMAND"
  env_line CLI_RUNTIME_CLAUDE_HOME "$HOME"
  env_line CLI_RUNTIME_CLAUDE_VERSION "$CLAUDE_VERSION"
  env_line CLI_RUNTIME_CODEX_COMMAND "$CODEX_COMMAND"
  env_line CLI_RUNTIME_CODEX_HOME "$HOME"
  env_line CLI_RUNTIME_CODEX_VERSION "$CODEX_VERSION"
  env_line CLI_RUNTIME_DRIVER_VERSION_ENFORCE "$VERSION_ENFORCE"
  env_line CLI_RUNTIME_TELEGRAM_DRIVER "$DEFAULT_DRIVER"
  env_line CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT "$PROJECTS_ROOT"
  env_line CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS "$ALLOWED_CHATS"
  env_line TELEGRAM_BOT_TOKEN "$TELEGRAM_TOKEN"
  env_line OPENAI_API_KEY "$OPENAI_KEY"
  env_line CLI_RUNTIME_OPENAI_NAVIGATOR "$OPENAI_NAVIGATOR"
  env_line CLI_RUNTIME_OPERATIONAL_RECORD_KEEP "$OPERATIONAL_RECORD_KEEP"
  env_line CLI_RUNTIME_OPERATIONAL_RECORD_GRACE_MS "$OPERATIONAL_RECORD_GRACE_MS"
} > "$TMP_ENV"
chmod 600 "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"

TMP_BIN="$BIN_PATH.tmp.$$"
{
  printf '#!/usr/bin/env bash\nset -a\n'
  printf 'source %q\n' "$ENV_FILE"
  printf 'set +a\nexec node %q "$@"\n' "$INSTALL_DIR/bin/cli-runtime.js"
} > "$TMP_BIN"
chmod 755 "$TMP_BIN"
mv "$TMP_BIN" "$BIN_PATH"

launch_with_systemd() {
  local unit_dir="$HOME/.config/systemd/user"
  mkdir -p "$unit_dir"
  cat > "$unit_dir/qozyai-cli-runtime.service" <<EOF
[Unit]
Description=QozyAI CLI runtime

[Service]
Type=simple
ExecStart="$BIN_PATH" daemon
Restart=on-failure
RestartSec=2
KillMode=process
UMask=0077

[Install]
WantedBy=default.target
EOF
  cat > "$unit_dir/qozyai-cli-runtime-telegram.service" <<EOF
[Unit]
Description=QozyAI CLI runtime Telegram adapter
After=qozyai-cli-runtime.service
Requires=qozyai-cli-runtime.service

[Service]
Type=simple
ExecStart="$BIN_PATH" telegram
Restart=on-failure
RestartSec=2
RestartPreventExitStatus=78
UMask=0077

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable qozyai-cli-runtime.service qozyai-cli-runtime-telegram.service
  systemctl --user restart qozyai-cli-runtime.service
  for _ in {1..50}; do
    [[ -S "$STATE_DIR/runtime.sock" ]] && break
    sleep 0.1
  done
  [[ -S "$STATE_DIR/runtime.sock" ]] || die "runtime service did not create its socket; check: journalctl --user -u qozyai-cli-runtime"
  systemctl --user restart qozyai-cli-runtime-telegram.service
  say "Started user services: qozyai-cli-runtime and qozyai-cli-runtime-telegram"
}

launch_with_tmux() {
  local daemon_session="qozyai-cli-runtime-daemon"
  local telegram_session="qozyai-cli-runtime-telegram"
  local daemon_log="$STATE_DIR/daemon.log"
  local telegram_log="$STATE_DIR/telegram.log"
  local daemon_command telegram_command
  printf -v daemon_command 'exec %q daemon >>%q 2>&1' "$BIN_PATH" "$daemon_log"
  printf -v telegram_command 'exec %q telegram >>%q 2>&1' "$BIN_PATH" "$telegram_log"
  tmux kill-session -t "$daemon_session" 2>/dev/null || true
  tmux kill-session -t "$telegram_session" 2>/dev/null || true
  tmux new-session -d -s "$daemon_session" "$daemon_command"
  for _ in {1..50}; do
    [[ -S "$STATE_DIR/runtime.sock" ]] && break
    sleep 0.1
  done
  [[ -S "$STATE_DIR/runtime.sock" ]] || die "runtime did not create its socket; check $daemon_log"
  tmux new-session -d -s "$telegram_session" "$telegram_command"
  say "User systemd is unavailable; started tmux supervisors instead."
}

if [[ "${CLI_RUNTIME_INSTALL_NO_START:-0}" != "1" ]]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    launch_with_systemd
  else
    launch_with_tmux
  fi
fi

say ""
say "Installed QozyAI CLI Runtime"
say "  source:    $INSTALL_DIR"
say "  projects:  $PROJECTS_ROOT"
say "  config:    $ENV_FILE"
say "  command:   $BIN_PATH"
say ""
say "Authenticate and inspect the selected driver:"
say "  $BIN_PATH auth status $DEFAULT_DRIVER"
say "  $BIN_PATH auth start $DEFAULT_DRIVER"
say ""
say "After authentication, send a message to your Telegram bot."
say "Attach to a runtime session with: $BIN_PATH session attach <session-key>"

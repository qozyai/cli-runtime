# QozyAI CLI Runtime

`cli-runtime` drives real Claude Code and Codex interactive sessions in `tmux`.
A human can attach to the same pane, inspect it, and intervene directly. The
runtime is driver-neutral, but it necessarily understands each driver's launch
arguments and artifact format.

It does not implement QozyAI conversations, delegates, reminders, or wake
policy. A caller represents each independent execution lane with a session key.

## Guarantees

- one daemon exclusively owns each state directory
- one Telegram adapter exclusively owns that state directory's ingress queue
- one active submission per session; independent sessions remain concurrent
- vendor JSONL artifacts, not terminal text, decide turn completion
- terminal text is used only before submission for readiness, auth, and recovery
- driver liveness and exit status come from tmux pane lifecycle, not pane text or pane-writable metadata
- every submission owns exact inbox and outbox directories
- event replay uses a bounded durable window with explicit cursor expiry
- normalized history and file exchange live under `<workspace>/.qozyai`

Raw provider artifacts and normalized workspace history can contain sensitive
project data. Tool arguments are excluded from normalized history and events;
bounded redaction is defense-in-depth, not a secrecy boundary.

## Install

Prerequisites are Git, tmux, Node.js 22 or newer, and at least one installed
driver (`claude` or `codex`). Download and run the interactive installer:

```bash
curl -fsSLO https://raw.githubusercontent.com/qozyai/cli-runtime/main/install.sh
chmod +x install.sh
./install.sh
```

The installer asks for the installation and working directories, selected
driver, Telegram bot token, allowed chat IDs, and optional OpenAI transcription
and navigation. It clones or safely updates the public repository, writes a
mode-`0600` environment file, installs `~/.local/bin/cli-runtime`, and launches
the daemon and Telegram adapter. It uses user-level systemd when available and
otherwise starts isolated tmux supervisors. Rerunning it updates the clone and
configuration.

## Start

```bash
export CLI_RUNTIME_CLAUDE_HOME="$HOME/.claude-runtime"
export CLI_RUNTIME_CODEX_HOME="$HOME/.codex-runtime"
cli-runtime daemon
```

The daemon owns the default socket at
`~/.local/state/qozyai-cli-runtime/runtime.sock`. A second daemon using the same
state directory is rejected even if it requests another socket.

## Local CLI

```bash
cli-runtime session create main claude "$HOME/project"
cli-runtime session send main --wait -- "Inspect the failing tests"
cli-runtime session status main
cli-runtime session output main
cli-runtime session interrupt main
cli-runtime session attach main
cli-runtime session restart main
cli-runtime session close main
```

`session attach` opens the resident terminal. Detach with `Ctrl-b d`.

Create a same-driver fork when the provider session supports it:

```bash
cli-runtime session create delegated claude "$HOME/project" --fork-from main
```

Replay a captured provider artifact deterministically:

```bash
cli-runtime artifact replay claude '<cli-runtime-submission id="..."/>' trace.jsonl
```

## API

```text
POST   /v1/sessions
GET    /v1/sessions/:sessionKey
DELETE /v1/sessions/:sessionKey
POST   /v1/sessions/:sessionKey/submissions
GET    /v1/sessions/:sessionKey/output
POST   /v1/sessions/:sessionKey/interrupt
POST   /v1/sessions/:sessionKey/restart
GET    /v1/sessions/:sessionKey/attach
GET    /v1/submissions/:submissionId
POST   /v1/submissions/:submissionId/outputs/ack
GET    /v1/events?after=<sequence>&sessionKey=<optional>&waitMs=<optional>
GET    /v1/auth/:driver/status
POST   /v1/auth/:driver/start
POST   /v1/auth/:driver/submit
```

Submission progress contains a bounded summary, up to three plaintext
reasoning chunks exposed by the provider, and up to three tool records shaped
as `{id, tool, success, error}`. Successful tool output and tool arguments are
not retained in normalized state.

Output acknowledgement accepts optional individual IDs:

```json
{"outputIds":["output-id"]}
```

## Authentication

```bash
cli-runtime auth status claude
cli-runtime auth start claude
cli-runtime auth submit claude '<authorization-code>'
cli-runtime auth status codex
cli-runtime auth start codex
```

Status is one of `authenticated`, `unauthenticated`, or `unknown`. A failed
status command never masquerades as logged out. An active login is reused unless
`auth start ... --force` explicitly replaces it. Dead login panes are replaced
automatically. Driver and authentication subprocesses receive only a small
allowlist of execution variables plus explicit driver settings; arbitrary daemon
environment variables and runtime credentials are not inherited.

## Telegram

Telegram is a separate API-only process; start the daemon first:

```bash
export TELEGRAM_BOT_TOKEN="..."
export CLI_RUNTIME_TELEGRAM_DRIVER=claude
export CLI_RUNTIME_TELEGRAM_WORKSPACE="$HOME/project"
export CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS="12345,67890"
cli-runtime telegram
```

Accepted updates are persisted before Telegram's offset advances and replayed
after adapter restart. Ordinary messages serialize per chat/topic. `/status`
and `/stop` run immediately. `/reset` and `/driver` interrupt immediately, then
act as ordered barriers before later messages on that route.

`CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS` fails closed: an empty value accepts no
updates. List explicit chat IDs, or use `*` only for an intentionally public bot.

Text, documents, photos, audio, voice, video, and video notes are accepted. Files are
acknowledged individually after delivery; oversized or failed siblings are
reported without stranding successful files.

Set `OPENAI_API_KEY` to optionally transcribe audio with
`gpt-4o-transcribe`. The original media is always submitted. Transcription
failure is visible to the user and does not discard the media.

## Navigation

Known startup screens stay deterministic. Unknown startup/auth/recovery screens
may use an explicit external navigator:

```bash
export CLI_RUNTIME_NAVIGATOR_URL="http://127.0.0.1:7000/decide"
export CLI_RUNTIME_NAVIGATOR_API_KEY="..." # optional
```

Direct OpenAI navigation is disabled unless explicitly enabled:

```bash
export OPENAI_API_KEY="..."
export CLI_RUNTIME_OPENAI_NAVIGATOR=1
```

Navigator requests omit session keys, contain only a redacted 4,000-character
pane tail, and use a strict action schema. Navigation is never consulted after
a submission binds; vendor artifacts remain the completion authority.

See [`docs/turn-state.md`](docs/turn-state.md) for workspace state and retention.

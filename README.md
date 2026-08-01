# QozyAI CLI Runtime

`cli-runtime` controls real Claude Code and Codex interactive sessions in
`tmux`. A user can attach to the same terminal the daemon is driving, inspect
problems, and intervene directly.

The runtime deliberately does not know about QozyAI conversations, delegates,
reminders, heartbeat, or wake intents. Callers represent every independent
execution context with a session key.

## Guarantees

- one active submission per session
- independent sessions may run concurrently
- completion is read from driver artifacts, not inferred from terminal text
- terminal text is used only for readiness, auth navigation, and diagnostics
- caller session keys are durable; provider session IDs remain internal
- every event has a durable sequence number for replay
- the API listens on a local Unix socket by default

## Start

```bash
export CLI_RUNTIME_CLAUDE_HOME="$HOME/.claude-runtime"
export CLI_RUNTIME_CODEX_HOME="$HOME/.codex-runtime"
export CLI_RUNTIME_CODEX_MODEL="gpt-5.6-sol"
cli-runtime daemon
```

The default socket is
`~/.local/state/qozyai-cli-runtime/runtime.sock`.

## Local CLI

```bash
cli-runtime session create main claude "$HOME/project"
cli-runtime session send main "Inspect the failing tests" --wait
cli-runtime session status main
cli-runtime session output main
cli-runtime session interrupt main
cli-runtime session attach main
cli-runtime session restart main
cli-runtime session close main
```

`session attach` opens the exact resident terminal used by the runtime. Detach
with the normal tmux key sequence (`Ctrl-b d`); finishing a provider turn in
that terminal preserves the provider session for later API submissions.

Forked sessions are optional:

```bash
cli-runtime session create delegated claude "$HOME/project" --fork-from main
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
GET    /v1/events?after=<sequence>&sessionKey=<optional>&waitMs=<optional>
GET    /v1/auth/:driver/status
POST   /v1/auth/:driver/start
POST   /v1/auth/:driver/submit
```

`session.submit` returns immediately. Consumers follow its `submissionId`
through the submission endpoint or durable event stream.

Submission progress includes the latest assistant message and bounded tool
records (`tool`, `arguments`, `success`, and an error only on failure).

## Authentication

```bash
cli-runtime auth status claude
cli-runtime auth start claude
cli-runtime auth submit claude '<authorization-code>'

cli-runtime auth status codex
cli-runtime auth start codex
```

Codex device authorization completes in the browser and needs no submitted
code. Add `--force` to `auth start` to test or replace existing credentials.

## Mapping From QozyAI

- main lane: one long-lived session
- delegate: another session, optionally forked from main
- heartbeat or consolidation: temporary session, submit once, then close
- reminder/check-in/handover: submit to main
- shell background jobs and app processes: remain outside this runtime

## Telegram

Set `TELEGRAM_BOT_TOKEN` and run:

```bash
cli-runtime telegram
```

Telegram is an adapter over the same Unix-socket API. Core session behavior
does not depend on Telegram. Optional settings are:

```bash
export CLI_RUNTIME_TELEGRAM_DRIVER=claude
export CLI_RUNTIME_TELEGRAM_WORKSPACE="$HOME/project"
export CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS="12345,67890"
```

Supported commands are `/start`, `/driver claude`, `/driver codex`, `/status`,
`/stop`, and `/reset`. Messages are serialized per chat/topic while different
routes remain concurrent.

## Navigation Fallback

Known provider screens stay on the deterministic fast path. To handle unknown
provider UI states with a separate intelligence service, set:

```bash
export CLI_RUNTIME_NAVIGATOR_URL="http://127.0.0.1:7000/decide"
export CLI_RUNTIME_NAVIGATOR_API_KEY="..." # optional
```

The runtime posts the driver, phase, target state, bounded terminal screen, and
an explicit action schema. The service may return only `wait`, `press_key`,
`submit_text`, `auth_required`, or `fail`; keys and submitted text are validated
before they reach tmux. QozyAI can provide this endpoint without moving its
conversation or lane policy into this module.

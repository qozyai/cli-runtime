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
- session-key reuse is bound to one canonical workspace and driver
- runtime-owned panes are never restarted, released, or closed while a tmux client is attached
- vendor JSONL artifacts, not terminal text, decide turn completion
- terminal text is used only before submission for readiness, auth, and recovery
- each turn clears and probes the editable composer before pasting the real prompt
- multiline, NUL-containing, and over-32-KiB prompts are preserved in a mode-`0600` runtime file and submitted through a short file-reference instruction
- driver liveness and exit status come from tmux pane lifecycle, not pane text or pane-writable metadata
- every submission owns exact inbox and outbox directories
- event replay uses a bounded durable window with explicit cursor expiry
- events are readable the moment they happen; their disk write follows, so a hard
  kill can lose recent events and a stuck disk sheds them with a reported count
- normalized history and file exchange live under `<workspace>/.qozyai`
- a missing workspace is never recreated implicitly
- observability, history, and enrichment failures never fail a turn; they warn

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

The installer asks for the installation directory, Telegram projects root, selected
driver, Telegram bot token, owner-enrollment private chat IDs, and optional
OpenAI transcription and navigation. It clones or safely updates the public repository, writes a
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
cli-runtime session release main
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
POST   /v1/sessions/:sessionKey/release
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

## Turn Lifetime

A bound turn has no wall-clock limit. It ends when the provider artifact says the
turn is terminal, when the driver process exits, when the caller interrupts it,
or when it goes silent. Elapsed time alone never fails a turn, because it says
nothing about whether the turn is healthy.

Silence does. The inactivity clock starts when the turn binds to its artifact and
resets on every new record parsed from that artifact. Polling, an unchanged file,
a repeated identical progress checkpoint, and another session's artifact do not
reset it. `lastProgressAt` on the submission reports when it last moved.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLI_RUNTIME_SUBMISSION_TIMEOUT_MS` | `0` | Absolute post-bind limit; `0` disables it. `timeoutMs` on a submission overrides it for that turn. |
| `CLI_RUNTIME_SUBMISSION_INACTIVITY_MS` | `1800000` | Silence before a bound turn is treated as stuck; `0` disables stall detection. |
| `CLI_RUNTIME_TIMEOUT_SETTLE_MS` | `5000` | Grace for the driver to return to its composer after the interrupt. |

Startup and prompt-binding deadlines are unaffected; they detect failures before
a turn is authoritatively bound.

When a limit does expire, the runtime interrupts the driver, then probes it. If
the composer answers, the session stays `ready`, the pane and the provider
conversation survive, and the next message continues in the same session. If it
does not, the session becomes `attention_required`. Either way the submission is
`failed` with the reason and the silence duration, and a `submission.timed_out`
event records whether the driver settled. No expiry path kills a pane.

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
export CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT="$HOME/projects"
export CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS="12345,67890"
cli-runtime telegram
```

Accepted updates are persisted before Telegram's offset advances and replayed
after adapter restart. The configured root is a catalog: each selectable project
is a direct child directory named with ASCII letters, digits, `_`, or `-`.
Telegram commands never create directories. Use `/project` to list projects or
`/project <name>` to select one in each chat or topic. Sessions start lazily on the first
ordinary message and always run in the selected project, never the catalog root.

The first accepted allowlisted private message binds its non-bot `from.id` as
the permanent Telegram owner in private state at
`<state-dir>/telegram/owner.json`. Before that enrollment, every update remains
fail-closed through `CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS`. Once bound, that owner
is accepted in any private chat, group, or topic where Telegram delivers their
message; group chat IDs need no separate configuration. Other
senders are discarded before queue persistence, command handling, attachment
download, route mutation, or agent submission. Invalid owner state stops adapter
startup instead of making the bot claimable again.

Only messages explicitly marked by Telegram as topic messages use a topic route;
ordinary reply-thread IDs and a forum's General topic use the chat's `main`
route. Ordinary messages serialize per route while different topics remain
concurrent. `/status`, `/stop`, and bare `/project` run immediately. `/project <name>`,
`/reset`, and `/driver` are ordered barriers and do not eagerly launch a pane.
Switching projects releases the old pane but preserves its provider conversation
for resumption when selected again.

Only the bound owner can instruct a driver. The owner can start using the bot in
a group without discovering its numeric chat ID or restarting the adapter;
Telegram privacy settings still determine which group messages reach the bot.
Group members can read prompts and replies, and Telegram may deliver their
messages to an administrator bot even though the adapter discards them.
Telegram topics remain visual and routing separation, not confidentiality
boundaries. Binding the same project to two routes also runs two independent
agents against one directory, so their edits can conflict.

`CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS` is the initial-owner enrollment boundary.
Before an owner exists, an empty value accepts no updates; list the intended
private chat ID. `*` allows the first private sender to claim a fresh state, so
do not use it during enrollment. After enrollment, the durable owner ID replaces
the chat allowlist as the admission boundary.

Text, documents, photos, audio, voice, video, and video notes are accepted. Files are
acknowledged individually after delivery; oversized or failed siblings are
reported without stranding successful files.

Set `OPENAI_API_KEY` to optionally transcribe audio with
`gpt-4o-transcribe`. The original media is always submitted. Transcription
failure is visible to the user and does not discard the media.

Replying to a message carries that message into the prompt. Its text or caption
is sent as a `<telegram-reply-context>` block ahead of `Current message:`;
replying to one of the bot's own answers works too, because those are posted as
rich messages and are flattened back to text. Attachments on the replied-to
message are downloaded and submitted alongside the new message's own files,
named `replied-<message-id>-<name>`, and replied-to audio is transcribed under a
`Replied-to audio transcript:` label. A replied-to attachment that cannot be
fetched — oversized against `CLI_RUNTIME_TELEGRAM_MAX_FILE_BYTES`, or simply
unavailable — does not stop the turn: the user is told, the reply context records
what is missing, and the message runs. Replying to a message that carries neither
text nor attachments, such as a forum's topic-created service message, adds no
context block.

Messages that arrive together become one turn. Every ordinary message waits a
short quiet period that each new arrival resets, so a long paste a client splits
into several messages is answered as the one thought it was, not as fragments in
sequence. Parts combine in arrival order — each keeping its own reply context —
and their attachments are submitted together.
`CLI_RUNTIME_TELEGRAM_BURST_DEBOUNCE_MS` (default `200`, `0` disables joining)
sets the quiet period; `CLI_RUNTIME_TELEGRAM_BURST_MAX_WAIT_MS` (default `2000`)
and `CLI_RUNTIME_TELEGRAM_BURST_MAX_PARTS` (default `25`) bound how long and how
large a burst may grow. A command is never absorbed: it dispatches the buffered
burst ahead of itself, except `/stop`, which discards it and says so. Messages
that arrive while a turn is already running still queue per route, unchanged.

A restart is announced rather than silent. Whoever restarts the adapter drops a
one-shot notice in `<state>/telegram/notices/*.json`
(`{version, kind, text, route?, expiresAt?}`); the running adapter drains that
directory once a second, sends each notice, and deletes it. A notice carrying a
`route` goes to that chat and topic, and one without goes to the bound owner
privately. Notices are deleted before they are sent, so a crash loses one rather
than repeating it, and a notice past `expiresAt` is discarded — a "stopping"
message must never arrive after the restart it described.

The adapter announces one thing on its own: a previous run that did not stop
cleanly, which it detects from `<state>/telegram/last-run.json`. Planned
restarts stay the restarter's business, because only it knows the reason.
Repeated crashes are collapsed into one message per
`CLI_RUNTIME_RESTART_ANNOUNCE_WINDOW_MS` (default five minutes) that reports how
many restarts it stands for; `CLI_RUNTIME_TELEGRAM_NOTICE_POLL_MS` (default
`1000`) sets the drain interval.

See [`docs/guides/telegram-projects.md`](docs/guides/telegram-projects.md) for
project naming, switching, rename recovery, route state, and command behavior.

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

See [`docs/guides/turn-state.md`](docs/guides/turn-state.md) for workspace state and retention.

# Telegram Projects

The configured Telegram directory is a **projects root**. Each selectable direct
child directory is a **project**. A Telegram forum topic can be bound to one
project, while a chat without topics has one active project selection.

Claude Code or Codex always runs inside the selected project directory, never in
the projects root.

## Trust boundary — read this first

The first accepted allowlisted private message binds its numeric Telegram sender
ID as the owner. Before enrollment, all other updates fail closed. After
enrollment, only that owner can instruct the agent in any private chat, group,
or topic where Telegram delivers their message; group chat IDs require no
separate configuration. All other senders are discarded before the durable
queue or any side effect. The drivers still run with permissions bypassed, so
protect the owner account and private runtime state. Group members can read
prompts and replies, and topics separate work visually; they are not a
confidentiality boundary. Project path validation keeps routing correct, but
cannot stop the owner from asking the agent to read another host path.

Owner state is stored at `<state-dir>/telegram/owner.json` with mode `0600`.
Malformed owner state fails adapter startup rather than reopening first-use
enrollment. To intentionally rebind, stop the adapter first, preserve an audit
copy of the old record, remove it, and send the new owner's allowlisted private
message before using the bot in a group.

Two routes may bind the same project. They then run independent agents in the
same directory. Nothing serializes their edits, so they can conflict.

## Configuration

Set an existing, dedicated directory:

```bash
export CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT="$HOME/projects"
```

The adapter exits with status `78` when this variable is absent, empty, the
runtime user's home directory, `/`, missing, or not a directory. There is no
single-workspace compatibility mode and `CLI_RUNTIME_TELEGRAM_WORKSPACE` is not
read. Create the root and move or clone projects beneath it before starting the
adapter.

Project names must match `^[A-Za-z0-9_-]+$`. Matching is exact and
case-sensitive. Files, sockets, symbolic links, nested directories, whitespace,
dots, separators, control characters, and non-ASCII names are not selectable.
Commands reject invalid names rather than sanitizing them.

Telegram commands never create, clone, rename, move, or delete project
directories. Create a project on the host, for example:

```bash
mkdir -p "$CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT/api"
```

## Routes and topics

A topic route exists only when Telegram marks the message with
`is_topic_message: true` and supplies `message_thread_id`. A bare thread ID on an
ordinary reply is ignored. Messages in a forum's General topic therefore use
the chat's `main` route, as do private chats and non-forum groups.

Every route stores its own project and driver. Different routes can run
concurrently; work within one route is ordered. Replies, progress, typing,
errors, transcripts, and output files use the same normalized topic identity.

## Commands

| Command | Behavior |
| --- | --- |
| `/project` | List selectable direct-child projects and mark the current selection. Never starts a session. |
| `/project <name>` | Bind or switch this route to the exact project name. |
| `/start` | Check authentication and binding readiness without starting a session. |
| `/status` | Show route, project availability, driver, session status, workspace, and active submission. |
| `/attach` | Ask the configured external attachment service for global and current-route terminal links. CLI runtime never exposes tmux to the internet itself. |
| `/stop` | Cancel adapter preparation or interrupt the exact accepted turn. The pane stays resident. |
| `/reset` | Permanently close this route-project conversation. The next ordinary message starts fresh. |
| `/driver claude\|codex` | Change the driver, close an incompatible conversation, and start nothing until the next ordinary message. Provider chat context is not transferred across the change. |

Unknown and invalid project names change nothing. Selecting the current project
or driver is an idempotent no-op and does not interrupt work. Bare `/project`,
`/status`, `/attach`, and `/stop` are immediate; project selection, reset, and driver
changes are ordered barriers before later messages.

`/attach` is optional. Set `CLI_RUNTIME_TELEGRAM_ATTACH_SERVICE_URL` to a local
HTTP endpoint supplied by the hosting environment. The adapter sends that
service only the current route's existing attach command; discovery of global
consoles, `ttyd`, tunneling, authentication, and exposure lifecycle stay outside
CLI runtime. Without the setting, `/attach` reports that attachment is not
configured.

## Switching and residency

A route has at most one resident pane. Switching from `api` to `web` cancels or
settles `api` work, releases its pane, persists the new binding, and does not
start `web`. The first ordinary message starts or resumes `web` lazily. Switching
back resumes `api` from its saved provider conversation ID.

`/stop` does not release a pane. A project switch is the only Telegram action
that does. If a human is attached to a pane, project switch, `/reset`, and a real
driver change refuse without changing state. Detach with `Ctrl-b d` and retry.

## Renames, replacement, and recovery

A bound project's canonical path is its identity while its conversation
matters.

- Renaming a never-bound directory simply changes the selectable name.
- Renaming a bound directory makes that project unavailable without deleting or
  retargeting its session. Restore the exact name to resume it, or explicitly
  select another valid project.
- Selecting the renamed directory under its new name creates a distinct session.
  Restoring and selecting the old path still resumes the old conversation.
- Deleting a directory and creating a different directory at the same path
  inherits the old conversation. Use `/reset` when that history is stale. The
  router deliberately writes no identity marker into project directories.

While a bound project is unavailable, ordinary messages, `/reset`, and
`/driver` refuse. `/status`, bare `/project`, `/stop`, and switching to another valid
project remain usable. A missing project and a missing projects root are reported
separately.

## Durable state and inspection

Bindings live in mode-`0600` `<state>/telegram/routes.json`. Each mutation is a
field-level merge serialized through one atomic write chain. Malformed JSON is
quarantined as a whole; schema-invalid entries are quarantined individually and
valid routes continue loading. There is no legacy route-file reader or route-key
migration.

Ordinary messages are buffered per route for a short debounce window before they
dispatch, so a burst arriving together becomes one turn; commands are never
buffered. Buffering happens after an update is persisted, so a burst interrupted
by a restart replays from the queue and re-forms.

Restart announcements use two more files in the same directory. Notices waiting
to be sent are one JSON file each under `<state>/telegram/notices/`, written by
whoever is about to restart the adapter and removed as they are sent;
`<state>/telegram/last-run.json` records the current run and is stamped
`stoppedCleanly` by the signal handler, so a start that finds it unstamped knows
the previous run died. Both are operational: a torn file is dropped and logged
rather than quarantined, because the message it held is already stale.

Use `cli-runtime session list` to inspect runtime records and
`cli-runtime session attach <session-key>` to inspect a resident pane. The local
runtime API is protected by its mode-`0600` Unix socket, not application-level
authentication.

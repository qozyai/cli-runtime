# Telegram Projects

> **Status: planned, not implemented.** This describes the intended operator
> contract for the Telegram project router specified in
> [`../specs/0002-telegram-project-routing/spec.md`](../specs/0002-telegram-project-routing/spec.md). It is
> completed and verified as part of that feature's final phase.

The configured Telegram directory is a **projects root**. Each direct child
directory is a **project**. A Telegram forum topic can be bound to a project, and
a chat without topics has one active project selection you can switch.

Claude Code or Codex always runs inside the selected project directory, never in
the projects root.

## Trust boundary — read this first

Anyone who can post in an allowlisted chat can instruct the agent, and the
drivers run with permissions bypassed. **Allowlist membership is equivalent to
shell access as the runtime user.** Topic creation in a forum group is
unprivileged, so topics separate your work visually — they are not an
authorization boundary. The project path rules keep routing correct; they do not
stop a message that simply asks the agent to read a file elsewhere on the host.

Two routes bound to the same project run independent agents in the same
directory. Nothing serializes their edits, so they can conflict.

## Creating a project

Project creation is a filesystem action. Telegram commands never create, clone,
move, or delete directories.

To create a project, make a direct child directory under the projects root. To
start a fresh conversation inside an existing project, use `/reset` — that does
not create anything.

### In a direct chat with the bot

1. On the runtime host, create `<projects-root>/Arctic Project` and initialize or
   clone its repository as needed.
2. Send `/projects` to confirm `Arctic Project` is discoverable.
3. Send `/project Arctic Project` to make it active.
4. Send your first work request. The tmux and provider session are created
   lazily.

### In a forum-enabled group

1. Create the project directory under the projects root as above.
2. Create a Telegram topic for it using the normal Telegram UI.
3. Inside that topic, send `/project Arctic Project` once to persist the binding.
4. Send work requests in that topic.

Creating a topic does not create a directory, and creating a directory does not
bind a topic.

## Commands

| Command | Behavior |
| --- | --- |
| `/projects` | List projects, mark the current selection, show how to select. Never starts a session. |
| `/project <name>` | Bind or switch this route to the exact project name. Spaces and Unicode work as typed. |
| `/start` | Check authentication, or guide project selection if unbound. |
| `/status` | Route, project, driver, session status, resolved workspace, active submission. |
| `/stop` | Interrupt the current turn for this route. The agent stays running, so your next message continues immediately. |
| `/reset` | Fresh conversation in the selected project. Keeps the binding and driver. |
| `/driver claude\|codex` | Change the driver, keeping the binding. |

Matching is exact and case-sensitive. Unknown names change nothing.

## Switching projects

A route holds one running agent at a time. Switching from A to B lets A's current
turn finish, then stops A's process. Switching back to A restarts it in the same
directory and **resumes the same conversation** — you lose a few seconds, not
your context.

Different topics are different routes, so they run in parallel and never
interrupt each other. Each keeps its own running agent, so a chat with many
active topics keeps that many agents alive — switching projects within a route is
what frees one.

## Renaming a project directory

A bound project's path is effectively immutable while its conversation matters,
because both the runtime and the providers key their session on that directory.

- Renaming a **never-bound** directory is free.
- Renaming a **bound** directory makes it unavailable. The binding is kept and
  nothing is torn down, so **renaming it back restores the conversation
  immediately**. Messages, `/reset`, and `/driver` all refuse with the same
  message until you do.
- Selecting the renamed directory under its **new** name is a new project with a
  fresh conversation. The old one still resumes if that exact path comes back.

## Recovering a wedged route

Bindings live in `<state>/telegram/routes.json`. The adapter caches them in
memory and rewrites the whole file, so **stop the adapter first**, then edit,
then restart. Editing while it runs loses your change at the next mutation.

An entry that fails validation is moved to `routes.invalid.<timestamp>.json` and
logged by route key; the adapter starts with the remaining routes.

To inspect a project's agent directly, use the session list and attach APIs — the
per-project tmux session runs on the named `cli-runtime-live` socket.

## Rolling back

Restore `routes.json` from your backup and point the Telegram workspace variable
at a **project** directory, never at the projects root. The route file format is
a superset of the older one, so bindings survive a downgrade; an older build
simply ignores the `project` field.

## Configuration

`CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT` sets the projects root. If Telegram is
enabled and this is not set, the adapter refuses to start with exit status 78
rather than running in whatever directory it happened to launch from. Existing
single-workspace installs migrate by pointing this variable at the parent of the
old workspace.

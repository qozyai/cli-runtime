# Telegram Topics And Project Routing Plan

## Status

Planned, not implemented.

The configured Telegram directory becomes a projects root. Each direct child
directory is an available project. Each Telegram forum topic can be bound to a
different project, and a chat without topics has one active project selection
that can be switched. Claude Code or Codex runs in the selected project
directory, never in the projects root. Bindings, driver choices, and
project-specific conversations survive adapter and daemon restarts.

**This work ships as two independent releases.** Release 1 is runtime session
correctness: a set of confirmed defects in shipped code that need no catalog, no
bindings, and no Telegram change to fix or to test. Two of them are live today on
a single workspace — `WorkspaceState.ensure` recreates a renamed-away workspace
as an empty directory, and `SessionManager.create` reuses a session key without
comparing its driver or workspace. Coupling those fixes to a new product surface
would leave them unshipped if routing slips. Release 2 is the Telegram project
router, built on a runtime that is already correct. Each release has its own gate.

This document is authoritative for implementation. `decisions.md` preserves
historical rationale and may describe alternatives superseded here; it is not
required reading.

## Existing Baseline

The current adapter already provides most of the transport behavior:

- ordinary work is serialized independently per route, so separate topics can
  already run concurrently
- `/status` and `/stop` bypass an occupied route; `/reset` and `/driver` are
  ordered barriers
- accepted Telegram updates are persisted before the upstream offset advances
- route driver choices are stored atomically in `<state>/telegram/routes.json`
- runtime sessions accept an absolute workspace and create the tmux pane and
  provider process in that directory
- normalized history and file exchange live under each workspace's `.qozyai`
- a session whose pane is gone becomes `stopped`, and `restart()` resumes it
  from a preserved `providerSessionId`

Two things need tightening. `routeKey(message)` currently separates messages by
`chat.id` and any raw `message_thread_id`; thread identity must mean an actual
Telegram topic before it becomes a project boundary. And every route currently
creates `telegram:<chat>:<thread>` in the one configured workspace.

## Terminology

- **Projects root:** the configured directory containing projects. It is a
  catalog boundary and is never passed to a driver as its workspace.
- **Project:** one direct child directory of the projects root.
- **Route:** one Telegram chat/topic pair, identified by
  `<chat-id>:<message-thread-id>` only when Telegram marks the message as a
  topic message, otherwise `<chat-id>:main`.
- **Binding:** the selected project stored for a route.
- **Project session:** the runtime record and provider conversation for one
  route and one project. Its pane may be running (resident) or released; a
  released session keeps its `providerSessionId` and resumes on next use.

## Product Contract

### Telegram topics

- A message belongs to a topic route only when `message.is_topic_message ===
  true` and `message_thread_id` is present. This covers forum supergroups and
  topic-enabled private bot chats.
- A bare `message_thread_id` without `is_topic_message` is not a topic boundary;
  fold ordinary non-forum group reply threads into `<chat-id>:main`.
- Use one normalized `topicThreadId(message)` helper for route keys and every
  outgoing Telegram call that accepts a topic ID, so routing, replies, progress,
  typing, errors, and files cannot disagree about whether a topic exists.
- Each topic route has its own project binding and driver choice, and topics run
  simultaneously because their route chains and session keys are independent.
- A switch in one topic must not interrupt, reset, or retarget another topic.
- Replies, progress edits, typing, transcripts, errors, and output files stay in
  the originating topic.
- The bot never creates, renames, closes, or deletes Telegram topics, and never
  binds a topic automatically from its visible title.

### Chats without topics

- The route is `<chat-id>:main`, including private chats and non-forum groups
  even when an update carries a non-topic thread identifier.
- It has one explicit active-project selection, changed with `/project <name>`.
- Switching from A to B cancels any adapter-side preparation, interrupts A's
  accepted turn if one exists, waits for it to settle, then releases A's pane. A
  project switch is the only thing that releases a pane.
  Switching back to A restarts it in A's unchanged directory and resumes its
  conversation, unless the user reset it, accepted a renamed path as a fresh
  project, or changed to an incompatible driver.
- A switch is a barrier before later messages. It persists the new binding but
  does not start B; the first ordinary message in B creates or resumes its
  session lazily.
- A switch or other control that would release or close a human-attached pane is
  refused without changing the binding. The user detaches and retries.

### Unbound routes

- No project is selected implicitly.
- `/start` and ordinary messages explain that a project must be selected and
  point to `/projects`.
- An unbound route must not create a session, download an attachment, write
  `.qozyai` under the projects root, or fall back to the root.
- If the root has no projects, say where to create one without exposing
  unrelated filesystem contents.

An operator may bind the same project to two routes. Each gets its own
conversation and tmux session, and the runtime does not serialize edits between
them; the documentation warns that simultaneous agents in one project conflict.

## Telegram Command Contract

| Command | Behavior |
| --- | --- |
| `/projects` | List available direct-child project names, mark the current selection, and show selection instructions. Never starts a session. |
| `/project <name>` | Validate and bind/switch this route to the exact project name. Never starts the target session. The full remainder is the name; because names cannot contain whitespace, the existing parser's trim is harmless and no quoting or escaping scheme is needed. |
| `/start` | Check authentication and binding readiness without starting a session; if unbound, guide project selection. |
| `/status` | Route, project, driver, session status, resolved workspace, and active submission ID. Say so explicitly when unbound or missing. |
| `/stop` | Cancel adapter preparation and interrupt the selected project's turn. Immediate, never queued. It does not release the pane, so the next message continues in a warm session. |
| `/reset` | Permanently close the selected project's current conversation. Keep the binding and driver; the next ordinary message starts fresh. |
| `/driver claude\|codex` | Change the route's driver. Preserve the binding, close an incompatible current session, and start nothing until the next ordinary message. |

- `/project` with no argument behaves as `/projects`.
- Unknown names leave the binding and current work untouched.
- Selecting the already-active project or driver is an idempotent no-op and
  must not cancel, interrupt, release, or close current work.
- Listing is sorted by byte value. Matching is exact and case-sensitive. The
  name charset makes byte order and display order the same thing, so there is no
  locale, collation, or normalization question to answer.
- Invalid filesystem entries are omitted from `/projects` and logged. Their
  exact count is not part of the user-facing contract.
- When the root holds directories excluded only by the name rule, `/projects`
  adds one generic line saying some directories are not selectable because of
  their names and giving the allowed charset. No count, no names, no paths. An
  operator who renames a directory to a legal name is the intended recovery, and
  without that line a legal-looking directory silently missing from the list is
  indistinguishable from a broken bot.
- `/project@botname ...` continues to work through the existing command parser.

## Project Catalog And Path Safety

Add a small project-catalog component instead of scattering path checks through
`telegram.js`. The catalog must:

1. Canonicalize the configured root with `fs.realpath` and require a directory.
2. Enumerate direct children only.
3. Accept only direct directories. Reject files, sockets, and symbolic links.
4. Define the stable identity path as `path.join(canonicalRoot, exactChildName)`.
   While the child exists, require its `realpath` to equal that expected direct-
   child path. This makes the identity recomputable for `/status`, `/stop`, and
   rename-back recovery even while the directory is missing. Never accept an
   arbitrary absolute path supplied through Telegram.
5. **Accept only names matching `^[A-Za-z0-9_-]+$`** — ASCII letters, digits,
   underscore, hyphen. This one rule is the entire name contract. It subsumes
   empty names, `.`, `..`, NUL bytes, `/`, platform separators, control
   characters, and every form of whitespace, because none of those characters
   are in the allowlist; `.` and `..` cannot match a pattern with no dot in it.
   Reject rather than sanitize, and never introduce an escaping scheme.

   An allowlist is what makes the existing command parser safe to keep.
   `commandFor` trims the message text and the argument, so a name with leading
   or trailing whitespace could never be typed; its regex has no `s` flag, so a
   name containing a newline does not match a command at all and would be
   submitted to the currently bound project as an ordinary prompt. Both become
   unreachable rather than handled.

   Non-ASCII letters are deliberately excluded. Linux does not normalize
   filename bytes, so NFC and NFD spellings of one name are two distinct
   directories that render identically in `/projects`, and exact matching fails
   against whichever one the client did not send. Confusable scripts (Cyrillic
   `а` against Latin `a`) produce two listings that look the same while
   resolving to different working directories, and drivers run there with
   `bypassPermissions`. Supporting them means choosing a normalization form,
   normalizing on both the catalog and command sides, and adding a confusables
   policy. Widening this allowlist later is backward compatible; narrowing it
   would not be.
6. Re-resolve and revalidate a selection immediately before session creation or
   submission; use the expected identity path only for lookup when missing, never
   as permission to create or run in it.
7. Verify containment with canonical paths and `path.relative`; prefix string
   comparison is insufficient.
8. Never create a missing project from a Telegram command.
9. Never treat the projects root itself as a project.
10. Distinguish a missing *project* from a missing or unreadable *projects
    root*, so an unmounted disk does not report "rename it back" on every route.

A bound project path is immutable while its conversation matters, because both
the runtime and the providers associate sessions with that working directory:

- A never-bound directory may be renamed freely.
- If a bound directory disappears, preserve the binding, report the project as
  unavailable, and never close, replace, or recreate its session implicitly.
  Ordinary messages, `/reset`, and `/driver` refuse. `/status`, `/projects`, and
  `/stop` remain usable, and an explicit switch to another valid project may
  release the old pane without ending its identity. Renaming the directory back
  therefore restores the resumable conversation with no recovery step.
- Explicitly selecting the renamed directory under its new name is a new project
  identity with a fresh conversation. The old-name session is left in place and
  resumes if that exact path is ever restored and selected again.
- **Replacing a directory at a bound path inherits the previous conversation,
  and this is accepted rather than detected.** Identity is the canonical path, so
  deleting `api` and creating a new `api` resumes the old `providerSessionId`
  against unrelated contents — and the provider's own transcript is keyed on the
  same path, so Claude resumes with history describing files that no longer
  exist. `/reset` is the documented remedy and the message for a replaced project
  is the same as for any stale conversation. A durable identity marker inside the
  project directory is rejected: it would mean the catalog writes into project
  directories, which it otherwise never does, and something would have to create
  it on first binding — reintroducing exactly the implicit directory mutation
  that `WorkspaceState.ensure` is being fixed to stop performing.

The root is trusted configuration, but Telegram input is not a path. The name
allowlist collapses most of this boundary into one rejection table — traversal
strings, absolute paths, separators, whitespace, and control characters are all
the same test. Type and containment checks still need their own cases: files,
sockets, symbolic links, a symlinked child resolving outside the root, and
directory replacement at a bound path.

## Configuration

`CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT` is the Telegram workspace setting, exposed
as `config.telegram.projectsRoot` after canonical validation. There is one mode.

- If Telegram is enabled and the projects root is not explicitly set, fail
  adapter startup with a focused configuration error naming the variable. Do not
  run a bot in the daemon's incidental `process.cwd()`. Local daemon/CLI
  defaults are unaffected.
- Exit with status `78` (`EX_CONFIG`) and add `RestartPreventExitStatus=78` to
  the Telegram unit template in `install.sh`, so a misconfigured bot stops with a
  diagnosable error instead of restarting silently forever. `launch_with_systemd`
  already rewrites both unit files with `cat >` on every run, so adding the line
  to the template is the entire change; there is no upgrade path to reason about.
- **Rejecting an empty value, `$HOME`, and `/` is config validation, not
  installer input validation.** `config.js` currently resolves
  `env.CLI_RUNTIME_TELEGRAM_WORKSPACE || process.cwd()` with no checks at all,
  and the env file is a thing operators edit by hand — so a rule enforced only at
  the installer prompt is not enforced. Validate in `config.js`, fail closed with
  the same exit `78`, and treat the installer prompt as a second line of defence
  that catches the mistake earlier with a friendlier message.
- **`CLI_RUNTIME_TELEGRAM_WORKSPACE` is removed, not migrated.** No detection, no
  inline migration text, no dual-variable support. Setting up the projects root
  is a one-time manual step for the one install that predates this work: create a
  root, move the old workspace inside it, set the variable. Carrying a migration
  path would mean the config layer, the startup error, and the installer each
  keep a second code path alive permanently to serve a single operator once.
- The installer prompt changes from `Working directory` to `Projects root
  directory` and applies the same three rejections; `path.resolve("")` returns
  the current directory, so an empty default would silently publish whatever
  directory the installer happened to run in.
- The installer keeps creating the directory it prompts for, so a fresh install
  begins with a valid but empty catalog. `/projects` must read as "no projects
  yet, create one here" rather than as an error.

There is no global cap on resident sessions. Residency is bounded structurally —
one resident session per route — and that bound is enforced by the switch path
itself. See **Session Residency**.

## Durable Route State

Keep the existing flat route document and add one field:

```json
{
  "-100123456:main": { "driver": "claude", "project": "api" },
  "-100123456:44": { "driver": "codex", "project": "website" }
}
```

- A record with no `project` is unbound.
- Serialize all route mutations through one shared in-process write chain, so
  two concurrent topic changes cannot lose one another.
- Write the document with the existing atomic-replace helper and mode `0600`.
  This protects readers and process-crash replay; power-loss durability for all
  runtime state is a separate concern and is not claimed here.
- **There is no route-state migration and no legacy route-file location.** Only
  `<state>/telegram/routes.json` is read. Any record that does not match the
  current schema and key format — including keys built from a bare non-topic
  `message_thread_id` — is quarantined by the per-entry validation below, which
  is machinery the file needs anyway. Reusing it costs nothing; a migration path
  would be a second reader kept alive forever to preserve driver choices that
  the next `/driver` re-states in one word.
- Treat syntax corruption and invalid entries separately. If the document is
  not valid JSON, atomically move the whole file to
  `routes.invalid.<timestamp>.json`, log the recovery path prominently, and
  start with no routes. If it is valid JSON, validate each entry, quarantine the
  invalid subset with its keys logged, persist the valid subset, and start with
  it. Permission and other I/O errors fail startup visibly rather than being
  mistaken for corruption.
- **Make staleness unrepresentable rather than forbidden.** The route store
  exposes exactly `get(key)` and `update(key, fields)`, and no function anywhere
  accepts a route record as a parameter. Today `dispatch` captures `route` and
  passes it into `control`, which writes the captured object back — so a
  preceding command's field is silently reverted while both commands report
  success. A rule against that has to be remembered at every call site and
  restated in every section; an API with no way to hold a record cannot express
  the bug. `update` applies a field-level merge onto the live record at the head
  of the write chain.
- Replaying a `/project` command is idempotent, and a queued switch is durably
  applied before later queued messages on that route.

Route state stores a relative project name, never credentials, provider session
IDs, absolute paths, or topic titles.

## Runtime Session Identity

```text
telegram:<chat-id>:<thread-or-main>:<canonical-project-path>
```

The key carries the canonical path directly and is not hashed here. `safeId` is
already `sha256(value).slice(0, n)` and is applied to the *whole* session key at
both places where it becomes a name — the session record directory and the tmux
session name — so the logical key never reaches the filesystem, and a second
hand-rolled hash would protect nothing. Keeping the path readable makes
`/status`, logs, and event records greppable by project, and makes "a moved
project cannot reuse the session recorded for its old path" self-evident instead
of an inference. Identity still changes when the directory is renamed or moved,
because the path changed. The public session record continues to expose the
canonical workspace for inspection.

- The route stays in the key, so two topics bound to one project do not share a
  conversation. The project stays in the key, so a non-topic chat can switch
  away and later resume its project-specific conversation.
- `SessionManager.create` is the identity authority **for session-key reuse**,
  and only for that. An existing non-closed key with a different driver or
  canonical workspace returns a fail-closed `SESSION_IDENTITY_MISMATCH`/409 and
  is not reused, closed, or retargeted. This closes a live defect: `create`
  currently returns an existing session without comparing either.
- For a new key the daemon accepts the workspace the caller asserts; it has no
  concept of a projects root. Path containment is adapter-side, in the catalog.
  Never skip catalog revalidation on the assumption that the daemon enforces it.
- `create` runs its steps in this order: normalize driver, `fs.realpath` **fail
  closed** with no fallback, `stat`, identity check, then
  `workspaceState.ensure`, persist, launch. Today `ensure` runs before the
  existing-record check, so a request that must be rejected mutates the target
  directory first, and a transient `realpath` failure stores a non-canonical
  workspace that then 409s permanently.
- `WorkspaceState.ensure` must never create the workspace root. It `lstat`s the
  workspace, throws a typed `WORKSPACE_MISSING` when absent or not a directory,
  and only then creates the `.qozyai` subtree. `fs.mkdir(..., { recursive: true
  })` otherwise fabricates the workspace from the turn-finalization paths
  (`collectOutputs`, `finishTurn`, `prune`), recreating a renamed-away project as
  an empty directory — which defeats the missing-path check, lists a phantom in
  `/projects`, and blocks rename-back recovery with `ENOTEMPTY`.
- Serialize create, restart, release, close, **and submission admission** per
  session key. Two concurrent creates for the same key wait on the same mutation
  chain; the later request then reuses the matching identity or receives 409.
  This is narrow operation serialization, not a background lifecycle state
  machine.
- **Submission admission is in the critical section because it is already racy
  today, not only because release needs it.** `submit` reads
  `sessionState(session).busy`, then awaits `driverRunning(session)`, and only
  afterwards sets `this.active`. Two concurrent submits on one key both observe
  `busy === false` across that await and both proceed, which is the same class of
  defect as the unchecked `create` reuse next to it. Admission means everything
  through `this.active.set` and the matching `status` write, so it is atomic
  against itself and against release. Release can then refuse `SESSION_BUSY` and
  kill the pane without a submission slipping in behind the check, with no
  transitional state and no separate admission gate.
- Every newly created session gets a random `incarnationId`, and its tmux name
  includes both the session-key hash and incarnation hash. A timed-out execution
  from a closed incarnation can therefore fail against its dead pane but can
  never send keys into a successor created under the same logical session key.
- Persist `providerSessionId` to the session record as soon as artifact binding
  observes it, not only after successful turn completion. A release or daemon
  restart after binding can then resume the conversation. If interruption occurs
  before the provider exposes any session ID, a fresh restart is unavoidable and
  is reported honestly.
- `/reset` closes only the current route-project identity and does not recreate
  it. The next ordinary message creates a fresh incarnation.
- `/driver` preserves the binding, records the new driver, closes an incompatible
  current identity, and does not create the replacement until the next ordinary
  message.
- Session keys are not migrated. A record written under the old route-only key
  format is simply never looked up again, because every lookup now computes the
  route-project key. The record and its workspace history stay on disk, inert and
  a few kilobytes each; `pruneOperationalState` only trims submission records, so
  nothing collects them and nothing needs to. Its tmux pane, if one survived the
  restart, is removed by ordinary startup reconciliation as a pane matching no
  current incarnation, under the same attached-client guard as any other. The
  ordered barrier therefore has no legacy branch: nothing special happens on the
  first project selection.

Claude Code ties sessions to the working directory and stores transcripts under
a path derived from it. The runtime therefore never relocates sessions or
migrates provider artifacts; stable project paths are part of the contract.

## Session Residency

**A route has at most one resident session.** Switching projects settles the
active turn and then releases the previous project's pane. That structural bound
is the whole residency mechanism; there is no global cap and no admission
control.

- Add daemon-owned `SessionManager.release(sessionKey)` and
  `POST /v1/sessions/:key/release`. Telegram never manipulates tmux directly.
  Release refuses with `SESSION_BUSY` while a turn is active and with
  `SESSION_ATTACHED` while a tmux client is attached. Otherwise it kills the
  runtime-owned pane, persists `stopped`, clears a release-related `lastError`,
  and keeps `providerSessionId`, workspace, driver, idempotency metadata, and
  history. It is idempotent.
- Release is small because "conversation alive, process gone" is already a
  working state in shipped code: `get()` marks a dead pane `stopped` and the
  adapter already restarts `stopped` sessions from a preserved
  `providerSessionId`. Release is a kill plus a persisted status, not a subsystem.
- **`restart` refuses an attached pane too.** It currently checks only for an
  active submission and then calls `launch`, whose first statement is an
  unconditional `tmux.kill`. That path is reachable without any Telegram change:
  `get()` marks a session `stopped` when the driver process is gone even though
  the tmux pane still exists, the adapter restarts `stopped` sessions on the next
  message, and a human attached to that pane loses it. Every operation that kills
  a runtime-owned pane — restart, release, close — takes the same guard, which is
  what makes "an attached pane is never killed" a property of the runtime rather
  than a property of the Telegram call sites. Startup reconciliation already
  carries this guard; see below.
- `close` remains permanent supersession and is the only operation that ends an
  identity. It also refuses an attached pane; Telegram has no force override.
  The operator detaches and retries. Release has no retired state, durable intent
  record, timer, reaper, or background worker.
- **A project switch is the only release trigger.** Nothing else releases a pane,
  so there is no admission chain, no `RESIDENT_LIMIT`, no capacity refusal to
  report, and no user-facing release verb.
- `/stop` is not a capacity control. It marks adapter preparation cancelled and
  interrupts the exact accepted submission, and it does nothing else. It stays
  immediate and is never queued behind the route chain. Releasing the pane here
  would make the most common use of `/stop` — killing a runaway turn to rephrase
  it — pay a full driver restart, including startup screens and a possible auth
  screen, on the very next message.
- Runtime startup reconciles only tmux sessions owned by this runtime. A pane
  whose name does not match the current recorded incarnation is stale; remove it
  only when no client is attached, otherwise log it and fail the create that
  would collide with it. Never touch unrelated or local CLI tmux work.
- No PID-based orphan guarantee is made. Tmux-session disappearance is the pane
  ownership assertion; proving that every detached descendant exited would
  require process-group or cgroup ownership and is outside this feature.

## Ordering, Concurrency, And Failure Semantics

`/project <name>` is a route barrier. It needs immediate preemption, but every
binding-dependent decision uses route state at the head of the serialized chain:

1. Parse the full argument and validate eagerly against the catalog. An invalid
   target enqueues an ordered error without interrupting work.
2. If the current resident pane is attached, enqueue an ordered refusal without
   cancelling or interrupting anything. Otherwise consult
   `activeOperationByRoute`. Only when its exact project differs from the
   requested target, mark its adapter preparation cancelled and interrupt its
   recorded runtime submission if one has been accepted. Never derive an
   interrupt target from a possibly stale binding.
3. Enqueue the switch behind the route's chain and await cancellation or
   preemption plus all preceding work. Session startup already in progress may
   finish, but the cancelled operation checks its token before downloading,
   submitting, or delivering anything further.
4. At the head of the chain, re-resolve the target through the live catalog and
   load the latest durable record.
5. If the target disappeared, report it without changing the binding. If it is
   already the latest selection, no-op without touching its session.
6. Release the previous project's pane once its work has settled. If it is
   attached, refuse the switch and leave the binding unchanged.
7. Persist the binding as a field-level update to the record loaded in step 4.
8. Confirm the selected project and driver, then allow later queued messages.
   Do not create, restart, authenticate, or admit the target pane here.

Set `activeOperationByRoute[routeKey]` at the beginning of every bound ordinary
message, before session lookup, startup, attachment download, or transcription.
It records the exact project, driver, computed session key, a cancellation token,
and the runtime submission ID once accepted. Check cancellation after every
asynchronous preparation stage and always remove temporary files. Clear the
tracker in `finally` only if it still refers to that operation. `/stop`, `/reset`,
`/driver`, and `/project` use it for immediate cancellation or preemption; the
durable record remains authoritative for ordered mutation. A rapid
`A -> /project B -> message -> /project A` sequence executes exactly in that
order and never drops the final switch as a stale no-op.

Validate `/driver` arguments before preemption. At the head of the chain, compare
the requested driver with the live record; an invalid or already-selected driver
does not cancel or close anything. `/reset` always cancels the exact active
operation before its ordered close. `/reset` and an actual `/driver` change
preflight attached state before cancellation, and the daemon rechecks it
immediately before release or close. `/stop` needs no attached preflight: it only
interrupts a turn, which is what the operator asked for whether or not a human is
watching the pane. Control commands never launch a replacement session.

Other topics keep separate chains and continue running. `/status` resolves the
active project at invocation time and remains immediate. `/stop` is immediate and
never queued; it cancels preparation and interrupts, and queues nothing on the
route chain. `/projects` is read-only and does not preempt.

Before creating, restarting, submitting, resetting, or changing driver for a
bound route, resolve its stored name against the live catalog. If the exact
directory is missing, report the immutable-path requirement without touching the
session. `/status` and `/projects` remain read-only, `/stop` may interrupt the
recorded identity without accessing the workspace, and `/project`
may switch to another valid target. This keeps recovery possible without making
a missing project impossible to inspect, stop, or leave.

Failure rules:

- Failed validation leaves the old binding unchanged. A target that disappears
  between eager validation and chained revalidation may have caused a safe
  interruption, but never rerouting or submission to an invalid workspace.
- Failure to persist the binding leaves the old binding active and its session
  resumable even if its pane was already released; no message is submitted
  during the failed switch.
- Target startup is not part of a switch. Failure on the next ordinary message
  preserves the selected binding and reports that its session needs attention.
  It never falls back to the old project or the root.
- A missing runtime session is distinct from a missing project directory in
  user-facing status.
- Adapter restart replays queued commands in update order and reloads bindings
  before dispatching. Daemon restart keeps bindings in adapter state and session
  records in daemon state; the next message uses the same identity.
- A stale session whose recorded workspace differs from the resolved project is
  never resumed.
- A process crash between interrupt, release, and binding persistence is
  replay-safe. Before persistence the old binding remains selected and its pane
  is at worst released; after persistence the new binding is selected and no
  target has been started by the command. Queue replay is idempotent in both
  cases.

## Security And Trust Boundary

- Chat admission remains fail-closed through `CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS`.
- **Anyone who can post in an allowlisted chat can instruct the agent, and the
  drivers run with `bypassPermissions` / `danger-full-access`.** Allowlist
  membership is therefore equivalent to shell access as the runtime user. Topic
  creation in a forum group is unprivileged, so topics are display separation,
  not an authorization boundary. State both facts at the top of the operator
  documentation; the catalog's path rules are routing correctness, not a
  security boundary against a message that simply asks the agent to read a file.
- Per-user Telegram ACLs are not added here.
- Project listings expose only accepted direct-child names, never absolute paths.
- Error messages use project names, not daemon state paths, credentials, or raw
  filesystem exceptions.
- Route files, queued updates, downloaded inputs, and installer environments keep
  their `0600`/private-directory protections.
- The runtime API is **not** authenticated; it is protected by the `0600` socket
  file mode. Do not describe any endpoint as authenticated.
- Driver subprocesses keep the explicit environment allowlist; project routing
  must not reintroduce Telegram or OpenAI credentials into driver panes.

## Non-Goals

- Creating, renaming, closing, or deleting Telegram topics, or binding one by
  its visible title.
- Any per-project visual styling, banner, pin, icon, colour, or reply label.
- A global cap on resident driver panes, and any admission control or eviction
  policy that would follow from one. The per-route bound is what prevents
  unbounded growth in normal use; a global cap only binds past roughly ten
  simultaneously warm routes, and buying that case costs a global admission
  chain, a capacity refusal path, and an explicit release verb. Add it if real
  memory pressure appears, with its own release control rather than by
  overloading `/stop`.
- Nested project discovery, or arbitrary paths outside the projects root.
- Creating, cloning, moving, or deleting project directories from Telegram.
- Merging conversation history between topics or projects.
- **Any backward compatibility with the pre-projects-root configuration.** No
  workspace-variable migration, no legacy route-file location, no legacy session
  key, no `.qozyai` history relocation, and no dual-mode operation. Setup for the
  one install that predates this work is a manual one-time step. Every one of
  these would be a permanent second code path bought for a single operator on a
  single afternoon.
- A global source-tree lock for duplicate project bindings.
- Per-user group permissions or Telegram administrator policy.
- Changing provider artifact completion, driver readiness or process-health
  detection, workspace retention, file exchange, authentication, navigation, or
  transcription contracts.

## Implementation Phases

## Release 1: Runtime Session Correctness And The Release Primitive

Ships on its own, ahead of any Telegram change. It is mostly defects in shipped
code, plus the one piece of new runtime surface that Release 2 cannot be built
without: daemon-owned `release`, its endpoint, and the attached-client detection
the refusals depend on. Calling the whole release a defect fix would be
inaccurate. Everything in it is reachable through the runtime API with a single
workspace and is verified entirely by `test/session-runtime.test.js`,
`test/server.test.js`, and `test/workspace-state.test.js`. No catalog, no
bindings, no new configuration.

### Phase 1: Session Identity, Workspace Safety, And Release

Defects: `WorkspaceState.ensure` throwing `WORKSPACE_MISSING` instead of creating
the workspace root; `create` step ordering so nothing mutates the target before
the identity check; the driver/workspace 409; `realpath` failing closed; per-key
serialization of create, restart, release, close, and submission admission;
unique session incarnations in the tmux name; immediate provider-session-ID
persistence at artifact binding; the attached-pane guard on `restart`.

New surface: daemon-owned `release` and its endpoint; attached-client detection
in `src/tmux.js` and the refusals across restart, release, and close that depend
on it.

Exit: create, restart, release, close, and submission admission are race-safe for
one key, and two concurrent submits cannot both be accepted; a released
conversation resumes from its `providerSessionId`; a turn finalizing against a
renamed-away workspace surfaces `WORKSPACE_MISSING` and leaves the filesystem
untouched; no runtime operation kills an attached pane; a stale execution cannot
send keys into a successor pane. Every assertion labelled **R1** below is green.

## Release 2: Telegram Project Router

Builds on a correct runtime. Begins only once Release 1 has shipped.

### Phase 2: Catalog And Configuration

Projects-root configuration with the fail-closed startup error, exit `78`, the
empty/`$HOME`/`/` rejection in `config.js`, and `RestartPreventExitStatus=78` in
the unit template; removing `CLI_RUNTIME_TELEGRAM_WORKSPACE`; the project-catalog
component with the `^[A-Za-z0-9_-]+$` name rule and containment validation; the
installer prompt applying the same three rejections.

Exit: no Telegram-supplied value can resolve outside a direct project directory;
a Telegram-enabled install with no projects root fails to start with a
diagnosable error rather than restart-looping.

### Phase 3: Route Record

The `project` field, the `get`/`update`-only route store over one shared write
chain, and separate whole-document and per-entry quarantine. Records predating
this work go through per-entry quarantine like any other invalid entry; there is
no migration branch.

Exit: parallel updates to two topics persist both bindings, an adapter restart
reproduces the same selections, a command cannot revert a field set by the
command before it, and a hand-corrupted entry does not prevent startup.

### Phase 4: Telegram Commands, Tests, And Documentation

Route-project session keys; lazy command behavior; `/projects`, `/project
<name>`, and route barriers; the full-operation tracker; missing-path command
rules; everything in the checklist below; `README.md`, `docs/guides/turn-state.md`,
and completing `docs/guides/telegram-projects.md`.

Exit: two topics run concurrently in different directories, and a non-topic
route switches A -> B -> A with A's conversation intact.

## Requirements And Release Gate

This list is the specification of correct behavior, the test plan, and the
release gate. Each line is one assertion.

The gate is tiered, because the two tiers fail for different reasons and holding
them to one standard makes the cheap tier as brittle as the expensive one:

- **Automated.** Every line without a **[live]** marker. These run in the local
  suite, must be green from a clean tree on every commit, and are a hard ship
  gate for their release.
- **[live].** Lines marked **[live]** additionally require the VM/Telegram
  fixture in `docs/dev-fixtures.md` (local-only, never committed — see
  `docs/README.md`) — authenticated driver profiles and a real
  bot. These run once per phase against the development VM and are recorded as a
  dated checklist in the pull request. They gate the release, not the commit.

**Every line carries an explicit `R1` or `R2` label.** Release assignment is not
inferred from whether a line happens to mention a project, a route, a topic, or a
binding. That rule contradicted itself in both directions: Release 1's own exit
condition requires the renamed-away-workspace behavior whose assertion says
*project*, while `a human-attached pane is never released or closed by Telegram`
and the `/reset`/`/driver` supersession line contain none of the keywords and are
Telegram-only. A label is one word per line and cannot drift from what the line
says. `R1+R2` marks the few lines that gate both releases.

**Routing and topics**

- `R2` only updates marked `is_topic_message` create topic routes; a bare
  `message_thread_id` in a non-forum reply chain stays on `<chat-id>:main`
- `R2` messages in a forum's General topic, which do not carry
  `is_topic_message`, fold into `<chat-id>:main` and share that route's binding.
  This falls out of the rule above, but General is the one topic in a forum that
  behaves unlike its siblings, so it is asserted rather than inferred
- `R2` routing and every outbound Telegram method use the same normalized topic
  helper; no delivery path leaks a raw non-topic thread ID
- `R2` two topics in one chat map to distinct projects, session keys, histories,
  and tmux working directories, and remain concurrent while each route serializes
- `R2` topic replies, typing, progress, transcripts, errors, and files retain the
  correct `message_thread_id` **[live]**
- `R2` an unbound route creates no session and downloads no attachments
- `R2` `/projects` is deterministic, marks the current selection, and logs
  omitted invalid entries without exposing filesystem details
- `R2` a name matching `^[A-Za-z0-9_-]+$` binds exactly; every other name is
  rejected without changing the binding, including whitespace, dots, separators,
  control characters, and non-ASCII letters
- `R2` a directory whose name the rule rejects is omitted from `/projects`, and
  the listing carries the generic name-rule line without naming or counting it

**Path safety**

- `R1` no code path recreates a missing workspace directory; a turn finalizing
  against a renamed-away workspace surfaces `WORKSPACE_MISSING`, leaves the
  filesystem untouched, and leaves rename-back working
- `R2` traversal strings, absolute paths, separators, whitespace, and control
  characters are rejected by the name rule; files, sockets, and symlinks are
  rejected by the type check; a symlinked child resolving outside the root is
  rejected by containment
- `R2` an invalid selection neither interrupts nor changes the existing route
- `R2` a missing project and a missing projects root produce different messages
- `R2` renaming a never-bound directory makes only the new name selectable
- `R2` renaming a bound directory makes it unavailable without retargeting or
  tearing down its identity; ordinary messages, `/reset`, and `/driver` refuse,
  while `/status`, `/projects`, `/stop`, and switching away remain usable;
  renaming back resumes the same conversation with its `providerSessionId`
  intact **[live]**
- `R2` explicitly selecting a renamed path yields a distinct identity and a fresh
  conversation, while restoring and selecting the exact old path still resumes
  the old context
- `R2` deleting a bound directory and creating a new one at the same path resumes
  the previous conversation, which is the accepted consequence of path identity;
  `/reset` starts a fresh one, and no marker file is written into any project

**Route record**

- `R2` two concurrent route mutations both survive the serialized atomic write
- `R2` `/project X` then `/driver codex` in one poll batch yields both fields; no
  chained mutation reverts a field set by a preceding command
- `R2` no function outside the route store accepts or returns a mutable route
  record, so a dispatch-time capture cannot be written back
- `R2` malformed JSON quarantines the whole route file and starts empty with a
  prominent log; schema-invalid entries quarantine only those entries and retain
  every valid route; permission/I/O errors fail visibly
- `R2` a crash/replay immediately before and after persistence is idempotent and
  preserves queue order
- `R2` no legacy route-file location is read, and a record whose key or schema
  predates this work is quarantined by the ordinary per-entry validation rather
  than by a migration branch

**Sessions and residency**

- `R1` daemon `release` is idempotent, preserves conversation identity, records
  `stopped`, and refuses busy or attached panes
- `R1` `SessionManager.create` rejects an existing-key driver/workspace mismatch
  with 409 even when a caller bypasses Telegram, and does so *before* creating
  `.qozyai` in the target directory; concurrent same-key creates serialize and
  cannot launch twice
- `R1` two concurrent submits for one session key cannot both be accepted; the
  loser gets `SESSION_BUSY`, and a submit racing a release either precedes it or
  is refused, never lands on a pane being killed
- `R1` a `realpath` failure during `create` fails closed rather than storing a
  non-canonical workspace
- `R1` artifact binding persists `providerSessionId` immediately; interruption
  after binding and before completion still resumes, while interruption before
  any ID exists is reported as unable to resume
- `R1` each new logical-session incarnation has a distinct tmux name; a stale
  execution from a closed incarnation cannot send keys into its successor
- `R1` restart, release, and close all refuse while a tmux client is attached, so
  no runtime operation kills an attached pane; a session marked `stopped` because
  its driver process died while the pane survives is not restarted over an
  attached client
- `R1` startup reconciliation removes a stale runtime-owned pane only when no
  client is attached, and otherwise logs it and fails the colliding create
- `R2` switching A -> B releases A's pane after its turn settles and leaves at
  most one resident session for the route; it starts no B pane, and the first
  ordinary B message starts or resumes lazily; switching back resumes A's
  conversation
- `R2` `/project`, `/start`, `/reset`, and `/driver` do not eagerly launch a
  pane; batched `/project B`, `/driver codex`, then a message launches Codex in B
  once
- `R2` `release` is the only tmux operation the Telegram switch path uses
- `R2` `/stop` cancels preparation and interrupts the exact turn, is dispatched
  immediately without entering the route chain, and leaves the pane resident; the
  next ordinary message continues in the same session with no restart
- `R2` a project switch is the only path that releases a pane; no control command
  releases one
- `R2` a human-attached pane is never released or closed by Telegram; switch,
  `/reset`, and `/driver` refuse until detach, then succeed **[live]**
- `R2` `/reset` and incompatible `/driver` close the superseded identity but
  create no replacement until the next ordinary message
- `R2` switch, release/resume, missing-path, reset, driver-change, crash,
  restart, and command replay leave no duplicate runtime-owned tmux session; no
  assertion about detached descendant processes is inferred from a single PID
- `R2` changing the projects root or moving a project cannot reuse a session
  recorded for the old canonical path
- `R2` one project bound to two topics produces distinct sessions and histories

**Ordering**

- `R2` a switch during adapter preparation cancels download/transcription results
  before submission; a switch during an accepted turn interrupts A before a
  later message enters B
- `R2` rapid queued `A -> /project B -> message -> /project A` uses the latest
  chained binding and never drops the final switch as a stale no-op
- `R2` invalid and already-selected `/project` or `/driver` commands never
  preempt; an actual change targets the exact tracked operation even when
  switches are already queued
- `R2` `/status`, `/stop`, `/reset`, and `/driver` target only the selected
  route-project session
- `R2` adapter and daemon restarts retain bindings and conversation routing
  **[live]**

**Configuration and operations**

- `R2` Telegram startup with no explicit projects root fails closed with exit 78
  instead of using `process.cwd()`
- `R2` config validation rejects an empty projects root, `$HOME`, and `/` with
  exit 78, whether the value arrives from the environment or the installer, so
  editing the env file by hand cannot publish a home directory as a catalog
- `R2` that startup error names `CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT`;
  `CLI_RUNTIME_TELEGRAM_WORKSPACE` is no longer read anywhere in the codebase
- `R2` an installed unit carries `RestartPreventExitStatus=78` and a misconfigured
  bot stops instead of restart-looping **[live]**
- `R2` installer reruns preserve secrets and the projects root, and reject an
  empty root, `$HOME`, and `/`
- `R2` a fresh install with an empty projects root answers `/projects` with
  guidance to create one, not an error
- `R2` authenticated Claude and Codex both run in the correct project directory
  **[live]**
- `R2` attachment, audio transcription, output delivery, protected human tmux
  attach, and auth-required flows show no routing regression **[live]**
- `R2` tmux, runtime API, and workspace state agree that every pane and public
  session workspace is the intended project directory, never the root **[live]**
- `R2` each project's `.qozyai` history proves nothing was written into a sibling
  project or the root **[live]**
- `R2` documentation states the allowlist trust boundary, the unprivileged nature
  of topic creation, and the duplicate-binding conflict risk
- `R1+R2` no credentials or private browser state appear in fixtures, logs, or
  commits
- `R1+R2` all existing hardening, auth, Telegram, artifact, output, and
  prompt-delivery tests continue to pass

## Likely Implementation Surface

Release 1:

- `src/workspace-state.js` — `ensure` throws `WORKSPACE_MISSING` and never
  creates the workspace root
- `src/session-manager.js` — `create` step ordering and the 409, `realpath`
  failing closed, per-key serialization covering create/restart/release/close
  and submission admission through `this.active.set`, the attached-pane guard on
  `restart` before it reaches `launch`, session incarnations, provider-ID
  persistence at bind time, daemon-owned release, startup reconciliation
- `src/tmux.js` — attached-client check and owned-session reconciliation
- `src/server.js` — identity, attached, and busy response mapping; release
  endpoint
- `test/session-runtime.test.js`, `test/server.test.js`,
  `test/workspace-state.test.js`

Release 2:

- `src/config.js` — projects-root configuration, the empty/`$HOME`/`/`
  rejection, and fail-closed startup
- new project-catalog module — enumeration, the name allowlist, and safe
  resolution
- new route-store module — `get`/`update` over one shared write chain, and
  quarantine
- `src/session-manager.js` — accepting the route-project key format
- `src/telegram.js` — commands, route-project keys, barriers, status, normalized
  topic signaling, full-operation tracking, lazy startup
- `install.sh` — projects-root prompt and validation, systemd unit rewrite with
  `RestartPreventExitStatus=78`
- `test/telegram.test.js`, `test/install.test.js`, and new catalog/route-store
  tests
- `README.md`, `docs/guides/turn-state.md`, `docs/guides/telegram-projects.md`

Keep artifact parsing, driver launch arguments, file exchange, and transcription
contracts unchanged unless a failing test exposes a generic defect. Immediate
provider-ID persistence and `WorkspaceState` missing-root behavior are deliberate
exceptions. Telegram must not manipulate tmux directly.

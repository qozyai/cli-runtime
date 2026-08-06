# Restart Announcements

## Status

Implemented on 2026-08-06. The **[live]** gate lines are unverified until the
next deployment runs with this release active.

A restart of the Telegram adapter becomes visible to its owner: a message before
a planned stop saying why, a message after it comes back, and an unprompted
message when it comes back from a restart nobody asked for.

`decisions.md` records the alternatives and why they lost.

## The Problem

The runtime replaces itself while the user is talking to it. Today that is
silent: the adapter stops mid-conversation and returns some seconds later with
no acknowledgement that anything happened, and a crash-and-restart looks exactly
like a slow reply.

Two facts decide the whole design, and neither component holds both:

- **Only the adapter can send.** It owns the bot token, the routes, and the
  delivery path. The daemon has no Telegram identity and must not acquire one.
- **Only the restarter knows why.** From inside the adapter, `SIGTERM` carries
  no reason. The deployer knows it is deploying; a crash has no author at all.

And the announcement of a stop has to leave the process before the thing that is
about to kill it does so.

## Design

A durable **notice spool**. Any component that causes a restart writes a small
JSON file; the running adapter drains the spool, sends each notice, and deletes
it. Telegram formatting, chunking, routing, and retries stay in the one place
that already implements them, and no second component learns the bot token.

```
<state>/telegram/notices/<monotonic>-<random>.json
{
  "version": 1,
  "kind": "shutdown" | "startup" | "info",
  "text": "Stopping to deploy release_20260806T111740Z_cfc6147.",
  "route": { "chatId": "-1001234567890", "threadId": 42 },   // optional
  "expiresAt": "2026-08-06T11:23:00.000Z"                     // optional
}
```

The file format is a stable contract: the deployment tooling lives outside this
repository and writes these files directly.

### Who announces what

| Message | Written by | Why not the other one |
| --- | --- | --- |
| Planned stop, with the reason | the restarter, before it stops the adapter | the adapter cannot know the reason |
| Planned start, with the result | the restarter, after it verifies health | the adapter cannot know whether the switch succeeded |
| Unexpected restart | the adapter itself, at startup | after a crash or reboot nothing else is alive to notice |

Planned restarts therefore need no policy inside `cli-runtime` at all. The
runtime contributes delivery and the one thing only it can observe: that the
previous run ended without stopping cleanly.

### Detecting an unexpected restart

The adapter maintains `<state>/telegram/last-run.json`:

```json
{
  "version": 1,
  "startedAt": "2026-08-06T11:22:40.000Z",
  "pid": 2523162,
  "release": "release_20260806T111740Z_cfc6147",
  "stoppedCleanly": false,
  "lastAnnouncedAt": null,
  "suppressed": { "count": 0, "since": null }
}
```

It is written at startup with `stoppedCleanly: false` and stamped `true` by the
existing `SIGINT`/`SIGTERM` handler. A record found at startup whose previous run
was not stamped means the process died rather than stopped: that is the
unexpected restart, and it is the only case the adapter announces on its own.

`release` is derived from the running entry-point path, so the message names the
release without new configuration.

### Rate limiting

`Restart=on-failure` with `RestartSec=2` would otherwise send a message every two
seconds. At most one unexpected-restart announcement is sent per
`CLI_RUNTIME_RESTART_ANNOUNCE_WINDOW_MS` (default five minutes). Restarts inside
that window increment `suppressed.count`, and the next announcement that does go
out reports how many restarts it stands for and since when.

### Delivery

A notice with a `route` goes to that chat and topic. A notice without one, and
every adapter-generated announcement, goes to the bound owner's private chat.
Broadcasting to every bound route is not done: four bound routes today means four
copies of one operational message.

If no owner is bound and the notice carries no route, the notice is dropped with
a log line. There is nowhere legitimate to send it.

### Ordering and expiry

- The spool is drained at startup **before** the queued Telegram backlog is
  replayed, so a start announcement precedes the answers to messages that
  arrived while the runtime was down.
- Each notice is deleted before it is sent. A crash mid-send loses a notice
  rather than repeating it; an announcement delivered twice, or a "stopping"
  arriving after the process already restarted, is worse than a missing one.
- A notice past `expiresAt` is deleted without sending. A stop announcement that
  could not be delivered before the stop must not surface after the start and
  invert the story.
- Notices are drained on a short timer, not only between long-poll cycles, so a
  deployer that writes a stop notice and waits does not wait out a 25-second
  `getUpdates`.

## Non-Goals

- Announcing planned restarts from inside the runtime. That is the restarter's
  job, and the runtime cannot describe an intent it does not have.
- Daemon-side announcements or a second component holding the bot token.
- A general pub/sub or notification API. This is an operational spool with three
  message kinds, not a messaging feature.
- Announcing every ordinary start. A clean stop followed by a start is a planned
  restart, and the restarter has already said both halves.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLI_RUNTIME_RESTART_ANNOUNCE_WINDOW_MS` | `300000` | Minimum spacing between unexpected-restart announcements. |
| `CLI_RUNTIME_TELEGRAM_NOTICE_POLL_MS` | `1000` | How often the running adapter drains the spool. |

## Requirements And Release Gate

Each line is one assertion. **[live]** lines need the local-only fixture in
`docs/dev-fixtures.md` and gate the release, not the commit.

**Spool**

- a notice written while the adapter is running is sent within one poll interval
  and its file is removed
- a notice is deleted before the send is attempted, so a failed send does not
  resend it later
- a notice past `expiresAt` is deleted without sending
- a malformed or unreadable notice is dropped with a log line and never blocks a
  valid sibling
- a notice with a route is delivered to that chat and topic; one without a route
  goes to the bound owner's private chat
- a notice with no route and no bound owner is dropped with a log line
- notices are drained at startup before the queued update backlog is replayed

**Restart detection**

- a previous run stamped `stoppedCleanly` produces no announcement
- a previous run without that stamp produces exactly one announcement naming the
  running release and when the previous run started
- the first ever start, with no previous record, produces no announcement
- `SIGTERM` and `SIGINT` stamp the marker before the process exits
- an unreadable or malformed marker is treated as no previous run rather than
  as a crash, and is replaced

**Rate limiting**

- two unexpected restarts inside the window produce one announcement
- the announcement that follows suppressed restarts reports their count and the
  time the suppression started
- a restart after the window elapses announces again and resets the counter

**Regression**

- the adapter's queue replay, offset persistence, ownership, and routing are
  unchanged
- every existing test continues to pass
- a real deployment announces its stop and its start in the triggering
  conversation, and a `kill -9` of the adapter announces the unexpected restart
  **[live]**

## Likely Implementation Surface

- `src/notices.js` — new: the spool (`write`, `drain`) and the run marker
  (`start`, `markCleanStop`), plus release-ID extraction from the entry path
- `src/telegram.js` — drain on a timer and at startup, the unexpected-restart
  announcement, and the owner/route target resolution
- `src/main.js` — stamp the marker in the existing signal handlers
- `src/config.js` — the two new settings
- `test/restart-announcements.test.js`
- `README.md`, `docs/guides/telegram-projects.md`
- Outside this repository: the deployment scripts write stop and start notices.

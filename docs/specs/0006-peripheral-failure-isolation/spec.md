# Peripheral Failure Isolation

## Status

Implemented on 2026-08-06.

This specification states a project-wide invariant and makes it structural rather
than a matter of habit: **a failure in observability, history, enrichment, or
announcement must never fail the work a user asked for.**

`decisions.md` records the reasoning and the one behavior this deliberately
changes.

## The Invariant

Core is the path from a user's message to a driver turn to its reply, plus the
state that keeps a session usable afterwards. Everything else — the event log,
normalized history, transcripts, quoted context, progress summaries, restart
announcements, `/status` detail — exists to make that path pleasant to observe
and use. None of it may decide whether the path completes.

Concretely, on the awaited path of a turn:

- **Core** may fail a turn: the driver process, its artifact, the tmux pane, the
  prompt delivery, the submission record, and the session record.
- **Peripheral** may not: appending an event, writing turn state or history,
  transcribing audio, fetching quoted attachments, navigating a startup screen,
  sending a progress edit, draining a notice, or probing a composer after a
  timeout.

A peripheral failure is reported — as a warning to the user, an event, or a log
line — and the turn continues.

## What Was Wrong

The invariant was already the intent, visible in `updateWorkspaceTurn`,
`finishWorkspaceTurn`, the navigator, transcription, and the admission failure
path, all of which degrade rather than throw. But it was a convention, and
`await eventStore.append(...)` is the natural thing to type, so five paths
violated it:

1. `failUnexpectedExecution` — the last net under a thrown execution — awaited
   `persistSession` and an event append unguarded. Since it runs as the `.catch()`
   of a fire-and-forget execution with nothing behind it, and no
   `unhandledRejection` handler existed, a throw there ended the daemon and every
   session with it.
2. `submission.progress` was appended, awaited, inside the artifact watcher's
   `onProgress` callback. A failing event log therefore failed the live turn.
   Same shape for `submission.started`, the finalization events, and
   `submission.timed_out`.
3. `settleTimedOutDriver` guarded its tmux calls but called `probeReadyInput`
   unguarded, so a tmux hiccup replaced a described timeout with an unexplained
   failure — and left the session `attention_required`, which makes the next
   message restart a healthy pane.
4. A quoted attachment that could not be fetched failed the whole message; the
   user's own text never reached the driver.
5. The notice spool's `mkdir` was awaited during adapter startup, so an
   uncreatable directory prevented the adapter from accepting messages at all.

## Design

**Events are published, not awaited.** `EventStore.append` now assigns the
sequence, pushes the record, and emits it, then queues the durable write behind
the existing chain. Readers serve from memory, so an event is visible to
`/v1/events` the moment it happens, while a caller that does not await the
returned promise cannot be failed by an unwritable log. Compaction rewrites only
records already on disk, so a queued append is never written twice. `append`
never throws synchronously — a caller's `.catch()` is not attached until it
returns — and the emit happens only after the event owns its position in the
write chain, so a listener that appends re-entrantly cannot reorder the file or
make `durableSequence` regress.

**Durability now lags visibility, and that is the trade.** An event is readable
immediately but reaches disk later, so a `SIGKILL` can lose recent events and a
client can read an event through the API that never reached the file. This is
acceptable for observability and would not be for anything core.

**A stuck disk sheds rather than grows.** A filesystem that hangs instead of
failing has no error to catch, and nothing on the turn path awaits these writes
any more, so the backlog would grow unbounded. Beyond `maxPendingWrites` (1000)
the durable write is dropped, the event stays readable, and the count of shed
writes is reported on stderr and published as a `runtime.events_dropped` event
once the backlog clears.

**`note(type, details)`** replaces every awaited `eventStore.append` in the
session and auth managers. It never throws, never blocks, and reports an append
failure on stderr.

**The last net is total.** `failUnexpectedExecution` settles in-memory session
and submission state first, then attempts persistence with every write guarded,
so it cannot itself throw.

**A backstop under the service.** Node makes an unhandled rejection fatal by
default. Both service modes install an `unhandledRejection` handler that reports
and keeps running: one stray promise in a peripheral path must not take every
live session down. Uncaught exceptions keep the default behavior, because they
unwind a stack whose state is no longer known.

**Enrichment degrades.** A replied-to attachment that cannot be fetched produces
a visible warning to the user, a line inside the reply context telling the driver
what is missing, and a turn that runs anyway.

**Announcements never gate ingress.** Spool creation, restart detection, and
notice delivery are wrapped as one optional step in adapter startup.

## Behavior Change

An oversized or unfetchable **replied-to** attachment previously failed the
message before submission. It now warns and submits. The earlier rule protected
the driver from acting on partial context, but it let an enrichment discard a
message whose own content was complete, which is exactly what this invariant
forbids. Attachments on the **current** message are unchanged: those are the
user's own payload, not a quote of someone else's.

## Non-Goals

- Retrying peripheral work. Degrade and report; a retry queue for progress
  summaries is a larger feature with its own failure modes.
- Suppressing peripheral errors silently. Every one of them surfaces as a
  warning, an event, or a log line.
- Weakening core failures. A missing workspace, a dead pane, an undeliverable
  prompt, or an unwritable submission record still fails the turn.
- Catching uncaught exceptions to keep a corrupted process alive.

## Requirements And Release Gate

Each line is one assertion, verified by fault injection rather than by reading.

**Observability**

- a turn completes and replies while every event append fails
- a failing driver is still finalized, and its session still reaches a correct
  status, while every event append fails
- an event is readable through the API immediately after the action that
  produced it, without waiting for the durable write
- compaction never rewrites a record whose durable append has not run
- an append failure is reported on stderr and nowhere else
- `append` returns a rejected promise rather than throwing synchronously, and a
  listener that throws neither escapes nor loses the event
- a listener that appends re-entrantly leaves the file ordered by sequence with
  no record written twice
- a filesystem that hangs leaves pending writes bounded, events readable, and
  the shed count reported as `runtime.events_dropped` when the backlog clears

**History**

- a turn completes while every turn-state and finish-turn write fails
- a history failure is recorded as `workspace.turn_state_failed`

**Turn lifetime**

- a composer probe that throws during timeout settling yields
  `settled: false` with the probe's own reason, not an unexplained failure
- the settle path never propagates an exception into the finalization path

**Enrichment**

- a replied-to attachment that cannot be fetched leaves the user's message
  submitted, warns the user, and tells the driver what is missing
- a cancelled operation still propagates as cancellation, not as a warning

**Service**

- the adapter starts and accepts messages when the notice spool cannot be created
- both service modes install an `unhandledRejection` backstop
- `failUnexpectedExecution` completes with every write failing

**Regression**

- every existing test continues to pass

## Implementation Surface

- `src/event-store.js` — synchronous publish, queued durable write,
  `durableSequence`-aware compaction
- `src/session-manager.js` — `note()`, converted appends, a total
  `failUnexpectedExecution`, a guarded settle probe
- `src/auth-manager.js` — `note()` and converted appends
- `src/server.js` — the startup event no longer gates the listening socket
- `src/telegram.js` — degraded reply enrichment, announcements wrapped
- `src/main.js` — `installRejectionBackstop`
- `test/peripheral-failures.test.js`, `test/telegram.test.js`

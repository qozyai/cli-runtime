# Turn Lifetime And Stall Detection

## Status

Implemented on 2026-08-06.

A submitted turn is no longer killed by wall-clock age. It is killed by silence:
thirty minutes with no new provider artifact record. When that happens the
runtime stops the driver, verifies it is back at its prompt, and reports what it
did — instead of today's behavior, where the turn is declared failed while the
driver keeps working and the next message kills its pane.

This document is authoritative for implementation. `decisions.md` records why
the alternatives were rejected; it is not required reading.

## The Defect

`watchArtifacts` computes `deadline = Date.now() + timeoutMs` once when it starts
and never extends it (`src/artifacts.js:58`), and `submissionTimeoutMs` defaults
to thirty minutes (`src/config.js:62`). No artifact record, tool transition, or
progress checkpoint moves that deadline. A turn that is doing useful work and a
turn that is wedged therefore fail at exactly the same moment, and the watcher
has no way to tell them apart.

Expiry then does three things, and only the first is intended:

1. The watcher throws and the submission is finalized `failed`.
2. Nothing interrupts the driver. The pane keeps running the turn and keeps
   appending to its artifact. The runtime's reported state is now false.
3. The session becomes `attention_required`, so the next Telegram message takes
   the recovery path at `src/telegram.js:872`, which issues `POST /restart` →
   `launch()` and **kills the still-working pane**. The provider conversation
   survives through `--resume`; the in-flight tool work does not.

This deadline is the only wall clock on a turn. The adapter's `waitSubmission`
loop is unbounded, and neither the HTTP server nor the client imposes a limit,
so removing it leaves no hidden second timeout behind.

## What Replaces It

- **No absolute deadline by default.** A bound turn runs until the artifact says
  it is terminal, the driver process exits, the caller interrupts it, or it goes
  silent for the inactivity window.
- **An inactivity deadline, on by default at thirty minutes**, measured from the
  most recent authoritative artifact record rather than from submission time.
- **A defined aftermath.** Expiry stops the driver and reconciles the runtime's
  state with reality before it reports anything.
- **A caller-supplied absolute limit stays available** per submission, for an
  orchestration layer that wants a foreground budget.

## Non-Goals

- Changing what decides completion. Vendor JSONL artifacts remain the only
  completion authority; terminal text is not consulted for liveness.
- Per-tool-call timeouts, or any attempt to distinguish a slow tool from a
  stuck one. A single silent tool call is indistinguishable from a stall, and
  the inactivity window is the operator's answer to that ambiguity.
- The deferred foreground-budget and background-continuation roadmap item. This
  spec keeps the caller-supplied absolute limit that feature would build on, and
  adds nothing else for it.
- Startup and prompt-binding deadlines. They detect different failures before a
  turn is authoritatively bound and are unchanged.

## Deadlines After This Change

| Deadline | Applies | Default | Behavior |
| --- | --- | --- | --- |
| Startup | Launch to ready composer | 30 s | Unchanged |
| Bind | Paste to artifact binding | 15 s | Unchanged; `confirmSubmission` already enforces it and aborts the watcher |
| Absolute | Bound turn, wall clock | off | Only when the caller passes `timeoutMs`, or an operator sets the environment variable |
| Inactivity | Bound turn, silence | 30 min | Resets on every new artifact record |

Pre-bind silence is still bounded, because `confirmSubmission` fails a
submission that never binds within the bind deadline and aborts the watcher.

## What Counts As Activity

The inactivity clock resets when, and only when, the runtime parses a new JSON
record appended to the **bound** artifact file. Binding itself counts.

It does not reset on:

- a poll tick that finds no new bytes
- a file whose mtime changed without producing a parseable record
- a repeated normalized progress checkpoint identical to the last one
- records appended to any file other than this turn's bound artifact, including
  another session's concurrent artifact in the same provider tree

The rule is deliberately narrow: the clock must measure the provider doing
something, not the runtime looking.

## Aftermath

On expiry of either deadline, in order:

1. Stop watching the artifact.
2. Interrupt the driver through the same tmux key path `/stop` uses. The pane is
   never killed and the session is never restarted.
3. Poll for up to the settle grace for the driver process to be alive and its
   composer to accept input, using the existing ready probe.
4. Finalize the submission `failed`, with an error naming the reason
   (`inactivity_timeout` or `absolute_timeout`), the silence duration, and
   whether the driver was stopped.
5. Set the session to `ready` when the composer settled — the pane is warm, the
   provider conversation is intact, and the next message continues in it — or to
   `attention_required` when it did not, which is the genuine wedge that the
   existing recovery path is for.
6. Append a `submission.timed_out` event carrying the reason, `lastProgressAt`,
   and whether the driver settled.

A settled timeout must not leave the session in `attention_required`, because
that is what makes the next ordinary message destroy a healthy pane.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLI_RUNTIME_SUBMISSION_TIMEOUT_MS` | `0` | Absolute post-bind limit. `0` disables it. |
| `CLI_RUNTIME_SUBMISSION_INACTIVITY_MS` | `1800000` | Silence before a bound turn is treated as stuck. `0` disables it. |
| `CLI_RUNTIME_TIMEOUT_SETTLE_MS` | `5000` | Grace for the driver to return to its composer after the interrupt. |

`POST /v1/sessions/:sessionKey/submissions` keeps its optional `timeoutMs`, which
overrides the absolute limit for that submission only.

## Observability

`lastProgressAt` is tracked for the active turn, exposed on the submission
resource, and rendered by Telegram `/status` alongside how long the turn has been
running. Without it, "no wall-clock limit" is indistinguishable from "hung", and
the operator has no cheap way to decide whether to `/stop`.

## Requirements And Release Gate

Each line is one assertion, and together they are the test plan. Lines marked
**[live]** additionally need the local-only fixture in `docs/dev-fixtures.md`;
they gate the release, not the commit.

**Deadlines**

- a bound turn with no absolute limit is not failed for elapsed time alone; only
  a terminal record, driver exit, interrupt, or inactivity ends it
- the inactivity clock resets on each new record parsed from the bound artifact,
  so a turn emitting records slower than the window never expires
- a bound turn that stops emitting records for the inactivity window expires,
  and the error names the reason and the silence duration
- a poll that finds no new bytes, and a repeated identical progress checkpoint,
  do not reset the clock
- records appended to another file in the same provider tree do not reset the
  clock for this turn
- a caller-supplied `timeoutMs` still enforces an absolute limit and is reported
  as `absolute_timeout`
- `CLI_RUNTIME_SUBMISSION_TIMEOUT_MS` defaults to `0` and
  `CLI_RUNTIME_SUBMISSION_INACTIVITY_MS` to thirty minutes
- setting the inactivity variable to `0` disables stall detection entirely
- startup and bind deadlines are unchanged, and a turn that never binds still
  fails within the bind deadline

**Aftermath**

- expiry interrupts the driver before the submission is finalized; no expiry
  path kills the pane, restarts the session, or closes the provider conversation
- a driver that returns to its composer within the settle grace leaves the
  session `ready`, and the next submission runs in the same warm session with
  the provider conversation intact
- a driver that does not return to its composer leaves the session
  `attention_required` with the existing recovery path unchanged
- a driver whose process exited during the stall is reported as exited, not as a
  settled timeout
- the finalized submission records `failed`, the reason, and `lastProgressAt`
- a `submission.timed_out` event carries the reason, `lastProgressAt`, and
  whether the driver settled
- an interrupt arriving while the runtime is settling a timeout does not produce
  two finalizations of one submission

**Observability**

- `lastProgressAt` advances on artifact activity and is present on the active
  and finalized submission resource
- Telegram `/status` reports running time and time since last activity for an
  active turn **[live]**

**Regression**

- every existing hardening, session-runtime, Telegram, artifact, output, and
  prompt-delivery test continues to pass
- a long turn that outlives the former thirty-minute deadline completes normally
  end to end **[live]**

## Likely Implementation Surface

- `src/config.js` — `submissionTimeoutMs` default `0`, new
  `submissionInactivityMs` and `timeoutSettleMs`, and a non-negative number
  helper so `0` is a valid configured value rather than a fallback trigger
- `src/artifacts.js` — split the single deadline into an optional absolute
  deadline and an inactivity deadline, reset the latter on parsed records from
  the bound file, add an activity callback, and give each expiry a distinct
  error code
- `src/session-manager.js` — pass both limits, track `lastProgressAt`, and add
  the settle-after-timeout path with its session-state and event contract
- `src/telegram.js` — `/status` running time and last activity
- `fixtures/mock-driver.js` — a driver that binds, emits records, then goes
  silent while remaining at its composer
- `test/turn-lifetime.test.js`, `test/session-runtime.test.js`
- `README.md`, `docs/guides/turn-state.md`

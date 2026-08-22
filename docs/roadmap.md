# Roadmap

## Feature Intake — 2026-08-05

These are persistent intake notes, not implementation specifications. They
record both the requested behavior and the current interpretation so the ideas
survive beyond the chat thread. Before implementation, each feature needs a
separate design pass and promotion into a numbered specification with an
explicit acceptance gate.

### Natural-Language, One-Turn Max Effort

**Requested:** The user can write `max effort` in ordinary prompt text. No
slash command is required. Whichever driver is active, Claude Code or Codex,
must use its maximum available effort for that turn only.

**Current interpretation:** Treat the phrase as an explicit turn-scoped
override, select the highest effort supported by the active driver and model,
and restore the session's previous or default effort before another ordinary
turn runs. It must not become a persistent session preference.

The exact phrase-matching rules, visibility of the applied override, behavior
for unsupported models, and restoration failure handling remain design work.

### Unbounded Or Activity-Based Turn Lifetime

**Promoted to [`specs/0004-turn-lifetime`](specs/0004-turn-lifetime/spec.md) and
implemented on 2026-08-06.** The open questions below were answered there: the
inactivity window is thirty minutes, a legitimately silent long tool call is
knowingly indistinguishable from a stall, and expiry does interrupt the driver
and verify where it landed before reporting. The rest of this entry is the
intake note that produced the spec.

**Requested:** Increase or remove the current 30-minute timeout for a submitted
turn. A turn that is still doing useful work should not fail merely because 30
minutes have elapsed. Prefer no post-bind timeout by default; if a protective
timeout remains, measure inactivity since the latest authoritative state
update rather than total wall-clock duration since submission.

**Current behavior:** `CLI_RUNTIME_SUBMISSION_TIMEOUT_MS` defaults to 30 minutes.
The artifact watcher computes one absolute deadline when it starts and does not
extend that deadline when it observes new artifact records or normalized
progress. A healthy long-running turn therefore fails at the same deadline as
a silent stuck turn.

**Current interpretation:** Keep finite startup and prompt-binding deadlines,
because those detect different failures before a turn is authoritatively bound.
After binding, remove the default absolute turn deadline. Optionally support a
caller-supplied absolute limit for workflows that explicitly need one and a
separate inactivity watchdog for general fault detection.

An inactivity deadline must reset only on genuine new evidence: newly parsed
provider artifact records, a changed normalized progress checkpoint, a tool
transition, or terminal state. Polling the same state, rewriting a file without
new semantic content, or repeatedly emitting the same progress must not keep a
stuck turn alive. Persist and expose `lastProgressAt` and distinguish
`inactivity_timeout` from an explicit `absolute_timeout` in structured output.

The inactivity duration, treatment of legitimately silent long-running tools,
and whether timeout first requests a graceful interrupt remain design work.

### Burst Messages And Turn Replacement

**Promoted in part to [`specs/0007-burst-joining`](specs/0007-burst-joining/spec.md),
which is implemented.** What shipped is pre-turn joining: messages that
arrive together are debounced into one turn. The replacement flow described
below, superseding a turn already running, was deliberately not built; mid-turn
messages still queue. The rest of this entry is the intake note that produced
the spec.

**Requested:** Decide how to handle several messages sent without waiting for
the current answer. Candidate behaviors are:

- deliver new information into the running driver turn
- stop the running turn and submit the new message
- queue the message until the turn completes, although this is currently the
  least favored option
- debounce a burst and combine its messages

The preferred candidate is an optimistic debounce flow. The initial message
starts a turn immediately rather than waiting. A short debounce window remains
open while that turn runs. If another message arrives during the window, retain
it and reset the timer; every further arrival resets the timer again. Once the
window expires, combine the initial message and all follow-ups in arrival order,
probably stop the original execution, and submit the combined text as a
replacement turn.

**Current interpretation:** With no follow-up, the initial turn proceeds
normally and pays no debounce latency. A real burst supersedes the partial
execution with one prompt containing the complete user intent. This is not a
simple post-turn queue: the system may discard the partial answer and restart
from the original message plus its amendments.

The debounce duration, driver steering versus restart, behavior when the first
turn finishes during the window, attachment and reply-context ordering, and
handling of side effects from an interrupted turn remain design work.

### Outer-Layer Foreground Budget And Forked Background Continuation

**Priority:** Deferred. This is a useful possible future feature, but its
complexity is not justified by a current necessity. Do not promote it into an
implementation specification or schedule near-term work unless it is
explicitly reprioritized.

**Requested:** Keep the interactive session responsive by allowing the caller
to give each foreground turn a configurable work budget, provisionally an
elapsed-time limit and/or 10–15 tool calls. When a turn exhausts that budget,
stop foreground execution and return a structured continuation result from
which the caller can create or resume a fork. Work and context accumulated up
to that point must not be lost. `cli-runtime` must not decide whether the fork
should actually run; that is an orchestration decision.

The source audit found two relevant generations of behavior. An existing
monitor elsewhere in the fleet has soft and hard tool-count thresholds, but
observes normalized progress and injects instructions asking the active agent
to delegate. That particular monitor is cooperative: the agent can continue
working, and its queued delegate starts only after the parent turn completes.

The stronger hook-based mechanism changes the feasibility assessment. A
synchronous before-tool-call hook can enforce the budget at the execution
boundary: once the limit is reached it refuses ordinary tools, returns a
synthetic/dummy result to close each attempted call cleanly, and permits only
the background-handoff path. A yield/abort primitive can then unwind the
foreground runner without another provider call. Unlike a prompt nudge, this
actually prevents further inline tool work. That existing progress monitor is
not currently wired into those hard-gate and yield primitives, so the roadmap
item is to combine them rather than mistake the monitor alone for the complete
implementation.

`cli-runtime` already has session-fork launch support for both Claude Code and
Codex. Its tested path forks a settled parent after a completed turn. Creating
a fork currently launches its CLI process immediately, so a budget-exhaustion
result should initially return a durable fork-source/checkpoint descriptor
rather than claim that a dormant provider fork has already been materialized.
If a driver later supports creating a dormant fork, the same result can also
carry that fork's session identifier.

**Current interpretation:** The orchestration layer chooses the per-turn
limits and later decides whether to launch, defer, or discard the continuation.
`cli-runtime` has the narrower responsibility of accepting those limits,
enforcing them uniformly across drivers, stopping at the strongest safe
checkpoint available, and returning authoritative structured state. It may
provide driver-specific hook plumbing because that is part of reliable CLI
integration, but it must not contain background scheduling, user-notification,
retry, or work-priority policy.

For a tool-count budget, exhaustion should happen at a settled tool boundary.
After the configured number of completed calls, the hook blocks the next
ordinary tool before it executes, closes the attempted call with a synthetic
result, and yields the foreground runner. `cli-runtime` then returns a result
conceptually shaped like:

```json
{
  "status": "budget_exhausted",
  "reason": "tool_calls",
  "usage": { "toolCallsCompleted": 10, "elapsedMs": 42000 },
  "checkpoint": { "kind": "settled_tool_boundary", "contextComplete": true },
  "continuation": {
    "kind": "fork",
    "forkFromSessionKey": "parent-session",
    "providerSessionId": "provider-session",
    "materialized": false
  }
}
```

The exact public schema belongs in a later specification. The important
contract is that returning this value does not start background execution. The
orchestrator can pass the descriptor back to `cli-runtime` later to create and
launch the fork, or decide that no continuation is needed.

Elapsed time should probably be the primary responsiveness budget because one
slow call can matter more than many quick reads. It needs explicit boundary
semantics: when the deadline expires, block new tool calls, allow an in-flight
call a bounded settling grace period, then interrupt if necessary. The result
must report whether the checkpoint is fully settled or interrupted so the
orchestrator does not blindly repeat an unknown side effect. Tool count remains
a useful deterministic secondary limit.

If the orchestrator later launches foreground and background sessions against
the same workspace, it—not `cli-runtime`—must prevent overlapping edits or
choose a separate worktree.

The preferred first version is therefore a caller-supplied time/tool budget,
hard enforcement inside `cli-runtime`, and a structured unstarted continuation
descriptor. Before shipping, live end-to-end tests for both drivers must prove
that the descriptor can launch a fork containing all completed calls and
results, blocked parallel calls do not leak through, the foreground unwinds
promptly, and an interrupted in-flight side effect is clearly represented.

### Outer-Layer Proactive Heartbeats And Warm Retirement

**Requested:** Add proactive behavior that periodically checks what is due or
needs attention, but keep that policy out of `cli-runtime`. The no-op path in
the outer layer must consult a very small, cheap index and avoid waking
expensive model execution. When the index contains actionable work, that layer
can use `cli-runtime` to wake or submit work to the corresponding session.

Projects, sessions, and their threads should remain warm by default under the
outer layer's lifecycle policy. Retirement will be designed later. A
provisional policy is to surface a question after a thread has been abandoned
for more than one week, asking whether it should stay warm. Keep it warm on
confirmation; stop it after a negative answer or no answer.

**Current interpretation:** This is explicitly a `cli-runtime` non-goal and an
agent/orchestration-layer feature. The outer layer owns heartbeat cadence, the
due-work index, attention policy, proactive wake decisions, and warm-retirement
policy. It addresses work through `cli-runtime`'s existing session and
workspace API.

`cli-runtime` remains the rock-solid CLI execution primitive: reliably start or
resume a driver in a folder, submit and interrupt turns, observe authoritative
completion artifacts, exchange files, and report lifecycle state. It may keep
a requested session resident, but it does not decide when a heartbeat is due,
what needs attention, or when a thread should retire.

The outer-layer heartbeat cadence, due-index schema, ownership between project/
session/thread, response timeout for the retirement question, and exact meaning
of "warm" remain design work.

## Interpreted Progress Observer

A future optional observer may consume bounded provider-artifact deltas in an
independent session and produce a richer progress summary. It must remain
advisory: it cannot submit input, decide completion, mutate normalized history,
or block the main driver. This is not part of the current runtime contract.

# Decisions — Turn Lifetime And Stall Detection

Rationale for `spec.md`. Historical; the spec is authoritative.

## Raising the limit instead of replacing it

Rejected. Thirty minutes to three hours makes the same failure rarer without
making it different: the deadline still carries no information about whether the
turn is healthy, and the aftermath — a false `failed`, a driver still running,
and a pane killed by the next message — is untouched. The bug is not that the
number is small.

## Inactivity, not wall clock

A bound turn's elapsed time says nothing about its health. The gap since the last
artifact record does: both drivers append a record when a tool call starts and
when it returns, so silence is bounded by one tool call's duration in a working
turn, and unbounded in a wedged one.

The cost is honest and worth stating. A single legitimate tool call longer than
the window — a long provisioning script, a slow suite — is indistinguishable
from a stall by this rule, and will be interrupted. Thirty minutes is the
operator's chosen tolerance for that ambiguity, not a derived value.

## Why the clock resets only on parsed records from the bound file

A watcher that reset on its own polling, on file mtime, or on re-emitted
identical progress would keep a stuck turn alive forever — the runtime would be
measuring itself. Restricting the reset to newly parsed records on this turn's
bound artifact means the clock measures the provider, and a busy neighboring
session in the same provider tree cannot mask this turn's silence.

## Interrupt before finalize

The current code finalizes and walks away, leaving a driver running against a
submission the runtime calls failed. Every later decision is then made against a
false state, and the worst of them — restarting the session on the next message —
destroys work that was still in flight.

Interrupting first costs one keypress and a bounded probe, and buys a state the
runtime has actually observed. The pane is never killed on this path: killing it
is the destructive act this spec exists to remove.

## `ready` after a settled timeout

Leaving a settled session in `attention_required` would preserve the pane-killing
recovery path for a session that is demonstrably fine. If the composer accepts
input, the correct state is `ready`: the conversation is resumable in place, and
the user's next message continues it. `attention_required` is reserved for the
case where the driver did not come back, which is what that state means.

## `failed`, not `interrupted`

`interrupted` means the caller asked to stop, and it clears `lastError` and
leaves the session ready without comment. A stall is not a user decision, and it
should carry an error the operator can read. The submission is `failed` with a
named reason; the session state records whether the driver recovered.

## Absolute limit retained, defaulted off

The deferred foreground-budget roadmap item needs a caller-supplied per-turn
limit, and `submit()` already accepts `timeoutMs`. Keeping the mechanism and
changing only its default preserves that future without shipping a policy the
runtime should not own.

## Terminal text as a liveness signal

Rejected. The repository's rule is that vendor artifacts, not terminal text,
decide turn state. Introducing screen scraping as a second liveness authority
would make stall detection depend on TUI rendering, which is exactly the coupling
the artifact contract removes.

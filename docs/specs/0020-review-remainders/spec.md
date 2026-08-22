# 0020: The review remainders

## Status

Specced, tests written and confirmed failing against the prior code, then built,
2026-08-22. Follows `0019` out of the same whole-repository review.

**Guarantees touched:** 6 (the driver seam), 7 (one peripheral append that could
fail a startup), and 1 at the surface (two silent-drop paths in the adapter).
Everything here is in `src/` or the installer, so it is a core change by the rule
in `AGENTS.md`.

## What changes, and why

**1. Provider identity gets one home.** `drivers/drivers.js` now exports the
driver set, the display labels, and `startupScreenAction`, which owns the
startup-dialog table that previously sat inside `core/session-manager.js` as a
branch on the driver name. The surface and `route-store` consume the registry
instead of carrying their own copies, and `config.js` validates the default
driver against it at load, where every sibling knob already fails. A new
structural test forbids `"claude"` and `"codex"` literals anywhere in `core/` or
`surface/` except the artifact parser, so the next leak fails the suite instead
of waiting for a review.

**2. A navigation decision survives an unwritable event log.** The navigator
awaited its event append, so a full disk discarded a decision the OpenAI call had
already paid for and let a startup screen loop into `attention_required`. The
append is now fire-and-forget with a logged failure, the same rule every other
append on the turn path already follows.

**3. Cancellation is visible.** A turn preempted by a barrier used to leave its
status bubble reading "Working." forever, and a message cancelled before it ever
started vanished with no trace. The cancellation path now finalizes the bubble as
"Interrupted." and tells the owner when a message was set aside unrun.

**4. Small correctness holes, each with the test that used to be missing:**

- a message whose only content is a `rich_message` body is admitted;
- a failed offset write no longer strands an already-queued update until restart;
- `tmux send-keys -l` no longer loses a trailing semicolon (tmux parses it as a
  command separator even via argv; the trailing one is escaped);
- the socket client times out instead of hanging on a wedged daemon;
- the installer remembers a custom install directory across reruns instead of
  quietly defaulting back to the XDG path.

**5. One stated exception.** The operational prune no longer re-reads the
sessions directory once per pruned record; the listing is hoisted above the loop.
This is a non-behavioural efficiency fix and carries no failing-first test,
which is stated here rather than papered over.

## What decides success

Every functional change above has a test that was run against the prior code and
failed for the intended reason: the registry and dialog tests, the provider-name
structural test, the navigator append test, the two cancellation-visibility
tests, the rich-body admission test, the offset-strand test, the tmux
trailing-semicolon tests (unit and against a real tmux), the wedged-client
timeout test, and the installer rerun test.

## Not built, and known

The busy-conflict resend gap named in `0019` stays as designed. The undocumented
`CLI_RUNTIME_TELEGRAM_SYSTEM_INGRESS_CHATS` admission path is documented in the
README as part of this change's companion docs commit, not silently left.

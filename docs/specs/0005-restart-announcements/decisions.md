# Decisions — Restart Announcements

Rationale for `spec.md`. Historical; the spec is authoritative.

## A file spool, not an HTTP endpoint

An endpoint on the daemon's socket would mean the daemon relaying to the adapter,
which is a dependency the two do not otherwise have. A spool directory is
readable, writable, and inspectable by a shell script, survives the adapter being
down, and needs no protocol version negotiation. The cost is that a writer must
know the path — which is already true of every other piece of runtime state.

## The deployer does not send Telegram messages itself

The deploy script could read the token out of `runtime.env` and `curl`
`sendMessage`. That puts the token in a second place, duplicates chunking and
topic routing in bash, and gives the operator two code paths that format messages
differently. Writing a notice file keeps one sender.

## Delete before send

At-most-once, deliberately. The alternative — send, then delete — repeats an
announcement whenever the process dies mid-send, and the crash case is exactly
when it would repeat. A "stopping" message arriving after the process has already
come back is actively misleading; a missing one is merely quiet.

## Expiry on the notice, not in the reader

The writer knows how long its message stays true. "Stopping now" is worthless
sixty seconds later; "release X is active" stays true indefinitely. Encoding the
lifetime at the point where the intent exists avoids a policy constant that has
to guess for both.

## Only unexpected restarts are announced by the runtime

Announcing every start would double every planned restart, since the restarter
already writes both halves. It would also make the runtime the author of a
message it cannot substantiate: it does not know whether the deployment
succeeded, only that it is running.

## The owner's private chat as the default target

The bound owner always exists once enrollment has happened, and an operational
message does not belong in four bound project routes at once. A notice that
concerns one conversation carries that conversation's route explicitly, which is
what the deployer does when a deployment was triggered from a topic.

## A separate drain timer

Draining only between `getUpdates` cycles would delay a stop announcement by up
to the 25-second long-poll timeout, and the deployer waits only seconds before
stopping the adapter. A one-second timer with a re-entrancy guard costs a
directory listing per second and makes the announcement prompt.

## Rate limiting in the marker, not in memory

A restart loop restarts the process, so an in-memory counter resets every time
and would rate-limit nothing. The suppression count and the last announcement
time live in `last-run.json` for the same reason the crash flag does: it is the
only state that survives the thing being counted.

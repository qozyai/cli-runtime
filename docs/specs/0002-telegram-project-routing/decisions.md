# Design Decisions

Rationale for `spec.md`. Not required reading to implement it — this exists so
the reasoning is recoverable without carrying it inside the specification.

## Telegram project routing

### Residency is bounded structurally, not by policy

**Decision:** a route has at most one resident session. Switching projects
releases the previous pane. That structural bound is the entire mechanism — there
is no global cap, no admission control, and no eviction policy.

An earlier revision let multiple projects stay resident *within* one route and
bounded them with a 12-hour inactivity timer. That single choice forced a
`retiring`/`retired` state pair, a liveness-refresh exemption so those states
would not be rewritten as `stopped`, a `retire()` operation and endpoint, a
per-session lifecycle lock, attached-client deadline policy, an idle worker with
earliest-deadline scheduling, crash-left `retiring` reconciliation, an injectable
clock, and roughly half the test surface — for a mechanism no requirement asked
for.

Three things settled it:

- "Conversation alive, process gone" is already a working state in shipped code:
  `get()` marks a dead pane `stopped`, the adapter restarts `stopped`, and
  `restart()` resumes from a preserved `providerSessionId`. `retired` was a
  second name for it, which is why the exemption rule was needed at all.
- The lifecycle lock deadlocked on the most common control path. `close()` took
  the lock and then called `interrupt()`, also a state transition; even exempting
  that, `close()` awaited completion while holding the lock completion needed.
  The lock existed only because a background sweep could race a foreground
  submission — deleting the sweep deletes the bug class rather than fixing it.
- The timer never bounded memory. Only a cap does. With release moved into the
  admission path, there is no background worker, no interval, and no
  reaper-versus-submission race.

Cost: within one non-topic chat, switching A → B no longer keeps A warm.
Switching back restarts and resumes, so the conversation is preserved and only a
few seconds are lost. Parallel work across topics is unaffected — those are
separate routes. This partially reverses an earlier call to keep parallel
projects resident, and was accepted deliberately.

The global cap went through two revisions before being dropped. It began as LRU
eviction at admission time, became refusal-only when eviction proved to be a way
of killing a session someone was using, and was then removed entirely. The
per-route bound already prevents unbounded growth in normal use; a global cap
only binds past roughly ten simultaneously warm routes, and paying for that case
meant a global admission chain serialized against create and restart, a
`RESIDENT_LIMIT` refusal, capacity reporting in Telegram, and an explicit release
verb. `/stop` had been drafted as that verb, which would have made the most
common use of `/stop` — killing a runaway turn to rephrase it — cost a full
driver restart on the next message. Dropping the cap removes all of it and
returns `/stop` to interrupt-only. If real memory pressure appears, the cap comes
back with its own control rather than overloading `/stop`.

### A missing directory changes nothing

**Decision:** when a bound directory disappears, refuse the turn and touch
nothing.

The earlier design "resource-retired" the session first and made the retirement
deliberately reversible, which required reasoning about crash windows either side
of the binding write. Doing nothing is strictly simpler and strictly more
recoverable: renaming back works because nothing was torn down.

This depends on one fix. `WorkspaceState.ensure` calls `fs.mkdir(dir, {
recursive: true })` on `<workspace>/.qozyai`, and `recursive: true` creates
`<workspace>` itself. Reached from `collectOutputs`, `finishTurn`, and `prune`
with the *recorded* workspace, it recreates a renamed-away project as an empty
directory — after which the missing-path check never fires again (the path
exists), `/project` lists a phantom, and rename-back fails with `ENOTEMPTY`.
Confirmed by probe against the real `WorkspaceState`.

The same rule had to be extended to `/reset` and `/driver`. Both are
delete-then-recreate: the delete succeeds as a permanent supersession, the
recreate fails on the missing path, and renaming back afterwards yields a fresh
record with no `providerSessionId`. `/reset` is exactly what an operator types at
a route that looks stuck.

### The daemon is authoritative for key reuse only

**Decision:** keep the fail-closed 409 on session-key reuse; describe containment
as adapter-side.

`create` currently returns an existing session without comparing driver or
workspace at all, so the check fixes a live defect. But for a *new* key the
daemon accepts whatever workspace the caller asserts — it has no concept of a
projects root. Calling it "the identity authority" would lead an implementer to
skip the catalog revalidation that is the only containment there is. Passing the
root into the daemon was considered and rejected: single-operator host, `0600`
socket, no other peer.

### No versioned route document

**Decision:** `{routeKey: {driver, project}}`, a flat superset of today's shape.

The adapter mutates a loaded record in place and writes the whole object back, so
an older build round-trips an unknown `project` field intact — the superset is
safe in both directions. A `{version, routes: {...}}` envelope would instead make
the current adapter read every route as `undefined`, silently unbinding every
chat and then persisting the mangled result over the versioned document. So
collapsing the envelope also removed the downgrade hazard it would have created.

Per-route version numbers were inert anyway: nothing read or incremented them,
and whole-document writes leave nothing for a CAS token to compare. Strict
per-document validation was actively harmful — `readJson` rethrows, `init()` does
not catch, and `run()` awaits `init()` outside its retry loop, so one malformed
byte exits into a `Restart=on-failure` loop with the bot silently dead, while
hand-editing that file is the documented recovery move for a wedged route.

### Cuts made for simplicity

- **Direct-chat project label.** Three conditions, a catalog count, a second
  delivery path, and a permanent loss of Markdown rendering on the primary chat
  path — for a cosmetic cue. It was also inverted: suppressed in group chats,
  where a shared binding makes mis-routing possible, and present only in the 1:1
  case where it cannot happen. Cut entirely.
- **Legacy dual-mode configuration.** Two permanent Telegram modes as a bridge
  for a migration that is one release note. Only the fail-closed rule was kept,
  because `config.js` otherwise defaults the Telegram workspace to
  `process.cwd()`, which under systemd is `$HOME`.
- **Bare `/project`.** The single read-only project-listing command.
- **Four overlapping requirement lists** (test bullets, live steps, a matrix, and
  a gate) collapsed into one checklist that is simultaneously the specification,
  the test plan, and the gate.
- **Development tooling and the operator tutorial** moved to `docs/`.

### Gate wording

"An independent review finds no defect" is unfalsifiable — the previous review
round on this codebase found nineteen defects introduced by the round before it.
The gate is stated as "every finding triaged, all blockers closed."

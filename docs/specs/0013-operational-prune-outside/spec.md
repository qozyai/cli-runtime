# 0013 — Move the operational prune outside, and the question it raises

**Status:** **answered (c), not built and not to be built.** Nothing has been removed
from `src/`. §3 was answered twice on 2026-08-19: first with option (b), then — after
(b) was built and produced evidence against itself — with option **(c)**. §4 records
both, because the reversal is the useful part.

**Guarantee touched:** none of the eight. Like `0012`, this removes housekeeping from
`src/` rather than changing what a turn does, and is a core change by the rule in
`AGENTS.md` because the diff is in `src/`.

## 1. It is separable, unlike the media floor

`pruneOperationalState()` in `src/core/session-manager.js` keeps the newest 1,000
terminal submission records by `completedAt || acceptedAt`, deletes the rest, and
deletes each one's prompt file under `sessions/<hash>/prompts/<id>.txt`.

It reads **no in-memory session state**. It lists a directory, parses records, sorts by
a timestamp, and unlinks. `scheduleOperationalPrune()` fires it on `setImmediate` after
turns, which is scheduling, not coupling.

The races are benign. A torn record mid-write parses as non-terminal and is skipped. A
plugin and the runtime pruning at once delete the same files, and `force: true` makes
the second a no-op. A record deleted while someone asks about it returns null, which is
already true after the runtime prunes it itself.

So unlike the 30-day media floor in `0012` §2, this one can move.

## 2. But it needs a second exception, and that is the point of this spec

The plugin contract names two interfaces: the socket and the notice spool. There is
deliberately no capability granting the runtime's state directory, because a plugin
reading runtime records makes the shape of those records a public contract.

Two exceptions already exist:

| plugin | reads | why it was allowed |
|---|---|---|
| `queue-janitor` | `<state>/telegram/queue` | the containment fix for a stranded-record bug; the coupling is a `{{stateDir}}` config value in one manifest |
| `memory-consolidate` | `<workspace>/.qozyai/history` | recorded in `AGENTS.md` as a sanctioned read-only seam, with the record shape accepted as an external contract |

This would be the third, over `<state>/submissions` and `<state>/sessions/*/prompts`.

**Three is not an exception. Three is a capability that nobody has admitted to
designing.** Each one was individually defensible and the set is now a pattern, and a
pattern that is not named is a rule that has quietly stopped being true.

## 3. Recommendation — decided: **(c)**, on 2026-08-19

Before a third exception is added, pick one deliberately:

**(a) Admit the capability.** Add a read-only `state` capability, document exactly which
subtrees it covers and that their record shapes are external contracts, and accept that
changing any of them is a core change. Honest, and it makes the cost visible in one
place instead of three READMEs.

**(b) One janitor, not many.** Fold queue sweeping and record pruning into a single
`runtime-janitor` plugin holding *the* documented exception, so the count of things
reaching into runtime state stays at one no matter how many chores it does.

**(c) Leave it in `src/`.** The prune is ~25 lines that have never caused a problem.
Moving it buys tidiness and spends a boundary. That is a defensible trade to refuse.

This spec recommends **(b)**: it keeps the boundary countable, it needs no new
capability, and the queue janitor is already exactly this shape. But the choice belongs
to whoever owns the invariant, not to the change that would benefit from relaxing it.

**The owner chose (b) on 2026-08-19, then reversed to (c) the same day.** The reversal
is recorded in `0017` §2 and in `0014-state-locality/decisions.md` §4.

What changed the answer was not an argument. `runtime-janitor` was built under (b),
with an equivalence test that ran the runtime's own `pruneOperationalState()` against
the plugin's reimplementation over a shared fixture, and it passed. On the same day the
neighbouring plugin `archive-sweep` — written earlier to the same standard, with the
same kind of equivalence test — was found red, because `0015` changed the runtime's
sweep and nobody updated the twin. Had it been enabled it would have deleted memory.

Two implementations of a deletion rule are correct exactly as long as somebody keeps
them that way, and the version of this repository that keeps them in sync is the one
that had just failed to. So (c) is no longer "the prune is only 25 lines and has never
caused a problem". It is that a redundant deletion rule is a standing maintenance cost
that buys nothing, and the cost is worst when one copy is dormant and nobody thinks to
run its suite.

## 4. State of the work — and the day this was decided twice

Under **(b)**, on 2026-08-19:

1. `runtime-janitor` was built in the plugins repo, folding in `queue-janitor`'s sweep.
2. Its equivalence test was written and passed against the runtime's own
   `pruneOperationalState()` over a 1,007-record fixture.
3. Removal from `src/` was gated on the plugin runner being resident. It never happened.

Then `archive-sweep`'s suite was found red — `0015` had landed on the runtime side only
— and the reversal to **(c)** followed. Under (c), the same day:

4. `runtime-janitor` was deleted in full. With the record prune staying in `src/` it was
   a duplicate of `queue-janitor` and nothing else.
5. `archive-sweep` was fixed to match the runtime, its fixture extended to carry a
   memory file in both trees, and it stays disabled as an equivalence tripwire.
6. `0017` gave retention what moving it outside was supposed to deliver: policy from the
   environment, and a clock that reaches workspaces no turn has touched.

**Nothing is outstanding.** `pruneOperationalState()` stays where it is, and the
`refactor.md` §6 Tier 2 row for it should be struck rather than left as a candidate.

The queue sweep is unaffected by any of this and stays a plugin. It is not retention; it
is containment for an adapter bug, judged by whether editing the turn path is worth it,
which is a different question with a different answer.

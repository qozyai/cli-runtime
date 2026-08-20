# Working in this repository

## The core, and why it is named

This runtime does one thing: it carries a message from its owner to a model and
brings the answer back. Everything else — scheduling, memory, cleanup, deployment,
announcements — is built *around* that path, never inside it.

That path is **the core**. It is defined by the guarantees below, not by a list of
files, because files move and guarantees do not.

1. **One message, one turn.** An accepted inbound message produces exactly one turn,
   or a failure the owner can see. It is never silently dropped.
2. **One active submission per session.** A second is refused explicitly. It is not
   queued behind the first without the caller being told.
3. **The provider decides the outcome.** Whether a turn succeeded is read from the
   provider's own artifact, never inferred from a timeout, an exit code, or a
   heuristic about the text.
4. **Every terminal turn is recorded once.** Finalization is idempotent by
   `submissionId`; a crash and replay must not produce two records.
5. **The reply goes back where it came from.** If it cannot be delivered, the failure
   is reported on that same route.
6. **Driver differences stop at the parser.** Above `artifact-parser.js`, nothing
   branches on which provider ran. Adding a driver must not touch anything else.
7. **Peripheral failures never fail a turn.** Anything convenient — history writing,
   notices, cleanup — fails to a log, not into the conversation.
8. **One way in, one way out.** The unix socket API is the only ingress. The notice
   spool is the only way anything that is not a turn reply reaches the owner.

## The rule

Every change is either a **core change** or an **outside change**. The default is
outside.

A **core change** is deliberate and says so. It names which guarantee it touches, it
carries a spec under `docs/specs/`, and it has a test that fails without it. Wanting
to edit the core in order to add a feature is the signal that a seam is missing — the
correct response is to add the seam, not the feature.

An **outside change** touches no file in `src/`. It talks to the runtime through the
socket API and the notice spool, and nothing else. Schedulers, memory passes,
janitors, deployment, and text-to-speech are all built this way and must stay that
way.

## A third seam, recorded rather than assumed

Guarantee 8 names two interfaces: the socket in, the notice spool out. Memory
consolidation needs a third — it reads normalized turn history from
`<workspace>/.qozyai/history`, because that is where the record of what happened
lives and there is no socket API that returns it.

That read is hereby **sanctioned and read-only**, and the cost is stated rather than
discovered later: **the shape of a history record is now an external contract.**
Changing it is a core change under the rule below, exactly as if something inside
`src/` depended on it. Nothing outside may write there.

It is one seam, named, with one consumer. It is not a licence for a plugin to read
whatever else it finds under a state directory — that remains forbidden, and the
plugin runner deliberately has no capability that grants it.

**One later note on the same seam.** Memory's *store* now also lives under
`<workspace>/.qozyai/memory` (`0014` `decisions.md` §2). "Nothing outside may write
there" above is about `history`, which the runtime owns; `memory/` the runtime neither
writes nor deletes, and `0015` is the change that stopped the age floor reaching it.

The alternative was a socket API returning history, which is a larger core change
made to avoid admitting a dependency that already exists: memory has read those files
since before it was scheduled. Writing it down is the honest option; pretending the
boundary holds is not.

## You are touching the core if

- your diff is in `src/` and is not adding or widening a documented seam;
- you are changing what a turn does, when it is considered finished, or where its
  reply goes;
- you are adding a branch on the driver name above the artifact parser;
- you are making something that used to be optional into something a turn depends on;
- you are changing the shape of a record that something outside already reads.

If any of those is true, stop and make it a core change on purpose: spec first, then
the test, then the code.

## Worked examples

**Correct as a core change.** Recording the full tool sequence on a finished turn
changes what guarantee 4 records, so it was specced, tested through the composed path
rather than around it, and reviewed. The review found that the first attempt silently
recorded nothing — which is exactly why core changes get that treatment.

**Correct as an outside change.** Self-scheduled wake-ups, memory consolidation, and
deployment all run as separate processes that use only the socket API and the notice
spool. None of them required a line of `src/`.

**Recorded as wrong, then kept, then split.** Age-based file cleanup went inside `src/`
because it was small and no seam existed, and this section called that debt. `0012` and
`0013` specced moving it out; `archive-sweep` and a record-pruning janitor were built to
do it; and the attempt produced the evidence that settled it — a change to the runtime's
sweep landed without its outside twin, and the twin's suite went red inside a day while
carrying a rule that would have deleted the memory store.

The lesson was not "keep it inside". It was that **two implementations of the same
deletion rule cost maintenance for ever and buy nothing**. `0018` states the split that
actually holds:

> **The runtime deletes by meaning. A janitor deletes by age.**

The runtime knows which records are still referenced, which turn is live, and which
history belongs to the last window of work. Nothing outside can know that, so retention,
ledger compaction, liveness and the submission-record prune stay here. It does not know
how long a voice note is worth keeping — that is a preference, and it now lives in a
marker file read by `plugins/retention-sweep`. There is no second implementation of
anything: the floors are gone from `src/` entirely.

The distinguishing question for the next chore is not where the state lives. It is
whether the decision needs a record.

## Layout

- Specs: `docs/specs/NNNN-slug/` — `spec.md`, `decisions.md`, and `review.md` when
  one exists. A spec states its status honestly, including what of it is not built.
- Operator contracts: `docs/guides/`.
- Tests: `node --test`. A change to the core without a failing-first test is not
  finished.

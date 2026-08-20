# 0014 — decisions

Taken by the owner on 2026-08-19, against the four questions in `spec.md` §7.

## 1. The promise is adopted

> Moving or archiving a project carries everything needed to understand and
> reconstruct its work — and nothing that could log in as you, and nothing that
> coordinates the machine that happened to run it.

This replaces "all state belongs in the project folder" as the rule. It is a promise
about what a project folder *contains*, not about which directory a given file sits
in, and it is what any future placement argument is settled against.

Rejected on the way here: **locality by cardinality** — "state referring to exactly
one project belongs to that project". It is mechanical and it is wrong, because
sessions, submissions and wake occurrences each refer to one project and each must
stay global for reasons of authority and recovery (`spec.md` §5).

## 2. Memory moves into the project

`<workspace>/.qozyai/memory/`, replacing `~/.local/state/qozyai-memory/<slug>/`.

**Built.** The relocation itself is an outside change — `memory.mjs` is a skill, and
no file under `src/` needed to know about it. It could not ship alone: the runtime's
ninety-day file floor walked the whole `.qozyai/` tree and would have deleted every
daily record at ninety days and one minute. That is the core change specced and built
as `0015-memory-in-workspace`, and it is the reason this decision cost a spec.

The existing store was migrated and the old location removed on 2026-08-19.

## 3. Copying a project forks its identity

Two copies of a folder are two projects, not one project in two places. A **move**
preserves identity; a **copy** creates a new project with its own id and its own
history from that point on.

This is the answer that unblocks everything else, and it is the cheaper of the two
answers to be right about: a fork that should have been a move loses continuity, which
is visible and recoverable. A move that should have been a fork gives two live copies
one identity — two sessions writing one history, two schedules firing into one thread —
which is neither.

**Not built.** It needs a versioned `.qozyai` manifest carrying a stable project id
and a global `projectId -> current path` registry, which is a core change. Specced
separately as `0016-project-identity`.

## 4. `0013` §3 is answered: option (b) — **superseded the same day by (c)**

Queue sweeping and operational record pruning fold into a single `runtime-janitor`
plugin, which holds *the* documented exception for reading the runtime's state
directory. The count of things reaching into runtime state stays at one however many
chores it grows.

Rejected at the time: **(a) admit a general `state` capability** — it makes the coupling
cheap to add, and the cost of this boundary should stay visible at the point of use.
**(c) leave the prune in `src/`** — judged defensible, but as leaving the queue janitor
a one-off exception with no rule behind it.

**Reversed to (c) on 2026-08-19, hours later.** Building (b) surfaced that
`archive-sweep` — the same pattern, one spec older — had silently drifted from the
runtime and would have deleted memory. The reasoning for (c) is no longer "the prune is
small"; it is that a second implementation of a deletion rule is a standing maintenance
cost with no benefit, and this repository had just demonstrated it does not reliably pay
it. See `0013` §3–§4 and `0017` §2. `runtime-janitor` was deleted.

The rule that replaced it is stated in both `AGENTS.md` files: **only the runtime
deletes.** A plugin may decide when something happens; it may not hold its own copy of
what to delete.

## What this does not decide

`spec.md` §7 question 3 — whether conversation payload must exist *only* in the
project — is untouched. Submission records still carry full reply text, prompt files
still hold assembled prompts, and `events.jsonl` still carries reply-bearing events.
Payload minimization of the global plane remains open, and `0015` §6 notes the
matching gap on the other side: nothing expires memory now that the floor does not
reach it.

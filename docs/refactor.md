# Refactor: core, drivers, surface, and jobs as plugins

**Status:** the layout has shipped. Steps 1 to 5 of §8 are done and deployed. Step 6 is
partly done and partly cancelled: see the Tier 2 table, which was rewritten on
2026-08-19 and again on 2026-08-20 after two reversals.

| Step | State |
|---|---|
| 1. Land what was uncommitted | `67608e1` |
| 2. Move the files | `ea14d32` — 21 files, byte-equivalent, nothing else in the commit |
| 3. Dependency test | `cabbbaa` — `test/source-layout.test.js`, with negative fixtures |
| 4. Per-directory `AGENTS.md` | `7a6112e` |
| 5. Plugin runner | **done** — built in the private `qozyai/plugins` repo, with four plugins |
| 6. Move Tier 2 candidates out | the auth watch is built; the two archive age floors left in `0018`; the rest either stay by decision or do not exist yet |

The runner lives outside this repository, at `/code/qozyai/plugins`, with its own
`AGENTS.md`. On this machine it runs as one user unit with five plugins: the queue
janitor and `retention-sweep` active, memory consolidation, the auth watch and wake
installed but disabled, each for a reason recorded in its own README.

The layout below is therefore a description of the tree, not a proposal. Sections 5–6
are still proposals.

This is one document for a set of decisions taken together. It exists so the next
person does not have to reconstruct the reasoning from a conversation.

## 1. Why

The runtime does one thing: it carries a message from its owner to a model and brings
the answer back. Around that, a set of helpers has accumulated — scheduling, memory
consolidation, cleanup, deployment, speech. Each was small. Each was tempting to add
inside `src/` because that is where the code already was.

The purpose of this refactor is to make the boundary between those two things
**visible in the layout and checkable by a test**, so that "the core stays simple" is
a property of the repository rather than a habit of whoever is editing it.

The invariant itself — the eight guarantees that define the core, and the rule for
changing it — is stated in [`AGENTS.md`](../AGENTS.md). This document is about the
structure that protects it.

## 2. Source layout

Four buckets, not three:

```
src/
  main.js        composition root — wires everything, may import anything
  config.js      composition — configures core and surface alike
  core/          the turn path
  drivers/       provider invocation and the terminal underneath it
  surface/       everything that exists because there is a human-facing front door
```

**`core/`** — `session-manager`, `server`, `client`, `workspace-state`,
`event-store`, `progress`, `artifacts`, `artifact-parser`, `util`,
`runtime-lock`.

**`drivers/`**: `drivers`, `driver-version`, `tmux`, `navigator`,
`openai-navigation`, `auth-manager`.

**`surface/`**: `telegram`, `notices`, `openai-helper`, `project-catalog`,
`owner-store`, `route-store`.

Two modules moved after the original layout shipped (`0021`, 2026-08-23):
`notices` to `surface/`, because its only consumer is the adapter, and the
navigator's OpenAI backend to `drivers/`, because startup navigation exists
with or without a chat attached. `client` stays in `core/` as the caller half
of the socket API pair, by recorded decision in the same spec. The counts in
§3 and §7 are the measurements from the day of the original move.

### Why `surface/` and not `adapters/`

Only two of those five are adapters to an external service. The other three — owner
store, route store, project catalog — are *state that exists because there is a chat
surface with owners, threads and project switching*. The core never asks any of those
questions; it deals in session keys.

The test that defines the bucket: **delete the whole directory and a working runtime
remains** — a socket API that accepts submissions and runs turns, with no chat on top.
Someone could add a Slack or command-line surface without touching core or drivers.
The value is substitutability, not tidiness.

### Why `main.js` and `config.js` stay at the root

`main.js` is the composition root; it is *supposed* to import everything, and leaving
it inside `core/` would be the only reason the dependency rule needs an exception.

`config.js` genuinely straddles the boundary — it configures the core and also holds
owner enrollment, ingress chat ids, the default project, the projects root, and a
whole surface-specific block. Wiring is allowed to know about everything.

### There is no `src/plugins/`

Deliberately. Plugins are separate processes living outside this repository (§5). A
`plugins/` directory inside `src/` would either sit empty or become precisely where
core creep hides: something plugin-shaped goes in, imports from core because that is
easy, and the boundary stops meaning anything.

## 3. The dependency rule

```
surface/  →  core/, drivers/        allowed
drivers/  →  core/                  allowed
core/     →  drivers/               allowed  (the core must be able to launch one)
core/     →  surface/               FORBIDDEN
main.js, config.js → anything       allowed
```

One rule, no exceptions.

### It is already true

Mapped across the **23** files in `src/`, there are **45 import edges**. With
`main.js` and `config.js` at the root:

| edge | count |
|---|---:|
| `surface → core` | 7 |
| `drivers → core` | 5 |
| `core → drivers` | 1 |
| **`core → surface`** | **0** |

Re-measured after the driver-version work landed, so the property survives a change
made by someone who had never read this document — which is the only kind of evidence
that a boundary is real rather than maintained by hand.

The single `core → drivers` edge is `session-manager → drivers`, which is legitimate.

The codebase is already this shape. The directories make visible what is already
true, which is the cheapest possible time to draw a boundary.

### Enforcement

**Directories signal; they do not enforce.** The enforcement is a test — roughly
thirty lines that parses the `require` graph and fails if anything under `core/`
imports from `surface/`. It runs in the existing suite.

Without that test this is a convention, and conventions erode the first time somebody
is in a hurry.

### Per-directory instructions

Each bucket gets its own `AGENTS.md`, with `CLAUDE.md` symlinked to it so both drivers
read one file. Nested instruction files are picked up when working inside a subtree,
so an agent editing something in `core/` has the core rules beside it rather than
needing to have read the repository root.

## 4. Known wrinkles

- ~~`notices.js` is generic but its log lines are prefixed `[telegram]`~~
  **Resolved by `0021`, 2026-08-23, by moving the module rather than editing the
  strings.** The prefixes were correctly labeled strings in the wrong directory;
  in `surface/` they are simply true. A structural test now fails if a module
  only the surface uses settles in `core/` again.
- Every line reference in the specs, the review documents and any external notes
  becomes stale. Cheap, but better known in advance than discovered afterwards.

## 5. Jobs as plugins

A **plugin** is a folder outside this repository containing a manifest that says how
it wants to run unattended:

```json
{ "name": "memory-consolidate",
  "kind": "periodic",
  "schedule": "0 4 * * *",
  "command": ["node", "scripts/memory.mjs", "consolidate", "{{workspace}}"],
  "timeoutSeconds": 1800,
  "needs": ["socket"] }
```

**Two kinds, because the existing jobs genuinely differ:**

- `daemon` — must stay resident. A twenty-second ticker cannot pay process startup
  4,320 times a day.
- `periodic` — starts, does one thing, exits.

**One runner** reads every manifest and runs them. Same runner on a host and inside a
container; plain Node, no per-job service units.

**Install semantics.** A skill installs its plugin on first use. For a scheduler, the
plugin is the resident ticker and later uses only add schedule files it picks up. For
a periodic job, installing the plugin *is* the installation — its manifest carries the
schedule and there is no second step.

**One entrypoint per environment, zero per job.** On a host, a single service unit
starts the runner — something must restart it after a reboot, and that is what an init
system is for. In a container there is no init system, so the existing supervisor
process starts the runner instead. (In one container image this replaces three
hand-written supervisors totalling ~729 lines.)

**Why not run an init system in the container:** the agent containers drop all
capabilities, run unprivileged as a non-root user with a read-only root filesystem and
`no-new-privileges`, and reconcile against those invariants. An init system needs
approximately the opposite of every one of those. That is a trade of the isolation
boundary for a scheduler, which is a bad trade when ~120 lines of Node buys the same
thing.

## 6. What can become a plugin

### Tier 1 — already outside, needs only a manifest

| Plugin | Kind | Notes |
|---|---|---|
| scheduler / wake | `daemon` | **Built.** Rewritten around a durable occurrence record; manifest ships disabled until an explicit cutover from `qozyai-wake.service`. |
| memory consolidation | `periodic` | **Built** as a manifest only; disabled, because a dry run shows the first run would consolidate 2026-08-03 rather than yesterday. |
| queue-record janitor | `periodic` | **Built and running.** Every minute. |
| speech | — | Not a job. Runs inline during a turn; stays a plain skill. |
| deployment | — | Not a job. One-shot, must outlive the runtime restart. |

### Tier 2 — was "inside the runtime today, and movable". **Struck, 2026-08-19.**

This section was rewritten twice in two days, and the second rewrite is the one that
holds. `0018` states the rule:

> **The runtime deletes by meaning. A janitor deletes by age.**

So the two archive age floors did leave, and the record-based retention did not. Which
is neither what this section originally proposed nor what the 2026-08-19 rewrite of it
claimed.

The row-by-row reasoning below was not wrong about separability. It was wrong about what
separability buys. Both candidates were first built as plugins holding a *copy* of a
runtime rule, kept in step by an equivalence test, and the evidence came back against
that shape within a day: `0015` changed the runtime's sweep, the twin in `archive-sweep`
was not updated, and its suite went red while carrying a rule that would by then have
deleted the memory store.

The lesson was not "keep it inside". It was that two implementations of one deletion rule
cost maintenance for ever and buy nothing. `retention-sweep` has no twin: the floors are
gone from `src/` entirely, and the policy is a marker file beside the data.

| Candidate | Where it lives | Disposition |
|---|---|---|
| **Workspace retention / prune** | `workspace-state.js` | Stays, and always will: it rewrites records inside a live `.jsonl`. The env policy and the periodic tick were `0017` and are gone again with `0018`. |
| **Archive file floor** (90d) | ~~`workspace-state.js`~~ | **Left, in `0018`** — but as a marker-driven janitor with no twin in `src/`, not as the equivalence-tested copy `0012` planned. |
| **Archive media floor** (30d) | ~~`workspace-state.js`~~ | **Left, in `0018`.** `0012` §2 was right that it could not be *lifted* — the answer was to delete it and let age be somebody else's job entirely. |
| **Operational prune** | `session-manager.js` | Stays. `runtime-janitor` was built under `0013` (b) and deleted under (c). |
| **Auth expiry watch** | *built, outside* | Highest value of the set — see below, including what it turned out not to be able to do. |
| **Knowledge / memory backup** | *does not exist* | Periodic, no runtime coupling. |
| **Health digest** | *does not exist* | What ran, what failed, what is stuck. |

**Build the auth expiry watch first.** Done, and it needs no new runtime code:
`GET /v1/auth/<driver>/status` is a sanctioned seam and the plugin uses nothing else.

**But it cannot warn before expiry, and this document was wrong to promise it.** That
endpoint returns `{driver, state, authenticated, method, email}` and no expiry time,
because the driver CLIs underneath it do not report one. "Auth expires in two days"
would need a seam that does not exist.

What is buildable is a watch on the *transition*, announced once when it happens and
once when it is repaired. The failure this exists for is credentials expiring with a
broken repair path and nobody noticing — which has silently killed a production agent
for weeks at a time. Minutes instead of weeks is the win that was actually available.

**Cost of moving retention out, and why the age floors did not pay it.** `prune()` runs
under an in-process lock that an external plugin cannot take, so a plugin rewriting the
same `.jsonl` the runtime is appending to would race it. That is still true, and it is
why record-based retention stays in `src/` and needs no further discussion.

The age floors escaped the problem rather than solving it. `retention-sweep` is scoped by
its marker to `io/history`, which is written once when a turn finalizes and never touched
again. There is no concurrent writer, so there is nothing to serialize against and no
shared lock is needed. A shared on-disk lock would only be required by something that
wanted to move the record surgery, and nothing does.

### Tier 3 — cannot move, named so nobody tries

| Thing | Why it stays |
|---|---|
| Voice transcription | On the critical path — the transcript must exist before the prompt is built. A hook, not a job. |
| Startup-screen navigator | Runs *during* session start. |
| Artifact parsing / completion detection | This is what the runtime is. |
| Notice delivery | Only the surface holds the outbound credential. Plugins write notices; the surface sends them. That asymmetry is the seam. |
| Session lifecycle, routing, the socket API | Core. |

## 7. Cost of the move

Measured, not estimated:

- **21** files moved — 23 in `src/`, less `main.js` and `config.js`, which stay at the root
- **26** import lines to fix inside `src/`
- **68** import lines across **20** test files
- **3** references outside `src/` — two in `package.json`, one in `bin/`

≈ **97 mechanical line edits and 21 moves.** Zero behaviour change. The suite (162
tests at the time, 174 now) is the safety net: a wrong path fails immediately with `MODULE_NOT_FOUND`.

## 8. Sequencing

1. ~~Land and deploy whatever is currently uncommitted.~~ **Done** — `main` is at
   `67608e1`, the tree is clean, and no feature branches remain.
2. Move the files. **Its own commit, containing nothing else**, because it changes no
   behaviour and that is what makes it reviewable.
3. Add the dependency test in the same commit or immediately after. The layout without
   the test is decoration.
4. Add the per-directory `AGENTS.md` files.
5. Build the plugin runner when the next job needs it — not before.
6. Move Tier 2 candidates out one at a time. Partly done: the archive age floors left
   in `0018`, record-based retention stays by decision, and the two remaining rows are
   jobs that do not exist yet.

**This move is itself a core change** by the definition in `AGENTS.md`: it touches
every file in `src/`. It changes no behaviour, which is exactly why it must be its own
commit with nothing else in it.

## 9. Debt this records, and how it was paid

Archive age floors were added inside `src/` because the change was small and no seam
existed yet. This section recorded that as debt rather than letting it pass quietly,
on the grounds that small changes going in because the seam does not exist is precisely
how a core stops being small.

**Paid on 2026-08-20, in `0018`.** Both floors were deleted from `src/` and age became
`plugins/retention-sweep`'s job. It took three attempts, and the two that failed are
worth more than the one that worked: both tried to move a *copy* of the rule and keep two
implementations in step, and both drifted. The version that shipped moved the decision
instead of the code, and left nothing behind to drift from.

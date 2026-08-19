# Refactor: core, drivers, surface, and jobs as plugins

**Status:** ready to execute. No code has moved.

Preconditions checked on 2026-08-18 22:36 EDT, against `main` at `67608e1`:

- `main` carries every branch's work; no feature branches remain.
- The working tree is clean.
- 162 tests pass.
- No other process has this repository as its working directory.
- The measurements below were re-taken on that tree and are current.

**Re-check the last two before starting.** This moves every file in `src/` and
rewrites every import path, so it cannot be merged with concurrent edits — whoever is
mid-change loses. A first attempt was abandoned on 2026-08-18 because a second session
was editing the tree, which is also how `driver-version.js` came to be missing from
the original measurements.

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
`event-store`, `progress`, `notices`, `artifacts`, `artifact-parser`, `util`,
`runtime-lock`.

**`drivers/`** — `drivers`, `driver-version`, `tmux`, `navigator`, `auth-manager`.

**`surface/`** — `telegram`, `openai-helper`, `project-catalog`, `owner-store`,
`route-store`.

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

- `notices.js` is generic but its log lines are prefixed `[telegram]`, and the
  directory it watches is handed to it by the surface. The code is clean; the strings
  are not. **Not fixed during the move** — it is a behaviour-adjacent edit, and mixing
  one into a pure move is how a "no behaviour change" claim stops being true. Its own
  commit, before or after.
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
| scheduler / wake | `daemon` | Exists. Today a hand-written service unit. |
| memory consolidation | `periodic` | Exists as a manual command. |
| queue-record janitor | `periodic` | Designed, not built. Every minute. |
| speech | — | Not a job. Runs inline during a turn; stays a plain skill. |
| deployment | — | Not a job. One-shot, must outlive the runtime restart. |

### Tier 2 — inside the runtime today, and movable

| Candidate | Where it lives | Why it can move |
|---|---|---|
| **Workspace retention / prune** | `workspace-state.js` | Reads everything from disk — pending outputs from the I/O ledger, retained ids from the history records. Touches no in-memory session state. A filesystem janitor that happens to be called from inside a turn. |
| **Archive age floors** | `workspace-state.js` | Pure file-age rules. No runtime state at all. |
| **Operational prune** | `session-manager.js` | Keeps the newest 1,000 terminal submission records and deletes their prompt files. Housekeeping. |
| **Auth expiry watch** | *does not exist* | Highest value of the set — see below. |
| **Knowledge / memory backup** | *does not exist* | Periodic, no runtime coupling. |
| **Health digest** | *does not exist* | What ran, what failed, what is stuck. |

**Build the auth expiry watch first.** A periodic job that asks whether each driver's
credentials are still valid and warns *before* they expire. Credentials expiring with
a broken repair path is a failure mode that has silently killed a production agent for
weeks at a time; a job that says "auth expires in two days" turns that into a
two-minute fix. It needs no new runtime code — `auth-manager.js` already exposes
status.

**Cost of moving retention out.** `prune()` runs under an in-process lock. An external
plugin cannot take that lock, so the two could race — the runtime appending a turn
record while the plugin rewrites the same file. Moving it out therefore requires a
**shared on-disk lock** both honour. That is a small change and arguably an
improvement: it turns an implicit in-process guarantee into an explicit seam. Until it
exists, retention stays where it is.

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
tests) is the safety net: a wrong path fails immediately with `MODULE_NOT_FOUND`.

## 8. Sequencing

1. ~~Land and deploy whatever is currently uncommitted.~~ **Done** — `main` is at
   `67608e1`, the tree is clean, and no feature branches remain.
2. Move the files. **Its own commit, containing nothing else**, because it changes no
   behaviour and that is what makes it reviewable.
3. Add the dependency test in the same commit or immediately after. The layout without
   the test is decoration.
4. Add the per-directory `AGENTS.md` files.
5. Build the plugin runner when the next job needs it — not before.
6. Move Tier 2 candidates out one at a time, retention last because it needs the
   shared lock.

**This move is itself a core change** by the definition in `AGENTS.md`: it touches
every file in `src/`. It changes no behaviour, which is exactly why it must be its own
commit with nothing else in it.

## 9. Debt this records

Archive age floors were added inside `src/` because the change was small and no seam
existed yet. They are pure file-age janitorial rules with no dependency on a turn, so
they belong outside. They work and are tested, and they are recorded here rather than
quietly accepted — small changes going in because the seam does not exist yet is
precisely how a core stops being small.

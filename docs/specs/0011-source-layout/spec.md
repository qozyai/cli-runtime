# Source Layout: core, drivers, surface

## Status

Planned and implemented on 2026-08-19: `ea14d32` moved the tree, `cabbbaa` added the
enforcement test, `7a6112e` placed the per-directory contracts. This block said "Not
implemented" for three days after the move landed; corrected 2026-08-22.

## Why this is a spec

`AGENTS.md` divides every change into a **core change** — deliberate, specced, with a
test that fails without it — and an **outside change**, which touches no file in
`src/`. Moving every file in `src/` is unambiguously the first kind, so it gets a
spec, even though it changes no behaviour at all. `docs/refactor.md` holds the design
and the reasoning; this states the contract and what must remain true.

## The layout

```
src/
  main.js        composition root — may import anything
  config.js      composition — configures core and surface alike
  core/          the turn path
  drivers/       provider invocation and the terminal underneath it
  surface/       everything that exists because there is a human-facing front door
```

| Bucket | Files |
|---|---|
| `core/` | `artifact-parser` `artifacts` `client` `event-store` `notices` `progress` `runtime-lock` `server` `session-manager` `util` `workspace-state` |
| `drivers/` | `auth-manager` `driver-version` `drivers` `navigator` `tmux` |
| `surface/` | `openai-helper` `owner-store` `project-catalog` `route-store` `telegram` |
| root | `config` `main` |

`main.js` and `config.js` stay at the root because wiring is allowed to know about
everything. Hoisting them is what lets the rule below have no exceptions.

There is deliberately no `src/plugins/`. Plugins are separate processes outside this
repository; a directory here would become where core creep hides.

## The rule

```
surface/  →  core/, drivers/        allowed
drivers/  →  core/                  allowed
core/     →  drivers/               allowed  (the core must be able to launch one)
core/     →  surface/               FORBIDDEN
main.js, config.js → anything       allowed
```

Measured on `67608e1`: 23 files, 45 intra-`src` import edges, and `core → surface`
already **0**. The layout makes visible a property the code already has.

## Enforcement

A test walks `src/**/*.js`, maps each file to its bucket by directory, resolves every
`require` to a bucket, and fails on a `core → surface` edge.

It must also fail when:

- a file in `src/` root is not `main.js` or `config.js` — a new file must be placed,
  not silently exempt;
- a `require` argument is not a string literal — the rule cannot be checked otherwise;
- it scanned no files. A structural test that silently inspects nothing passes for
  ever, so its own failure modes are proven with synthetic fixtures rather than
  assumed.

It inspects `.js` only: each bucket also carries an `AGENTS.md` and a `CLAUDE.md`
symlink.

## What must remain true

All eight guarantees in `AGENTS.md` are unchanged by this. Nothing about turn
admission, completion detection, finalization, delivery, driver neutrality,
peripheral-failure isolation, or the socket/notice seams is touched.

Concretely, the move must be **byte-identical apart from import paths**: every moved
file equals its previous content after applying only the expected `require`
substitutions, and the suite passes unchanged at 162 tests.

## Deliberate non-goals

- No behaviour change of any kind, including the `[telegram]` log prefix in
  `notices.js`, which `docs/refactor.md` records as a separate wrinkle.
- No plugin runner and no moves of runtime work out to plugins. Those candidates are
  listed in `docs/refactor.md` and are separate changes.
- Stale line references in older specs are historical and are not chased.

## Tests

- [x] The dependency test fails on the flat layout, before the move.
- [x] It fails on a synthetic `core → surface` import.
- [x] It passes on a synthetic allowed import.
- [x] It fails on an unmapped file in `src/` root.
- [x] It fails on a non-literal `require`.
- [x] It fails if it scanned nothing.
- [x] The full suite passes at 162 after the move, unchanged. (The suite has grown
      since; 162 is the count that held on the day of the move.)

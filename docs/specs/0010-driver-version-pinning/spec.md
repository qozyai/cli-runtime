# Driver Version Pinning

## Status

Planned and partially implemented on 2026-08-18.

**Landed.** Two declared pins (`CLI_RUNTIME_CLAUDE_VERSION`,
`CLI_RUNTIME_CODEX_VERSION`), a startup probe that classifies each driver as `ok`,
`drifted`, `unpinned`, or `unknown`, an enforcement switch
(`CLI_RUNTIME_DRIVER_VERSION_ENFORCE=warn|block`) that rejects any other value, and
installer support so an upgrade preserves the pins instead of erasing them. The bind
repair that motivated this is in the artifact parser.

**Still open.** Resident-pane verification — see *Known gap* below. Until that lands,
a pin governs newly launched sessions only, and the daemon says so at startup rather
than implying more.

## Why

Codex `0.146.0` → `0.147.0` (2026-08-08) switched the interactive TUI's `history_mode`
from `legacy` to `paginated`, renaming the rollout event carrying the user prompt.
Bind matches this turn's marker in the driver's artifact, and bind gates everything —
`if (!state.bound) return null`. So the rename did not degrade a turn, it erased it:
Codex ran the work, wrote its output files, and the runtime reported
`driver did not accept prompt before bind timeout` and discarded the result. Ten days,
every Codex turn, reported to the owner as an unexplained model error.

Claude Code drifted the same month — `2.1.221` → `2.1.226` → `2.1.231` — and broke
nothing, which is the point: nothing was watching either driver.

## Guarantees touched

**Guarantee 1 and 3 (a turn is bound to its artifact, and a bound turn is recorded).**
The parser now accepts every shape Codex has used to carry the prompt: the legacy
`event_msg`/`user_message`, the `item_completed` envelope around a `UserMessage` item,
and the `response_item` message with `role: "user"`. Marker gating is unchanged — an
entry that does not carry this turn's marker still does not bind.

Both shapes are live simultaneously in `0.147.0`: `originator=codex-tui` sessions use
the new one, `codex exec` and spawned subagent threads still emit the old one. Legacy
support is therefore current behaviour, not back-compatibility.

## Requirements

1. A driver may declare an expected version. A declared pin is verified at daemon
   start, before the session manager initializes, so a refusal happens before
   interrupted turns are finalized and panes reconciled.
2. `warn` is the default. A patch bump that breaks nothing must not take the bot off
   the air.
3. Under `block`, the assertion is `actual === expected`. Drift blocks, and so does a
   pin that could not be verified — an unreadable probe leaves exactly the uncertainty
   `block` exists to refuse. An unpinned driver asserted nothing and never blocks.
4. An unrecognised enforcement value is a configuration error (`EX_CONFIG`), not a
   silent downgrade to `warn`.
5. Rebuilding `runtime.env` preserves the pins. An upgrade that silently un-pins a
   deployment defeats the feature.

## Known gap: resident panes

The probe runs the *configured command*, which decides what a newly launched pane will
run. Driver panes are long-lived and survive daemon restarts —
`reconcileRuntimePanes` only kills panes that no live session claims. So changing a
pin and restarting reports the new version while existing sessions keep serving turns
from the binary they were launched with.

This is exactly the upgrade path the pin is meant to protect, so the gap matters. Both
providers already record their real version in the artifact the runtime is reading
anyway — `session_meta.payload.cli_version` for Codex, top-level `version` for Claude
— so the resident version is observable without a new mechanism. Closing this means
either validating the resident version from the artifact on bind, or draining
mismatched panes on restart while preserving the attached-client and active-turn
guarantees.

Until then the startup report states its own scope out loud rather than implying
coverage it does not have.

## Deployment note

Pinning the path is what actually stops drift; this spec only declares and verifies
it. Aim `CLI_RUNTIME_*_COMMAND` at version-exact paths: Claude Code's native installer
already keeps every version under `~/.local/share/claude/versions/`, and Codex needs a
version-specific npm prefix because an npm global holds one version per package.
Resolving the current global symlink is not a pin.

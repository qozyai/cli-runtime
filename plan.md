# CLI Runtime Hardening Plan

## Status

Implemented and release-gated on 2026-08-02. This plan consolidated four
independent review passes and direct verification against real Claude and Codex
artifacts; every phase below is now reflected in the implementation and tests.

The core design remains:

- run the real interactive CLI in a real tmux pane
- let a human attach to that same pane
- use vendor JSONL artifacts as the turn completion authority
- use terminal content only for pre-submission readiness, authentication, and
  bounded recovery
- keep the runtime usable independently and as a QozyAI execution provider

Direct OpenAI navigation is disabled by default and must be enabled explicitly.
Transcription remains an independent optional capability using
`POST /v1/audio/transcriptions` with `gpt-4o-transcribe`.

## Design Decisions

- One daemon is the sole writer for a runtime state directory.
- Telegram is an API adapter, not a second runtime owner.
- Completion and driver errors come from vendor artifacts, not pane text.
- Process health comes from tmux/process metadata, not text painted in a pane.
- Normalized continuity remains under `<workspace>/.qozyai` so it is portable
  across drivers and future execution hosts.
- Runtime events, submissions, and prompt artifacts are bounded operational
  state under the daemon state directory.
- Every submission owns its own inbox and outbox directories.
- Unknown or malformed durable records are preserved, never inferred to be
  garbage.
- Tool arguments are not written to normalized durable history or events.
- Redaction is defense-in-depth, not a guarantee that stored artifacts are
  non-sensitive.
- API-assisted navigation is explicit opt-in and never part of the healthy
  submission path.
- Tmux capture and vendor artifact polling are retained; measurements show they
  are not current performance bottlenecks.

## Confirmed Release Blockers

- Starting `daemon` and `telegram` creates two runtimes with independent locks
  and event counters over shared files.
- The second runtime can unlink the first runtime's live Unix socket.
- Mid-turn terminal text can forge authentication and process-exit outcomes.
- Claude API-error endings using `stop_sequence` are not terminal to the parser.
- Telegram control commands queue behind the turn they need to inspect or stop.
- Telegram updates can be acknowledged upstream before queued work is durable.
- Output discovery can miss same-size, same-mtime rewrites without reporting an
  error.
- One stale invalid outbox entry can poison later output collection.
- Invalid history timestamps can cause irreplaceable records to be pruned.
- `/stop` during input staging reports success but does not stop execution.
- `events.jsonl` grows forever and every read fully parses it on Node's main
  thread.
- OpenAI request timeouts stop after headers rather than after body consumption.
- The navigator can send an unredacted pane and session key to an external API.
- Auth command failures can be misclassified as unauthenticated.
- Codex tool-result classification does not match observed vendor output.
- Incremental artifact reads can corrupt split multibyte UTF-8 characters.
- Telegram output delivery has no per-file channel limit or acknowledgement.
- Known output and transcription failures are computed but not surfaced.

## Available Development Tooling

Live verification for this plan ran against a disposable development VM carrying
authenticated Claude and Codex driver profiles, a dedicated Telegram bot, a
shared browser session authenticated to Telegram Web, and two runtime API
sockets — one authenticated, one deliberately unauthenticated.

That fixture's address, filesystem layout, bot identity, tmux session names, and
credential-snapshot locations are internal and are deliberately not recorded in
this repository. They live in `docs/dev-fixtures.md`, which is local-only and
excluded from version control.

Credential snapshots hold real driver credentials. They must never be committed,
printed, copied into fixtures, or included in test output, and they must be
restored into a fresh disposable profile rather than over a known-good one.
Tests may verify only that secrets are configured, never their values.

### Test Capabilities Enabled By This Fixture

- authenticated Claude and Codex live turns without reauthorization
- clean unauthenticated flows for both drivers
- corrupt and stale credential behavior
- credential restoration after destructive tests
- real Telegram ordering, interruption, restart, and file-delivery behavior
- real audio ingress and OpenAI transcription
- tmux attach and human takeover during active work
- process death, stale socket, and daemon restart injection
- artifact replay against genuine provider sessions
- comparison of API, durable state, vendor JSONL, and visible TUI state

## Phase 0: Freeze And Regression Corpus

1. Do not add features while hardening is active.
2. Preserve the current uncommitted OpenAI work separately before structural
   edits begin.
3. Turn every confirmed data-loss and false-outcome probe into a regression
   test.
4. Create curated, sanitized Claude and Codex artifact fixtures from observed
   real formats.
5. Record the current healthy E2E behavior for both drivers, tmux attachment,
   authentication, file delivery, and Telegram progress updates.

## Phase 1: Artifact Completion Oracle

1. Extract a deterministic incremental parser:

   ```js
   const parser = createArtifactParser({ driver, marker });
   const progress = parser.feed(entry);
   const result = replayArtifact({ driver, marker, entries });
   ```

2. Keep `watchArtifacts()` as thin I/O that discovers files, reads complete
   JSONL records, feeds the parser, and reports byte offsets.
3. Add Claude terminal handling for corpus-confirmed normal completion, API
   errors, `stop_sequence`, token exhaustion, interruption, and malformed
   terminal records.
4. Add Codex terminal and tool-result handling from structured vendor fields
   where available. Text fallback must match exact wrapper formats rather than
   generic mentions of exit codes.
5. Keep incomplete artifact data as bytes. Split at newline bytes and decode
   only complete JSONL records.
6. Persist artifact path and start/end offsets on failed submissions. Do not
   automatically duplicate sensitive raw traces.
7. Provide an explicit replay command for operator diagnosis and fixture
   generation.

## Phase 2: Unforgeable Terminal Health And Submission Binding

1. Remove `isAuthRequired()` and text-based exit detection from mid-turn
   monitoring.
2. Check only tmux session, pane, and driver-process liveness during a bound
   turn.
3. If the driver process dies, perform a final artifact drain before reporting
   process failure so a terminal artifact wins races with process exit.
4. Restrict pane parsing to startup, empty-input readiness, explicit auth, and
   recovery before a turn is bound.
5. Submit the prompt once and continue watching for its marker.
6. Use one configurable bind deadline. Retry submission only when deterministic
   UI state or navigator output proves the prompt remains unsubmitted.
7. Keep the bind deadline distinct from the overall turn timeout. A post-bind
   API error is handled by the parser, not by the bind timeout.

## Phase 3: Single Writer And Explicit Session Lifecycle

1. Make `daemon` the sole owner of sessions, tmux, submissions, workspace
   mutation, and event sequencing.
2. Make `telegram` connect to the daemon's Unix API without constructing a
   second runtime.
3. Probe the Unix socket before cleanup. Refuse a live second daemon and remove
   a socket only after proving it stale.
4. Enforce exclusive ownership of the state directory even if a custom socket
   path is configured.
5. Replace independent `reserved`, `active`, `activeSubmissionId`, and loosely
   related status values with one lifecycle:

   ```text
   starting -> ready -> preparing -> submitting -> running
                         |             |           |
                         +-------> interrupting ---+

   auth_required | attention_required | stopped | closed
   ```

6. Store the submission ID and abort controller in one active-work object from
   the beginning of preparation.
7. Define one `sessionState()`/`isBusy()` implementation used by submit, get,
   interrupt, restart, close, and recovery.
8. Assert legal lifecycle invariants after every state mutation.
9. Make interruption during staging cancel staging and prevent driver launch.
10. Return a user-interrupted session to `ready`; reserve
    `attention_required` for genuine faults.

## Phase 4: Durable Telegram Ingress And Control Lane

1. Persist each accepted Telegram update before advancing the upstream offset.
2. Replay unfinished updates after adapter restart using Telegram message IDs as
   idempotency keys.
3. Keep ordinary messages serialized per chat/topic.
4. Route `/stop` and `/status` through an immediate control lane rather than the
   normal message chain.
5. Implement `/reset` as interrupt, terminal acknowledgement, close, and clean
   session creation rather than queueing it behind active work.
6. Do not execute the real driver auth-status command for every message.
7. Represent auth status as `authenticated`, `unauthenticated`, or `unknown`.
   Command crashes and timeouts produce `unknown`, never `unauthenticated`.
8. Cache successful status checks and let driver artifacts transition an active
   session to `auth_required`.
9. Make auth start idempotent. Reuse an active login session unless restart is
   explicitly requested.

## Phase 5: Per-Submission File Ownership

Use this layout:

```text
.qozyai/io/inbox/<submissionId>/
.qozyai/io/outbox/<submissionId>/
.qozyai/io/history/inbox/<submissionId>/
.qozyai/io/history/outbox/<submissionId>/
```

1. Create the turn directories before prompt submission and inject their exact
   paths into the prompt.
2. Remove session-hash output prefixes, output baselines, mtime signatures,
   snapshot comparisons, and prefix instructions.
3. At terminal completion, validate and atomically seal or move that turn's
   output directory into output history.
4. Return valid direct files even when another entry is invalid, and surface the
   invalid-entry error.
5. Ensure an invalid entry affects only its own submission.
6. Track delivery per output with a stable output ID.
7. Acknowledge files individually. A failed or oversized Telegram upload must
   not strand successfully delivered siblings.
8. Enforce the Telegram document limit before reading the file into memory and
   report undeliverable files to the user.

## Phase 6: Lossless History And Bounded Operational State

1. Separate JSONL reading from JSONL repair. Read functions never modify files.
2. Run trailing-partial-line recovery explicitly under the workspace lock.
3. Preserve unknown versions, invalid timestamps, and malformed records.
4. Abort pruning and emit a visible diagnostic when safe retention cannot be
   determined.
5. Keep normalized history under `.qozyai/history` and run Git-exclude setup
   once per workspace.
6. Retain the requested 48-active-hour continuity semantics, document exactly
   how work clusters count time, and never delete unclassified records.
7. Replace full event-file reads with a bounded in-memory replay ring backed by
   a compact durable window.
8. Preserve monotonic event sequence numbers across restart and compaction.
9. Return an explicit cursor-expired response for callers older than the
   retained event window.
10. Use fixed limits rather than adding event-retention environment variables.
11. Prune terminal submission JSON, prompt files, abandoned active snapshots,
    and I/O archives according to bounded retention.

## Phase 7: Progress, Errors, And Sensitive Data

1. Persist submission acceptance and terminal state rather than rewriting the
   complete submission JSON on every progress tick.
2. Keep active progress in memory and in one durable active-turn snapshot for
   diagnostics and restart handling.
3. Standardize one tool-call shape:

   ```js
   { id, tool, success, error }
   ```

4. Remove tool arguments from normalized durable history and event records.
5. Keep bounded redaction as defense-in-depth and document normalized history
   and raw provider artifacts as sensitive.
6. Surface output validation, transcription, workspace-state, cursor-expiry,
   ineffective-interrupt, auth-status, and navigation failures.
7. Suppress only errors from genuinely best-effort cleanup paths.

## Phase 8: Optional OpenAI Capabilities

1. Keep transcription and navigation independently configurable. Setting an
   OpenAI key for transcription must not silently enable terminal navigation.
2. Keep transcription on `/v1/audio/transcriptions` using
   `gpt-4o-transcribe` by default.
3. Preserve the original audio file even when transcription succeeds.
4. If transcription fails, continue with the original audio but tell the user
   that transcription failed.
5. Keep the abort signal active through request upload, response headers, and
   complete body parsing.
6. Make external navigator egress explicit opt-in.
7. Remove `sessionKey` from navigator payloads, minimize the pane excerpt, apply
   bounded redaction, and document that terminal content is sent to the chosen
   intelligence provider.
8. Keep the navigator out of healthy turns. It acts only on unknown
   startup/auth/recovery states and remains constrained to the strict action
   schema.

## Phase 9: Deletion And Documentation

1. Delete obsolete output snapshot/signature/prefix machinery.
2. Collapse lock-wrapper methods that only unpack and repack one options object.
3. Remove duplicate progress and tool-call mapping shapes.
4. Convert unused size, count, formatting, and polling environment settings to
   named constants.
5. Retain configuration only for deployment paths, driver commands/homes/models,
   credentials, Telegram routing, startup timeout, submission timeout, and bind
   timeout.
6. Split progress normalization, workspace I/O, artifact parsing, and history
   only where deletion leaves clear ownership boundaries.
7. Update current-behavior documentation after implementation.
8. Move the interpreted observer design into an explicit roadmap rather than a
   V1 behavior contract.
9. Describe the runtime as driver-neutral, not provider-independent.
10. Do not target an arbitrary source-line count; measure success by removed
    states, removed guesses, and impossible data-loss paths.

## Required Tests

- [x] second daemon rejection without disrupting the live daemon
- [x] unique event sequences across restart and compaction
- [x] event replay, cursor expiry, and no full-log read path
- [x] forged auth and exit strings in user prompts and model replies
- [x] Claude real normal, API-error, `stop_sequence`, and token-limit artifacts
- [x] Codex real completion, abort, error, and command-result artifacts
- [x] UTF-8 characters split across artifact poll boundaries
- [x] delayed marker binding beyond the old 4.5-second window
- [x] no repeated Enter without proof that the prompt is unsubmitted
- [x] process death with a final artifact written immediately before exit
- [x] retained dead pane detected structurally and restarted with provider resume
- [x] `/stop` during file staging and during driver execution
- [x] `/status` while a turn is active
- [x] Telegram restart after updates are durably queued but before handling
- [x] transient auth-status command failure during an active login
- [x] same-size, same-mtime output rewrite
- [x] stale and invalid output entries isolated to one submission
- [x] malformed and unknown-version history preserved through pruning
- [x] individual output acknowledgement and Telegram oversize handling
- [x] OpenAI slow headers, slow body, timeout, and abort behavior
- [x] navigator payload minimization and explicit enablement
- [x] transcription failure visibly reported while original audio proceeds
- [x] real Claude and Codex tmux attachment and human takeover

## Implementation Evidence

- The local and disposable-VM suites each pass all 64 tests.
- Sanitized replay fixtures cover Claude normal, API-error, token-limit and
  `stop_sequence` records, plus Codex completion, abort, error, and command
  results.
- The live duplicate-daemon and duplicate-Telegram-adapter probes are rejected
  while their original processes remain healthy.
- Authenticated Claude and Codex both complete, resume, attach, accept direct
  human input in their panes, and continue through the API afterward.
- Live dead-pane probes stop reporting a resident driver, restart the pane, and
  preserve each provider session across the restart.
- Live driver panes do not inherit runtime OpenAI, Telegram, or navigator
  credentials.
- Separate unauthenticated profiles classify both drivers as unauthenticated
  without disturbing the authenticated profiles.
- Real Telegram ingress passes text, immediate `/status` and `/stop`, `/reset`,
  per-file delivery acknowledgement, OGG ingress, `gpt-4o-transcribe`, visible
  progress editing, and post-adapter-restart continuation.
- Event sequencing remains monotonic across daemon restart and compaction.
- The deployed disposable runtime uses this exact working tree.

## Release Gate

The release is acceptable only when all confirmed data-loss probes are
regression tests, artifact replay handles the real Claude and Codex corpus,
terminal text cannot forge turn outcomes, Telegram control remains responsive
during active work, restarts do not lose accepted messages, operational state is
bounded, and both drivers pass live tmux E2E with attach, interrupt, files,
recovery, and authentication.

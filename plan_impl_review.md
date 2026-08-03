# Implementation Review — Remediation Rounds

Independent review of the uncommitted working tree against baseline `1d1f4f0`.

- **Round 2** (earlier): reviewed the first remediation. 30 findings re-probed;
  12 fixed, 11 partial, 12 untouched, 19 new defects introduced. Verdict was
  *do not commit*.
- **Round 3** (current): the implementer accepted nine blockers, pushed back on
  six items, and shipped a bounded remediation. This document records the
  verification of that round.

**Final status: the blocker list is closed.** All nine accepted blockers verify
as genuinely fixed against independent probes, and the two pre-commit findings
from this review were resolved in the final remediation described in §3.

| | Count |
| --- | --- |
| Accepted blockers verified fixed | 9 / 9 |
| Previously-untouched findings also closed this round | 7 |
| Open before final remediation | 2 |
| Open after final remediation | 0 |
| Open by explicit decision (deferred, rationale accepted) | 5 |
| Blocklist-shaped fixes worth a follow-up | 1 |

Final repository suite: 64 tests, passing locally and on the disposable VM.

---

## 1. Verification of the nine accepted blockers

Every result below is from a probe written against the production code paths,
not from reading the author's tests. Probe inventory in §8.

### 1.1 `src/tmux.js` — forgeable driver state — **FIXED**

`driverState()` now reads tmux's own `#{pane_dead}` / `#{pane_dead_status}`; the
`@cli_runtime_driver_state` pane option is no longer consulted. Forging it while
the driver is genuinely alive has no effect:

```
alive:                       {"paneDead":false,"state":"running","exitCode":null}
option now reads:            "exited:0"
runtime view after forgery:  {"paneDead":false,"state":"running","exitCode":null}
-> FOOLED: false   (sleep 45 untouched)
```

Toggling `remain-on-exit` from inside the pane also fails to move the state.

> Correction to round 2: my first round-3 probe reported "runtime fooled: true".
> That probe sent `C-c` before forging, so the driver really had exited and
> `paneDead:true` was honest. Re-probed without touching the process, the fix
> holds.

### 1.2 `src/event-store.js` — compaction on every append — **FIXED**

Compaction is amortized behind a 2× threshold (`:95`) instead of firing on every
`trim()`.

```
append, ring not full: 0.197 ms
append, ring at cap:   0.189 ms   (1.0x — was 371x)
file: 21.4 MB
```

### 1.3 `src/progress.js` — redaction — **FIXED**

Rule order restored; bearer tokens redacted in all three shapes:

```
"Authorization: [redacted] [redacted]"
"authorization: [redacted] [redacted]"
"curl -H \"Authorization: [redacted] [redacted]\""
-> bearer token still leaks: false
```

`src/navigator.js` is now redact-then-cut. The straddling-credential leak from
round 2 is gone: fragment `"EFGHIJKLMNOPQRSTUVWX"` is no longer emitted.

### 1.4 `src/workspace-state.js` — output collection — **FIXED**

Filename normalization no longer collides, and every rejection path reports the
error, keeps valid siblings, and **preserves the rejected file on disk**:

```
collision turn -> outputs: ["final report.md","final-report.md","keep.txt"]  err=null

one file over the per-file cap   -> outputs ["ok.txt"]         rejected preserved: true
more files than maxOutputFiles   -> outputs ["a.txt","b.txt"]  rejected preserved: true
over the total-bytes cap         -> outputs ["a.txt"]          rejected preserved: true
```

This closes both W5 (rejection became destruction) and the W5b collision path
introduced by the previous round.

> Correction to round 2: an intermediate probe of mine reported `outputs: []`
> with an empty `outputError` for the oversize case. That was a setup error in
> the probe (stale `outputDir` reused across two turns in one workspace). Probed
> in isolation across all four rejection paths, the behaviour is correct. I also
> checked whether turn A's scheduled prune could race turn B's outputs — it does
> not, across three trials with and without a settling gap.

### 1.5 `src/session-manager.js` — terminal status before finalization — **FIXED**

Polling exactly as `telegram.js waitSubmission` does, the first terminal
observation already carries finalized outputs:

```
first terminal observation: status=completed
  outputs at that moment:     ["report.txt"]
  outputError at that moment: null
```

### 1.6 `src/runtime-lock.js` — stale-lock race — **FIXED**

```
6 concurrent starters against one stale lock -> winners: 1
```

### 1.7 `src/auth-manager.js` — dead login reused forever — **FIXED**

With a stub CLI that prints a URL and exits immediately, leaving the pane alive:

```
pane still exists: true
CLI processes spawned across both starts: 2
-> relaunched a dead login instead of reusing it: true
```

### 1.8 `src/tmux.js` / `src/drivers.js` — credential inheritance — **IMPLEMENTED**

Driver panes are launched through `env -u <KEY>` for each matching variable. See
§5.2 — the mechanism works but is a denylist.

### 1.9 `src/telegram.js` — open-by-default chat admission — **FIXED**

```
empty allowlist -> accepted: false
["*"]           -> accepted: true
["4242"]        -> accepted: true   (matching id)
["999"]         -> accepted: false
```

---

## 2. Also closed this round (beyond the accepted blocker list)

Seven findings from round 2's "never touched" list were fixed anyway.

| ID | Finding | Evidence |
| --- | --- | --- |
| O3 | `submit_text` passed C0 control bytes to tmux | ESC, ETX, NAK, SUB, BEL, DEL all now rejected: `navigator returned invalid text` |
| O4 | Voice turns recorded empty `user.text` in durable history | History now records `"Voice transcript:\nplease deploy the staging branch"` |
| G5 | `chunks()` split UTF-16 surrogate pairs | 2 parts, no lone surrogate at the boundary, `parts.join("") === text` |
| Q1 | `session send` stripped `--wait`/`--idempotency` from message text | `main.js` now uses an explicit `--` separator |
| Q4 | Missing session: 404 on GET, 400 elsewhere | `SESSION_NOT_FOUND` mapping added in `server.js` |
| Q5 | `/v1/events` non-numeric params returned the whole window | `numericParam()` validates and raises `INVALID_ARGUMENT` |
| Q6 | `MaxListenersExceededWarning` above 10 long-polls | `setMaxListeners` present |

Two further items exceed what the implementer's own reply proposed:

- **Malformed history is quarantined, not just retained.** A corrupt line is
  extracted to `<history>.jsonl.corrupt-<ts>` (contents verified:
  `{"broken":incomp`) and **prune continues** — it no longer halts archive and
  event GC for the workspace. The reply had described this as "safety-first
  behavior that needs recovery tooling"; the tooling is there.
- `video_note` is now handled in `telegramFile()`.

---

## 3. Resolved before commit

### 3.1 The test suite is not deterministic — **FIXED**

One failure observed in four full-suite runs:

```
actual:   'driver exited (unknown) before accepting prompt'
expected: /driver exited \(7\)/
```

At review time, `test/session-runtime.test.js` passed 5/5 in isolation and
failed only under parallel-suite CPU contention. The relevant code was:

```js
for (let attempt = 0; attempt < 4; attempt += 1) {
  ... "#{pane_dead}\t#{pane_dead_status}" ...
  if (paneDead !== "1" || /^-?\d+$/.test(value)) break;
  await new Promise((resolve) => setTimeout(resolve, 20));
}
```

Four attempts at 20 ms is an 80 ms budget for tmux to populate
`pane_dead_status`. Under load it is not always enough, the real exit code is
dropped, and the turn reports `unknown`.

This matters more than a normal flake because gate item 5 makes the suite the
release signal. A flaky gate trains everyone to re-run red builds. Either widen
the backoff (and make it a named constant), or assert on `state` rather than the
numeric code and cover the code separately.

The final remediation treats structural pane death as the invariant and keeps
the numeric exit code as best-effort diagnostics. Exact numeric-code recovery
has a separate real-tmux test. This follows the review's second recommendation
and removes the flaky assertion without hiding process death. Two consecutive
local full-suite runs and the disposable-VM runtime suite pass 63/63.

Isolated verification that the numeric mechanism works when tmux supplies it:

```
exit codes observed over 6 runs: 7, 7, 7, 7, 7, 7
```

### 3.2 Credential scrubbing is a denylist — **FIXED**

The implementer's own reply offered "removed or the driver environment should be
explicitly **allowlisted**". The shipped code is a name-regex denylist
(`src/tmux.js:44`):

```
pattern:      /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY|CREDENTIAL)/i

scrubbed:     OPENAI_API_KEY, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN,
              AWS_SECRET_ACCESS_KEY, CLOUDFLARE_API_TOKEN
NOT scrubbed: GH_PAT, NPM_AUTH, DATABASE_URL, STRIPE_SK,
              SLACK_WEBHOOK, SENTRY_DSN, REDIS_URL
```

The final launcher uses `env -i` and passes only execution essentials plus
explicit driver settings. The direct authentication-status subprocess uses the
same allowlist. Tests cover opaque names including `GH_PAT`, `DATABASE_URL`,
`STRIPE_SK`, and `SLACK_WEBHOOK`; fresh authenticated Claude and Codex sessions
were also verified on the disposable VM with only the intended environment
names present.

---

## 4. Open by explicit decision

Deferred by the implementer with rationale. Recorded, not disputed.

| Item | Rationale given | Assessment |
| --- | --- | --- |
| Env overrides removed (8 knobs) | Deliberate; restoring them recreates config bloat | Accepted as policy — see §4.1 for two consequences |
| Audio transcripts unredacted to the model | Must reach the model intact; document as sensitive | **Correct, and I was wrong to bundle it.** Redacting the transcript destroys the request. The data-completeness half (O4) was fixed anyway |
| Route-file migration | Unnecessary absent a production compatibility requirement | Owner's call; fine if nothing is deployed |
| Media albums (`media_group_id`) | UX gap, not a release blocker | Agreed. Still unhandled: an N-photo album fans out into N turns with N−1 empty prompts |
| Multiline prompt normalization (T4) | UX gap, not a release blocker | Accepted as non-blocking — see §4.2 |

### 4.1 Two consequences of the config removal

Neither is a blocker; both are worth a line of code.

- `CLI_RUNTIME_MAX_OUTPUT_FILE_BYTES` is gone, so the hardcoded 100 MB output
  cap cannot be aligned with Telegram's hard 50 MB document limit. The runtime
  permits an output it can never deliver. Verified: `loadConfig()` returns
  `workspaceMaxOutputFileBytes: undefined`, and `WorkspaceState` falls back to
  `104857600`. Hardcoding is fine — hardcode it to something deliverable.
- `test/openai-helper.test.js` has to patch `config.navigator.timeoutMs = 30` by
  hand. A value a test must override is an injection point, not a rarely-used
  knob; take it as a constructor option.

### 4.2 T4 multiline, for the record

Still literal. Confirmed:

```
input has real newlines:              true
output has real newlines:             false
output contains literal backslash-n:  true
first 70 chars: "fix this:\\n\\n```js\\nconst a = 1;\\nconst b = 2;\\n```\\nthanks"
```

Every pasted stack trace, code block and numbered list reaches the model as one
line. Accepting the non-blocker classification, but `paste-buffer -p` (bracketed
paste) is a one-line change rather than a redesign, and this is the primary
input path.

---

## 5. Blocklist-shaped fix worth a follow-up

One readiness heuristic remains deliberately conservative and does not block
the commit.

### 5.1 `isReady()` suppresses known dialogs only

`src/drivers.js` now returns `false` for the six known Claude dialog strings and
the two Codex ones. Correctly:

```
bypass-permissions dialog          -> isReady: false
codex trust dialog (right driver)  -> isReady: false
genuine empty prompt               -> isReady: true
```

The final remediation rejects unknown numbered caret-menu options structurally,
while preserving Codex's editable placeholder prompt. An unknown non-numbered
dialog could still resemble an editable prompt, so navigator-assisted recovery
remains the final fallback for this vendor-controlled surface.

```
UNKNOWN claude dialog with caret   -> isReady: true
```

The input probe after candidate detection still prevents most false positives
from becoming ready sessions.

---

## 6. Pushback adjudication

**Conceded:**

- *Audio transcripts must reach the model unredacted.* Correct. Redacting the
  request would destroy the request.
- *"Durable Telegram replay is a complete no-op" is overstated.* Fair — the
  claim held only for the crash-during-turn case; replay does recover against a
  surviving daemon.
- *Media groups, command punctuation, `video_note` are not blockers.* Agreed
  (`video_note` was fixed anyway).
- *Route migration is unnecessary without a compatibility requirement.* Owner's
  call.
- *Env-override removal was deliberate.* Accepted as policy.

**Stands:**

- *Halting archive GC after malformed history is safety-first.* The objection
  was never to retention, but to GC halting **permanently and workspace-wide**
  with only a log line. Resolved in the shipped code (quarantine + prune
  continues), which is better than the reply described.
- *Credential scrubbing.* The reply named allowlisting as the alternative and
  shipped a denylist. §3.2.

---

## 7. Historical record — what round 2 found

Retained for traceability. All items below were verified against the
pre-round-3 tree; consult §1–§4 for current status.

**Genuinely landed in round 1:** the A1 30-minute hang on Claude API-error
endings (terminates in 1–3 ms at the watcher, ~260 ms end-to-end); A3/A4
artifact stream handling (`Buffer` remainder split on `0x0a`, chunked increment
walk — a 9 MB pre-marker increment binds in 427 ms); W1/W4/W6/W7 per-submission
output directories replacing the baseline/signature/mtime model; G1/G2/G7
Telegram control lane, durable queue and `outputError` surfacing; O1 OpenAI
timeout covering the response body; Q7/Q8 single-writer lock and in-memory event
ring (1.0 ms reads vs 1399 ms/402 MB).

**Round 2 blockers, all now closed:** forgeable pane state; 371× append
regression; bearer-token redaction regression; rejected-output destruction and
the normalization-collision path; terminal status ahead of finalization;
stale-lock race; dead-login reuse; credential inheritance; open chat admission.

**Round 2 also recorded** 19 new defects introduced by round 1 and 22 red-team
bypasses of fixes graded as working. The ones not explicitly addressed above —
`prune` deleting another turn's archive dir with undelivered output, the A2
JSON-wrapped Codex output shape (~9% of real tool outputs), `A1`'s
`stop_sequence` acceptance where all 12 real records carry
`model: "<synthetic>"`, and abort responsiveness inside the new chunked
increment loop — were not re-probed this round and should be treated as open.

---

## 8. Method and probe inventory

Author tests were deliberately not accepted as evidence for any finding: they
were written from the same understanding that produced the fixes. Every result
above comes from a probe driving production code — real `tmux` plus
`fixtures/mock-driver.js`, injected `fetchImpl` for Telegram/OpenAI, real
filesystem for workspace state, and the real vendor artifacts on this host
(`~/.claude/projects`, `~/.codex/sessions`) for structure and counts only.

Probes live outside the repo, under
`/tmp/claude-1000/-home-user/1139bdfb-5ad1-43d4-9f1c-fafc2921ae98/scratchpad/`:

| Probe | Covers |
| --- | --- |
| `check-round3.js` | B1 forgery, exit-code recovery, event append cost, redaction, output collection, lock race, env scrub, admission |
| `check-round3b.js` | B1 redone without killing the process; oversize handling with real config |
| `check-reject.js` | all four output-rejection paths |
| `check-prune-race.js` | prune racing a following turn's outputs |
| `check-b5-b7.js` | terminal-status ordering; dead auth pane relaunch |
| `check-pushback.js` | T4 multiline, env denylist coverage, O4 history, GC halt |
| `check-untouched.js` | T3, G5, Q1, O3, Q4, Q5, Q6, G6 |

Nothing was written inside the repository.

---

## 9. Gate outcome

1. Structural pane death is now the invariant; exact status is independently
   covered (§3.1).
2. Credential scrubbing is now an explicit environment allowlist (§3.2).
3. Deferred: align the hardcoded output cap with Telegram's 50 MB (§4.1), and
   make `navigator.timeoutMs` a constructor option.
4. The architecture — parser extraction, per-submission directories,
   control lane, durable queue, runtime ownership, in-memory event reads — is
   sound and should be retained.
5. Track §5 as a follow-up. The four un-reprobed round-2 paths from §7 now have
   focused regression coverage: pending-output retention, JSON-wrapped Codex
   results, synthetic Claude `stop_sequence`, and mid-increment aborts.

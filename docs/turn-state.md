# Turn State And File Exchange

The runtime keeps portable, driver-neutral continuity under the workspace:

```text
.qozyai/
  history/
    <session-hash>.jsonl
    active/<submission-id>.json
  io/
    inbox/<submission-id>/
    outbox/<submission-id>/
    history/
      inbox/<submission-id>/
      outbox/<submission-id>/
      events.jsonl
```

The runtime adds `.qozyai/` to the repository-local Git exclude once per
workspace. These files are private runtime state, not project source.

## Submission Lifecycle

The daemon creates the submission's directories before it submits the prompt.
Caller inputs are copied transactionally into the exact inbox and its history
archive. The prompt names the exact outbox directory. No model-generated hash
prefix, baseline snapshot, mtime comparison, or filename signature is involved.

The exact assembled prompt is also retained under the daemon's private state
directory. Single-line prompts up to 32 KiB are bracket-pasted directly after
an editable-composer probe. Multiline, NUL-containing, and larger prompts are
left in that mode-`0600` file; the terminal receives only a short instruction
to read the entire file. This avoids terminal paste ambiguity without adding
runtime files to the user's workspace.

While work is active, `history/active/<submission-id>.json` contains the latest
artifact cursor, provider session ID, three bounded reasoning chunks, three tool
records shaped as `{id, tool, success, error}`, and a 500-character summary.
Tool arguments and successful tool output are excluded.

At terminal completion, the whole submission outbox is atomically moved into
history before it is inspected. Valid direct files are returned with stable
output IDs and their exact names. Invalid, oversized, and excess entries are
reported and preserved in that archive rather than deleted. Delivery
acknowledgement is per output; pending archives are retained even if their turn
would otherwise age out.

## History

Each terminal turn is appended once to the session JSONL. JSONL reads never
mutate files. A torn final line is repaired explicitly under the workspace lock
and copied to a quarantine file first. Unknown versions, invalid timestamps,
and malformed lines are never inferred to be garbage. Malformed lines are
copied verbatim to a mode-0600 quarantine file before the parseable JSONL is
rewritten, so one damaged line cannot disable all later workspace cleanup.

Voice transcripts are included in the normalized user turn so later sessions
do not lose the substance of audio-only messages. Raw provider artifacts,
transcripts, and normalized history remain sensitive workspace data even though
known credential forms are redacted as defense in depth.

When transcription succeeds, Telegram sends the raw automated transcript as a
separate message. The driver receives both the original audio and transcript,
is warned that recognition may be imperfect, and is instructed to begin its
answer with a concise `Here is how I understood your prompt:` interpretation.

Retention uses active work rather than wall-clock gaps:

- a gap of at least six hours starts another work cluster
- newest complete clusters are retained until their accumulated durations reach
  at least 48 hours
- gaps between clusters do not consume the 48-hour budget
- unclassifiable records are retained

Runtime events, submissions, prompts, active snapshots, and I/O archives are
separately bounded operational state. Event cursors older than the retained
window receive an explicit cursor-expired response.

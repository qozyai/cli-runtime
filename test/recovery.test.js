"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/core/event-store");
const { SessionManager } = require("../src/core/session-manager");
const { safeId, writeAtomic } = require("../src/core/util");

test("runtime restart terminally records an orphaned active submission", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const sessionKey = "restart/main";
  const submissionId = "sub_orphaned";
  await writeAtomic(path.join(stateDir, "sessions", safeId(sessionKey, 32), "session.json"), {
    version: 1,
    sessionKey,
    driver: "claude",
    workspace: root,
    tmuxSessionName: "not-running",
    status: "running",
    activeSubmissionId: submissionId,
    lastSubmissionId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await writeAtomic(path.join(stateDir, "submissions", `${safeId(submissionId, 40)}.json`), {
    version: 1,
    submissionId,
    sessionKey,
    status: "running",
    acceptedAt: new Date().toISOString(),
  });
  const eventStore = new EventStore(stateDir);
  await eventStore.init();
  const sessions = new SessionManager({ config: { stateDir }, tmux: {}, eventStore });
  await sessions.init();

  const session = await sessions.get(sessionKey, { refresh: false });
  const submission = await sessions.getSubmission(submissionId);
  assert.equal(session.status, "attention_required");
  assert.equal(session.activeSubmissionId, null);
  assert.equal(submission.status, "failed");
  assert.match(submission.error, /runtime restarted/);
});

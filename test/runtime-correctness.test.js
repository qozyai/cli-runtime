"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/event-store");
const { SessionManager } = require("../src/session-manager");
const { WorkspaceState } = require("../src/workspace-state");

async function managerFixture(t, tmuxOverrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-correctness-"));
  const stateDir = path.join(root, "state");
  const events = new EventStore(stateDir);
  await events.init();
  const tmux = {
    listSessions: async () => [],
    has: async () => false,
    hasAttachedClients: async () => false,
    kill: async () => {},
    ...tmuxOverrides,
  };
  const manager = new SessionManager({ config: { stateDir }, tmux, eventStore: events });
  await manager.init();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, manager, events, tmux };
}

test("workspace state never recreates a renamed-away workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-missing-workspace-"));
  const workspace = path.join(root, "project");
  const moved = path.join(root, "project-moved");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(workspace);
  const state = new WorkspaceState({ config: {} });
  await state.ensure(workspace);
  await fs.rename(workspace, moved);
  await assert.rejects(() => state.ensure(workspace), (error) => error.code === "WORKSPACE_MISSING");
  await assert.rejects(() => fs.access(workspace));
  await fs.rename(moved, workspace);
  await fs.access(path.join(workspace, ".qozyai"));
  await fs.rm(path.join(workspace, ".qozyai"), { recursive: true });
  await state.prune(workspace);
  await assert.rejects(() => fs.access(path.join(workspace, ".qozyai")));
});

test("create serializes one identity, rejects retargeting before mutation, and uses incarnations", async (t) => {
  let launches = 0;
  const { root, manager } = await managerFixture(t);
  const firstWorkspace = path.join(root, "first");
  const otherWorkspace = path.join(root, "other");
  await fs.mkdir(firstWorkspace);
  await fs.mkdir(otherWorkspace);
  manager.launch = async (session) => {
    launches += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.status = "ready";
    await manager.persistSession(session);
    return manager.get(session.sessionKey, { refresh: false });
  };
  const [first, same] = await Promise.all([
    manager.create({ sessionKey: "route", driver: "claude", workspace: firstWorkspace }),
    manager.create({ sessionKey: "route", driver: "claude", workspace: firstWorkspace }),
  ]);
  assert.equal(launches, 1);
  assert.equal(first.workspace, await fs.realpath(firstWorkspace));
  assert.equal(same.workspace, first.workspace);
  const firstTmuxName = manager.rawSession("route").tmuxSessionName;
  assert.match(firstTmuxName, /^cli-[a-f0-9]{16}-[a-f0-9]{8}$/);
  await assert.rejects(
    () => manager.create({ sessionKey: "route", driver: "codex", workspace: otherWorkspace }),
    (error) => error.code === "SESSION_IDENTITY_MISMATCH",
  );
  await assert.rejects(() => fs.access(path.join(otherWorkspace, ".qozyai")));
  await manager.close("route");
  const successor = await manager.create({ sessionKey: "route", driver: "claude", workspace: firstWorkspace });
  assert.notEqual(manager.rawSession("route").tmuxSessionName, firstTmuxName);
  assert.equal(successor.status, "ready");
});

test("release preserves provider identity and pane-killing operations refuse attached clients", async (t) => {
  let attached = false;
  let kills = 0;
  const { root, manager } = await managerFixture(t, {
    has: async () => true,
    hasAttachedClients: async () => attached,
    kill: async () => { kills += 1; },
  });
  const workspace = path.join(root, "project");
  await fs.mkdir(workspace);
  const now = new Date().toISOString();
  manager.sessions.set("route", {
    version: 1,
    sessionKey: "route",
    driver: "claude",
    workspace,
    incarnationId: "incarnation",
    tmuxSessionName: "cli-route-incarnation",
    status: "ready",
    providerSessionId: "provider-one",
    startMode: "resume",
    activeSubmissionId: null,
    lastSubmissionId: "sub-one",
    lastError: null,
    idempotency: {},
    createdAt: now,
    updatedAt: now,
  });
  const released = await manager.release("route");
  assert.equal(released.status, "stopped");
  assert.equal(manager.rawSession("route").providerSessionId, "provider-one");
  assert.equal(kills, 1);
  assert.equal((await manager.release("route")).status, "stopped");
  assert.equal(kills, 2);

  attached = true;
  await assert.rejects(() => manager.restart("route"), (error) => error.code === "SESSION_ATTACHED");
  await assert.rejects(() => manager.release("route"), (error) => error.code === "SESSION_ATTACHED");
  await assert.rejects(() => manager.close("route"), (error) => error.code === "SESSION_ATTACHED");
  assert.equal(kills, 2);
});

test("terminal submission state is not observable before durable persistence", async (t) => {
  const { manager } = await managerFixture(t);
  const session = { sessionKey: "route", workspace: "/unused", driver: "claude" };
  const submission = {
    submissionId: "sub-durability",
    sessionKey: "route",
    status: "running",
    outputs: [],
  };
  manager.active.set("route", { submission });
  manager.finishWorkspaceTurn = async (_session, finalized) => {
    finalized.outputs = [{ outputId: "output-one", deliveryStatus: "pending" }];
  };

  let persistenceStarted;
  let releasePersistence;
  const started = new Promise((resolve) => { persistenceStarted = resolve; });
  const release = new Promise((resolve) => { releasePersistence = resolve; });
  manager.persistSubmission = async () => {
    persistenceStarted();
    await release;
  };

  const finalizing = manager.finalizeSubmission(session, submission, {
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  await started;
  const beforePersistence = await manager.getSubmission(submission.submissionId);
  assert.equal(beforePersistence.status, "running");
  assert.deepEqual(beforePersistence.outputs, []);

  releasePersistence();
  await finalizing;
  const afterPersistence = await manager.getSubmission(submission.submissionId);
  assert.equal(afterPersistence.status, "completed");
  assert.equal(afterPersistence.outputs[0].deliveryStatus, "pending");
});

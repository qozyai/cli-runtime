"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TelegramAdapter } = require("../src/telegram");

const CHAT = { id: 42 };

async function adapterFor(t, telegram = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-burst-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const submissions = [];
  const sent = [];
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      socketPath: path.join(root, "runtime.sock"),
      telegram: {
        token: "token",
        defaultDriver: "claude",
        projectsRoot: root,
        allowedChatIds: new Set(["42"]),
        burstDebounceMs: 60,
        burstMaxWaitMs: 400,
        burstMaxParts: 4,
        ...telegram,
      },
    },
    fetchImpl: async () => { throw new Error("no network in this test"); },
    log: () => {},
  });
  await fs.mkdir(path.join(root, "project"), { recursive: true });
  await adapter.init();
  await adapter.routeStore.update("42:main", { driver: "claude", project: "project" });
  adapter.api = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  adapter.ensureSession = async () => ({ status: "ready" });
  adapter.runtime = async (method, urlPath, body) => {
    if (method === "POST" && urlPath.endsWith("/submissions")) {
      submissions.push(body);
      return { submission: { submissionId: `sub-${submissions.length}` } };
    }
    return { submission: { submissionId: "sub", status: "completed", reply: "done", outputs: [] } };
  };
  adapter.waitSubmission = async () => ({ submissionId: "sub", status: "completed", reply: "done", outputs: [] });
  return { adapter, submissions, sent, root };
}

function textUpdate(id, text, extra = {}) {
  return { update_id: id, message: { chat: CHAT, message_id: id, text, ...extra } };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(adapter, ms = 400) {
  await settle(ms);
  await Promise.all([...adapter.chains.values()].map((chain) => chain.catch(() => {})));
  await settle(20);
}

test("messages arriving together become one turn", async (t) => {
  const { adapter, submissions } = await adapterFor(t);

  adapter.dispatch(textUpdate(1, "first half of a long paste"));
  adapter.dispatch(textUpdate(2, "second half of the same paste"));
  adapter.dispatch(textUpdate(3, "third half, because pastes are like that"));
  await drain(adapter);

  assert.equal(submissions.length, 1, "one submission for the whole burst");
  assert.equal(
    submissions[0].message,
    "first half of a long paste\nsecond half of the same paste\nthird half, because pastes are like that",
  );
  assert.equal(submissions[0].idempotencyKey, "telegram:42:1", "the first part identifies the burst");
});

test("each arrival resets the window, and a gap ends the burst", async (t) => {
  const { adapter, submissions } = await adapterFor(t);

  adapter.dispatch(textUpdate(1, "one"));
  await settle(30);
  adapter.dispatch(textUpdate(2, "two"));
  await settle(30);
  adapter.dispatch(textUpdate(3, "three"));
  await drain(adapter);
  assert.equal(submissions.length, 1, "parts closer than the debounce all join");
  assert.equal(submissions[0].message, "one\ntwo\nthree");

  adapter.dispatch(textUpdate(4, "later thought"));
  await drain(adapter);
  assert.equal(submissions.length, 2, "a message after the window is its own turn");
  assert.equal(submissions[1].message, "later thought");
});

test("a burst dispatches at the part cap and at the maximum wait", async (t) => {
  const capped = await adapterFor(t, { burstMaxParts: 3 });
  for (let index = 1; index <= 3; index += 1) capped.adapter.dispatch(textUpdate(index, `part ${index}`));
  await drain(capped.adapter, 20);
  assert.equal(capped.submissions.length, 1, "the cap dispatches without waiting for quiet");
  assert.equal(capped.submissions[0].message, "part 1\npart 2\npart 3");

  const slow = await adapterFor(t, { burstDebounceMs: 100, burstMaxWaitMs: 150, burstMaxParts: 50 });
  slow.adapter.dispatch(textUpdate(1, "a"));
  await settle(80);
  slow.adapter.dispatch(textUpdate(2, "b"));
  await settle(80);
  slow.adapter.dispatch(textUpdate(3, "c"));
  await drain(slow.adapter);
  assert.ok(slow.submissions.length >= 1, "a steady stream still dispatches at the maximum wait");
  assert.match(slow.submissions[0].message, /^a\nb/, "the earliest parts went first, in order");
});

test("a zero debounce keeps every message its own turn", async (t) => {
  const { adapter, submissions } = await adapterFor(t, { burstDebounceMs: 0 });

  adapter.dispatch(textUpdate(1, "one"));
  adapter.dispatch(textUpdate(2, "two"));
  await drain(adapter, 50);

  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map((s) => s.message), ["one", "two"]);
});

test("bursts in different routes stay independent", async (t) => {
  const { adapter, submissions, root } = await adapterFor(t);
  await fs.mkdir(path.join(root, "other"), { recursive: true });
  await adapter.routeStore.update("42:7", { driver: "claude", project: "other" });

  adapter.dispatch(textUpdate(1, "main route"));
  adapter.dispatch(textUpdate(2, "topic route", { is_topic_message: true, message_thread_id: 7 }));
  await drain(adapter);

  assert.equal(submissions.length, 2);
  assert.deepEqual(submissions.map((s) => s.message).sort(), ["main route", "topic route"]);
});

test("a reply inside a burst keeps its own quoted context", async (t) => {
  const { adapter, submissions } = await adapterFor(t);

  adapter.dispatch(textUpdate(1, "look at this"));
  adapter.dispatch(textUpdate(2, "and answer it", {
    reply_to_message: { chat: CHAT, message_id: 99, text: "the quoted question" },
  }));
  await drain(adapter);

  assert.equal(submissions.length, 1);
  assert.match(submissions[0].message, /^look at this\n<telegram-reply-context>/);
  assert.match(submissions[0].message, /the quoted question[\s\S]*Current message:\nand answer it/);
});

test("a command flushes the burst ahead of itself, and /stop discards it", async (t) => {
  const { adapter, submissions, sent } = await adapterFor(t);

  adapter.dispatch(textUpdate(1, "buffered thought"));
  adapter.dispatch(textUpdate(2, "/status"));
  await drain(adapter);
  assert.equal(submissions.length, 1, "the buffered burst still ran");
  assert.equal(submissions[0].message, "buffered thought");
  assert.ok(sent.some((call) => /Route: 42:main/.test(String(call.body.text || ""))), "the command ran too");

  adapter.dispatch(textUpdate(3, "never mind this"));
  adapter.dispatch(textUpdate(4, "/stop"));
  await drain(adapter);
  assert.equal(submissions.length, 1, "the discarded burst never became a turn");
  assert.ok(sent.some((call) => /Dropped 1 unsent message\./.test(String(call.body.text || ""))));
});

test("every part's queue record is removed once the joined turn succeeds", async (t) => {
  const { adapter, submissions, root } = await adapterFor(t);
  const queueDir = path.join(root, "telegram", "queue");

  const parts = [textUpdate(1, "part one"), textUpdate(2, "part two")];
  for (const update of parts) {
    const queuePath = path.join(queueDir, `${update.update_id}.json`);
    await fs.writeFile(queuePath, JSON.stringify(update));
    adapter.dispatch(update, queuePath);
  }
  await drain(adapter);

  assert.equal(submissions.length, 1);
  assert.deepEqual(await fs.readdir(queueDir), [], "no part is left behind to replay");
});

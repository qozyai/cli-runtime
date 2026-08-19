"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { NoticeSpool, RunMarker, releaseIdFromPath, restartAnnouncement } = require("../src/core/notices");
const { TelegramAdapter } = require("../src/surface/telegram");

async function spoolRoot(t, label) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `cli-runtime-${label}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function adapterWith(root, { sent, owner = { userId: "111222333" } }) {
  const adapter = new TelegramAdapter({
    config: {
      stateDir: root,
      telegram: { token: "token", defaultDriver: "claude", projectsRoot: root, allowedChatIds: new Set() },
    },
    fetchImpl: async () => { throw new Error("no network in this test"); },
    log: () => {},
  });
  adapter.ownerStore = { get: () => owner };
  adapter.api = async (method, body) => { sent.push({ method, body }); return { message_id: sent.length }; };
  return adapter;
}

test("a notice is delivered once and its file is removed", async (t) => {
  const root = await spoolRoot(t, "notice-once");
  const spool = new NoticeSpool({ dir: path.join(root, "notices"), log: () => {} });
  await spool.init();
  await spool.write({ kind: "shutdown", text: "Stopping to deploy release_x." });

  const sent = [];
  const adapter = adapterWith(root, { sent });
  adapter.notices = spool;
  await adapter.flushNotices();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "sendMessage");
  assert.equal(sent[0].body.chat_id, "111222333");
  assert.match(sent[0].body.text, /Stopping to deploy release_x\./);
  assert.deepEqual(await fs.readdir(path.join(root, "notices")), []);

  await adapter.flushNotices();
  assert.equal(sent.length, 1, "a drained notice must not be sent again");
});

test("a routed notice reaches its chat and topic", async (t) => {
  const root = await spoolRoot(t, "notice-route");
  const spool = new NoticeSpool({ dir: path.join(root, "notices"), log: () => {} });
  await spool.init();
  await spool.write({ kind: "startup", text: "release_y is active.", route: { chatId: "-1001234567890", threadId: 42 } });

  const sent = [];
  const adapter = adapterWith(root, { sent });
  adapter.notices = spool;
  await adapter.flushNotices();

  assert.equal(sent[0].body.chat_id, "-1001234567890");
  assert.equal(sent[0].body.message_thread_id, 42);
});

test("expired, malformed, and unroutable notices are dropped without blocking siblings", async (t) => {
  const root = await spoolRoot(t, "notice-drop");
  const dir = path.join(root, "notices");
  const spool = new NoticeSpool({ dir, log: () => {} });
  await spool.init();
  await spool.write({ kind: "shutdown", text: "stale", expiresAt: new Date(Date.now() - 1000).toISOString() });
  await fs.writeFile(path.join(dir, `${Date.now()}-bad0.json`), "{not json");
  await spool.write({ kind: "info", text: "still valid" });

  const sent = [];
  const adapter = adapterWith(root, { sent });
  adapter.notices = spool;
  await adapter.flushNotices();

  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /still valid/);
  assert.deepEqual(await fs.readdir(dir), [], "every drained file is removed, valid or not");

  await spool.write({ kind: "info", text: "nowhere to go" });
  const orphaned = [];
  const ownerless = adapterWith(root, { sent: orphaned, owner: null });
  ownerless.notices = spool;
  await ownerless.flushNotices();
  assert.equal(orphaned.length, 0);
});

test("a clean stop is not a restart, and a missing stamp is", async (t) => {
  const root = await spoolRoot(t, "marker");
  const marker = new RunMarker({ filePath: path.join(root, "last-run.json"), log: () => {} });

  const first = await marker.start({ release: "release_a", now: 1000 });
  assert.equal(first.unexpected, false, "the first ever start has no previous run to judge");
  assert.equal(first.announce, false);

  await marker.markCleanStop();
  const afterClean = await marker.start({ release: "release_a", now: 2000 });
  assert.equal(afterClean.unexpected, false);
  assert.equal(afterClean.announce, false);

  const afterCrash = await marker.start({ release: "release_b", now: 3000 });
  assert.equal(afterCrash.unexpected, true);
  assert.equal(afterCrash.announce, true);
  assert.equal(afterCrash.previousStartedAt, new Date(2000).toISOString());

  const text = restartAnnouncement(afterCrash);
  assert.match(text, /did not stop cleanly/);
  assert.match(text, /release_b/);
});

test("restart loops announce once per window and report what they stand for", async (t) => {
  const root = await spoolRoot(t, "marker-loop");
  const marker = new RunMarker({ filePath: path.join(root, "last-run.json"), log: () => {} });
  const windowMs = 300_000;

  await marker.start({ release: "release_a", now: 0 });
  const announced = await marker.start({ release: "release_a", now: 1000, windowMs });
  assert.equal(announced.announce, true);

  const suppressedOne = await marker.start({ release: "release_a", now: 3000, windowMs });
  const suppressedTwo = await marker.start({ release: "release_a", now: 5000, windowMs });
  assert.equal(suppressedOne.announce, false);
  assert.equal(suppressedTwo.announce, false);

  const afterWindow = await marker.start({ release: "release_a", now: 1000 + windowMs + 1, windowMs });
  assert.equal(afterWindow.announce, true);
  assert.equal(afterWindow.suppressedCount, 2);
  assert.match(restartAnnouncement(afterWindow), /2 further restarts were not reported/);

  const reset = await marker.start({ release: "release_a", now: 1000 + windowMs + 2, windowMs });
  assert.equal(reset.announce, false, "the counter resets after an announcement");
  assert.equal(reset.suppressedCount, 0);
});

test("an unreadable marker is replaced rather than read as a crash", async (t) => {
  const root = await spoolRoot(t, "marker-bad");
  const filePath = path.join(root, "last-run.json");
  await fs.writeFile(filePath, "{ broken");
  const marker = new RunMarker({ filePath, log: () => {} });

  const started = await marker.start({ release: "release_a", now: 1000 });
  assert.equal(started.unexpected, false);
  assert.equal(started.announce, false);
  assert.equal(JSON.parse(await fs.readFile(filePath, "utf8")).release, "release_a");
});

test("the running release is read from the entry path", () => {
  assert.equal(
    releaseIdFromPath("/home/user/.local/share/qozyai-cli-runtime-releases/release_20260806T111740Z_cfc6147/bin/cli-runtime.js"),
    "release_20260806T111740Z_cfc6147",
  );
  assert.equal(releaseIdFromPath("/code/qozyai/cli-runtime/bin/cli-runtime.js"), null);
});

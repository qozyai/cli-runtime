"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventStore } = require("../src/event-store");

test("event replay stays monotonic across compaction and restart", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-events-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = new EventStore(root, { maxBytes: 4096, maxEvents: 5 });
  await first.init();
  for (let index = 0; index < 12; index += 1) await first.append("tick", { index, text: "x".repeat(100) });
  assert.equal(first.sequence, 12);
  assert.ok(first.records.length <= 5);
  assert.throws(() => first.read({ after: 1 }), (error) => error.code === "EVENT_CURSOR_EXPIRED");
  const earliest = first.records[0].event.sequence;
  assert.equal(first.read({ after: earliest - 1 })[0].sequence, earliest);

  const second = new EventStore(root, { maxBytes: 4096, maxEvents: 5 });
  await second.init();
  assert.equal(second.sequence, 12);
  const written = await second.append("after_restart");
  assert.equal(written.sequence, 13);
  assert.deepEqual(second.read({ after: 12 }).map((item) => item.sequence), [13]);
});

test("event wait uses the in-memory ring and reports expired cursors", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-events-wait-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new EventStore(root, { maxBytes: 4096, maxEvents: 3 });
  await store.init();
  await store.append("one");
  const waiting = store.wait({ after: 1, waitMs: 1000 });
  await store.append("two");
  assert.equal((await waiting)[0].type, "two");
  await store.append("three");
  await store.append("four");
  await store.append("five");
  await assert.rejects(() => store.wait({ after: 1, waitMs: 1 }), (error) => error.code === "EVENT_CURSOR_EXPIRED");
  assert.throws(() => store.read({ after: store.sequence + 1 }), (error) => error.code === "EVENT_CURSOR_EXPIRED");
  assert.throws(() => store.read({ after: Number.POSITIVE_INFINITY }), (error) => error.code === "EVENT_CURSOR_EXPIRED");
});

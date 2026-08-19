"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { OwnerStore } = require("../src/surface/owner-store");
const { readJson } = require("../src/core/util");

function direct(userId, text = "hello") {
  return {
    chat: { id: userId, type: "private" },
    from: { id: userId, is_bot: false },
    message_id: 1,
    text,
  };
}

function group(userId, chatId = -1001) {
  return {
    chat: { id: chatId, type: "supergroup" },
    from: { id: userId, is_bot: false },
    message_id: 2,
    text: "group prompt",
  };
}

test("first accepted private sender becomes the durable Telegram owner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-owner-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new OwnerStore({ stateDir: root, log: () => {} });
  await store.init();

  assert.equal(await store.authorize(group(42)), false);
  assert.equal(await store.authorize(direct(42)), true);
  assert.equal(await store.authorize(group(42)), true);
  assert.equal(await store.authorize(group(43)), false);
  assert.equal(await store.authorize(direct(43)), false);
  assert.equal(await store.authorize({ ...group(42), chat: { id: -1001, type: "channel" } }), false);
  assert.equal(await store.authorize({ ...group(42), from: { id: 42, is_bot: true } }), false);

  const persisted = await readJson(path.join(root, "telegram", "owner.json"));
  assert.equal(persisted.userId, "42");
  assert.equal((await fs.stat(path.join(root, "telegram", "owner.json"))).mode & 0o777, 0o600);

  const restarted = new OwnerStore({ stateDir: root, log: () => {} });
  await restarted.init();
  assert.equal(await restarted.authorize(group(42)), true);
  assert.equal(await restarted.authorize(direct(43)), false);
});

test("concurrent first-use claims have exactly one winner", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-owner-race-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new OwnerStore({ stateDir: root, log: () => {} });
  await store.init();
  assert.deepEqual(await Promise.all([
    store.authorize(direct(42)),
    store.authorize(direct(43)),
  ]), [true, false]);
  assert.equal(store.get().userId, "42");
});

test("invalid owner state fails closed instead of reopening enrollment", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-owner-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "telegram"), { recursive: true });
  await fs.writeFile(path.join(root, "telegram", "owner.json"), JSON.stringify({ version: 1, userId: "bad" }));
  const store = new OwnerStore({ stateDir: root, log: () => {} });
  await assert.rejects(() => store.init(), (error) => error.code === "TELEGRAM_OWNER_STATE_INVALID");
  assert.equal(store.get(), null);
});

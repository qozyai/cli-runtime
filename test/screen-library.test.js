"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ScreenLibrary, compilePattern } = require("../src/drivers/screen-library");

test("patterns earn their place", () => {
  assert.ok(compilePattern("Do you trust the contents"));
  assert.equal(compilePattern("x".repeat(201)), null, "too long");
  assert.equal(compilePattern("("), null, "does not compile");
  assert.equal(compilePattern(".*"), null, "matches the empty string");
  assert.equal(compilePattern("a?"), null, "matches the empty string via optional");
  assert.equal(compilePattern("ab"), null, "too short");
});

test("lessons commit only on success and survive a reload", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-screen-library-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const filePath = path.join(root, "screens.jsonl");
  const library = new ScreenLibrary({ filePath });
  const lesson = {
    driver: "claude",
    pattern: "Choose the color theme",
    action: { action: "press_key", key: "Enter" },
    reason: "theme dialog",
  };
  assert.equal(library.remember("attempt-1", lesson), true);
  assert.equal(await library.match("claude", "Choose the color theme\n> Dark"), null, "pending is not live");
  await library.commit("attempt-1");
  const hit = await library.match("claude", "some scrollback\nChoose the color theme\n> Dark");
  assert.equal(hit.action.key, "Enter");
  assert.equal(await library.match("codex", "Choose the color theme"), null, "per driver");

  const reloaded = new ScreenLibrary({ filePath });
  assert.ok(await reloaded.match("claude", "CHOOSE THE COLOR THEME"), "case-insensitive after reload");

  assert.equal(reloaded.remember("attempt-2", lesson), false, "duplicates are refused");
  reloaded.remember("attempt-3", { ...lesson, pattern: "Something discarded" });
  reloaded.discard("attempt-3");
  await reloaded.commit("attempt-3");
  assert.equal(await reloaded.match("claude", "Something discarded"), null, "discard teaches nothing");

  const text = await fs.readFile(filePath, "utf8");
  assert.equal(text.trim().split("\n").length, 1, "exactly one committed lesson on disk");
});

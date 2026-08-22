"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DRIVERS, driverLabel, startupScreenAction } = require("../src/drivers/drivers");

test("the registry is the single source of driver identity", () => {
  assert.deepEqual([...DRIVERS].sort(), ["claude", "codex"]);
  assert.equal(driverLabel("claude"), "Claude Code");
  assert.equal(driverLabel("codex"), "Codex");
  // An unknown key degrades to itself rather than throwing: labels are display,
  // not validation.
  assert.equal(driverLabel("newdriver"), "newdriver");
});

test("startup dialogs are answered from the drivers seam", () => {
  assert.equal(startupScreenAction("claude", "WARNING: Claude Code running in Bypass Permissions mode"), "2");
  assert.equal(startupScreenAction("claude", "Try the new fullscreen renderer?"), "2");
  assert.equal(startupScreenAction("claude", "Security notes"), "Enter");
  assert.equal(startupScreenAction("claude", "an ordinary composer"), null);
  assert.equal(startupScreenAction("codex", "Do you trust the contents of this directory?"), "1");
  assert.equal(startupScreenAction("codex", "update available. press s to skip"), "2");
  assert.equal(startupScreenAction("codex", "an ordinary composer"), null);
});

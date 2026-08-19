"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("../src/config");
const { parseDriverVersion, versionCommand } = require("../src/drivers");
const { blockingVersionFailures, describeVersionCheck, verifyDriverVersion } = require("../src/driver-version");
const { reportDriverVersions } = require("../src/main");

// Real output from both drivers as shipped: neither prints a bare semver, and the
// wrapper text differs, so the parser reads the version out of each one's own format.
test("driver versions are read from each CLI's own --version wrapper", () => {
  assert.equal(parseDriverVersion("codex-cli 0.147.0"), "0.147.0");
  assert.equal(parseDriverVersion("2.1.231 (Claude Code)"), "2.1.231");
  assert.equal(parseDriverVersion("codex-cli 0.148.0-rc.1"), "0.148.0-rc.1");
  assert.equal(parseDriverVersion(""), null);
  assert.equal(parseDriverVersion("no version printed"), null);
});

test("the version probe runs the configured command, not a bare driver name", () => {
  const config = loadConfig({ CLI_RUNTIME_CLAUDE_COMMAND: "/opt/claude/versions/2.1.231" });
  const spec = versionCommand(config, "claude");
  assert.equal(spec.command, "/opt/claude/versions/2.1.231");
  assert.deepEqual(spec.args, ["--version"]);
  assert.equal(spec.env.DISABLE_AUTOUPDATER, "1");
});

test("an unpinned driver is reported without being treated as a failure", async () => {
  const config = loadConfig({ CLI_RUNTIME_CODEX_COMMAND: "/bin/echo" });
  const result = await verifyDriverVersion(config, "codex");
  assert.equal(result.state, "unpinned");
  assert.equal(result.expected, null);
  assert.match(describeVersionCheck(result), /not pinned/);
  assert.deepEqual(blockingVersionFailures(config, [result]), []);
});

test("a pin the running binary contradicts is drift, and blocks only when asked", async () => {
  const env = { CLI_RUNTIME_CODEX_COMMAND: "/bin/echo", CLI_RUNTIME_CODEX_VERSION: "0.146.0" };
  const warn = loadConfig(env);
  const drifted = { driver: "codex", expected: "0.146.0", actual: "0.147.0", state: "drifted", error: null };
  assert.match(describeVersionCheck(drifted), /DRIFTED: pinned 0\.146\.0, found 0\.147\.0/);
  // Warn is the default: a driver that moved is loud, but the bot stays on the air.
  assert.deepEqual(blockingVersionFailures(warn, [drifted]), []);

  const block = loadConfig({ ...env, CLI_RUNTIME_DRIVER_VERSION_ENFORCE: "block" });
  assert.deepEqual(blockingVersionFailures(block, [drifted]).map((r) => r.driver), ["codex"]);
});

// Under `block` the assertion is `actual === expected`. A pin nobody could verify has
// not been satisfied, and letting it pass would leave the exact uncertainty — an
// output-format change, a replaced binary — that block exists to refuse.
test("an unverifiable pin blocks too, but an unpinned driver never does", async () => {
  // /bin/echo prints its argument, so the probe sees "--version" and no semver at all.
  const pinned = { CLI_RUNTIME_CODEX_COMMAND: "/bin/echo", CLI_RUNTIME_CODEX_VERSION: "0.146.0" };
  const unreadable = await verifyDriverVersion(loadConfig(pinned), "codex");
  assert.equal(unreadable.state, "unknown");
  assert.match(describeVersionCheck(unreadable), /pinned 0\.146\.0 but its version could not be read/);

  const block = loadConfig({ ...pinned, CLI_RUNTIME_DRIVER_VERSION_ENFORCE: "block" });
  assert.deepEqual(blockingVersionFailures(block, [unreadable]).map((r) => r.driver), ["codex"]);
  assert.deepEqual(blockingVersionFailures(loadConfig(pinned), [unreadable]), []);

  const unpinned = await verifyDriverVersion(loadConfig({ CLI_RUNTIME_CODEX_COMMAND: "/bin/echo" }), "codex");
  assert.equal(unpinned.state, "unpinned");
  const blockUnpinned = loadConfig({ CLI_RUNTIME_DRIVER_VERSION_ENFORCE: "block" });
  assert.deepEqual(blockingVersionFailures(blockUnpinned, [unpinned]), []);
});

// A safety switch that silently downgrades reads as enforcement while permitting the
// drift it was set to stop, so an unrecognised value is a configuration error.
test("the enforcement switch rejects anything but warn and block", () => {
  assert.equal(loadConfig({}).driverVersionEnforce, "warn");
  assert.equal(loadConfig({ CLI_RUNTIME_DRIVER_VERSION_ENFORCE: "warn" }).driverVersionEnforce, "warn");
  assert.equal(loadConfig({ CLI_RUNTIME_DRIVER_VERSION_ENFORCE: "block" }).driverVersionEnforce, "block");
  for (const value of ["blok", "BLOCK", "Block", "1", "true"]) {
    assert.throws(
      () => loadConfig({ CLI_RUNTIME_DRIVER_VERSION_ENFORCE: value }),
      (err) => err.code === "EX_CONFIG",
      `${value} should be rejected`,
    );
  }
});

test("a driver that cannot be executed is reported, not crashed on", async () => {
  const config = loadConfig({
    CLI_RUNTIME_CODEX_COMMAND: "/nonexistent/codex-binary",
    CLI_RUNTIME_CODEX_VERSION: "0.147.0",
  });
  const result = await verifyDriverVersion(config, "codex");
  assert.equal(result.state, "unknown");
  assert.equal(result.actual, null);
  assert.match(describeVersionCheck(result), /could not be read/);
});

// The helpers were tested in isolation while the thing the daemon actually calls was
// not, so the startup path could have been wired backwards and every test still passed.
test("the startup report is what refuses to boot, and only under block", async () => {
  const pinned = {
    CLI_RUNTIME_CLAUDE_COMMAND: "/bin/echo",
    CLI_RUNTIME_CODEX_COMMAND: "/bin/echo",
    CLI_RUNTIME_CODEX_VERSION: "0.147.0",
  };
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    // Warn keeps the bot on the air even though the pinned probe proves nothing.
    const results = await reportDriverVersions(loadConfig(pinned));
    assert.equal(results.find((r) => r.driver === "codex").state, "unknown");
    await assert.rejects(
      () => reportDriverVersions(loadConfig({ ...pinned, CLI_RUNTIME_DRIVER_VERSION_ENFORCE: "block" })),
      /driver version pin unsatisfied: codex pinned 0\.147\.0, found unreadable/,
    );
  } finally {
    process.stderr.write = original;
  }
  const output = written.join("");
  // A pin that governs only new panes must not read as covering the resident ones.
  assert.match(output, /resident panes keep the binary they started with/);
  assert.match(output, /codex pinned 0\.147\.0 but its version could not be read/);
});

// An unpinned deployment gets no scope caveat, because it made no claim to qualify.
test("the resident-pane caveat appears only when something is actually pinned", async () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
  try {
    await reportDriverVersions(loadConfig({
      CLI_RUNTIME_CLAUDE_COMMAND: "/bin/echo",
      CLI_RUNTIME_CODEX_COMMAND: "/bin/echo",
    }));
  } finally {
    process.stderr.write = original;
  }
  assert.doesNotMatch(written.join(""), /resident panes/);
});

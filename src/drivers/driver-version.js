"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { normalizeDriver, parseDriverVersion, versionCommand } = require("./drivers");
const { isolatedProcessEnv } = require("../core/util");

const execFileAsync = promisify(execFile);

const PROBE_TIMEOUT_MS = 15_000;

// A release is validated against exact driver builds. Codex moved 0.146.0 -> 0.147.0
// under a running deployment and renamed the rollout event the runtime binds on, so
// every turn failed as an unexplained model error for ten days. Pinning is what stops
// the drift; this check is what makes an unpinned or replaced binary say so out loud.
async function probeDriverVersion(config, driver) {
  const spec = versionCommand(config, normalizeDriver(driver));
  try {
    const result = await execFileAsync(spec.command, spec.args, {
      env: isolatedProcessEnv(spec.env),
      encoding: "utf8",
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    return { version: parseDriverVersion(output), error: null };
  } catch (err) {
    return { version: null, error: err.message || String(err) };
  }
}

async function verifyDriverVersion(config, driver) {
  const name = normalizeDriver(driver);
  const expected = String(config.drivers[name].version || "").trim();
  const { version: actual, error } = await probeDriverVersion(config, name);
  if (!expected) return { driver: name, expected: null, actual, state: "unpinned", error };
  if (error) return { driver: name, expected, actual: null, state: "unknown", error };
  if (!actual) return { driver: name, expected, actual: null, state: "unknown", error: "no version in --version output" };
  return { driver: name, expected, actual, state: actual === expected ? "ok" : "drifted", error: null };
}

async function verifyDriverVersions(config, drivers = ["claude", "codex"]) {
  return Promise.all(drivers.map((driver) => verifyDriverVersion(config, driver)));
}

function describeVersionCheck(result) {
  if (result.state === "ok") return `[cli-runtime] ${result.driver} pinned at ${result.expected}`;
  if (result.state === "unpinned") {
    const seen = result.actual ? ` (running ${result.actual})` : "";
    return `[cli-runtime] ${result.driver} is not pinned${seen}; set CLI_RUNTIME_${result.driver.toUpperCase()}_VERSION`;
  }
  if (result.state === "unknown") {
    return `[cli-runtime] ${result.driver} pinned ${result.expected} but its version could not be read: ${result.error}`;
  }
  return `[cli-runtime] ${result.driver} DRIFTED: pinned ${result.expected}, found ${result.actual}`;
}

// Under `block` the assertion is `actual === expected`, so anything that leaves it
// unproven blocks: a pin cannot be satisfied by a version nobody could read. An
// unpinned driver asserted nothing, so it is reported and allowed either way.
function blockingVersionFailures(config, results) {
  if (config.driverVersionEnforce !== "block") return [];
  return results.filter((result) => result.state === "drifted" || result.state === "unknown");
}

module.exports = {
  blockingVersionFailures,
  describeVersionCheck,
  probeDriverVersion,
  verifyDriverVersion,
  verifyDriverVersions,
};

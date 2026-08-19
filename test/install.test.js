"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

function runInstaller(script, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script], { env, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
    child.stdin.end(input);
  });
}

test("installer clones, protects configuration, and reruns idempotently", async (t) => {
  const project = path.resolve(__dirname, "..");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cli-runtime-install-"));
  const source = path.join(root, "source");
  const home = path.join(root, "home");
  const installDir = path.join(home, "runtime");
  const workspace = path.join(home, "workspace");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(home, { recursive: true });
  await fs.cp(project, source, {
    recursive: true,
    filter: (entry) => !entry.split(path.sep).includes(".git"),
  });
  await execFileAsync("git", ["-C", source, "init", "-q", "-b", "main"]);
  await execFileAsync("git", ["-C", source, "config", "user.name", "installer-test"]);
  await execFileAsync("git", ["-C", source, "config", "user.email", "installer@example.test"]);
  await execFileAsync("git", ["-C", source, "add", "."]);
  await execFileAsync("git", ["-C", source, "commit", "-qm", "initial"]);

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_STATE_HOME: path.join(home, "state"),
    CLI_RUNTIME_REPO_URL: `file://${source}`,
    CLI_RUNTIME_INSTALL_INPUT: "stdin",
    CLI_RUNTIME_INSTALL_NO_START: "1",
  };
  const token = "123456:INSTALLER_TEST_TOKEN";
  const firstInput = [
    installDir,
    workspace,
    "claude",
    "/bin/true",
    "codex",
    token,
    "-100123, 42",
    "",
  ].join("\n") + "\n";
  const first = await runInstaller(path.join(project, "install.sh"), firstInput, env);
  assert.equal(first.code, 0, first.stderr);
  assert.doesNotMatch(`${first.stdout}\n${first.stderr}`, new RegExp(token));
  assert.ok((await fs.stat(path.join(installDir, ".git"))).isDirectory());
  assert.ok((await fs.stat(path.join(home, ".local", "bin", "cli-runtime"))).mode & 0o100);

  const envPath = path.join(home, "config", "qozyai-cli-runtime", "runtime.env");
  const envStat = await fs.stat(envPath);
  assert.equal(envStat.mode & 0o777, 0o600);
  const { stdout: savedValues } = await execFileAsync("bash", [
    "-c",
    'source "$1"; printf "%s\\n%s\\n%s\\n" "$CLI_RUNTIME_TELEGRAM_ALLOWED_CHATS" "$TELEGRAM_BOT_TOKEN" "$CLI_RUNTIME_TELEGRAM_PROJECTS_ROOT"',
    "installer-test",
    envPath,
  ]);
  assert.equal(savedValues, `-100123,42\n${token}\n${workspace}\n`);
  assert.doesNotMatch(await fs.readFile(envPath, "utf8"), /CLI_RUNTIME_TELEGRAM_WORKSPACE/);
  const installerText = await fs.readFile(path.join(project, "install.sh"), "utf8");
  assert.match(installerText, /qozyai-cli-runtime-telegram\.service[\s\S]*RestartPreventExitStatus=78/);
  assert.match(installerText, /qozyai-cli-runtime\.service[\s\S]*KillMode=process/);

  const second = await runInstaller(path.join(project, "install.sh"), "\n".repeat(8), env);
  assert.equal(second.code, 0, second.stderr);
  assert.doesNotMatch(`${second.stdout}\n${second.stderr}`, new RegExp(token));
  const { stdout: dirty } = await execFileAsync("git", ["-C", installDir, "status", "--porcelain"]);
  assert.equal(dirty, "");

  // A release is validated against exact driver builds, and this file is rebuilt from
  // scratch on every run. A pin the installer does not carry through would be erased by
  // the next upgrade, silently un-pinning the deployment the pin exists to protect.
  await fs.appendFile(envPath, [
    "CLI_RUNTIME_CLAUDE_VERSION=2.1.231",
    "CLI_RUNTIME_CODEX_VERSION=0.147.0",
    "CLI_RUNTIME_DRIVER_VERSION_ENFORCE=block",
    "",
  ].join("\n"));
  const third = await runInstaller(path.join(project, "install.sh"), "\n".repeat(8), env);
  assert.equal(third.code, 0, third.stderr);
  const { stdout: pins } = await execFileAsync("bash", [
    "-c",
    'source "$1"; printf "%s\\n%s\\n%s\\n" "$CLI_RUNTIME_CLAUDE_VERSION" "$CLI_RUNTIME_CODEX_VERSION" "$CLI_RUNTIME_DRIVER_VERSION_ENFORCE"',
    "installer-test",
    envPath,
  ]);
  assert.equal(pins, "2.1.231\n0.147.0\nblock\n");
});

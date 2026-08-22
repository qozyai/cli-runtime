"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Tmux, literalSendArgument } = require("../src/drivers/tmux");

test("literal send arguments escape only a trailing semicolon", () => {
  assert.equal(literalSendArgument("hello;"), "hello\\;");
  assert.equal(literalSendArgument("a;b"), "a;b");
  assert.equal(literalSendArgument("plain"), "plain");
  assert.equal(literalSendArgument(";"), "\\;");
});

test("a trailing semicolon survives a real tmux literal send", async (t) => {
  const tmux = new Tmux(`cli-runtime-tmux-${process.pid}-${Date.now()}`);
  const session = "semicolon";
  await tmux.run(["new-session", "-d", "-s", session, "-x", "80", "-y", "24", "cat"]);
  t.after(async () => {
    await tmux.run(["kill-server"], { allowFailure: true });
  });
  await tmux.sendLiteral(session, "hello; world;");
  const deadline = Date.now() + 3000;
  let screen = "";
  while (Date.now() < deadline) {
    screen = await tmux.capture(session, 5);
    if (screen.includes("hello; world;")) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(screen, /hello; world;/);
});

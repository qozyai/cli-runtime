#!/usr/bin/env node
"use strict";

require("../src/main").main().catch((err) => {
  process.stderr.write(`cli-runtime: ${err.message}\n`);
  // Exit codes are operator contract: the installed systemd unit stops
  // restarting on 78, so a config error must survive this wrapper.
  process.exit(err.exitCode || (err.code === "EX_CONFIG" ? 78 : 1));
});

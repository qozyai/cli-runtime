#!/usr/bin/env node
"use strict";

require("../src/main").main().catch((err) => {
  process.stderr.write(`cli-runtime: ${err.message}\n`);
  process.exit(1);
});

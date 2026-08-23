"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const BUCKETS = new Set(["core", "drivers", "surface"]);
// Wiring is allowed to know about everything, so the composition root and the
// configuration it builds are the only files permitted to sit outside a bucket.
const ROOT_FILES = new Set(["main.js", "config.js"]);
// The one rule. Everything else is allowed, including core reaching for a driver:
// the core has to be able to launch one.
const FORBIDDEN = [["core", "surface"]];

// Only .js — each bucket also carries an AGENTS.md and a CLAUDE.md symlink.
function collect(dir, root = "") {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collect(full, root ? `${root}/${entry.name}` : entry.name));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push({ bucket: root || null, name: entry.name, path: full });
    }
  }
  return files;
}

function requiresOf(text) {
  const literal = [];
  // A require whose argument is not a string literal cannot be checked, so it is
  // reported rather than skipped.
  const computed = [];
  for (const match of text.matchAll(/\brequire\(\s*([^)]*?)\s*\)/g)) {
    const argument = match[1].trim();
    const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(argument);
    if (quoted) literal.push(quoted[1] ?? quoted[2]);
    else computed.push(argument);
  }
  return { literal, computed };
}

function bucketOfTarget(root, file, specifier) {
  if (!specifier.startsWith(".")) return null;                 // node: or a package
  const resolved = path.resolve(path.dirname(file.path), specifier);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..")) return null;                  // outside src/
  const head = relative.split(path.sep)[0];
  return BUCKETS.has(head) ? head : null;                      // root files have no bucket
}

function analyse(srcDir = SRC) {
  const files = collect(srcDir);
  const problems = [];
  for (const file of files) {
    if (!file.bucket && !ROOT_FILES.has(file.name)) {
      problems.push(`${file.name} sits in src/ root; place it in core/, drivers/ or surface/`);
      continue;
    }
    const { literal, computed } = requiresOf(fs.readFileSync(file.path, "utf8"));
    for (const argument of computed) {
      problems.push(`${file.bucket || "."}/${file.name} has a non-literal require(${argument}); the rule cannot be checked`);
    }
    if (!file.bucket) continue;
    for (const specifier of literal) {
      const target = bucketOfTarget(srcDir, file, specifier);
      if (!target) continue;
      if (FORBIDDEN.some(([from, to]) => from === file.bucket && to === target)) {
        problems.push(`${file.bucket}/${file.name} imports ${target}/ (${specifier})`);
      }
    }
  }
  return { files, problems };
}

test("core does not import surface", () => {
  const { files, problems } = analyse();
  // A structural test that silently scans nothing passes for ever.
  assert.ok(files.length > 15, `expected to scan the source tree, saw ${files.length} files`);
  assert.ok(
    files.some((file) => file.bucket === "core") && files.some((file) => file.bucket === "surface"),
    "expected core/ and surface/ to exist — the layout this rule describes is not in place",
  );
  assert.deepEqual(problems, []);
});

// Guarantee 6's structural half: provider names are vocabulary, and vocabulary
// lives in drivers/ (and the parser, which is where the guarantee draws its
// line). A literal "claude" or "codex" anywhere else in core/ or surface/ means
// a third driver would have to touch that file too. Spec 0020.
test("provider names stay behind the parser and the drivers seam", () => {
  const offenders = [];
  for (const file of collect(SRC)) {
    if (!file.bucket || file.bucket === "drivers") continue;
    if (file.bucket === "core" && file.name === "artifact-parser.js") continue;
    const text = fs.readFileSync(file.path, "utf8");
    if (/["'](?:claude|codex)["']/.test(text)) offenders.push(`${file.bucket}/${file.name}`);
  }
  assert.deepEqual(offenders, []);
});

// A core module that only the surface imports is surface code in the wrong
// directory. Core modules earn their place from core, drivers, or the
// composition root; notices.js sat in core on exactly this gap. Spec 0021.
test("core hosts nothing that only the surface uses", () => {
  const files = collect(SRC);
  const importers = new Map();
  for (const file of files) {
    const { literal } = requiresOf(fs.readFileSync(file.path, "utf8"));
    for (const specifier of literal) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file.path), specifier);
      const relative = path.relative(SRC, resolved);
      if (relative.split(path.sep)[0] !== "core") continue;
      const key = relative.endsWith(".js") ? relative : `${relative}.js`;
      if (!importers.has(key)) importers.set(key, new Set());
      importers.get(key).add(file.bucket || "root");
    }
  }
  const misplaced = [];
  for (const file of files) {
    if (file.bucket !== "core") continue;
    const from = importers.get(path.relative(SRC, file.path)) || new Set();
    const earned = from.has("core") || from.has("drivers") || from.has("root");
    if (!earned && from.has("surface")) misplaced.push(path.relative(SRC, file.path));
  }
  assert.deepEqual(misplaced, []);
});

// The analyser's own failure modes, proven rather than assumed.
function fixture(tree) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "layout-"));
  for (const [relative, body] of Object.entries(tree)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test("the analyser catches a core file reaching into surface", () => {
  const root = fixture({
    "core/a.js": 'const x = require("../surface/b");\n',
    "surface/b.js": "module.exports = {};\n",
  });
  const { problems } = analyse(root);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /core\/a\.js imports surface\//);
});

test("the analyser permits every direction that is allowed", () => {
  const root = fixture({
    "main.js": 'require("./core/u"); require("./surface/t");\n',
    "config.js": 'require("./core/u");\n',
    "core/u.js": "module.exports = {};\n",
    "core/s.js": 'require("../drivers/d"); require("./u");\n',
    "drivers/d.js": 'require("../core/u");\n',
    "surface/t.js": 'require("../core/u"); require("../drivers/d");\n',
  });
  assert.deepEqual(analyse(root).problems, []);
});

test("the analyser refuses a file left in src/ root", () => {
  const root = fixture({ "main.js": "", "stray.js": "module.exports = {};\n" });
  assert.match(analyse(root).problems.join(), /stray\.js sits in src\/ root/);
});

test("the analyser refuses a require it cannot read", () => {
  const root = fixture({ "core/a.js": "const name = 'x'; require(name);\n" });
  assert.match(analyse(root).problems.join(), /non-literal require/);
});

test("the analyser ignores node builtins, packages, and non-js files", () => {
  const root = fixture({
    "core/a.js": 'require("node:fs"); require("some-package");\n',
    "core/AGENTS.md": "not code\n",
  });
  const { files, problems } = analyse(root);
  assert.deepEqual(problems, []);
  assert.deepEqual(files.map((f) => f.name), ["a.js"]);
});

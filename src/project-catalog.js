"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const PROJECT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

function catalogError(code, message, cause = null) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function validProjectName(name) {
  return PROJECT_NAME_PATTERN.test(String(name || ""));
}

class ProjectCatalog {
  constructor({ root, log = console.error } = {}) {
    this.configuredRoot = root ? path.resolve(root) : null;
    this.root = null;
    this.log = log;
  }

  async init() {
    if (!this.configuredRoot) {
      throw catalogError("PROJECTS_ROOT_UNAVAILABLE", "projects root is not configured");
    }
    let canonical;
    try {
      canonical = await fs.realpath(this.configuredRoot);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory()) throw new Error("not a directory");
    } catch (cause) {
      throw catalogError("PROJECTS_ROOT_UNAVAILABLE", "configured projects root is unavailable", cause);
    }
    this.root = canonical;
    return this.root;
  }

  identityPath(name) {
    if (!validProjectName(name)) {
      throw catalogError("PROJECT_NAME_INVALID", "project names may use only ASCII letters, digits, underscore, and hyphen");
    }
    if (!this.root) throw catalogError("PROJECTS_ROOT_UNAVAILABLE", "configured projects root is unavailable");
    return path.join(this.root, String(name));
  }

  async assertRootAvailable() {
    if (!this.root) return this.init();
    try {
      const canonical = await fs.realpath(this.root);
      const stat = await fs.stat(canonical);
      if (!stat.isDirectory() || canonical !== this.root) throw new Error("projects root identity changed");
      return canonical;
    } catch (cause) {
      throw catalogError("PROJECTS_ROOT_UNAVAILABLE", "configured projects root is unavailable", cause);
    }
  }

  async resolve(name) {
    const expected = this.identityPath(name);
    await this.assertRootAvailable();
    let entry;
    try {
      entry = await fs.lstat(expected);
    } catch (cause) {
      if (cause?.code === "ENOENT") {
        throw catalogError("PROJECT_MISSING", `project is unavailable: ${name}`, cause);
      }
      throw catalogError("PROJECT_INVALID", `project cannot be inspected: ${name}`, cause);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw catalogError("PROJECT_INVALID", `project is not a direct directory: ${name}`);
    }
    let canonical;
    try {
      canonical = await fs.realpath(expected);
    } catch (cause) {
      throw catalogError("PROJECT_INVALID", `project cannot be resolved: ${name}`, cause);
    }
    const relative = path.relative(this.root, canonical);
    if (canonical !== expected || !relative || relative.startsWith("..") || path.isAbsolute(relative)
      || relative.includes(path.sep)) {
      throw catalogError("PROJECT_INVALID", `project is outside the direct-child catalog: ${name}`);
    }
    return Object.freeze({ name: String(name), path: canonical });
  }

  async list() {
    await this.assertRootAvailable();
    let entries;
    try {
      entries = await fs.readdir(this.root, { withFileTypes: true });
    } catch (cause) {
      throw catalogError("PROJECTS_ROOT_UNAVAILABLE", "configured projects root is unreadable", cause);
    }
    const projects = [];
    let hasInvalidNames = false;
    for (const entry of entries) {
      if (!validProjectName(entry.name)) {
        if (entry.isDirectory()) hasInvalidNames = true;
        this.log(`[telegram] omitted unselectable project entry: ${JSON.stringify(entry.name)}`);
        continue;
      }
      try {
        projects.push(await this.resolve(entry.name));
      } catch (err) {
        this.log(`[telegram] omitted invalid project entry ${JSON.stringify(entry.name)}: ${err.code || err.message}`);
      }
    }
    projects.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    return Object.freeze({ projects: Object.freeze(projects), hasInvalidNames });
  }
}

module.exports = { PROJECT_NAME_PATTERN, ProjectCatalog, catalogError, validProjectName };

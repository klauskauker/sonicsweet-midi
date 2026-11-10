"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

assert.equal(process.platform, "win32", "This build step targets Windows.");
const modules = path.join(__dirname, "..", "node_modules");
const source = path.join(modules, "@ktamas77", "abletonlink");
const gypPath = path.join(source, "binding.gyp");
const config = JSON.parse(fs.readFileSync(gypPath, "utf8"));
const target = config.targets.find((entry) => entry.target_name === "abletonlink");
assert.ok(target, "Missing native Ableton Link build target.");

// The upstream global define also affects the Windows build, selecting Darwin headers.
// The macOS-specific condition already supplies the same define on macOS.
target.defines = target.defines.filter((define) => define !== "LINK_PLATFORM_MACOSX=1");
fs.writeFileSync(gypPath, JSON.stringify(config, null, 2) + "\n");

const nodeGyp = path.join(modules, "node-gyp", "bin", "node-gyp.js");
execFileSync(process.execPath, [nodeGyp, "rebuild"], { cwd: source, stdio: "inherit" });

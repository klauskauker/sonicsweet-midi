"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const localModules = path.join(__dirname, "..", "node_modules");
for (const name of ["@julusian/midi/lazy", "@ktamas77/abletonlink"]) {
  const location = path.relative(localModules, require.resolve(name));
  assert.ok(!location.startsWith("..") && !path.isAbsolute(location), `${name} must be installed in this checkout`);
}
const midi = require("@julusian/midi/lazy");
const { AbletonLink } = require("@ktamas77/abletonlink");

midi.verifyLibraryLoaded();
const link = new AbletonLink(120);
assert.equal(link.getTempo(), 120);
console.log("MIDI and Ableton Link loaded on", process.platform, process.arch);

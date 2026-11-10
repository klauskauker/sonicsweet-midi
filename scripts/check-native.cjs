"use strict";

const assert = require("node:assert/strict");
const midi = require("@julusian/midi/lazy");
const { AbletonLink } = require("@ktamas77/abletonlink");

midi.verifyLibraryLoaded();
const link = new AbletonLink(120);
assert.equal(link.getTempo(), 120);
console.log("MIDI and Ableton Link loaded on", process.platform, process.arch);

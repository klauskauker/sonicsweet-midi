"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { RtMidiBackend } = require("../src/midi-backend.cjs");
const { MidiMapper } = require("../src/midi-mapper.cjs");

function windowsOutput() {
  const sent = [];
  const backend = new RtMidiBackend("win32");
  backend.midi = {
    verifyLibraryLoaded() {},
    Output: class {
      getPortCount() { return 1; }
      getPortName() { return "SonicSweet loopMIDI"; }
      openPort(index) { assert.equal(index, 0); }
      closePort() {}
      sendMessage(bytes) { sent.push(bytes); }
    }
  };
  return { backend, sent };
}

test("Windows automatic backend falls back to loopMIDI and preserves velocity and MPE", async () => {
  const { backend, sent } = windowsOutput();
  const context = {
    process: { platform: "win32" },
    settings: { midiMode: "mpe", backend: "auto", legacyPortName: "" },
    activeBackend: null, rtMidi: backend,
    windowsMidiServices: { probe: async () => ({ available: false, reason: "helper-not-packaged" }) },
    listLegacyPorts: () => backend.listPorts(), saveSettings() {}
  };
  const mapper = new MidiMapper(bytes => context.activeBackend && context.activeBackend.send(bytes));
  context.mapper = mapper;
  const source = fs.readFileSync(path.join(__dirname, "../src/main.cjs"), "utf8");
  const start = source.indexOf("async function configureMidi");
  vm.runInNewContext(source.slice(start, source.indexOf("function createPairing", start)), context);
  const status = await context.configureMidi();
  assert.equal(status.open, true);
  assert.equal(status.kind, "legacy-output");
  assert.equal(context.activeBackend, backend);
  assert.ok(sent.some(bytes => bytes[0] === 0xb0 && bytes[1] === 100 && bytes[2] === 6));
  assert.ok(sent.some(bytes => bytes[0] === 0xb1 && bytes[1] === 6 && bytes[2] === 48));
  sent.length = 0;
  const event = (type, seq, payload) => mapper.handleEnvelope({ kind: "note-event", type, seq, payload }, { sourceId: "ipad" });
  event("mod", 2, { id: "a", cents: 6100, vel: 81 });
  event("note", 1, { id: "a", pitch: 6000, vel: 29 });
  assert.deepEqual(sent.find(bytes => bytes[0] === 0x91), [0x91, 60, 29]);
  assert.deepEqual(sent.filter(bytes => bytes[0] === 0xd1).at(-1), [0xd1, 81]);
  assert.equal(mapper.notes.get("ipad:a").cents, 6100);
  event("stop", 3, { id: "a" });
  assert.ok(sent.some(bytes => bytes[0] === 0x81 && bytes[1] === 60));
  assert.equal(mapper.notes.size, 0);
});

test("Windows standard MIDI routes attack velocity and pressure to the selected channel", () => {
  const { backend, sent } = windowsOutput();
  backend.openPort(0);
  const mapper = new MidiMapper(bytes => backend.send(bytes));
  const context = { sourceId: "ipad", standardChannel: 7 };
  mapper.handleEnvelope({ kind: "note-event", type: "note", seq: 1, payload: { id: "a", pitch: 6400, vel: 44 } }, context);
  mapper.handleEnvelope({ kind: "note-event", type: "mod", seq: 2, payload: { id: "a", vel: 99 } }, context);
  mapper.handleEnvelope({ kind: "note-event", type: "stop", seq: 3, payload: { id: "a" } }, context);
  assert.deepEqual(sent, [[0x97, 64, 44], [0xd7, 99], [0x87, 64, 0]]);
});

test("Windows reports a missing MIDI port instead of pretending output is ready", () => {
  const { backend } = windowsOutput();
  assert.throws(() => backend.openMacVirtual(), /macOS/);
  assert.throws(() => backend.openPort(9), /nicht mehr verfügbar/);
  assert.throws(() => backend.send([0x90, 60, 100]), /Kein MIDI-Ausgang/);
});

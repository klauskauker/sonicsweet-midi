"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { MidiMapper } = require("../src/midi-mapper.cjs");

test("standard mode emits channel-one note and pressure messages", () => {
  const sent = [];
  const mapper = new MidiMapper((message) => sent.push(message));
  mapper.handleEnvelope({ kind: "note-event", type: "note", payload: { id: "a", pitch: 6049, vel: 95 } });
  mapper.handleEnvelope({ kind: "note-event", type: "mod", payload: { id: "a", cents: 6200, vel: 72 } });
  mapper.handleEnvelope({ kind: "note-event", type: "stop", payload: { id: "a" } });
  assert.deepEqual(sent, [
    [0x90, 60, 95],
    [0xd0, 72],
    [0x80, 60, 0],
  ]);
});

test("MPE mode allocates per-note channels and emits pitch bend", () => {
  const sent = [];
  const mapper = new MidiMapper((message) => sent.push(message), { mode: "mpe" });
  mapper.noteOn({ id: "a", pitch: 6050, vel: 100 });
  mapper.noteOn({ id: "b", pitch: 6400, vel: 90 });
  mapper.modulate({ id: "a", cents: 6100, vel: 80 });
  assert.deepEqual(sent[0], [0xd1, 0]);
  assert.equal(sent[1][0], 0xe1);
  assert.deepEqual(sent[2], [0x91, 61, 100]);
  assert.deepEqual(sent[3], [0xd2, 0]);
  assert.equal(sent[4][0], 0xe2);
  assert.deepEqual(sent[5], [0x92, 64, 90]);
  assert.deepEqual(sent[6], [0xd1, 80]);
  assert.equal(sent[7][0], 0xe1);
});

test("active-note snapshots recover missed notes and stop stale notes", () => {
  const sent = [];
  const mapper = new MidiMapper((message) => sent.push(message));
  mapper.reconcile([{ id: "a", pitch: 6000, vel: 100 }]);
  mapper.reconcile([{ id: "b", pitch: 6200, vel: 90 }]);
  assert.deepEqual(sent, [
    [0x90, 60, 100],
    [0x80, 60, 0],
    [0x90, 62, 90],
  ]);
});

test("standard mode routes devices independently and reconciles only its source", () => {
  const sent = [];
  const mapper = new MidiMapper((message) => sent.push(message));
  mapper.handleEnvelope({ kind: "note-event", type: "note", payload: { id: "same", pitch: 6000, vel: 100 } }, { sourceId: "a", standardChannel: 2 });
  mapper.handleEnvelope({ kind: "note-event", type: "note", payload: { id: "same", pitch: 6400, vel: 90 } }, { sourceId: "b", standardChannel: 7 });
  mapper.handleEnvelope({ kind: "active-notes", activeNotes: [] }, { sourceId: "a", standardChannel: 2 });
  assert.deepEqual(sent, [[0x92, 60, 100], [0x97, 64, 90], [0x82, 60, 0]]);
  assert.equal(mapper.notes.size, 1);
});

test("MPE uses one shared channel pool across devices", () => {
  const mapper = new MidiMapper(() => {}, { mode: "mpe" });
  mapper.handleEnvelope({ kind: "note-event", type: "note", payload: { id: "same", pitch: 6000, vel: 100 } }, { sourceId: "a" });
  mapper.handleEnvelope({ kind: "note-event", type: "note", payload: { id: "same", pitch: 6400, vel: 100 } }, { sourceId: "b" });
  assert.deepEqual(Array.from(mapper.notes.values()).map((note) => note.channel), [1, 2]);
});

test("cross-channel snapshots do not retrigger attacks or undo newer events", () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message), { mode: "mpe" });
  const context = { sourceId: "tablet" };
  const note = { id: "a", pitch: 6000, vel: 37 };
  const event = (type, seq, payload) => mapper.handleEnvelope({ kind: "note-event", type, seq, payload }, context);
  mapper.handleEnvelope({ kind: "active-notes", seq: 1, activeNotes: [note] }, context);
  event("note", 1, note);
  assert.deepEqual(sent.filter(message => (message[0] & 0xf0) === 0x90), [[0x91, 60, 37]]);
  event("mod", 2, { id: "a", vel: 82, cents: 6100 });
  const count = sent.length;
  mapper.handleEnvelope({ kind: "active-notes", seq: 1, activeNotes: [] }, context);
  assert.equal(sent.length, count);
  assert.equal(mapper.notes.size, 1);
  event("stop", 3, { id: "a" });
  mapper.handleEnvelope({ kind: "active-notes", seq: 2, activeNotes: [note] }, context);
  event("note", 1, note);
  assert.equal(mapper.notes.size, 0);
});

test("unordered modulation before attack preserves velocity and newest MPE values", () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message), { mode: "mpe" });
  const event = (type, seq, payload) => mapper.handleEnvelope({ kind: "note-event", type, seq, payload });
  event("mod", 3, { id: "a", vel: 93, cents: 6200 });
  event("mod", 2, { id: "a", vel: 20, cents: 5900 });
  event("note", 1, { id: "a", pitch: 6000, vel: 41 });
  assert.deepEqual(sent.find(message => (message[0] & 0xf0) === 0x90), [0x91, 60, 41]);
  assert.deepEqual(sent.filter(message => message[0] === 0xd1).at(-1), [0xd1, 93]);
  assert.equal(mapper.notes.get("default:a").cents, 6200);
  event("stop", 4, { id: "a" });
  event("note", 1, { id: "a", pitch: 6000, vel: 41 });
  assert.equal(mapper.notes.size, 0);
});

test("snapshot repairs lost modulation without replaying the note attack", () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message), { mode: "mpe" });
  mapper.handleEnvelope({ kind: "note-event", type: "note", seq: 1, payload: { id: "a", pitch: 6000, vel: 70 } });
  mapper.handleEnvelope({ kind: "active-notes", seq: 2, activeNotes: [
    { id: "a", pitch: 6100, vel: 90, mod: { id: "a", cents: 6100, vel: 90 } }
  ] });
  assert.equal(sent.filter(message => (message[0] & 0xf0) === 0x90).length, 1);
  assert.deepEqual(sent.filter(message => message[0] === 0xd1).at(-1), [0xd1, 90]);
  assert.equal(mapper.notes.get("default:a").cents, 6100);
  mapper.handleEnvelope({ kind: "active-notes", seq: 3, activeNotes: [] });
  mapper.handleEnvelope({ kind: "note-event", type: "note", seq: 1, payload: { id: "a", pitch: 6000, vel: 70 } });
  assert.equal(mapper.notes.size, 0);
});

test("reused MPE channels reset pressure without changing note-on velocity", () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message), { mode: "mpe" });
  mapper.noteOn({ id: "a", pitch: 6000, vel: 120 });
  mapper.modulate({ id: "a", vel: 127 });
  mapper.noteOff("default:a");
  sent.length = 0;
  mapper.noteOn({ id: "b", pitch: 6000, vel: 25 });
  assert.deepEqual(sent[0], [0xd1, 0]);
  assert.deepEqual(sent.at(-1), [0x91, 60, 25]);
});

test('performance controls emit CCs on the device channel without starting notes', () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message));
  const context = { sourceId: 'tablet', standardChannel: 4 };
  mapper.handleEnvelope({ kind: 'midi-cc', controller: 102, value: 64 }, context);
  mapper.handleEnvelope({ kind: 'midi-cc', controller: 110, value: 127, momentary: true }, context);
  mapper.handleEnvelope({ kind: 'active-notes', seq: 999, activeNotes: [] }, context);
  mapper.handleEnvelope({ kind: 'midi-cc', controller: 110, value: 0, momentary: true }, context);
  assert.deepEqual(sent, [[0xb4, 102, 64], [0xb4, 110, 127], [0xb4, 110, 0]]);
  assert.equal(mapper.notes.size, 0);
  assert.equal(mapper.heldControls.size, 0);
});

test('disconnect releases only the source triggers and retains fader positions', () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message));
  mapper.handleEnvelope({ kind: 'midi-cc', controller: 102, value: 80 }, { sourceId: 'a', standardChannel: 2 });
  for (const [sourceId, standardChannel] of [['a', 2], ['b', 5]]) {
    mapper.handleEnvelope({ kind: 'midi-cc', controller: 110, value: 127, momentary: true }, { sourceId, standardChannel });
  }
  sent.length = 0;
  mapper.panicSource('a');
  assert.deepEqual(sent, [[0xb2, 110, 0]]);
  assert.equal(mapper.heldControls.size, 1);
  mapper.panic();
  assert.deepEqual(sent[1], [0xb5, 110, 0]);
  assert.equal(mapper.heldControls.size, 0);
});

test('MPE performance controls use the manager channel and reject invalid control messages', () => {
  const sent = [];
  const mapper = new MidiMapper(message => sent.push(message), { mode: 'mpe' });
  mapper.handleEnvelope({ kind: 'midi-cc', controller: 117, value: 127 }, { standardChannel: 7 });
  for (const payload of [
    { controller: -1, value: 1 }, { controller: 120, value: 0 },
    { controller: 102, value: 128 }, { controller: 102, value: -1 },
    { controller: '102', value: 10 }, { controller: 102, value: NaN },
    { controller: 102.5, value: 10 }, { controller: 102, value: null }
  ]) mapper.handleEnvelope({ kind: 'midi-cc', ...payload });
  assert.deepEqual(sent, [[0xb0, 117, 127]]);
});

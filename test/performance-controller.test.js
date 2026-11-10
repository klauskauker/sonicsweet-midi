"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { MidiMapper } = require('../src/midi-mapper.cjs');
const source = fs.readFileSync(path.join(__dirname, '../src/renderer.js'), 'utf8');

for (const mode of ['standard', 'mpe']) {
  test(`desktop renderer forwards all Performance CCs to MIDI output in ${mode} mode`, async () => {
    const sent = [];
    const mapper = new MidiMapper(bytes => sent.push(bytes), { mode });
    const calls = [];
    const context = { deviceId: 'tablet' };
    const scope = {
      api: { handleMidiEvent: async (envelope, deviceId) => {
        calls.push(deviceId);
        mapper.handleEnvelope(envelope, { sourceId: deviceId, standardChannel: 4 });
        return { ok: true };
      } },
      elements: { midiHelp: { textContent: '' } },
      isDuplicate() { throw new Error('CCs must not enter note-event deduplication'); },
      trackSequence() { throw new Error('CCs must not consume note sequence numbers'); },
      scheduleFeedback() {}
    };
    const start = source.indexOf('function handleDataMessage(');
    vm.runInNewContext(source.slice(start, source.indexOf('function handleSyncMessage(', start)), scope);
    const channel = mode === 'mpe' ? 0xb0 : 0xb4;
    for (let i = 0; i < 8; i++) {
      scope.handleDataMessage(context, JSON.stringify({ kind: 'midi-cc', controller: 102 + i, value: 32 + i }));
      scope.handleDataMessage(context, JSON.stringify({ kind: 'midi-cc', controller: 110 + i, value: 127, momentary: true }));
      scope.handleDataMessage(context, JSON.stringify({ kind: 'midi-cc', controller: 110 + i, value: 0, momentary: true }));
    }
    await Promise.resolve();
    assert.equal(calls.length, 24);
    assert.ok(calls.every(id => id === 'tablet'));
    for (let i = 0; i < 8; i++) assert.deepEqual(sent.slice(i * 3, i * 3 + 3), [
      [channel, 102 + i, 32 + i], [channel, 110 + i, 127], [channel, 110 + i, 0]
    ]);
    assert.equal(mapper.notes.size, 0);
    assert.equal(mapper.heldControls.size, 0);
    assert.equal(scope.elements.midiHelp.textContent, '');
  });
}

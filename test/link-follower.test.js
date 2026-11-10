"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AbletonLinkFollower, alignBeatToPhase } = require("../src/link-follower.cjs");

test("Link beat follows the shared quantum phase instead of the local beat origin", () => {
  assert.equal(alignBeatToPhase(19.25, 0.25, 4), 20.25);
  assert.equal(alignBeatToPhase(19.25, 3.25, 4), 19.25);
  assert.equal(alignBeatToPhase(20.25, 3.25, 4), 19.25);
});

test("Ableton Link follower only writes tempo or transport after an explicit control request", () => {
  const calls = [];
  let intervalCallback = null;
  class FakeLink {
    enableStartStopSync(value) { calls.push(["enableStartStopSync", value]); }
    enable(value) { calls.push(["enable", value]); }
    getTempo() { return 127.5; }
    getBeat() { return 19.25; }
    getPhase(quantum) { calls.push(["getPhase", quantum]); return 3.25; }
    isPlaying() { return true; }
    getNumPeers() { return 2; }
    setTempo(value) { calls.push(["setTempo", value]); }
    setIsPlaying(value) { calls.push(["setIsPlaying", value]); }
  }
  const snapshots = [];
  const follower = new AbletonLinkFollower({
    loadBinding: () => FakeLink,
    now: () => 123456,
    setInterval: (callback) => { intervalCallback = callback; return 7; },
    clearInterval: (timer) => calls.push(["clearInterval", timer]),
    onSnapshot: (snapshot) => snapshots.push(snapshot),
  });

  const status = follower.start({ quantum: 4, startStopSync: true });
  assert.equal(status.enabled, true);
  assert.deepEqual(snapshots[0], {
    kind: "link-sync",
    version: 1,
    enabled: true,
    sequence: 1,
    capturedAt: 123456,
    tempo: 127.5,
    beat: 19.25,
    phase: 3.25,
    quantum: 4,
    playing: true,
    peers: 2,
  });
  intervalCallback();
  assert.equal(snapshots[1].sequence, 2);
  assert.deepEqual(calls.slice(0, 3), [
    ["enableStartStopSync", true],
    ["enable", true],
    ["getPhase", 4],
  ]);
  assert.equal(calls.some(([name]) => name === "setTempo" || name === "setIsPlaying"), false);

  const beforeConfigure = calls.length;
  assert.equal(follower.start({ quantum: 3, startStopSync: true }).quantum, 3);
  assert.deepEqual(calls.slice(beforeConfigure), [["getPhase", 3]]);
  assert.equal(snapshots.at(-1).playing, true);

  const beforeTransportChange = calls.length;
  follower.start({ quantum: 3, startStopSync: false });
  assert.deepEqual(calls.slice(beforeTransportChange), [["enableStartStopSync", false], ["getPhase", 3]]);

  assert.equal(follower.control({ action: "set-tempo", tempo: 132 }).ok, true);
  assert.equal(follower.control({ action: "set-playing", playing: false }).ok, true);
  assert.equal(calls.some((call) => call[0] === "setTempo" && call[1] === 132), true);
  assert.equal(calls.some((call) => call[0] === "setIsPlaying" && call[1] === false), true);

  follower.stop();
  assert.deepEqual(calls.slice(-2), [["clearInterval", 7], ["enable", false]]);
  assert.equal(snapshots.at(-1).enabled, false);
});

test("Ableton Link follower degrades gracefully when the optional binding is absent", () => {
  const follower = new AbletonLinkFollower({
    loadBinding: () => { throw new Error("module missing"); },
  });
  const status = follower.start();
  assert.equal(status.available, false);
  assert.equal(status.enabled, false);
  assert.match(status.error, /module missing/);
});

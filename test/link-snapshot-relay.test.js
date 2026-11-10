"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { relayLinkSnapshot } = require("../src/link-snapshot-relay.cjs");

test("Link snapshots use both sync and reliable control channels", () => {
  const syncMessages = [];
  const controlMessages = [];
  const sync = { readyState: "open", bufferedAmount: 0, send: (value) => syncMessages.push(JSON.parse(value)) };
  const control = { readyState: "open", bufferedAmount: 0, send: (value) => controlMessages.push(JSON.parse(value)) };
  const snapshot = { kind: "link-sync", version: 1, sequence: 4, tempo: 126, peers: 1 };

  assert.equal(relayLinkSnapshot(snapshot, [sync, control]), 2);
  assert.deepEqual(syncMessages, [snapshot]);
  assert.deepEqual(controlMessages, [snapshot]);
});

test("Link relay skips closed, congested and duplicate channels", () => {
  const messages = [];
  const open = { readyState: "open", bufferedAmount: 0, send: (value) => messages.push(value) };
  const congested = { readyState: "open", bufferedAmount: 50000, send: () => assert.fail("congested channel used") };
  const closed = { readyState: "closed", bufferedAmount: 0, send: () => assert.fail("closed channel used") };

  assert.equal(relayLinkSnapshot({ kind: "link-sync" }, [open, open, congested, closed]), 1);
  assert.equal(messages.length, 1);
});

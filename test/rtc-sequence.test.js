const test = require('node:test');
const assert = require('node:assert/strict');
const { trackSequence, sequenceFeedback } = require('../src/rtc-sequence.cjs');

const context = () => ({ seenSeqs: new Set(), highestSeq: 0, highestContiguousSeq: 0 });

test('one lost packet does not permanently report near-total loss or grow tracking storage', () => {
  const state = context();
  for (let seq = 1; seq <= 10000; seq++) if (seq !== 3) trackSequence(state, seq);
  assert.equal(state.highestContiguousSeq, 2);
  assert.equal(sequenceFeedback(state).recentLossEstimate, 0);
  assert.ok(state.seenSeqs.size <= 129);
});

test('recent packet loss is counted and late arrivals repair the estimate', () => {
  const state = context();
  for (let seq = 1; seq <= 80; seq++) if (seq !== 60) trackSequence(state, seq);
  assert.equal(sequenceFeedback(state).recentLossEstimate, 1 / 64);
  trackSequence(state, 60);
  assert.equal(sequenceFeedback(state).recentLossEstimate, 0);
});

test('reconnection at an existing sequence and reordered newest packets do not look like loss', () => {
  const state = context();
  for (const seq of [100, 104, 101, 102, 103]) trackSequence(state, seq);
  assert.equal(state.highestContiguousSeq, 104);
  assert.equal(sequenceFeedback(state).recentLossEstimate, 0);
});

"use strict";

function trackSequence(context, seq) {
  if (!Number.isInteger(seq) || seq <= 0) return;
  if (context.firstSeq == null) {
    context.firstSeq = seq;
    context.highestContiguousSeq = seq - 1;
  }
  context.seenSeqs.add(seq);
  context.highestSeq = Math.max(context.highestSeq, seq);
  while (context.seenSeqs.has(context.highestContiguousSeq + 1)) context.highestContiguousSeq += 1;
  for (const value of context.seenSeqs) {
    if (value < context.highestSeq - 128) context.seenSeqs.delete(value);
  }
}

function sequenceFeedback(context) {
  // Allow four recent events to arrive out of order. A single historical
  // lost packet must not permanently throttle every later gesture.
  const end = context.highestSeq - 4;
  const start = Math.max(context.firstSeq ?? 1, end - 63);
  let missing = 0;
  for (let seq = start; seq <= end; seq++) if (!context.seenSeqs.has(seq)) missing += 1;
  const count = Math.max(0, end - start + 1);
  return {
    ackSeq: context.highestContiguousSeq,
    highestSeq: context.highestSeq,
    gapEstimate: missing,
    recentLossEstimate: count ? missing / count : 0
  };
}

module.exports = { trackSequence, sequenceFeedback };

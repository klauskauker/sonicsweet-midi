"use strict";

function relayLinkSnapshot(snapshot, channels, maxBufferedAmount = 32768) {
  if (!snapshot) return 0;
  const payload = JSON.stringify(snapshot);
  const sent = new Set();
  let count = 0;
  for (const channel of channels || []) {
    if (!channel || sent.has(channel) || channel.readyState !== "open") continue;
    if (Number(channel.bufferedAmount) > maxBufferedAmount) continue;
    try {
      channel.send(payload);
      sent.add(channel);
      count += 1;
    } catch (_error) {}
  }
  return count;
}

module.exports = { relayLinkSnapshot };

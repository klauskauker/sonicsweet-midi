import QRCode from "qrcode";
import { relayLinkSnapshot } from "./link-snapshot-relay.cjs";

const api = window.sonicSweetDesktop;
const elements = Object.fromEntries([
  "qr", "pairing-title", "pairing-detail", "connection-status", "midi-status", "midi-mode", "backend-row", "backend",
  "port-row", "legacy-port", "refresh-midi", "test-note", "panic", "midi-help", "link-enabled", "link-transport",
  "link-quantum", "link-status", "link-detail", "link-beat", "link-phase", "link-playing",
  "server-url", "save-server", "renew", "device-list", "device-table", "device-empty", "global-offset",
  "midi-info", "loopmidi-link"
].map((id) => [id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), document.getElementById(id)]));

let platform = "";
let rtcConfiguration = { iceServers: [] };
let latestLinkSnapshot = null;
let devices = [];
let globalOffsetMs = 0;
const peers = new Map();

function serializeIceCandidate(candidate) {
  if (!candidate) return null;
  const value = typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
  if (!value || !value.candidate || (value.sdpMid == null && value.sdpMLineIndex == null)) return null;
  return value;
}
function createIceCandidate(value) {
  if (!value || !value.candidate || (value.sdpMid == null && value.sdpMLineIndex == null)) return null;
  return new RTCIceCandidate(value);
}
function serializeSessionDescription(description) {
  return description && description.type ? { type: description.type, sdp: String(description.sdp || "") } : null;
}
function createSessionDescription(value) {
  if (!value || !value.type) throw new Error("WebRTC-Sitzungsbeschreibung ohne Typ empfangen.");
  return new RTCSessionDescription({ type: value.type, sdp: String(value.sdp || "") });
}

function setConnectionStatus(label, detail) {
  elements.connectionStatus.textContent = label;
  elements.pairingDetail.textContent = detail || "";
}

function connectedCount() { return Array.from(peers.values()).filter((context) => context.connected).length; }
function updateConnectionSummary() {
  const count = connectedCount();
  setConnectionStatus(count ? `${count} ${count === 1 ? "Gerät" : "Geräte"} verbunden` : "Warte auf SonicSweet …");
}

function cleanupPeer(sessionId) {
  const context = peers.get(sessionId);
  if (!context) return;
  if (context.feedbackTimer) clearTimeout(context.feedbackTimer);
  try { context.peer.close(); } catch (_error) {}
  api.panicDevice(context.deviceId);
  peers.delete(sessionId);
  updateConnectionSummary();
  renderDevices();
}

function isDuplicate(context, id) {
  if (!id) return false;
  const threshold = Date.now() - 10000;
  for (const [key, time] of context.recentMessageIds) if (time < threshold) context.recentMessageIds.delete(key);
  if (context.recentMessageIds.has(id)) return true;
  context.recentMessageIds.set(id, Date.now());
  return false;
}

import { trackSequence, sequenceFeedback } from "./rtc-sequence.cjs";

function scheduleFeedback(context) {
  if (context.feedbackTimer) return;
  context.feedbackTimer = setTimeout(() => {
    context.feedbackTimer = null;
    if (!context.controlChannel || context.controlChannel.readyState !== "open") return;
    context.controlChannel.send(JSON.stringify({
      kind: "control-feedback", ...sequenceFeedback(context), sentAt: Date.now(),
    }));
  }, 80);
}

function handleDataMessage(context, raw) {
  try {
    const envelope = JSON.parse(raw);
    if (envelope.kind === "note-event") {
      if (isDuplicate(context, envelope.messageId)) return scheduleFeedback(context);
      trackSequence(context, envelope.seq);
      scheduleFeedback(context);
    }
    if (envelope.kind === "note-event" || envelope.kind === "active-notes" || envelope.kind === "midi-cc") {
      api.handleMidiEvent(envelope, context.deviceId).then((result) => {
        if (result && result.error) elements.midiHelp.textContent = result.error;
      });
    }
  } catch (error) { elements.midiHelp.textContent = "Ungültige Steuerdaten: " + (error.message || error); }
}

function handleSyncMessage(context, channel, raw) {
  try {
    const message = JSON.parse(raw);
    if (message.kind === "link-command") {
      api.controlLink(message).then((result) => { if (result && result.status) sendLinkSnapshot(result.status); });
      return;
    }
    if (message.kind !== "link-clock-ping" || !Number.isFinite(Number(message.sentAt))) return;
    const desktopReceivedAt = Date.now();
    channel.send(JSON.stringify({ kind: "link-clock-pong", clientSentAt: Number(message.sentAt), desktopReceivedAt, desktopSentAt: Date.now() }));
  } catch (_error) {}
}

function deviceOffset(deviceId) {
  const device = devices.find((item) => item.deviceId === deviceId);
  return Number(device && device.syncOffsetMs) || 0;
}

function sendSnapshotTo(context, snapshot) {
  const adjusted = { ...snapshot, syncOffsetMs: globalOffsetMs + deviceOffset(context.deviceId) };
  relayLinkSnapshot(adjusted, [context.syncChannel, context.controlChannel]);
}

function sendLinkSnapshot(snapshot) {
  latestLinkSnapshot = snapshot;
  for (const context of peers.values()) sendSnapshotTo(context, snapshot);
}

function attachChannel(context, channel) {
  if (channel.label === "control") context.controlChannel = channel;
  if (channel.label === "sync") context.syncChannel = channel;
  channel.onmessage = (event) => {
    if (channel.label === "sync" || channel.label === "control") handleSyncMessage(context, channel, event.data);
    if (channel.label !== "sync") handleDataMessage(context, event.data);
  };
  channel.onopen = () => {
    if ((channel.label === "sync" || channel.label === "control") && latestLinkSnapshot) sendSnapshotTo(context, latestLinkSnapshot);
    if (channel.label === "notes") {
      context.connected = true;
      updateConnectionSummary(); renderDevices();
    }
  };
  channel.onclose = () => {
    if (channel.label === "control") api.panicDevice(context.deviceId);
    if (channel.label === "notes") { context.connected = false; updateConnectionSummary(); renderDevices(); }
  };
}

function createPeerContext(payload) {
  for (const [sessionId, current] of peers) if (current.deviceId === payload.deviceId) cleanupPeer(sessionId);
  const context = {
    sessionId: payload.sessionId, deviceId: payload.deviceId, deviceName: payload.deviceName || "SonicSweet",
    peer: new RTCPeerConnection(rtcConfiguration), pendingCandidates: [], controlChannel: null, syncChannel: null,
    recentMessageIds: new Map(), seenSeqs: new Set(), highestSeq: 0, highestContiguousSeq: 0, feedbackTimer: null, connected: false,
  };
  context.peer.onicecandidate = (event) => {
    const candidate = serializeIceCandidate(event.candidate);
    if (candidate) api.sendSignal({ sessionId: context.sessionId, signal: { candidate } });
  };
  context.peer.ondatachannel = (event) => attachChannel(context, event.channel);
  context.peer.onconnectionstatechange = () => {
    context.connected = context.peer.connectionState === "connected";
    if (["disconnected", "failed", "closed"].includes(context.peer.connectionState)) api.panicDevice(context.deviceId);
    updateConnectionSummary(); renderDevices();
  };
  peers.set(payload.sessionId, context);
  renderDevices();
  return context;
}

async function handleSignal(payload) {
  const context = peers.get(payload && payload.sessionId);
  if (!context || !payload.signal) return;
  if (payload.signal.description) {
    await context.peer.setRemoteDescription(createSessionDescription(payload.signal.description));
    for (const candidate of context.pendingCandidates.splice(0)) await context.peer.addIceCandidate(candidate);
    if (payload.signal.description.type === "offer") {
      const answer = await context.peer.createAnswer();
      await context.peer.setLocalDescription(answer);
      const description = serializeSessionDescription(context.peer.localDescription);
      if (!description) throw new Error("WebRTC-Antwort konnte nicht erstellt werden.");
      await api.sendSignal({ sessionId: context.sessionId, signal: { description } });
    }
  }
  if (payload.signal.candidate) {
    const candidate = createIceCandidate(payload.signal.candidate);
    if (!candidate) return;
    if (context.peer.remoteDescription) await context.peer.addIceCandidate(candidate);
    else context.pendingCandidates.push(candidate);
  }
}

async function renderPairing(pairing) {
  if (!pairing) return;
  const canvas = document.createElement("canvas");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", "QR-Code zum Verbinden mit SonicSweet");
  await QRCode.toCanvas(canvas, pairing.pairingUrl, { width: 192, margin: 4, errorCorrectionLevel: "M" });
  elements.qr.replaceChildren(canvas);
  elements.renew.hidden = true;
  elements.pairingTitle.textContent = "QR-Code mit SonicSweet scannen";
  updateConnectionSummary();
}

function showPairingState(title, loading = false) {
  elements.pairingTitle.textContent = title;
  elements.qr.replaceChildren();
  elements.renew.hidden = true;
  if (loading) {
    const spinner = document.createElement("div");
    spinner.className = "spinner";
    elements.qr.appendChild(spinner);
  }
}

function formatOffset(value) { const number = Number(value) || 0; return `${number > 0 ? "+" : ""}${number} ms`; }

function offsetControl(value, deviceId = "") {
  const wrapper = document.createElement("div");
  wrapper.className = "offset-control";
  wrapper.setAttribute("role", "group");
  wrapper.setAttribute("aria-label", deviceId ? "Geräte-Offset" : "Globaler Sync-Offset");
  for (const [action, label] of [["dec", "−"], ["reset", formatOffset(value)], ["inc", "+"]]) {
    const button = document.createElement("button");
    button.type = "button"; button.className = action === "reset" ? "offset-value" : "offset-step"; button.textContent = label;
    button.setAttribute("aria-label", action === "reset" ? `${label}, auf null zurücksetzen` : action === "inc" ? "5 ms hinzufügen" : "5 ms abziehen");
    button.onclick = async () => {
      const next = action === "reset" ? 0 : Math.max(-250, Math.min(250, value + (action === "inc" ? 5 : -5)));
      if (deviceId) await api.updateDevice({ deviceId, syncOffsetMs: next });
      else { const result = await api.setGlobalOffset(next); globalOffsetMs = result.globalSyncOffsetMs; renderGlobalOffset(); }
      if (latestLinkSnapshot) sendLinkSnapshot(latestLinkSnapshot);
    };
    wrapper.appendChild(button);
  }
  return wrapper;
}

function renderGlobalOffset() {
  elements.globalOffset.innerHTML = "";
  elements.globalOffset.appendChild(offsetControl(globalOffsetMs));
}

function renderDevices() {
  elements.deviceList.replaceChildren();
  elements.deviceTable.hidden = !devices.length;
  elements.deviceEmpty.hidden = Boolean(devices.length);
  const connectedDevices = new Set(Array.from(peers.values()).filter((peer) => peer.connected).map((peer) => peer.deviceId));
  for (const device of devices) {
    const online = connectedDevices.has(device.deviceId);
    const row = document.createElement("tr");
    const nameCell = document.createElement("th");
    nameCell.scope = "row";
    const heading = document.createElement("div");
    heading.className = "device-heading";
    const dot = document.createElement("span");
    dot.className = online ? "device-dot online" : "device-dot";
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", online ? "Verbunden" : "Offline");
    const name = document.createElement("span");
    name.className = "device-name";
    name.textContent = device.name;
    heading.title = `${device.name} · ${online ? "Verbunden" : "Offline"}`;
    heading.append(dot, name);
    nameCell.appendChild(heading);
    row.appendChild(nameCell);
    const channelCell = row.insertCell();
    const select = document.createElement("select");
    for (let channel = 1; channel <= 16; channel += 1) { const option = document.createElement("option"); option.value = channel; option.textContent = String(channel); select.appendChild(option); }
    select.value = String(device.midiChannel); select.disabled = elements.midiMode.value === "mpe";
    select.setAttribute("aria-label", `MIDI-Kanal für ${device.name}`);
    if (select.disabled) select.title = "Im MPE-Modus werden die Kanäle automatisch vergeben.";
    select.onchange = () => api.updateDevice({ deviceId: device.deviceId, midiChannel: Number(select.value) });
    channelCell.appendChild(select);
    row.insertCell().appendChild(offsetControl(device.syncOffsetMs, device.deviceId));
    const forget = document.createElement("button"); forget.type = "button"; forget.className = "text-danger"; forget.textContent = "Gerät vergessen";
    forget.setAttribute("aria-label", `${device.name} vergessen`);
    forget.onclick = () => api.forgetDevice(device.deviceId);
    row.insertCell().appendChild(forget);
    elements.deviceList.appendChild(row);
  }
}

function renderLinkStatus(status) {
  const safe = status || {};
  const requested = elements.linkEnabled.checked;
  const active = requested && safe.enabled;
  const count = Number(safe.peers) || 0;
  elements.linkTransport.disabled = !active;
  elements.linkQuantum.disabled = !active;
  elements.linkBeat.textContent = active ? Number(safe.beat || 0).toFixed(2) : "—";
  elements.linkPhase.textContent = active ? Number(safe.phase || 0).toFixed(2) : "—";
  const followsTransport = active && elements.linkTransport.checked;
  elements.linkPlaying.textContent = followsTransport && count ? (safe.playing ? "Läuft" : "Gestoppt") : "—";
  const unavailable = requested && safe.available === false;
  const detail = unavailable ? (safe.error || "Ableton Link konnte nicht geladen werden.") : (requested && safe.error) || "";
  if (elements.linkDetail.textContent !== detail) elements.linkDetail.textContent = detail;
  if (!requested) elements.linkStatus.textContent = "Aus";
  else if (unavailable) elements.linkStatus.textContent = "Nicht verfügbar";
  else if (!active) elements.linkStatus.textContent = detail ? "Fehler" : "Wird gestartet …";
  else elements.linkStatus.textContent = `${Number(safe.tempo || 0).toFixed(1)} BPM · ${count} ${count === 1 ? "Peer" : "Peers"}`;
}
async function applyLinkSettings() { renderLinkStatus(await api.configureLink({ linkEnabled: elements.linkEnabled.checked, linkStartStopSync: elements.linkTransport.checked, linkQuantum: Number(elements.linkQuantum.value) || 4 })); }

function populatePorts(ports, selectedName) {
  elements.legacyPort.innerHTML = "";
  const list = Array.isArray(ports) ? ports : [];
  if (!list.length) { const option = document.createElement("option"); option.value = ""; option.textContent = "Kein MIDI-Ausgang gefunden"; elements.legacyPort.appendChild(option); elements.legacyPort.disabled = true; return; }
  elements.legacyPort.disabled = false;
  const placeholder = new Option("Port auswählen …", "", true, true);
  placeholder.disabled = true;
  elements.legacyPort.appendChild(placeholder);
  for (const port of list) { const option = document.createElement("option"); option.value = port.name; option.textContent = port.name; elements.legacyPort.appendChild(option); }
  elements.legacyPort.value = list.some((port) => port.name === selectedName) ? selectedName : "";
}
function renderMidiStatus(status) {
  const safe = status || {};
  const showPorts = platform === "win32" && safe.kind !== "windows-midi-services" && elements.backend.value !== "modern";
  elements.portRow.hidden = !showPorts;
  elements.refreshMidi.hidden = !showPorts;
  if (showPorts) populatePorts(safe.ports, safe.portName || elements.legacyPort.value);
  elements.testNote.disabled = !safe.open;
  if (safe.open) {
    const kind = safe.kind === "windows-midi-services" ? "Windows MIDI Services" : safe.kind === "coremidi-virtual" ? "CoreMIDI" : "Klassisches MIDI";
    elements.midiStatus.textContent = safe.portName;
    elements.midiStatus.title = kind;
    elements.midiHelp.textContent = "";
  } else {
    elements.midiStatus.textContent = "Kein Ausgang geöffnet";
    elements.midiStatus.removeAttribute("title");
    elements.midiHelp.textContent = safe.error || (showPorts ? "MIDI-Port auswählen oder loopMIDI einrichten." : "");
  }
  renderDevices();
}
async function applyMidiSettings() { renderMidiStatus(await api.configureMidi({ midiMode: elements.midiMode.value, backend: elements.backend.value, legacyPortName: elements.legacyPort.value })); }

api.on("pairing:created", renderPairing);
api.on("pairing:pending", () => {
  showPairingState("QR-Code wird erstellt …", true);
  elements.pairingDetail.textContent = "";
});
api.on("pairing:server", (status) => {
  if (status.connected) {
    showPairingState("QR-Code wird erstellt …", true);
    setConnectionStatus("Server verbunden");
  } else {
    for (const sessionId of peers.keys()) cleanupPeer(sessionId);
    showPairingState("Server nicht verbunden");
    setConnectionStatus("Server nicht verbunden");
  }
});
api.on("pairing:error", (error) => {
  showPairingState("QR-Code nicht verfügbar");
  setConnectionStatus("Serverfehler", error.message);
  elements.renew.hidden = !error.retryable;
});
api.on("pairing:peer-ready", (payload) => { createPeerContext(payload); setConnectionStatus("SonicSweet erkannt", "WebRTC-Verbindung wird aufgebaut …"); });
api.on("pairing:signal", (payload) => handleSignal(payload).catch((error) => setConnectionStatus("WebRTC-Fehler", error.message)));
api.on("pairing:peer-disconnected", (payload) => cleanupPeer(payload.sessionId));
api.on("devices:changed", (next) => { devices = next || []; renderDevices(); if (latestLinkSnapshot) sendLinkSnapshot(latestLinkSnapshot); });
api.on("offset:changed", (next) => { globalOffsetMs = Number(next.globalSyncOffsetMs) || 0; renderGlobalOffset(); });
api.on("midi:status", renderMidiStatus);
api.on("link:status", renderLinkStatus);
api.on("link:snapshot", sendLinkSnapshot);

elements.midiMode.onchange = applyMidiSettings; elements.backend.onchange = applyMidiSettings; elements.legacyPort.onchange = applyMidiSettings;
elements.refreshMidi.onclick = async () => { const result = await api.refreshMidi(); populatePorts(result.ports, elements.legacyPort.value); await applyMidiSettings(); };
elements.testNote.onclick = async () => {
  const id = "desktop-test-" + Date.now(); const result = await api.handleMidiEvent({ kind: "note-event", type: "note", payload: { id, pitch: 6000, vel: 100 } }, "desktop-test");
  if (!result.ok) elements.midiHelp.textContent = result.error;
  setTimeout(() => api.handleMidiEvent({ kind: "note-event", type: "stop", payload: { id } }, "desktop-test"), 300);
};
elements.panic.onclick = () => api.panic(); elements.linkEnabled.onchange = applyLinkSettings; elements.linkTransport.onchange = applyLinkSettings; elements.linkQuantum.onchange = applyLinkSettings;
elements.renew.onclick = () => api.renewPairing();
const midiInfoButtons = document.querySelectorAll("[data-midi-info]");
for (const button of midiInfoButtons) button.onclick = () => elements.midiInfo.showModal();
elements.loopmidiLink.onclick = (event) => {
  event.preventDefault();
  api.openExternal(elements.loopmidiLink.href);
};
elements.saveServer.onclick = async () => { try { await api.setServer(elements.serverUrl.value); } catch (error) { setConnectionStatus("Ungültige Server-Adresse", error.message || String(error)); } };

api.getState().then((initial) => {
  platform = initial.platform; rtcConfiguration = initial.rtcConfig || rtcConfiguration; devices = initial.devices || []; globalOffsetMs = Number(initial.settings.globalSyncOffsetMs) || 0;
  elements.backendRow.hidden = platform !== "win32";
  for (const button of midiInfoButtons) button.hidden = platform !== "win32";
  elements.midiMode.value = initial.settings.midiMode || "standard";
  elements.backend.value = initial.settings.backend || "auto"; elements.serverUrl.value = initial.settings.serverUrl || ""; elements.linkEnabled.checked = initial.settings.linkEnabled === true;
  elements.linkTransport.checked = initial.settings.linkStartStopSync !== false; elements.linkQuantum.value = String(initial.settings.linkQuantum || 4);
  renderMidiStatus(initial.midiStatus); renderLinkStatus(initial.linkStatus); renderGlobalOffset(); renderDevices(); if (initial.pairing) renderPairing(initial.pairing);
});

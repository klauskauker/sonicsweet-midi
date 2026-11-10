"use strict";

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { io } = require("socket.io-client");
const { MidiMapper } = require("./midi-mapper.cjs");
const { RtMidiBackend, WindowsMidiServicesBackend } = require("./midi-backend.cjs");
const { AbletonLinkFollower } = require("./link-follower.cjs");

const APP_NAME = "SonicSweet MIDI";
const APP_ICON = path.join(__dirname, "sonicsweet.png");
const userDataPath = app.getPath("userData");
app.setName(APP_NAME);
app.setPath("userData", userDataPath);

let mainWindow = null;
let signalSocket = null;
let currentPairing = null;
let pairingRequestPending = false;
let activeBackend = null;
let quitting = false;
const activeSessions = new Map();
const rtMidi = new RtMidiBackend();
const windowsMidiServices = new WindowsMidiServicesBackend();
const DEFAULT_SERVER_URL = "https://sonicsweet.de";
let settings = {
  schemaVersion: 4,
  serverUrl: process.env.SONICSWEET_SERVER_URL || DEFAULT_SERVER_URL,
  midiMode: "standard",
  backend: "auto",
  legacyPortName: "",
  linkEnabled: false,
  linkQuantum: 4,
  linkStartStopSync: true,
  globalSyncOffsetMs: 0,
  bridgeId: "",
  bridgeSecret: "",
  devices: {},
  revokedDeviceIds: [],
};

const mapper = new MidiMapper((message) => {
  if (activeBackend) activeBackend.send(message);
}, { mode: settings.midiMode });
const linkFollower = new AbletonLinkFollower({
  onSnapshot: (snapshot) => sendToRenderer("link:snapshot", snapshot),
  onStatus: (status) => sendToRenderer("link:status", status),
});

function clampOffset(value) {
  return Math.max(-250, Math.min(250, Math.round((Number(value) || 0) / 5) * 5));
}

function cleanChannel(value) { return Math.max(1, Math.min(16, Math.round(Number(value) || 1))); }

function buildRtcConfig() {
  const turnUrls = String(process.env.SONICSWEET_TURN_URLS || "").split(",").map((url) => url.trim()).filter(Boolean);
  const iceServers = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  if (turnUrls.length) iceServers.push({
    urls: turnUrls,
    username: process.env.SONICSWEET_TURN_USERNAME || "",
    credential: process.env.SONICSWEET_TURN_CREDENTIAL || "",
  });
  return { iceServers };
}

function configPath() { return path.join(app.getPath("userData"), "settings.json"); }

function loadSettings() {
  try {
    const loaded = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    settings = Object.assign(settings, loaded);
    if ((!loaded.schemaVersion || loaded.schemaVersion < 2) && /^http:\/\/(localhost|127\.0\.0\.1)(?::|\/|$)/i.test(settings.serverUrl)) settings.serverUrl = DEFAULT_SERVER_URL;
  } catch (_error) {}
  if (process.env.SONICSWEET_SERVER_URL) settings.serverUrl = process.env.SONICSWEET_SERVER_URL;
  settings.schemaVersion = 4;
  settings.midiMode = settings.midiMode === "mpe" ? "mpe" : "standard";
  settings.linkEnabled = settings.linkEnabled === true;
  settings.linkStartStopSync = settings.linkStartStopSync !== false;
  settings.linkQuantum = Math.max(1, Number(settings.linkQuantum) || 4);
  settings.globalSyncOffsetMs = clampOffset(settings.globalSyncOffsetMs);
  settings.bridgeId = String(settings.bridgeId || crypto.randomUUID());
  settings.bridgeSecret = String(settings.bridgeSecret || crypto.randomBytes(32).toString("base64url"));
  settings.devices = settings.devices && typeof settings.devices === "object" ? settings.devices : {};
  settings.revokedDeviceIds = Array.isArray(settings.revokedDeviceIds) ? settings.revokedDeviceIds.slice(-200) : [];
  for (const device of Object.values(settings.devices)) {
    device.midiChannel = cleanChannel(device.midiChannel);
    device.syncOffsetMs = clampOffset(device.syncOffsetMs);
  }
  saveSettings();
}

function saveSettings() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(settings, null, 2));
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function listLegacyPorts() {
  try { return rtMidi.listPorts(); }
  catch (_error) { return []; }
}

function nextMidiChannel() {
  const used = new Set(Object.values(settings.devices).map((device) => cleanChannel(device.midiChannel)));
  for (let channel = 1; channel <= 16; channel += 1) if (!used.has(channel)) return channel;
  return (Object.keys(settings.devices).length % 16) + 1;
}

function upsertDevice(payload) {
  const deviceId = String(payload.deviceId || "");
  if (!deviceId) throw new Error("Geräte-ID fehlt.");
  const previous = settings.devices[deviceId] || {};
  settings.devices[deviceId] = {
    name: String(payload.deviceName || previous.name || "SonicSweet").slice(0, 80),
    midiChannel: cleanChannel(previous.midiChannel || nextMidiChannel()),
    syncOffsetMs: clampOffset(previous.syncOffsetMs),
    trustedAt: previous.trustedAt || Date.now(),
    lastSeen: Date.now(),
  };
  settings.revokedDeviceIds = settings.revokedDeviceIds.filter((id) => id !== deviceId);
  saveSettings();
  return settings.devices[deviceId];
}

function publicDevices() {
  const connected = new Set(Array.from(activeSessions.values()).map((session) => session.deviceId));
  return Object.entries(settings.devices).map(([deviceId, device]) => ({
    deviceId,
    name: device.name,
    midiChannel: cleanChannel(device.midiChannel),
    syncOffsetMs: clampOffset(device.syncOffsetMs),
    connected: connected.has(deviceId),
    lastSeen: device.lastSeen || 0,
  })).sort((a, b) => Number(b.connected) - Number(a.connected) || b.lastSeen - a.lastSeen);
}

function publishDevices() { sendToRenderer("devices:changed", publicDevices()); }

function publicSettings() {
  return {
    schemaVersion: settings.schemaVersion,
    serverUrl: settings.serverUrl,
    midiMode: settings.midiMode,
    backend: settings.backend,
    legacyPortName: settings.legacyPortName,
    linkEnabled: settings.linkEnabled,
    linkQuantum: settings.linkQuantum,
    linkStartStopSync: settings.linkStartStopSync,
    globalSyncOffsetMs: settings.globalSyncOffsetMs,
  };
}

function createReconnectToken(deviceId) {
  const body = Buffer.from(JSON.stringify({ v: 1, bridgeId: settings.bridgeId, deviceId })).toString("base64url");
  const signature = crypto.createHmac("sha256", settings.bridgeSecret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyReconnectToken(token, deviceId) {
  try {
    const [body, signature] = String(token || "").split(".");
    if (!body || !signature) return false;
    const expected = crypto.createHmac("sha256", settings.bridgeSecret).update(body).digest();
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.v === 1 && payload.bridgeId === settings.bridgeId && payload.deviceId === deviceId;
  } catch (_error) { return false; }
}

function configureLink(next = {}) {
  settings = Object.assign(settings, next);
  settings.linkEnabled = settings.linkEnabled === true;
  settings.linkStartStopSync = settings.linkStartStopSync !== false;
  settings.linkQuantum = Math.max(1, Number(settings.linkQuantum) || 4);
  const status = settings.linkEnabled
    ? linkFollower.start({ quantum: settings.linkQuantum, startStopSync: settings.linkStartStopSync })
    : linkFollower.stop();
  saveSettings();
  return status;
}

async function configureMidi(next = {}) {
  settings = Object.assign(settings, next);
  try { mapper.panic(); } catch (_error) {}
  mapper.mode = settings.midiMode === "mpe" ? "mpe" : "standard";
  if (activeBackend && typeof activeBackend.close === "function") activeBackend.close();
  activeBackend = null;
  if (process.platform === "darwin") {
    activeBackend = rtMidi;
    const status = rtMidi.openMacVirtual("SonicSweet MIDI");
    if (mapper.mode === "mpe") mapper.initializeMpe();
    saveSettings();
    return { ...status, requestedBackend: settings.backend, ports: [] };
  }
  if (process.platform === "win32" && settings.backend !== "legacy") {
    const probe = await windowsMidiServices.probe();
    if (probe.available) {
      try {
        await windowsMidiServices.open("SonicSweet MIDI");
        activeBackend = windowsMidiServices;
        if (mapper.mode === "mpe") mapper.initializeMpe();
        saveSettings();
        return { open: true, kind: "windows-midi-services", portName: "SonicSweet MIDI", probe, ports: listLegacyPorts() };
      } catch (error) { if (settings.backend === "modern") throw error; }
    } else if (settings.backend === "modern") throw new Error("Windows MIDI Services sind nicht verfügbar: " + (probe.reason || "unbekannter Fehler"));
  }
  const ports = listLegacyPorts();
  const selected = ports.find((port) => port.name === settings.legacyPortName) || ports.find((port) => /sonicsweet|loopmidi/i.test(port.name));
  if (selected) {
    activeBackend = rtMidi;
    const status = rtMidi.openPort(selected.index);
    if (mapper.mode === "mpe") mapper.initializeMpe();
    settings.legacyPortName = selected.name;
    saveSettings();
    return { ...status, requestedBackend: settings.backend, ports };
  }
  saveSettings();
  return { open: false, kind: "legacy-output", portName: "", requestedBackend: settings.backend, needsPort: true, ports };
}

function createPairing() {
  if (!signalSocket || !signalSocket.connected || pairingRequestPending) return;
  const socket = signalSocket;
  const socketId = socket.id;
  currentPairing = null;
  pairingRequestPending = true;
  sendToRenderer("pairing:pending");
  socket.timeout(8000).emit("midi-pairing:create", {}, (error, result) => {
    if (socket !== signalSocket || socket.id !== socketId || !socket.connected) return;
    pairingRequestPending = false;
    if (error) return sendToRenderer("pairing:error", { message: "Der Server antwortet nicht auf MIDI-Pairing.", retryable: true });
    if (!result || !result.ok) return sendToRenderer("pairing:error", { message: "Der SonicSweet-Server konnte keinen Pairing-Code erstellen.", retryable: true });
    currentPairing = result;
    sendToRenderer("pairing:created", result);
  });
}

function rejectSession(payload, reason = "forgotten") {
  if (signalSocket) signalSocket.emit("midi-pairing:leave", { sessionId: payload.sessionId, reason });
}

function acceptPeer(payload = {}) {
  const deviceId = String(payload.deviceId || "");
  if (!deviceId) return rejectSession(payload, "invalid-device");
  if (payload.persistent) {
    if (!settings.devices[deviceId] || settings.revokedDeviceIds.includes(deviceId) || !verifyReconnectToken(payload.reconnectToken, deviceId)) {
      return rejectSession(payload, "forgotten");
    }
    upsertDevice(payload);
  } else {
    upsertDevice(payload);
    signalSocket.emit("midi-pairing:authorize", {
      sessionId: payload.sessionId,
      reconnectToken: createReconnectToken(deviceId),
    });
  }
  for (const [sessionId, active] of Array.from(activeSessions.entries())) {
    if (active.deviceId === deviceId && sessionId !== payload.sessionId) {
      signalSocket.emit("midi-pairing:leave", { sessionId, reason: "reconnected" });
      activeSessions.delete(sessionId);
    }
  }
  activeSessions.set(payload.sessionId, { deviceId, deviceName: payload.deviceName || "SonicSweet" });
  publishDevices();
  sendToRenderer("pairing:peer-ready", payload);
  if (!payload.persistent) createPairing();
}

function disconnectSession(payload = {}) {
  const active = activeSessions.get(String(payload.sessionId || ""));
  if (!active) return;
  activeSessions.delete(payload.sessionId);
  mapper.panicSource(active.deviceId);
  sendToRenderer("pairing:peer-disconnected", { ...payload, deviceId: active.deviceId });
  publishDevices();
}

function connectSignalServer() {
  if (signalSocket) signalSocket.close();
  activeSessions.clear();
  currentPairing = null;
  pairingRequestPending = false;
  signalSocket = io(settings.serverUrl, { query: { type: "midi-bridge" }, reconnection: true });
  signalSocket.on("connect", () => {
    sendToRenderer("pairing:server", { connected: true });
    signalSocket.timeout(8000).emit("midi-pairing:register-bridge", { bridgeId: settings.bridgeId }, (error, result) => {
      if (error || !result || !result.ok) return sendToRenderer("pairing:error", { message: "Die Desktop-Bridge konnte nicht registriert werden." });
      createPairing();
    });
  });
  signalSocket.on("connect_error", (error) => sendToRenderer("pairing:error", { message: `SonicSweet-Server nicht erreichbar (${settings.serverUrl}). ${error && error.message ? error.message : error}` }));
  signalSocket.on("disconnect", () => {
    currentPairing = null;
    pairingRequestPending = false;
    for (const active of activeSessions.values()) mapper.panicSource(active.deviceId);
    activeSessions.clear();
    publishDevices();
    sendToRenderer("pairing:server", { connected: false });
  });
  signalSocket.on("midi-pairing:peer-ready", acceptPeer);
  signalSocket.on("midi-pairing:signal", (payload) => {
    if (activeSessions.has(String(payload && payload.sessionId || ""))) sendToRenderer("pairing:signal", payload);
  });
  signalSocket.on("midi-pairing:expired", (payload) => {
    if (currentPairing && payload && currentPairing.sessionId === payload.sessionId) createPairing();
  });
  signalSocket.on("midi-pairing:disconnected", disconnectSession);
}

function registerIpc() {
  ipcMain.handle("app:get-state", async () => {
    let midiStatus;
    try { midiStatus = await configureMidi(); }
    catch (error) { midiStatus = { open: false, error: error.message || String(error), ports: listLegacyPorts() }; }
    return { settings: publicSettings(), devices: publicDevices(), midiStatus, linkStatus: linkFollower.getStatus(), platform: process.platform, pairing: currentPairing, rtcConfig: buildRtcConfig() };
  });
  ipcMain.handle("midi:configure", async (_event, next) => {
    try {
      const status = await configureMidi(next || {});
      sendToRenderer("midi:status", status);
      return status;
    } catch (error) { return { open: false, error: error.message || String(error), ports: listLegacyPorts() }; }
  });
  ipcMain.handle("midi:refresh", async () => ({ ports: listLegacyPorts() }));
  ipcMain.handle("midi:event", (_event, input = {}) => {
    try {
      if (!activeBackend) throw new Error("Kein MIDI-Ausgang geöffnet.");
      const deviceId = String(input.deviceId || "desktop-test");
      const device = settings.devices[deviceId];
      mapper.handleEnvelope(input.envelope || input, { sourceId: deviceId, standardChannel: cleanChannel(device && device.midiChannel) - 1 });
      return { ok: true };
    } catch (error) { return { ok: false, error: error.message || String(error) }; }
  });
  ipcMain.handle("midi:panic", () => { try { mapper.panic(); return { ok: true }; } catch (error) { return { ok: false, error: error.message || String(error) }; } });
  ipcMain.handle("midi:panic-device", (_event, deviceId) => { mapper.panicSource(String(deviceId || "")); return { ok: true }; });
  ipcMain.handle("link:configure", (_event, next) => configureLink(next || {}));
  ipcMain.handle("link:control", (_event, command) => linkFollower.control(command || {}));
  ipcMain.handle("pairing:signal", (_event, payload) => { if (signalSocket) signalSocket.emit("midi-pairing:signal", payload); });
  ipcMain.handle("pairing:renew", () => createPairing());
  ipcMain.handle("devices:update", (_event, input = {}) => {
    const device = settings.devices[String(input.deviceId || "")];
    if (!device) throw new Error("Gerät nicht gefunden.");
    if (Object.prototype.hasOwnProperty.call(input, "midiChannel")) device.midiChannel = cleanChannel(input.midiChannel);
    if (Object.prototype.hasOwnProperty.call(input, "syncOffsetMs")) device.syncOffsetMs = clampOffset(input.syncOffsetMs);
    saveSettings(); publishDevices();
    return { ok: true, devices: publicDevices() };
  });
  ipcMain.handle("devices:forget", (_event, deviceIdValue) => {
    const deviceId = String(deviceIdValue || "");
    delete settings.devices[deviceId];
    settings.revokedDeviceIds = Array.from(new Set(settings.revokedDeviceIds.concat(deviceId))).slice(-200);
    for (const [sessionId, active] of Array.from(activeSessions.entries())) {
      if (active.deviceId === deviceId) {
        mapper.panicSource(deviceId);
        if (signalSocket) signalSocket.emit("midi-pairing:leave", { sessionId, reason: "forgotten" });
        activeSessions.delete(sessionId);
        sendToRenderer("pairing:peer-disconnected", { sessionId, deviceId, reason: "forgotten" });
      }
    }
    saveSettings(); publishDevices();
    return { ok: true, devices: publicDevices() };
  });
  ipcMain.handle("settings:set-global-offset", (_event, value) => {
    settings.globalSyncOffsetMs = clampOffset(value);
    saveSettings();
    sendToRenderer("offset:changed", { globalSyncOffsetMs: settings.globalSyncOffsetMs });
    return { ok: true, globalSyncOffsetMs: settings.globalSyncOffsetMs };
  });
  ipcMain.handle("settings:set-server", (_event, serverUrl) => {
    const parsed = new URL(String(serverUrl || ""));
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Die Server-Adresse muss mit http:// oder https:// beginnen.");
    settings.serverUrl = parsed.toString().replace(/\/$/, "");
    saveSettings(); connectSignalServer(); return { ok: true };
  });
  ipcMain.handle("shell:open-external", (_event, url) => { const parsed = new URL(url); if (parsed.protocol === "https:") return shell.openExternal(parsed.toString()); });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 760, height: 820, minWidth: 620, minHeight: 600, backgroundColor: "#151211", title: APP_NAME,
    icon: APP_ICON,
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  mainWindow.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  app.dock?.setIcon(APP_ICON);
  loadSettings(); mapper.mode = settings.midiMode; registerIpc(); createWindow(); connectSignalServer(); configureLink();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("before-quit", () => {
  if (quitting) return;
  quitting = true;
  try { mapper.panic(); } catch (_error) {}
  if (activeBackend && typeof activeBackend.close === "function") activeBackend.close();
  linkFollower.close();
  if (signalSocket) signalSocket.close();
});
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

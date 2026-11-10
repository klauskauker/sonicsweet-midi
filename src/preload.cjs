"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sonicSweetDesktop", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  configureMidi: (settings) => ipcRenderer.invoke("midi:configure", settings),
  refreshMidi: () => ipcRenderer.invoke("midi:refresh"),
  handleMidiEvent: (envelope, deviceId) => ipcRenderer.invoke("midi:event", { envelope, deviceId }),
  panic: () => ipcRenderer.invoke("midi:panic"),
  panicDevice: (deviceId) => ipcRenderer.invoke("midi:panic-device", deviceId),
  configureLink: (settings) => ipcRenderer.invoke("link:configure", settings),
  controlLink: (command) => ipcRenderer.invoke("link:control", command),
  sendSignal: (payload) => ipcRenderer.invoke("pairing:signal", payload),
  renewPairing: () => ipcRenderer.invoke("pairing:renew"),
  updateDevice: (settings) => ipcRenderer.invoke("devices:update", settings),
  forgetDevice: (deviceId) => ipcRenderer.invoke("devices:forget", deviceId),
  setGlobalOffset: (value) => ipcRenderer.invoke("settings:set-global-offset", value),
  setServer: (url) => ipcRenderer.invoke("settings:set-server", url),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  on: (channel, listener) => {
    const allowed = new Set([
      "pairing:created", "pairing:pending", "pairing:error", "pairing:server", "pairing:peer-ready",
      "pairing:signal", "pairing:peer-disconnected", "midi:status",
      "link:status", "link:snapshot", "devices:changed", "offset:changed"
    ]);
    if (!allowed.has(channel)) return function () {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});

"use strict";

const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

class RtMidiBackend {
  constructor(platform = process.platform) {
    this.platform = platform;
    this.output = null;
    this.midi = null;
    this.kind = "closed";
    this.portName = "";
  }

  load() {
    if (!this.midi) this.midi = require("@julusian/midi/lazy");
    this.midi.verifyLibraryLoaded();
  }

  listPorts() {
    this.load();
    const probe = new this.midi.Output();
    try {
      const ports = [];
      for (let index = 0; index < probe.getPortCount(); index += 1) {
        ports.push({ index, name: probe.getPortName(index) });
      }
      return ports;
    } finally {
      probe.closePort();
    }
  }

  close() {
    if (this.output) {
      try { this.output.closePort(); } catch (_error) {}
    }
    this.output = null;
    this.kind = "closed";
    this.portName = "";
  }

  openMacVirtual(name = "SonicSweet MIDI") {
    if (this.platform !== "darwin") throw new Error("Virtual CoreMIDI ports are only available on macOS.");
    this.close();
    this.load();
    this.output = new this.midi.Output();
    this.output.openVirtualPort(name);
    this.kind = "coremidi-virtual";
    this.portName = name;
    return this.status();
  }

  openPort(index) {
    const ports = this.listPorts();
    const selected = ports.find((port) => port.index === Number(index));
    if (!selected) throw new Error("Der ausgewählte MIDI-Ausgang ist nicht mehr verfügbar.");
    this.close();
    this.load();
    this.output = new this.midi.Output();
    this.output.openPort(selected.index);
    this.kind = "legacy-output";
    this.portName = selected.name;
    return this.status();
  }

  send(message) {
    if (!this.output) throw new Error("Kein MIDI-Ausgang geöffnet.");
    this.output.sendMessage(Array.from(message));
  }

  status() {
    return { open: !!this.output, kind: this.kind, portName: this.portName };
  }
}

class WindowsMidiServicesBackend {
  constructor(options = {}) {
    this.executable = options.executable || path.join(process.resourcesPath || "", "windows-midi-services", "SonicSweetMidiServices.exe");
    this.process = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 0;
  }

  async probe() {
    if (process.platform !== "win32") return { available: false, reason: "wrong-platform" };
    if (!existsSync(this.executable)) return { available: false, reason: "helper-not-packaged" };
    try {
      const result = await this.request("probe");
      return result && result.available ? result : { available: false, reason: result && result.reason || "service-unavailable" };
    } catch (error) {
      return { available: false, reason: error.message || String(error) };
    }
  }

  startProcess() {
    if (this.process) return;
    this.process = spawn(this.executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.process.stdout.setEncoding("utf8");
    this.process.stdout.on("data", (chunk) => this.consume(chunk));
    this.process.on("exit", () => {
      const error = new Error("Windows MIDI Services helper wurde beendet.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
      this.process = null;
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const response = JSON.parse(line);
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        if (response.ok === false) pending.reject(new Error(response.error || "MIDI Services error"));
        else pending.resolve(response.result || response);
      } catch (_error) {}
    }
  }

  request(command, payload = {}) {
    this.startProcess();
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ id, command, ...payload }) + "\n");
    });
  }

  open(name = "SonicSweet MIDI") {
    return this.request("open", { name });
  }

  send(message) {
    if (!this.process) throw new Error("Windows MIDI Services ist nicht geöffnet.");
    this.process.stdin.write(JSON.stringify({ command: "send", bytes: Array.from(message) }) + "\n");
  }

  close() {
    if (!this.process) return;
    try { this.process.stdin.write(JSON.stringify({ command: "close" }) + "\n"); } catch (_error) {}
    this.process.kill();
    this.process = null;
  }
}

module.exports = { RtMidiBackend, WindowsMidiServicesBackend };

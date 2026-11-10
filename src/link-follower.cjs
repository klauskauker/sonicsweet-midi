"use strict";

function defaultLoadBinding() {
  const binding = require("@ktamas77/abletonlink");
  return binding.AbletonLink || binding.default || binding;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function alignBeatToPhase(beat, phase, quantum) {
  const safeQuantum = Math.max(1, finiteNumber(quantum, 4));
  const safeBeat = finiteNumber(beat, 0);
  const safePhase = positiveModulo(finiteNumber(phase, 0), safeQuantum);
  const beatPhase = positiveModulo(safeBeat, safeQuantum);
  const delta = positiveModulo(safePhase - beatPhase + safeQuantum / 2, safeQuantum) - safeQuantum / 2;
  return safeBeat + delta;
}

class AbletonLinkFollower {
  constructor(options = {}) {
    this.loadBinding = options.loadBinding || defaultLoadBinding;
    this.now = options.now || Date.now;
    this.setInterval = options.setInterval || setInterval;
    this.clearInterval = options.clearInterval || clearInterval;
    this.onSnapshot = options.onSnapshot || function () {};
    this.onStatus = options.onStatus || function () {};
    this.intervalMs = Math.max(20, finiteNumber(options.intervalMs, 50));
    this.initialTempo = Math.max(20, finiteNumber(options.initialTempo, 120));
    this.quantum = Math.max(1, finiteNumber(options.quantum, 4));
    this.link = null;
    this.timer = null;
    this.startStopSync = null;
    this.sequence = 0;
    this.status = {
      available: null,
      enabled: false,
      peers: 0,
      tempo: this.initialTempo,
      beat: 0,
      phase: 0,
      playing: false,
      quantum: this.quantum,
      error: "",
    };
  }

  getStatus() {
    return { ...this.status };
  }

  emitStatus(next = {}) {
    this.status = { ...this.status, ...next };
    this.onStatus(this.getStatus());
    return this.getStatus();
  }

  ensureLink() {
    if (this.link) return this.link;
    const AbletonLink = this.loadBinding();
    if (typeof AbletonLink !== "function") throw new Error("Das Ableton-Link-Modul stellt keinen Link-Client bereit.");
    this.link = new AbletonLink(this.initialTempo);
    return this.link;
  }

  start(options = {}) {
    this.quantum = Math.max(1, finiteNumber(options.quantum, this.quantum));
    const startStopSync = options.startStopSync !== false;
    try {
      const link = this.ensureLink();
      if (!this.status.enabled || this.startStopSync !== startStopSync) {
        link.enableStartStopSync(startStopSync);
        this.startStopSync = startStopSync;
      }
      if (this.status.enabled) {
        this.capture();
        return this.getStatus();
      }
      link.enable(true);
      this.emitStatus({ available: true, enabled: true, quantum: this.quantum, error: "" });
      if (this.capture()) this.timer = this.setInterval(() => this.capture(), this.intervalMs);
    } catch (error) {
      this.stop(false);
      this.link = null;
      this.emitStatus({
        available: false,
        enabled: false,
        error: error && error.message ? error.message : String(error),
      });
    }
    return this.getStatus();
  }

  capture() {
    if (!this.link || !this.status.enabled) return null;
    try {
      const rawBeat = finiteNumber(this.link.getBeat(), this.status.beat);
      const phase = finiteNumber(this.link.getPhase(this.quantum), this.status.phase);
      const snapshot = {
        kind: "link-sync",
        version: 1,
        enabled: true,
        sequence: ++this.sequence,
        capturedAt: this.now(),
        tempo: finiteNumber(this.link.getTempo(), this.status.tempo),
        beat: alignBeatToPhase(rawBeat, phase, this.quantum),
        phase,
        quantum: this.quantum,
        playing: Boolean(this.link.isPlaying()),
        peers: Math.max(0, Math.trunc(finiteNumber(this.link.getNumPeers(), 0))),
      };
      this.emitStatus(snapshot);
      this.onSnapshot(snapshot);
      return snapshot;
    } catch (error) {
      this.stop(false);
      this.emitStatus({ enabled: false, error: error && error.message ? error.message : String(error) });
      return null;
    }
  }

  control(command = {}) {
    if (!this.link || !this.status.enabled) {
      return { ok: false, error: "Ableton Link ist nicht aktiv.", status: this.getStatus() };
    }
    try {
      if (command.action === "set-tempo") {
        const tempo = Math.max(20, Math.min(400, finiteNumber(command.tempo, this.status.tempo)));
        this.link.setTempo(tempo);
      } else if (command.action === "set-playing") {
        this.link.setIsPlaying(command.playing === true);
      } else {
        return { ok: false, error: "Unbekannter Link-Befehl.", status: this.getStatus() };
      }
      const snapshot = this.capture();
      return { ok: true, status: snapshot || this.getStatus() };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error), status: this.getStatus() };
    }
  }

  stop(emit = true) {
    const wasEnabled = this.status.enabled;
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
    if (this.link) {
      try { this.link.enable(false); } catch (_error) {}
    }
    this.status.enabled = false;
    if (emit) this.onStatus(this.getStatus());
    if (emit && wasEnabled) {
      this.onSnapshot({
        kind: "link-sync",
        version: 1,
        enabled: false,
        sequence: ++this.sequence,
        capturedAt: this.now(),
        tempo: this.status.tempo,
        beat: this.status.beat,
        phase: this.status.phase,
        quantum: this.status.quantum,
        playing: false,
        peers: this.status.peers,
      });
    }
    return this.getStatus();
  }

  close() {
    this.stop(false);
    this.link = null;
  }
}

module.exports = { AbletonLinkFollower, alignBeatToPhase };

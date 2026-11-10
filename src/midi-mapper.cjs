"use strict";

function clamp7(value) {
  return Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
}

function clampMidiNote(value) {
  return Math.max(0, Math.min(127, Math.round(Number(value) || 0)));
}

class MidiMapper {
  constructor(send, options = {}) {
    this.send = typeof send === "function" ? send : function () {};
    this.mode = options.mode === "mpe" ? "mpe" : "standard";
    this.standardChannel = Math.max(0, Math.min(15, Number(options.standardChannel) || 0));
    this.bendRange = Math.max(1, Math.min(96, Number(options.bendRange) || 48));
    this.notes = new Map();
    this.channelOrder = [];
    this.eventStates = new Map();
    this.snapshotSeqs = new Map();
    this.heldControls = new Map();
  }

  setMode(mode) {
    this.panic();
    this.mode = mode === "mpe" ? "mpe" : "standard";
    if (this.mode === "mpe") this.initializeMpe();
  }

  initializeMpe() {
    // Configure the lower MPE zone: channel 1 is manager, channels 2-16 members.
    this.send([0xb0, 101, 0]);
    this.send([0xb0, 100, 6]);
    this.send([0xb0, 6, 15]);
    this.send([0xb0, 38, 0]);
    this.send([0xb0, 101, 127]);
    this.send([0xb0, 100, 127]);
    for (let channel = 1; channel <= 15; channel += 1) {
      this.send([0xb0 | channel, 101, 0]);
      this.send([0xb0 | channel, 100, 0]);
      this.send([0xb0 | channel, 6, this.bendRange]);
      this.send([0xb0 | channel, 38, 0]);
      this.send([0xb0 | channel, 101, 127]);
      this.send([0xb0 | channel, 100, 127]);
    }
  }

  allocateMpeChannel() {
    for (let channel = 1; channel <= 15; channel += 1) {
      if (!this.channelOrder.includes(channel)) {
        this.channelOrder.push(channel);
        return channel;
      }
    }
    const stolen = this.channelOrder.shift();
    const entry = Array.from(this.notes.entries()).find((item) => item[1].channel === stolen);
    if (entry) this.noteOff(entry[0]);
    this.channelOrder.push(stolen);
    return stolen;
  }

  releaseChannel(channel) {
    const index = this.channelOrder.indexOf(channel);
    if (index >= 0) this.channelOrder.splice(index, 1);
  }

  pitchBend(channel, cents, baseNote) {
    const delta = Number(cents) - baseNote * 100;
    const normalized = Math.max(-1, Math.min(1, delta / (this.bendRange * 100)));
    const value = Math.max(0, Math.min(16383, Math.round(8192 + normalized * 8191)));
    this.send([0xe0 | channel, value & 0x7f, (value >> 7) & 0x7f]);
  }

  noteKey(noteId, sourceId = "default") {
    return `${String(sourceId || "default")}:${String(noteId || "")}`;
  }

  noteOn(payload = {}, context = {}) {
    const rawId = String(payload.id || payload.noteId || "");
    const sourceId = String(context.sourceId || "default");
    const id = this.noteKey(rawId, sourceId);
    if (!rawId) return;
    if (this.notes.has(id)) this.noteOff(id);
    const cents = Number(payload.pitch);
    const safeCents = Number.isFinite(cents) ? cents : 6000;
    const note = clampMidiNote(safeCents / 100);
    const requestedChannel = Number(context.standardChannel);
    const standardChannel = Number.isInteger(requestedChannel)
      ? Math.max(0, Math.min(15, requestedChannel))
      : this.standardChannel;
    const channel = this.mode === "mpe" ? this.allocateMpeChannel() : standardChannel;
    if (this.mode === "mpe") {
      // Member channels are reused; reset pressure left by the previous note.
      this.send([0xd0 | channel, 0]);
      this.pitchBend(channel, safeCents, note);
    }
    this.send([0x90 | channel, note, clamp7(payload.vel)]);
    this.notes.set(id, { channel, note, cents: safeCents, sourceId, rawId, startedAt: Date.now() });
  }

  noteOff(noteId) {
    const id = String(noteId || "");
    const note = this.notes.get(id);
    if (!note) return;
    this.send([0x80 | note.channel, note.note, 0]);
    if (this.mode === "mpe") {
      this.send([0xe0 | note.channel, 0, 64]);
      this.releaseChannel(note.channel);
    }
    this.notes.delete(id);
  }

  modulate(payload = {}, context = {}) {
    const note = this.notes.get(this.noteKey(payload.id, context.sourceId));
    if (!note) return;
    if (Object.prototype.hasOwnProperty.call(payload, "vel") && Number.isFinite(Number(payload.vel))) {
      this.send([0xd0 | note.channel, clamp7(payload.vel)]);
    }
    if (this.mode === "mpe" && Number.isFinite(Number(payload.cents))) {
      note.cents = Number(payload.cents);
      this.pitchBend(note.channel, note.cents, note.note);
    }
  }

  reconcile(activeNotes, context = {}) {
    const sourceId = String(context.sourceId || "default");
    const incoming = new Map((Array.isArray(activeNotes) ? activeNotes : [])
      .filter((note) => note && note.id)
      .map((note) => [this.noteKey(note.id, sourceId), note]));
    for (const [id, current] of Array.from(this.notes.entries())) {
      if (current.sourceId === sourceId && !incoming.has(id)) this.noteOff(id);
    }
    for (const [id, note] of incoming) {
      if (!this.notes.has(id)) this.noteOn(note, context);
    }
  }

  controlChange(envelope, context = {}) {
    const { controller, value } = envelope;
    if (!Number.isInteger(controller) || controller < 0 || controller > 119 ||
        !Number.isInteger(value) || value < 0 || value > 127) return;
    const requested = Number(context.standardChannel);
    const channel = this.mode === "mpe" ? 0 : Number.isInteger(requested)
      ? Math.max(0, Math.min(15, requested)) : this.standardChannel;
    const sourceId = String(context.sourceId || "default");
    const key = JSON.stringify([sourceId, channel, controller]);
    this.send([0xb0 | channel, controller, value]);
    if (envelope.momentary && value > 0) this.heldControls.set(key, { sourceId, channel, controller });
    else this.heldControls.delete(key);
  }

  releaseControls(sourceId) {
    for (const [key, control] of this.heldControls) {
      if (sourceId !== undefined && control.sourceId !== sourceId) continue;
      this.send([0xb0 | control.channel, control.controller, 0]);
      this.heldControls.delete(key);
    }
  }

  handleEnvelope(envelope, context = {}) {
    if (!envelope || typeof envelope !== "object") return;
    if (envelope.kind === "midi-cc") { this.controlChange(envelope, context); return; }
    const sourceId = String(context.sourceId || "default");
    const seq = Number.isInteger(envelope.seq) && envelope.seq >= 0 ? envelope.seq : null;
    if (envelope.kind === "active-notes") {
      if (seq === null) { this.reconcile(envelope.activeNotes, context); return; }
      if (seq < (this.snapshotSeqs.get(sourceId) ?? -1)) return;
      this.snapshotSeqs.set(sourceId, seq);
      const incoming = new Map((Array.isArray(envelope.activeNotes) ? envelope.activeNotes : [])
        .filter(note => note && note.id).map(note => [this.noteKey(note.id, sourceId), note]));
      for (const [id, note] of Array.from(this.notes)) {
        if (note.sourceId !== sourceId || incoming.has(id)) continue;
        const state = this.eventStates.get(id);
        if (state && state.seq > seq) continue;
        this.noteOff(id);
        this.rememberEvent(id, { seq, stopped: true });
      }
      for (const [id, payload] of incoming) {
        const state = this.eventStates.get(id);
        if (state && (state.seq > seq || (state.stopped && state.seq >= seq))) continue;
        if (!this.notes.has(id)) this.noteOn(payload, context);
        if (payload.mod) this.modulate(payload.mod, context);
        this.rememberEvent(id, { seq, stopped: false });
      }
      return;
    }
    if (envelope.kind !== "note-event") return;
    const payload = envelope.payload || {};
    if (!payload.id) return;
    const id = this.noteKey(payload.id, sourceId);
    const state = this.eventStates.get(id);
    if (seq !== null) {
      if (seq <= (this.snapshotSeqs.get(sourceId) ?? -1)) return;
      if (state && state.seq >= seq) {
        // An unordered modulation can arrive before its attack. Keep that
        // latest state, but still allow the missing attack to create the note.
        if (envelope.type !== "note" || state.stopped || this.notes.has(id)) return;
      }
    }
    if (envelope.type === "note") {
      if (!this.notes.has(id)) this.noteOn(payload, context);
      if (state && state.pendingMod) this.modulate(state.pendingMod, context);
      this.rememberEvent(id, { seq: Math.max(seq ?? -1, state ? state.seq : -1), stopped: false });
    }
    if (envelope.type === "stop") {
      this.noteOff(id);
      this.rememberEvent(id, { seq: seq ?? -1, stopped: true });
    }
    if (envelope.type === "mod") {
      if (state && state.stopped) return;
      if (this.notes.has(id)) {
        this.modulate(payload, context);
        this.rememberEvent(id, { seq: seq ?? -1, stopped: false });
      } else {
        this.rememberEvent(id, { seq: seq ?? -1, stopped: false,
          pendingMod: { ...(state && state.pendingMod), ...payload } });
      }
    }
  }

  rememberEvent(id, state) {
    this.eventStates.delete(id);
    this.eventStates.set(id, state);
    // Bound tombstones and pre-attack modulation storage in long sessions.
    while (this.eventStates.size > 4096) this.eventStates.delete(this.eventStates.keys().next().value);
  }

  panicSource(sourceId) {
    const safeSourceId = String(sourceId || "default");
    this.releaseControls(safeSourceId);
    for (const [id, note] of Array.from(this.notes.entries())) {
      if (note.sourceId === safeSourceId) this.noteOff(id);
    }
    for (const id of this.eventStates.keys()) if (id.startsWith(safeSourceId + ":")) this.eventStates.delete(id);
    this.snapshotSeqs.delete(safeSourceId);
  }

  panic() {
    this.releaseControls();
    for (const id of Array.from(this.notes.keys())) this.noteOff(id);
    for (let channel = 0; channel <= 15; channel += 1) {
      this.send([0xb0 | channel, 123, 0]);
      this.send([0xe0 | channel, 0, 64]);
    }
    this.notes.clear();
    this.channelOrder = [];
    this.eventStates.clear();
    this.snapshotSeqs.clear();
  }
}

module.exports = { MidiMapper, clamp7, clampMidiNote };

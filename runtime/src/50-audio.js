// Sound: a small synthesiser built on the browser's Web Audio API. It plays a quiet bed of pad
// chords and bass, and short effects at the moments a film declares. No audio files are used.
//
// Every event is stored with its film time in real seconds. While sound is on, the audio clock is
// the film's master clock, so effects stay on their moments.

const NOTE_OFFSETS = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

// Turns a chord name such as "Am", "F" or "C#m" into the notes the bed plays for it, as MIDI
// numbers: three pad notes and one bass note. Returns null for a name it cannot read.
const parseChord = (name) => {
  const m = /^([A-Ga-g])([#b]?)(m?)/.exec(String(name).trim());
  if (!m) return null;
  const pitch = (NOTE_OFFSETS[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  const root = pitch >= 5 ? 48 + pitch : 60 + pitch;
  const third = m[3] ? 3 : 4;
  return { root, third, pad: [root, root + third, root + 7], bass: root - 12 };
};

const midiToHz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
const dbToGain = (db) => Math.pow(10, db / 20);

// Builds the full event list for a film.
//
// timeline.scenes[i] has: start (real seconds), warp, and the scene's declared `cues` and
// `bubbles`. Declared cue times are animation times and are converted to real film times here,
// once, so nothing is computed during playback.
const buildScore = (film, timeline) => {
  const events = [];
  const duration = timeline.duration;
  const fx = (name, t, o) => { if (t >= 0 && t < duration) events.push({ kind: 'fx', name, t, o: o || {}, dur: 1 }); };
  const note = (track, midi, t, dur, vel) => { events.push({ kind: 'note', track, midi, t, dur, vel }); };

  // The bed: one chord per bar of four beats, from the start to a closing chord.
  const bed = film.bed || {};
  const chords = (bed.progression || ['Am', 'F', 'C', 'G']).map(parseChord).filter(Boolean);
  const beat = 60 / (bed.bpm || 80);
  if (chords.length) {
    const bars = Math.max(0, Math.floor((duration - 4) / (4 * beat)));
    for (let bar = 0; bar < bars; bar++) {
      const chord = chords[bar % chords.length];
      chord.pad.forEach((midi) => note('pad', midi, bar * 4 * beat, 4 * beat, 40));
      if (bar >= 1) note('bass', chord.bass, bar * 4 * beat, 2 * beat, 44);
    }
    const end = bars * 4 * beat;
    const home = chords[0];
    [home.root, home.root + 7, home.root + 12, home.root + 12 + home.third].forEach((midi) => note('pad', midi, end, 3.5, 48));
    note('bass', home.root - 24, end, 3.5, 48);
    fx('chime', end + 0.05, { vel: 42 });
  }

  timeline.scenes.forEach((scene, index) => {
    if (index > 0) fx('chime', scene.start + 0.02, { vel: 22 });
    // A pop when a bubble appears, or a ding when it is an alarm bubble.
    scene.bubbles.forEach((bubble, i) => {
      if (scene.warp.starts[i] == null) return;
      fx(bubble.alarm ? 'ding' : 'pop', scene.start + scene.warp.starts[i] + 0.02, { vel: bubble.alarm ? 46 : 34 });
    });
    (scene.cues || []).forEach((cue) => {
      const o = { vel: cue.vel, into: cue.into, dur: cue.dur == null ? undefined : Math.min(2, cue.dur) };
      fx(cue.fx, scene.start + scene.warp.realAt(cue.at), o);
    });
  });

  events.forEach((e) => { if (!isFinite(e.t)) e.t = -1; });
  return {
    events: events.filter((e) => e.t >= 0 && e.t <= duration).sort((a, b) => a.t - b.t),
    tracks: { pad: { patch: 'pad', rev: 0.5, gain: -3 }, bass: { patch: 'bass', gain: -4, rev: 0 } },
    masterDb: -6,
    fadeOut: 1.6,
    duration,
  };
};

const audio = {
  ctx: null, master: null, session: null, sessionVerb: null, verb: null, verbIn: null, noise: null,
  score: null, anchorCtx: 0, anchorFilm: 0, rate: 1, nextIndex: 0, running: false,

  load(score) { this.score = score; },

  // Creates the audio context and the shared reverb and noise buffers on first use. Browsers only
  // allow this after a user gesture, which is why it is not done at page load.
  ensure() {
    if (this.ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = this.ctx = new AudioCtx();
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    // A soft reverb made from decaying noise.
    const length = Math.floor(ctx.sampleRate * 2.6);
    const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = impulse.getChannelData(c);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.6);
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = impulse;
    this.verbIn = ctx.createGain();
    this.verbIn.connect(this.verb);
    this.verb.connect(this.master);
    const noiseLength = ctx.sampleRate * 2;
    const noise = ctx.createBuffer(1, noiseLength, ctx.sampleRate);
    const noiseData = noise.getChannelData(0);
    for (let i = 0; i < noiseLength; i++) noiseData[i] = Math.random() * 2 - 1;
    this.noise = noise;
  },

  // Starts sound at film time `pos`, playing `rate` film seconds per real second.
  start(pos, rate) {
    this.ensure();
    if (!this.ctx || !this.score) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.stop();
    const ctx = this.ctx;
    const score = this.score;
    this.rate = rate || 1;
    this.session = ctx.createGain();
    this.session.connect(this.master);
    this.sessionVerb = ctx.createGain();
    this.sessionVerb.connect(this.verbIn);
    this.anchorCtx = ctx.currentTime + 0.06;
    this.anchorFilm = pos;
    this.running = true;
    // Master level, with a fade over the last `fadeOut` seconds of the film.
    const gain = this.master.gain;
    const base = dbToGain(score.masterDb);
    const end = score.duration;
    const fadeStart = end - score.fadeOut;
    const at = (filmTime) => this.anchorCtx + (filmTime - pos) / this.rate;
    gain.cancelScheduledValues(0);
    if (pos < fadeStart) {
      gain.setValueAtTime(base, ctx.currentTime);
      gain.setValueAtTime(base, at(fadeStart));
      gain.linearRampToValueAtTime(0.0001, at(end));
    } else {
      const k = score.fadeOut ? Math.max(0.0001, (end - pos) / score.fadeOut) : 1;
      gain.setValueAtTime(base * k, ctx.currentTime);
      gain.linearRampToValueAtTime(0.0001, at(end));
    }
    // Notes that began before `pos` and are still sounding join in part-way through.
    this.nextIndex = 0;
    const events = score.events;
    while (this.nextIndex < events.length && events[this.nextIndex].t < pos) {
      const e = events[this.nextIndex];
      if (e.kind === 'note' && e.t + e.dur > pos + 0.1) this.note(e, this.anchorCtx, (e.t + e.dur - pos) / this.rate, true);
      this.nextIndex++;
    }
    this.pump();
  },

  stop() {
    this.running = false;
    if (this.session && this.ctx) {
      const session = this.session;
      const sessionVerb = this.sessionVerb;
      const now = this.ctx.currentTime;
      session.gain.setTargetAtTime(0, now, 0.03);
      sessionVerb.gain.setTargetAtTime(0, now, 0.03);
      setTimeout(() => { try { session.disconnect(); sessionVerb.disconnect(); } catch (e) { /* already disconnected */ } }, 300);
    }
    this.session = null;
  },

  // The film time according to the audio clock.
  filmTime() { return this.anchorFilm + (this.ctx.currentTime - this.anchorCtx) * this.rate; },

  // Schedules every event due within the next second of film time. Called on every frame.
  pump() {
    if (!this.running || !this.ctx) return;
    const events = this.score.events;
    const horizon = this.filmTime() + 1.0 * this.rate;
    while (this.nextIndex < events.length && events[this.nextIndex].t <= horizon) {
      const e = events[this.nextIndex++];
      const when = this.anchorCtx + (e.t - this.anchorFilm) / this.rate;
      if (when < this.ctx.currentTime - 0.05) continue;
      const at = Math.max(when, this.ctx.currentTime);
      if (e.kind === 'note') this.note(e, at, e.dur / this.rate, false); else this.fx(e.name, at, e.o);
    }
  },

  note(e, when, dur, joined) {
    const ctx = this.ctx;
    const track = this.score.tracks[e.track] || { patch: 'keys', gain: 0, rev: 0 };
    const level = (e.vel / 127) * dbToGain(track.gain || 0);
    const hz = midiToHz(e.midi);
    const out = ctx.createGain();
    out.connect(this.session);
    if (track.rev) {
      const send = ctx.createGain();
      send.gain.value = track.rev * 0.6;
      out.connect(send);
      send.connect(this.sessionVerb);
    }
    const stopAt = when + dur + 2.5;
    if (track.patch === 'pad') {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 1500;
      lowpass.Q.value = 0.4;
      lowpass.connect(out);
      [[-7, 'sawtooth', 0.35], [7, 'sawtooth', 0.35], [0, 'triangle', 0.6]].forEach(([detune, type, mix]) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = hz;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = mix;
        osc.connect(g);
        g.connect(lowpass);
        osc.start(when);
        osc.stop(stopAt);
      });
      const peak = level * 0.16;
      out.gain.setValueAtTime(joined ? peak : 0.0001, when);
      if (!joined) out.gain.linearRampToValueAtTime(peak, when + Math.min(0.8, dur * 0.4));
      out.gain.setValueAtTime(peak, when + dur);
      out.gain.setTargetAtTime(0.0001, when + dur, 0.6);
    } else if (track.patch === 'bass') {
      const lowpass = ctx.createBiquadFilter();
      lowpass.type = 'lowpass';
      lowpass.frequency.value = 700;
      lowpass.connect(out);
      [['sine', 1], ['triangle', 0.4]].forEach(([type, mix]) => {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = hz;
        const g = ctx.createGain();
        g.gain.value = mix;
        osc.connect(g);
        g.connect(lowpass);
        osc.start(when);
        osc.stop(stopAt);
      });
      const peak = level * 0.32;
      out.gain.setValueAtTime(joined ? peak * 0.6 : 0.0001, when);
      if (!joined) {
        out.gain.linearRampToValueAtTime(peak, when + 0.02);
        out.gain.setTargetAtTime(peak * 0.6, when + 0.02, 0.4);
      }
      out.gain.setValueAtTime(peak * 0.6, when + dur);
      out.gain.setTargetAtTime(0.0001, when + dur, 0.25);
    } else {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = hz;
      osc.connect(out);
      osc.start(when);
      osc.stop(stopAt);
      out.gain.setValueAtTime(0.0001, when);
      out.gain.linearRampToValueAtTime(level * 0.2, when + 0.01);
      out.gain.setTargetAtTime(0.0001, when + 0.01, 0.4);
    }
  },

  noiseSource(when, dur) {
    const source = this.ctx.createBufferSource();
    source.buffer = this.noise;
    source.loop = true;
    source.start(when);
    source.stop(when + dur + 0.1);
    return source;
  },

  fx(name, when, o) {
    const ctx = this.ctx;
    const level = ((o && o.vel) == null ? 64 : o.vel) / 127;
    const out = ctx.createGain();
    out.connect(this.session);
    // One oscillator with a fast attack and an exponential decay, optionally sliding in pitch.
    const tone = (type, f0, f1, len, peak, at) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f0, at);
      if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, at + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.linearRampToValueAtTime(peak, at + 0.005);
      g.gain.setTargetAtTime(0.0001, at + 0.005, len / 3);
      osc.connect(g);
      g.connect(out);
      osc.start(at);
      osc.stop(at + len * 3 + 0.2);
    };
    if (name === 'pop') tone('sine', 900, 280, 0.09, level * 0.55, when);
    else if (name === 'click') tone('square', 1800, 1800, 0.02, level * 0.18, when);
    else if (name === 'thud') tone('sine', 140, 42, 0.28, level * 0.95, when);
    else if (name === 'ding') {
      tone('sine', 1320, 1320, 0.9, level * 0.32, when);
      tone('sine', 2640, 2640, 0.5, level * 0.1, when);
    } else if (name === 'chime') {
      [1046.5, 1568, 2093].forEach((f, i) => tone('sine', f, f, 1.4 - i * 0.3, level * (0.24 - i * 0.05), when + i * 0.04));
    } else if (name === 'boing') {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(180, when);
      osc.frequency.exponentialRampToValueAtTime(420, when + 0.25);
      const wobble = ctx.createOscillator();
      wobble.frequency.value = 14;
      const depth = ctx.createGain();
      depth.gain.value = 25;
      wobble.connect(depth);
      depth.connect(osc.frequency);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(level * 0.4, when + 0.01);
      g.gain.setTargetAtTime(0.0001, when + 0.05, 0.15);
      osc.connect(g);
      g.connect(out);
      osc.start(when);
      wobble.start(when);
      osc.stop(when + 0.9);
      wobble.stop(when + 0.9);
    } else if (name === 'tick' || name === 'crash') {
      const isTick = name === 'tick';
      const len = isTick ? 0.03 : 1.6;
      const source = this.noiseSource(when, len * 3);
      const filter = ctx.createBiquadFilter();
      filter.type = isTick ? 'bandpass' : 'highpass';
      filter.frequency.value = isTick ? 3200 : 5000;
      filter.Q.value = isTick ? 3 : 0.7;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(level * (isTick ? 0.7 : 0.4), when + 0.003);
      g.gain.setTargetAtTime(0.0001, when + 0.003, len / 3);
      source.connect(filter);
      filter.connect(g);
      g.connect(out);
    } else if (name === 'whoosh') {
      // The length is capped at two seconds because a long noise burst can stall the audio engine.
      const len = Math.max(0.3, Math.min(2, (o && o.dur) || 0.6));
      const source = this.noiseSource(when, len);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 1.2;
      const into = o && o.into;
      filter.frequency.setValueAtTime(into ? 2800 : 300, when);
      filter.frequency.exponentialRampToValueAtTime(into ? 300 : 2800, when + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, when);
      g.gain.linearRampToValueAtTime(level * 0.5, when + len * 0.45);
      g.gain.linearRampToValueAtTime(0.0001, when + len);
      source.connect(filter);
      filter.connect(g);
      g.connect(out);
    }
  },
};

// Ville — procedural Web Audio synthesizer for cozy house sound effects.
// Zero external audio assets required.

function nameHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

export class SoundFX {
  constructor() {
    this.ctx = null;
    this.enabled = localStorage.getItem('ville.sound') === '1';
    this.lastBlip = 0;
    this.lastStep = 0;
  }

  toggle() {
    this.enabled = !this.enabled;
    localStorage.setItem('ville.sound', this.enabled ? '1' : '0');
    if (this.enabled) {
      this.ensureCtx();
      this.playChime();
    }
    return this.enabled;
  }

  ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  /** Cozy pitched speech murmer (2-3 soft sine/triangle pips keyed to speaker's name). */
  playSay(who = 'resident', isHuman = false) {
    if (!this.enabled) return;
    const nowMs = performance.now();
    if (nowMs - this.lastBlip < 120) return;
    this.lastBlip = nowMs;

    const ctx = this.ensureCtx();
    if (!ctx) return;

    const baseFreq = isHuman ? 310 : 210 + nameHash(who) * 190;
    const notes = [1, 1.12, 1.25];
    const t0 = ctx.currentTime;

    notes.forEach((mult, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = isHuman ? 'triangle' : 'sine';
      const jitter = 0.96 + Math.random() * 0.08;
      osc.frequency.setValueAtTime(baseFreq * mult * jitter, t0 + i * 0.055);

      gain.gain.setValueAtTime(0.0001, t0 + i * 0.055);
      gain.gain.exponentialRampToValueAtTime(0.035, t0 + i * 0.055 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.055 + 0.048);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + i * 0.055);
      osc.stop(t0 + i * 0.055 + 0.052);
    });
  }

  /** Soft wooden floorboard tap when walking or changing rooms. */
  playMove() {
    if (!this.enabled) return;
    const nowMs = performance.now();
    if (nowMs - this.lastStep < 250) return;
    this.lastStep = nowMs;

    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(140, t0);
    osc.frequency.exponentialRampToValueAtTime(65, t0 + 0.06);

    gain.gain.setValueAtTime(0.001, t0);
    gain.gain.exponentialRampToValueAtTime(0.04, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.065);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.07);
  }

  /** Warm harmonic chime for reflections and goal milestones. */
  playChime() {
    if (!this.enabled) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const chord = [523.25, 659.25, 783.99, 987.77]; // C5 E5 G5 B5

    chord.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + i * 0.06);

      gain.gain.setValueAtTime(0.0001, t0 + i * 0.06);
      gain.gain.exponentialRampToValueAtTime(0.03, t0 + i * 0.06 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.06 + 0.45);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + i * 0.06);
      osc.stop(t0 + i * 0.06 + 0.48);
    });
  }

  /** Gentle two-note motif when a resident falls asleep or wakes up. */
  playSleep(asleep = true) {
    if (!this.enabled) return;
    const ctx = this.ensureCtx();
    if (!ctx) return;
    const t0 = ctx.currentTime;
    const pair = asleep ? [440, 329.63] : [329.63, 493.88];

    pair.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + i * 0.12);

      gain.gain.setValueAtTime(0.0001, t0 + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.025, t0 + i * 0.12 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.12 + 0.28);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + i * 0.12);
      osc.stop(t0 + i * 0.12 + 0.3);
    });
  }
}


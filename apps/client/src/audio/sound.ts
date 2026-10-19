import { storageGet, storageSet } from '../net/identity.ts';

/**
 * Game sounds, synthesised with Web Audio (no audio files): construction, demolition, coins
 * for income, a chime for news, a crash, and a low rumble of vehicles near the camera.
 * The audio context starts on the first click or key press (browsers require a gesture).
 */

const VOLUME_KEY = 'ts.volume';
const MUTE_KEY = 'ts.muted';

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private ambient: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private last = new Map<string, number>();
  volume = Number(storageGet(VOLUME_KEY) ?? 0.5);
  muted = storageGet(MUTE_KEY) === '1';
  private listeners = new Set<() => void>();

  constructor() {
    if (!Number.isFinite(this.volume)) this.volume = 0.5;
    if (typeof window === 'undefined') return;
    const start = () => {
      this.ensure();
      window.removeEventListener('pointerdown', start);
      window.removeEventListener('keydown', start);
    };
    window.addEventListener('pointerdown', start);
    window.addEventListener('keydown', start);
  }

  /** Subscribe to volume/mute changes (for the UI). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
    storageSet(VOLUME_KEY, String(this.volume));
    this.apply();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    storageSet(MUTE_KEY, m ? '1' : '0');
    this.apply();
  }

  private apply(): void {
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
    for (const l of this.listeners) l();
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
    } catch {
      return null;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(this.ctx.destination);
    // Two seconds of noise, reused by every noisy sound.
    const len = this.ctx.sampleRate * 2;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    let brown = 0;
    for (let i = 0; i < len; i++) {
      // Brownish noise: softer and lower than white noise.
      brown = (brown + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = brown * 3.5;
    }
    // Ambient vehicle rumble: looped low noise whose level follows nearby traffic.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 180;
    this.ambient = this.ctx.createGain();
    this.ambient.gain.value = 0;
    src.connect(lp).connect(this.ambient).connect(this.master);
    src.start();
    return this.ctx;
  }

  /** At most one of a kind of sound per `ms`. */
  private throttle(kind: string, ms: number): boolean {
    const now = performance.now();
    if (now - (this.last.get(kind) ?? -Infinity) < ms) return false;
    this.last.set(kind, now);
    return true;
  }

  private burst(freq: number, q: number, dur: number, gain: number, type: BiquadFilterType = 'bandpass', delay = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.noise) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.05);
  }

  private tone(freq: number, dur: number, gain: number, type: OscillatorType = 'sine', delay = 0, slideTo?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  /** Something was built: a couple of knocks. */
  build(): void {
    if (!this.ensure() || !this.throttle('build', 90)) return;
    this.burst(900, 2, 0.08, 0.5);
    this.tone(140, 0.12, 0.25, 'triangle', 0, 90);
    this.burst(1300, 3, 0.06, 0.3, 'bandpass', 0.09);
  }

  /** Something was demolished: a crumble. */
  demolish(): void {
    if (!this.ensure() || !this.throttle('demolish', 150)) return;
    this.burst(400, 0.8, 0.35, 0.6, 'lowpass');
    this.burst(2200, 1, 0.12, 0.2, 'bandpass', 0.05);
  }

  /** Money came in: a small coin. */
  coin(): void {
    if (!this.ensure() || !this.throttle('coin', 250)) return;
    this.tone(1568, 0.09, 0.12, 'square', 0);
    this.tone(2093, 0.18, 0.1, 'square', 0.07);
  }

  /** A news item: a soft two-note chime. */
  chime(): void {
    if (!this.ensure() || !this.throttle('chime', 800)) return;
    this.tone(659, 0.35, 0.18, 'sine');
    this.tone(988, 0.5, 0.15, 'sine', 0.12);
  }

  /** An accident: a crash and a rumble. */
  crash(): void {
    if (!this.ensure() || !this.throttle('crash', 1500)) return;
    this.burst(1800, 0.7, 0.25, 0.8, 'bandpass');
    this.burst(220, 0.5, 1.4, 0.9, 'lowpass', 0.05);
    this.tone(70, 0.9, 0.4, 'sawtooth', 0.02, 40);
  }

  /** Level of the ambient rumble from how much traffic is near the camera (0..1). */
  setTraffic(level: number): void {
    if (!this.ctx || !this.ambient) return;
    this.ambient.gain.setTargetAtTime(Math.max(0, Math.min(1, level)) * 0.35, this.ctx.currentTime, 0.5);
  }
}

export const sound = new Sound();

/**
 * Audio core.
 *
 * Every sound in the game is synthesised at runtime from oscillators and noise
 * buffers — there are no audio files, for the same reason there are no model or
 * texture files. A footstep is a filtered noise burst with an envelope; an
 * engine is a stack of detuned saws under a lowpass whose cutoff tracks load.
 *
 * The context starts suspended (browsers require a gesture) and is resumed from
 * the "Enter Solara" button. Voices may be created and started before that;
 * they simply produce nothing until the context runs.
 */

export interface Bus {
  ctx: AudioContext;
  /** One-shots and close-up sounds. */
  sfx: GainNode;
  /** Looping beds: surf, wind, city, crowd. */
  ambience: GainNode;
  /** Engines, kept on their own bus so they can duck independently. */
  machines: GainNode;
}

export class AudioCore {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly bus: Bus;

  private limiter: DynamicsCompressorNode;
  private muted = false;
  private started = false;

  private white!: AudioBuffer;
  private brown!: AudioBuffer;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;

    // A gentle limiter, mostly so an engine at full throttle plus a collision
    // can't clip the bus.
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -8;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.004;
    this.limiter.release.value = 0.18;

    this.master.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    const sub = (gain: number) => {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      g.connect(this.master);
      return g;
    };

    // Balanced by ear against measured RMS: ambience sits around -30 dBFS,
    // footsteps peak near -20, and an engine under load near -18.
    this.bus = {
      ctx: this.ctx,
      sfx: sub(1.0),
      ambience: sub(1.05),
      machines: sub(0.6),
    };

    this.buildNoise();
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* Blocked; the next gesture will try again. */
      }
    }
    this.started = true;
  }

  get running(): boolean {
    return this.started && this.ctx.state === 'running';
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    // Ramped, so toggling doesn't click.
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setTargetAtTime(muted ? 0 : 0.85, this.ctx.currentTime, 0.02);
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  /* ------------------------------------------------------------- buffers */

  private buildNoise(): void {
    const rate = this.ctx.sampleRate;
    const len = Math.floor(rate * 2);

    this.white = this.ctx.createBuffer(1, len, rate);
    const w = this.white.getChannelData(0);
    for (let i = 0; i < len; i++) w[i] = Math.random() * 2 - 1;

    // Brown noise: leaky integration of white. Much better for surf and rumble
    // than lowpassed white, which still sounds hissy underneath.
    this.brown = this.ctx.createBuffer(1, len, rate);
    const b = this.brown.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * w[i]) / 1.02;
      b[i] = last * 3.5;
    }
    // Cross-fade the tail into the head so the loop point is inaudible.
    const fade = Math.floor(rate * 0.05);
    for (let i = 0; i < fade; i++) {
      const t = i / fade;
      b[i] = b[i] * t + b[len - fade + i] * (1 - t);
      w[i] = w[i] * t + w[len - fade + i] * (1 - t);
    }
  }

  noise(kind: 'white' | 'brown' = 'white'): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = kind === 'brown' ? this.brown : this.white;
    src.loop = true;
    return src;
  }

  /* ------------------------------------------------------------- helpers */

  get now(): number {
    return this.ctx.currentTime;
  }

  filter(type: BiquadFilterType, freq: number, q = 1): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  gain(value = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return g;
  }

  panner(pan = 0): StereoPannerNode {
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    return p;
  }

  osc(type: OscillatorType, freq: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return o;
  }

  /**
   * Percussive envelope, and the node tears itself down when it finishes.
   * One-shots are created and discarded constantly, so nothing may leak.
   */
  envelope(
    node: AudioScheduledSourceNode,
    out: AudioNode,
    peak: number,
    attack: number,
    decay: number,
    when = this.now,
  ): GainNode {
    const g = this.gain(0);
    node.connect(g);
    g.connect(out);

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    // Exponential-ish tail: setTargetAtTime never truly reaches zero, so the
    // stop() below is what actually ends the voice.
    g.gain.setTargetAtTime(0, when + attack, decay / 3);

    node.start(when);
    node.stop(when + attack + decay + 0.05);
    node.onended = () => {
      g.disconnect();
      node.disconnect();
    };
    return g;
  }
}

/** Smoothly drive an AudioParam without clicks. */
export function ramp(param: AudioParam, value: number, now: number, time = 0.05): void {
  param.setTargetAtTime(value, now, Math.max(0.005, time / 3));
}

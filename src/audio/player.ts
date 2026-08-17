import { AudioCore } from './core';

/**
 * Mara's own sounds: footsteps, jump and landing, splashes and swim strokes.
 *
 * Footsteps are fired from the animator's gait phase rather than on a timer, so
 * the sound lands on the frame the foot actually plants — at a sprint the
 * difference between the two is very audible.
 */

export type Surface = 'pavement' | 'sand' | 'grass' | 'shallow' | 'road';

export class PlayerAudio {
  /** Swim stroke accumulator, in metres. */
  private strokeDist = 0;

  constructor(private core: AudioCore) {}

  /**
   * One footstep. `effort` is 0 for a creep and 1 for a sprint; it drives both
   * level and how much low-end thump the step carries.
   */
  step(surface: Surface, effort: number): void {
    const c = this.core;
    const now = c.now;
    const vary = 0.85 + Math.random() * 0.3;

    switch (surface) {
      case 'sand': {
        // Soft, dull, no transient — sand swallows almost all the high end.
        const n = c.noise('white');
        const f = c.filter('lowpass', 900 * vary, 0.9);
        n.connect(f);
        this.burst(n, f, 0.16 + effort * 0.13, 0.012, 0.12, now);
        break;
      }
      case 'grass': {
        const n = c.noise('white');
        const f = c.filter('bandpass', 1700 * vary, 1.1);
        n.connect(f);
        this.burst(n, f, 0.14 + effort * 0.12, 0.006, 0.09, now);
        break;
      }
      case 'shallow': {
        this.splash(0.32 + effort * 0.32, 1.0);
        break;
      }
      default: {
        // Pavement and road: a sharp scuff over a small body thump.
        const n = c.noise('white');
        const f = c.filter('highpass', 1500 * vary, 0.8);
        n.connect(f);
        this.burst(n, f, 0.15 + effort * 0.18, 0.002, 0.055, now);
        this.thump(130 * vary, 70, 0.12 + effort * 0.12, 0.02, 0.12, now);
        break;
      }
    }
  }

  jump(): void {
    const c = this.core;
    const n = c.noise('white');
    const f = c.filter('bandpass', 1100, 0.9);
    n.connect(f);
    this.burst(n, f, 0.16, 0.004, 0.13, c.now);
  }

  land(surface: Surface, force: number): void {
    const c = this.core;
    const now = c.now;
    if (surface === 'shallow') {
      this.splash(0.7 * force, 0.85);
      return;
    }

    this.thump(105, 48, 0.34 * force, 0.045, 0.25, now);

    const soft = surface === 'sand';
    const n = c.noise('white');
    const f = c.filter(soft ? 'lowpass' : 'highpass', soft ? 700 : 1200, 0.9);
    n.connect(f);
    this.burst(n, f, 0.2 * force, 0.003, soft ? 0.16 : 0.1, now);
  }

  /**
   * A splash. `size` scales level and duration; `bright` controls how much
   * spray sits on top of the low "displaced water" body.
   */
  splash(size: number, bright: number): void {
    const c = this.core;
    const now = c.now;
    const s = Math.min(1.6, Math.max(0.1, size));

    // Spray: bandpass noise swept down as the droplets fall back.
    const n = c.noise('white');
    const f = c.filter('bandpass', 2600, 0.7);
    n.connect(f);
    f.frequency.setValueAtTime(2600 + Math.random() * 900, now);
    f.frequency.exponentialRampToValueAtTime(600, now + 0.25 * s);
    this.burst(n, f, 0.2 * s * bright, 0.004, 0.22 * s, now);

    // Body: the low displacement thump, which is what makes it read as water
    // rather than as a noise burst.
    const b = c.noise('brown');
    const bf = c.filter('lowpass', 420, 0.8);
    b.connect(bf);
    this.burst(b, bf, 0.24 * s, 0.008, 0.18 * s, now);
  }

  /** Swim strokes, paced by distance so they match the animator's crawl. */
  swim(distance: number): void {
    this.strokeDist += distance;
    // Roughly one arm entry per 1.1 m of glide.
    if (this.strokeDist < 1.1) return;
    this.strokeDist = 0;

    const c = this.core;
    const now = c.now;
    const n = c.noise('white');
    const f = c.filter('bandpass', 1300 + Math.random() * 700, 0.8);
    n.connect(f);
    f.frequency.exponentialRampToValueAtTime(500, now + 0.2);
    this.burst(n, f, 0.15, 0.01, 0.2, now);

    const b = c.noise('brown');
    const bf = c.filter('lowpass', 360, 0.7);
    b.connect(bf);
    this.burst(b, bf, 0.11, 0.012, 0.16, now);
  }

  /** Entering or leaving the water out of your depth. */
  waterTransition(entering: boolean): void {
    this.splash(entering ? 1.3 : 0.8, entering ? 1.1 : 0.7);
  }

  /* ------------------------------------------------------------- voices */

  /**
   * Envelope a noise source into the sfx bus, then tear the whole chain down.
   * The source is started here — a buffer source that is never started is
   * silent, and one that is never stopped leaks a voice per footstep.
   */
  private burst(
    src: AudioBufferSourceNode,
    tail: AudioNode,
    peak: number,
    attack: number,
    decay: number,
    when: number,
  ): void {
    const c = this.core;
    const g = c.gain(0);
    tail.connect(g);
    g.connect(c.bus.sfx);

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setTargetAtTime(0, when + attack, decay / 3.5);

    // Random offset into the loop, so repeated steps aren't bit-identical.
    src.start(when, Math.random() * 1.5);
    src.stop(when + attack + decay + 0.2);
    src.onended = () => {
      src.disconnect();
      tail.disconnect();
      g.disconnect();
    };
  }

  /** A pitched-down sine: body weight, impacts, footfall on hard ground. */
  private thump(
    from: number,
    to: number,
    peak: number,
    decay: number,
    life: number,
    when: number,
  ): void {
    const c = this.core;
    const o = c.osc('sine', from);
    const g = c.gain(0);
    o.connect(g);
    g.connect(c.bus.sfx);

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.005);
    g.gain.setTargetAtTime(0, when + 0.008, decay);
    o.frequency.exponentialRampToValueAtTime(to, when + life * 0.6);

    o.start(when);
    o.stop(when + life);
    o.onended = () => {
      o.disconnect();
      g.disconnect();
    };
  }
}

import { AudioCore } from './core';

/**
 * Gunfire, synthesised like everything else.
 *
 * A gunshot is three things layered, and dropping any one of them makes it
 * read as a toy: a very short, very bright noise transient (the crack), a
 * pitched-down body thump (the report), and a filtered tail that is really the
 * street answering back. The tail is what makes a shot sound like it happened
 * *in a city* rather than in a padded room — it is the longest part and the
 * quietest, and it is the first thing you miss when it is not there.
 *
 * Levels are set against the same analyser-measured RMS the rest of `audio/`
 * uses. Gunfire is the loudest thing in the game by a wide margin, which is
 * correct, but it runs through the shared limiter so a held burst compresses
 * rather than clipping.
 */

export class WeaponAudio {
  constructor(private core: AudioCore) {}

  /**
   * Envelope a noise source heard *through* a filter.
   *
   * `AudioCore.envelope` starts and stops the node it is handed, so it only
   * works on a bare source; anything filtered has to pass the source and the
   * tail of the chain separately, the same split `audio/player.ts` uses for
   * footsteps. Both ends are torn down on `ended` — a buffer source that is
   * never stopped leaks a voice per shot, and at 750 rpm that adds up fast.
   */
  private burst(
    src: AudioBufferSourceNode,
    tail: AudioNode,
    out: AudioNode,
    peak: number,
    attack: number,
    decay: number,
    when: number,
  ): void {
    const c = this.core;
    const g = c.gain(0);
    tail.connect(g);
    g.connect(out);

    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + attack);
    g.gain.setTargetAtTime(0, when + attack, decay / 3.5);

    // Random offset into the loop so repeated shots are not bit-identical.
    src.start(when, Math.random() * 1.5);
    src.stop(when + attack + decay + 0.15);
    src.onended = () => {
      src.disconnect();
      tail.disconnect();
      g.disconnect();
    };
  }

  /**
   * @param body Centre frequency of the report. A pistol barks higher than an
   *   SMG; below about 90 Hz it stops sounding like a gun and starts sounding
   *   like a door.
   * @param level Overall gain, 0..1.
   */
  shot(body: number, level: number, pan: number): void {
    const c = this.core;
    if (!c.running) return;
    const now = c.now;
    const p = c.panner(pan);
    p.connect(c.bus.sfx);

    // 1. Crack: a couple of milliseconds of bright noise, barely filtered.
    const crack = c.noise('white');
    const hp = c.filter('highpass', 1800, 0.7);
    crack.connect(hp);
    this.burst(crack, hp, p, 0.9 * level, 0.001, 0.035, now);

    // 2. Report: the body of the shot, pitched down hard and fast.
    const thump = c.osc('triangle', body * 2.2);
    thump.frequency.exponentialRampToValueAtTime(body * 0.55, now + 0.07);
    c.envelope(thump, p, 0.75 * level, 0.002, 0.09, now);

    // A little square in with it: pure triangle is too clean to read as a
    // muzzle blast, and the odd harmonics are most of the aggression.
    const edge = c.osc('square', body * 1.35);
    edge.frequency.exponentialRampToValueAtTime(body * 0.5, now + 0.05);
    c.envelope(edge, p, 0.22 * level, 0.001, 0.045, now);

    // 3. Tail: the street answering. Long, dark and quiet.
    const tail = c.noise('brown');
    const bp = c.filter('bandpass', 620, 0.8);
    tail.connect(bp);
    this.burst(tail, bp, p, 0.3 * level, 0.012, 0.42, now);

    // Tear the panner down once the longest voice has finished.
    setTimeout(() => p.disconnect(), 900);
  }

  /** A filtered noise transient: the click of a catch or a latch. */
  private clack(when: number, freq: number, q: number, level: number, decay: number): void {
    const c = this.core;
    const n = c.noise('white');
    const bp = c.filter('bandpass', freq, q);
    n.connect(bp);
    this.burst(n, bp, c.bus.sfx, level, 0.001, decay, when);
  }

  /** The weight behind a click: a fast pitch drop, which is what reads as metal
   * moving rather than a fingernail on a desk. */
  private thunk(when: number, from: number, to: number, level: number, decay: number): void {
    const c = this.core;
    const o = c.osc('triangle', from);
    o.frequency.exponentialRampToValueAtTime(to, when + decay * 0.8);
    c.envelope(o, c.bus.sfx, level, 0.002, decay, when);
  }

  /** Hammer falling on an empty chamber. */
  dryFire(): void {
    const c = this.core;
    if (!c.running) return;
    const now = c.now;
    this.clack(now, 2400, 2.5, 0.34, 0.03);
    this.thunk(now, 320, 150, 0.2, 0.05);
  }

  /**
   * Magazine out, magazine in, bolt released.
   *
   * Scheduled across the reload rather than fired as one sound: the rhythm of
   * three separate mechanical events is what tells the player how long the
   * reload takes, without a progress bar. `player/animator.ts` poses the hands
   * to land on the same three beats.
   *
   * The first pass was three thin bandpassed clicks at level 0.14–0.2, which
   * measured 0.023 RMS on the master bus against a 0.020 ambience floor — they
   * were playing and were inaudible. Every beat now carries a pitched body
   * under the transient, which is what makes it read as metal.
   */
  reload(duration: number): void {
    const c = this.core;
    if (!c.running) return;
    const now = c.now;

    // Levels measured on an analyser tap on the master bus, the same way the
    // rest of `audio/` was set: ambience sits at ~0.021 RMS and a gunshot at
    // ~0.16. A reload wants to land near 0.08 — plainly audible over the
    // street, and obviously not a gunshot.

    // 1. Magazine catch, and the magazine dropping clear.
    this.clack(now + 0.02, 1800, 3, 0.28, 0.035);
    this.thunk(now + 0.02, 420, 190, 0.15, 0.06);
    this.clack(now + 0.1, 700, 1.6, 0.15, 0.09);

    // 2. Fresh magazine seated — the heaviest of the three, and the one the
    // player feels. Low and solid rather than bright.
    const seat = now + duration * 0.55;
    this.clack(seat, 520, 1.4, 0.25, 0.06);
    this.thunk(seat, 260, 95, 0.32, 0.1);

    // 3. Bolt released: bright, short, with a little ring off the receiver.
    const bolt = now + duration * 0.9;
    this.clack(bolt, 2600, 2.2, 0.3, 0.03);
    this.thunk(bolt, 700, 300, 0.17, 0.05);
    const ring = c.osc('triangle', 1750);
    c.envelope(ring, c.bus.sfx, 0.055, 0.002, 0.13, bolt);
  }

  /** Bullet arriving: dust, metal or meat. */
  impact(kind: 'ground' | 'wall' | 'person' | 'vehicle', level: number, pan: number): void {
    const c = this.core;
    if (!c.running) return;
    const p = c.panner(pan);
    p.connect(c.bus.sfx);

    if (kind === 'vehicle') {
      // Sheet metal: a ringing partial over the thud.
      const ring = c.osc('triangle', 1400 + Math.random() * 500);
      c.envelope(ring, p, 0.16 * level, 0.001, 0.16);
      const n = c.noise('white');
      const bp = c.filter('bandpass', 3200, 2);
      n.connect(bp);
      this.burst(n, bp, p, 0.2 * level, 0.001, 0.05, c.now);
    } else if (kind === 'person') {
      const n = c.noise('brown');
      const lp = c.filter('lowpass', 420, 1);
      n.connect(lp);
      this.burst(n, lp, p, 0.32 * level, 0.002, 0.09, c.now);
    } else {
      // Dust and grit off stone or tarmac.
      const n = c.noise('white');
      const bp = c.filter('bandpass', kind === 'ground' ? 900 : 1600, 1.2);
      n.connect(bp);
      this.burst(n, bp, p, 0.22 * level, 0.001, 0.075, c.now);
    }
    setTimeout(() => p.disconnect(), 500);
  }
}

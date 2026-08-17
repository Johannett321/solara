import { AudioCore, ramp } from './core';

/**
 * Looping environmental beds: surf, wind, the city, and crowd murmur.
 *
 * Each bed is a permanently-running noise voice whose gain and pan are driven
 * from the listener's position every frame. Starting and stopping loops as the
 * player moves would click and thrash; leaving them running at zero gain costs
 * almost nothing.
 */

/** A noise layer with a filter, gain and pan, held open for the whole session. */
class Bed {
  readonly gainNode: GainNode;
  readonly panNode: StereoPannerNode;
  readonly filterNode: BiquadFilterNode;

  constructor(
    core: AudioCore,
    kind: 'white' | 'brown',
    type: BiquadFilterType,
    freq: number,
    q: number,
    out: AudioNode,
  ) {
    const src = core.noise(kind);
    this.filterNode = core.filter(type, freq, q);
    this.gainNode = core.gain(0);
    this.panNode = core.panner(0);

    src.connect(this.filterNode);
    this.filterNode.connect(this.gainNode);
    this.gainNode.connect(this.panNode);
    this.panNode.connect(out);
    src.start();
  }

  set(gain: number, pan: number, now: number, smooth = 0.25): void {
    ramp(this.gainNode.gain, gain, now, smooth);
    ramp(this.panNode.pan, pan, now, 0.3);
  }
}

export interface AmbienceState {
  /** Cross-shore distance from the listener to the waterline, metres. */
  shoreDistance: number;
  /** Signed: negative when the sea is to the listener's left. */
  shorePan: number;
  /** Distance from the built strip, metres. */
  cityDistance: number;
  /** Pedestrians within earshot. */
  crowdNearby: number;
  /** Listener speed, m/s — feeds wind noise. */
  speed: number;
  /** True when the listener is under water level (swimming). */
  submerged: boolean;
  /** Rain intensity, 0..1. */
  rain: number;
  /** Wind strength, 0..1 — audible on its own well before it rains. */
  gust: number;
}

export class Ambience {
  private surfBody: Bed;
  private surfBreak: Bed;
  private wind: Bed;
  private city: Bed;
  private crowd: Bed;
  private crowdHigh: Bed;
  /** Rain is two beds: the low roar of the mass and the hiss on hard surfaces. */
  private rainBody: Bed;
  private rainHiss: Bed;

  /** Drives the surf swell so sets roll in rather than hissing steadily. */
  private t = 0;
  private gullTimer = 6;
  private hornTimer = 20;

  constructor(private core: AudioCore) {
    const out = core.bus.ambience;

    // Surf body: brown noise is the only thing that sounds like water mass.
    // Lowpassed white still reads as hiss no matter how far you push it.
    this.surfBody = new Bed(core, 'brown', 'lowpass', 520, 0.7, out);
    // The break: brighter, and it pulses much harder with each set.
    this.surfBreak = new Bed(core, 'white', 'bandpass', 1700, 0.75, out);

    this.wind = new Bed(core, 'white', 'bandpass', 620, 0.6, out);
    this.city = new Bed(core, 'brown', 'lowpass', 230, 0.7, out);
    this.crowd = new Bed(core, 'white', 'bandpass', 780, 1.4, out);
    this.crowdHigh = new Bed(core, 'white', 'bandpass', 1900, 1.8, out);

    this.rainBody = new Bed(core, 'brown', 'lowpass', 900, 0.6, out);
    this.rainHiss = new Bed(core, 'white', 'highpass', 1900, 0.5, out);
  }

  /**
   * A thunderclap `distance` metres away.
   *
   * Sound travels at ~343 m/s, so the delay after the flash is what actually
   * tells you how far off the storm is — a clap that lands on the flash reads as
   * an explosion, not as lightning. Distance also rolls the top off and turns
   * the crack into a rumble.
   */
  thunder(distance: number): void {
    const core = this.core;
    const delay = Math.min(12, distance / 343);
    const near = 1 - Math.min(1, distance / 3400);
    const now = core.now + delay;

    // Body: brown noise through a lowpass that closes as it decays, which is
    // what makes a rumble roll away rather than just fading.
    const src = core.noise('brown');
    const filter = core.filter('lowpass', 140 + near * 900, 0.9);
    const g = core.gain(0);
    src.connect(filter);
    filter.connect(g);
    g.connect(core.bus.ambience);

    const peak = 0.28 + near * 0.75;
    const length = 2.4 + (1 - near) * 4.5;
    g.gain.setValueAtTime(0.0001, now);
    // Near strikes crack; distant ones swell.
    g.gain.exponentialRampToValueAtTime(peak, now + (near > 0.6 ? 0.02 : 0.35));
    g.gain.exponentialRampToValueAtTime(0.0001, now + length);
    filter.frequency.setValueAtTime(140 + near * 900, now);
    filter.frequency.exponentialRampToValueAtTime(60 + near * 120, now + length);

    src.start(now);
    // An AudioBufferSourceNode that is never stopped leaks a voice per one-shot.
    src.stop(now + length + 0.1);
  }

  update(dt: number, s: AmbienceState): void {
    const now = this.core.now;
    this.t += dt;

    /* ------------------------------------------------------------- rain */

    // Indoors is not modelled, so rain is heard everywhere at the same level;
    // what changes with the weather is its weight, not its position.
    const r = s.submerged ? 0 : s.rain;
    this.rainBody.set(r * 0.5, 0, now, 0.6);
    this.rainHiss.set(r * r * 0.34, 0, now, 0.6);

    /* ------------------------------------------------------------- surf */

    // Sets: two slow oscillators beating against each other, so the rhythm
    // never repeats obviously.
    const set =
      0.5 + 0.32 * Math.sin(this.t * 0.34) + 0.18 * Math.sin(this.t * 0.13 + 1.7);
    const breakPulse = Math.pow(Math.max(0, set), 2.2);

    // Falls off slowly: surf is a line source hundreds of metres long, so it
    // stays audible from the street rather than dying like a point source.
    const surfNear = 1 / (1 + Math.pow(Math.max(0, s.shoreDistance) / 30, 1.35));
    // Standing in the break, the sound surrounds you and stops being directional.
    const directional = Math.min(1, Math.max(0, s.shoreDistance - 6) / 40);
    const pan = s.shorePan * 0.55 * directional;

    const muffle = s.submerged ? 0.35 : 1;
    this.surfBody.set(surfNear * (0.16 + set * 0.1) * muffle, pan, now, 0.4);
    this.surfBreak.set(surfNear * breakPulse * 0.075 * (s.submerged ? 0.15 : 1), pan, now, 0.35);

    // Underwater everything above a few hundred hertz disappears.
    ramp(this.surfBody.filterNode.frequency, s.submerged ? 240 : 520, now, 0.4);

    /* ------------------------------------------------------------- wind */

    const gust = 0.5 + 0.5 * Math.sin(this.t * 0.21 + 0.6) * Math.sin(this.t * 0.07);
    // Open ground and speed both add wind; being submerged removes it entirely.
    const exposure = 0.4 + 0.6 * Math.min(1, Math.max(0, 60 - s.cityDistance) / 60);
    const rush = Math.min(1, s.speed / 26) * 0.5;
    this.wind.set(
      (0.012 + gust * 0.016) * exposure * (s.submerged ? 0 : 1) + rush * 0.05,
      Math.sin(this.t * 0.11) * 0.3,
      now,
      0.3,
    );
    ramp(this.wind.filterNode.frequency, 560 + gust * 260 + rush * 900, now, 0.4);

    /* ------------------------------------------------------------- city */

    const cityNear = 1 / (1 + Math.pow(Math.max(0, s.cityDistance) / 55, 1.6));
    this.city.set(cityNear * 0.09 * (s.submerged ? 0.2 : 1), 0, now, 0.5);

    /* ------------------------------------------------------------ crowd */

    // Murmur, not voices: two bands of noise wobbling against each other reads
    // as a crowd at distance without ever sounding like a specific person.
    const density = Math.min(1, s.crowdNearby / 14);
    const wobble = 0.6 + 0.4 * Math.sin(this.t * 1.7);
    const wobble2 = 0.6 + 0.4 * Math.sin(this.t * 2.3 + 1.1);
    const crowdGain = density * 0.05 * (s.submerged ? 0.1 : 1);
    this.crowd.set(crowdGain * wobble, Math.sin(this.t * 0.3) * 0.2, now, 0.5);
    this.crowdHigh.set(crowdGain * 0.45 * wobble2, -Math.sin(this.t * 0.27) * 0.25, now, 0.5);

    /* ------------------------------------------------- occasional one-offs */

    this.gullTimer -= dt;
    if (this.gullTimer <= 0) {
      // Gulls only near the water, and more often the closer you are.
      const likely = surfNear > 0.25;
      this.gullTimer = 5 + Math.random() * 14;
      if (likely && !s.submerged && Math.random() < 0.75) this.gull();
    }

    this.hornTimer -= dt;
    if (this.hornTimer <= 0) {
      this.hornTimer = 14 + Math.random() * 30;
      if (cityNear > 0.35 && !s.submerged && Math.random() < 0.5) this.horn();
    }
  }

  /** A gull cry: two quick descending chirps with a bit of FM roughness. */
  private gull(): void {
    const c = this.core;
    const now = c.now;
    const pan = (Math.random() * 2 - 1) * 0.8;
    const base = 900 + Math.random() * 500;
    const calls = 2 + Math.floor(Math.random() * 3);

    for (let i = 0; i < calls; i++) {
      const t = now + i * (0.16 + Math.random() * 0.09);
      const o = c.osc('sawtooth', base);
      const f = c.filter('bandpass', base * 1.4, 4);
      const env = c.gain(0);
      const p = c.panner(pan);

      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.15), t);
      o.frequency.exponentialRampToValueAtTime(base * 0.55, t + 0.17);

      // Vibrato is what gives the cry its raucous quality.
      const lfo = c.osc('sine', 26);
      const lfoGain = c.gain(70);
      lfo.connect(lfoGain);
      lfoGain.connect(o.frequency);
      lfo.start(t);
      lfo.stop(t + 0.3);

      o.connect(f);
      f.connect(env);
      env.connect(p);
      p.connect(c.bus.ambience);

      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.05, t + 0.02);
      env.gain.setTargetAtTime(0, t + 0.04, 0.05);

      o.start(t);
      o.stop(t + 0.3);
      o.onended = () => {
        o.disconnect();
        lfo.disconnect();
        lfoGain.disconnect();
        f.disconnect();
        env.disconnect();
        p.disconnect();
      };
    }
  }

  /** A distant car horn, two tones a fourth apart like a real one. */
  private horn(): void {
    const c = this.core;
    const now = c.now;
    const pan = (Math.random() * 2 - 1) * 0.5;
    const p = c.panner(pan);
    const lp = c.filter('lowpass', 1400, 0.8);
    const out = c.gain(0);

    lp.connect(out);
    out.connect(p);
    p.connect(c.bus.ambience);

    const dur = 0.25 + Math.random() * 0.4;
    for (const f of [420, 560]) {
      const o = c.osc('sawtooth', f);
      o.connect(lp);
      o.start(now);
      o.stop(now + dur + 0.1);
      o.onended = () => o.disconnect();
    }
    out.gain.setValueAtTime(0, now);
    out.gain.linearRampToValueAtTime(0.035, now + 0.02);
    out.gain.setValueAtTime(0.035, now + dur);
    out.gain.setTargetAtTime(0, now + dur, 0.04);
    setTimeout(() => {
      lp.disconnect();
      out.disconnect();
      p.disconnect();
    }, (dur + 0.5) * 1000);
  }
}

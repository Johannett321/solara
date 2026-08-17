import { AudioCore, ramp } from './core';

/**
 * Engines, tyres and impacts.
 *
 * The car engine is a stack of detuned sawtooths at multiples of a fundamental
 * that tracks simulated RPM, run through a lowpass whose cutoff opens with
 * throttle. Simulated *gears* are what make it read as a car rather than a
 * siren: without the RPM drop at each shift, pitch just climbs forever.
 */

const GEAR_RATIOS = [3.2, 1.95, 1.35, 1.0, 0.78];
const IDLE_RPM = 750;
const REDLINE = 6400;

/** Harmonic series of a rough four-cylinder, as multiples of the fundamental. */
const HARMONICS: Array<[number, number]> = [
  [0.5, 0.5],
  [1, 1.0],
  [2, 0.45],
  [3, 0.22],
  [4.5, 0.1],
];

class EngineVoice {
  private oscs: OscillatorNode[] = [];
  private oscGains: GainNode[] = [];
  private lowpass: BiquadFilterNode;
  private out: GainNode;
  private intake: AudioBufferSourceNode;
  private intakeGain: GainNode;
  private intakeFilter: BiquadFilterNode;
  private running = false;

  constructor(
    private core: AudioCore,
    private baseHz: number,
    timbre: OscillatorType,
  ) {
    const c = core;
    this.out = c.gain(0);
    this.lowpass = c.filter('lowpass', 700, 1.4);
    this.lowpass.connect(this.out);
    this.out.connect(c.bus.machines);

    for (const [mult, level] of HARMONICS) {
      const o = c.osc(timbre, baseHz * mult);
      const g = c.gain(level);
      o.connect(g);
      g.connect(this.lowpass);
      o.start();
      this.oscs.push(o);
      this.oscGains.push(g);
    }

    // Induction/exhaust roar: noise that grows with load, not with RPM.
    this.intake = c.noise('brown');
    this.intakeFilter = c.filter('bandpass', 320, 0.9);
    this.intakeGain = c.gain(0);
    this.intake.connect(this.intakeFilter);
    this.intakeFilter.connect(this.intakeGain);
    this.intakeGain.connect(c.bus.machines);
    this.intake.start();
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
    const now = this.core.now;
    ramp(this.out.gain, 0, now, 0.25);
    ramp(this.intakeGain.gain, 0, now, 0.25);
  }

  /**
   * @param rpm    simulated engine speed
   * @param load   0..1 throttle
   * @param volume overall level, so a distant or idling engine can duck
   */
  set(rpm: number, load: number, volume: number): void {
    if (!this.running) return;
    const c = this.core;
    const now = c.now;
    const f = (rpm / 60) * this.baseHz * 0.02;

    for (let i = 0; i < this.oscs.length; i++) {
      const mult = HARMONICS[i][0];
      // Slight per-harmonic detune keeps it from sounding like an organ.
      const detune = 1 + (i % 2 === 0 ? 0.004 : -0.005);
      ramp(this.oscs[i].frequency, Math.max(20, f * mult * detune), now, 0.04);
    }

    // Cutoff opens with both revs and throttle: the "opening up" of a car
    // pulling hard is mostly a brightness change, not a pitch change.
    ramp(this.lowpass.frequency, 380 + rpm * 0.22 + load * 1400, now, 0.06);
    ramp(this.out.gain, volume * (0.1 + load * 0.14), now, 0.08);

    ramp(this.intakeFilter.frequency, 220 + rpm * 0.06, now, 0.08);
    ramp(this.intakeGain.gain, volume * load * 0.09, now, 0.1);
  }

  dispose(): void {
    for (const o of this.oscs) {
      o.stop();
      o.disconnect();
    }
    for (const g of this.oscGains) g.disconnect();
    this.intake.stop();
    this.intake.disconnect();
    this.intakeFilter.disconnect();
    this.intakeGain.disconnect();
    this.lowpass.disconnect();
    this.out.disconnect();
  }
}

export class MachineAudio {
  private car: EngineVoice;
  private boat: EngineVoice;

  /** Tyre scrub, held open and gated by gain. */
  private skid: AudioBufferSourceNode;
  private skidGain: GainNode;
  private skidFilter: BiquadFilterNode;

  /** Hull wash, likewise. */
  private wash: AudioBufferSourceNode;
  private washGain: GainNode;
  private washFilter: BiquadFilterNode;

  private gear = 0;
  private gearCooldown = 0;
  private displayedRpm = IDLE_RPM;

  constructor(private core: AudioCore) {
    this.car = new EngineVoice(core, 44, 'sawtooth');
    // Lower and softer: a marine engine is all torque and no top end.
    this.boat = new EngineVoice(core, 26, 'triangle');

    this.skid = core.noise('white');
    this.skidFilter = core.filter('bandpass', 1250, 5.5);
    this.skidGain = core.gain(0);
    this.skid.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    this.skidGain.connect(core.bus.machines);
    this.skid.start();

    this.wash = core.noise('white');
    this.washFilter = core.filter('bandpass', 900, 0.7);
    this.washGain = core.gain(0);
    this.wash.connect(this.washFilter);
    this.washFilter.connect(this.washGain);
    this.washGain.connect(core.bus.machines);
    this.wash.start();
  }

  enterCar(): void {
    this.car.start();
    this.gear = 0;
    this.displayedRpm = IDLE_RPM;
    this.door();
    this.starter();
  }

  exitCar(): void {
    this.car.stop();
    ramp(this.skidGain.gain, 0, this.core.now, 0.1);
    this.door();
  }

  enterBoat(): void {
    this.boat.start();
    this.starter();
  }

  exitBoat(): void {
    this.boat.stop();
    ramp(this.washGain.gain, 0, this.core.now, 0.2);
  }

  /* ---------------------------------------------------------------- car */

  updateCar(dt: number, speed: number, throttle: number, handbrake: boolean, slip: number): void {
    const abs = Math.abs(speed);

    // Pick a gear from road speed, with a cooldown so it can't hunt.
    this.gearCooldown = Math.max(0, this.gearCooldown - dt);
    const wanted = Math.min(
      GEAR_RATIOS.length - 1,
      Math.max(0, Math.floor(abs / 7.2)),
    );
    if (wanted !== this.gear && this.gearCooldown === 0) {
      this.gear = wanted;
      this.gearCooldown = 0.45;
    }

    const ratio = GEAR_RATIOS[this.gear];
    const target = Math.min(REDLINE, IDLE_RPM + abs * ratio * 190);
    // The needle lags the road speed, and drops on each shift.
    this.displayedRpm += (target - this.displayedRpm) * Math.min(1, dt * 6);

    const load = Math.min(1, Math.abs(throttle) * 0.7 + (abs / 34) * 0.5);
    this.car.set(this.displayedRpm, load, 1);

    // Scrub: from the handbrake, or from genuine lateral slide.
    const scrub = Math.min(1, (handbrake ? Math.min(1, abs / 6) : 0) + slip);
    ramp(this.skidGain.gain, scrub * 0.14, this.core.now, 0.06);
    ramp(this.skidFilter.frequency, 900 + scrub * 900, this.core.now, 0.1);
  }

  /* --------------------------------------------------------------- boat */

  updateBoat(_dt: number, speed: number, throttle: number, topSpeed: number): void {
    const abs = Math.abs(speed);
    const rpm = 620 + (abs / Math.max(1, topSpeed)) * 3400;
    const load = Math.min(1, Math.abs(throttle) * 0.6 + (abs / Math.max(1, topSpeed)) * 0.6);
    this.boat.set(rpm, load, 0.9);

    // Water rushing along the hull: the faster you go, the brighter it gets.
    const rush = Math.min(1, abs / Math.max(1, topSpeed));
    ramp(this.washGain.gain, rush * 0.11, this.core.now, 0.15);
    ramp(this.washFilter.frequency, 500 + rush * 1500, this.core.now, 0.2);
  }

  /** Hull slamming down off a wave. */
  hullSlap(force: number): void {
    const c = this.core;
    const now = c.now;
    const n = c.noise('white');
    const f = c.filter('lowpass', 900, 0.8);
    n.connect(f);
    const g = c.gain(0);
    f.connect(g);
    g.connect(c.bus.machines);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14 * force, now + 0.006);
    g.gain.setTargetAtTime(0, now + 0.01, 0.05);
    n.start(now, Math.random());
    n.stop(now + 0.4);
    n.onended = () => {
      n.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  /* ------------------------------------------------------------- impacts */

  /** Collision: a low body thud plus metallic ring. */
  impact(force: number): void {
    const c = this.core;
    const now = c.now;
    const f = Math.min(1, Math.max(0.15, force));

    const body = c.osc('sine', 90);
    const bg = c.gain(0);
    body.connect(bg);
    bg.connect(c.bus.sfx);
    bg.gain.setValueAtTime(0, now);
    bg.gain.linearRampToValueAtTime(0.28 * f, now + 0.004);
    bg.gain.setTargetAtTime(0, now + 0.008, 0.06);
    body.frequency.exponentialRampToValueAtTime(42, now + 0.18);
    body.start(now);
    body.stop(now + 0.35);
    body.onended = () => {
      body.disconnect();
      bg.disconnect();
    };

    // Panel clatter: a couple of inharmonic squares, very short.
    for (const hz of [380, 611, 947]) {
      const o = c.osc('square', hz * (0.9 + Math.random() * 0.2));
      const bp = c.filter('bandpass', hz, 6);
      const g = c.gain(0);
      o.connect(bp);
      bp.connect(g);
      g.connect(c.bus.sfx);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.05 * f, now + 0.002);
      g.gain.setTargetAtTime(0, now + 0.004, 0.03);
      o.start(now);
      o.stop(now + 0.2);
      o.onended = () => {
        o.disconnect();
        bp.disconnect();
        g.disconnect();
      };
    }
  }

  /* --------------------------------------------------------------- misc */

  /** Door thunk on getting in or out. */
  private door(): void {
    const c = this.core;
    const now = c.now;
    const n = c.noise('brown');
    const f = c.filter('lowpass', 520, 1.2);
    n.connect(f);
    const g = c.gain(0);
    f.connect(g);
    g.connect(c.bus.sfx);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.22, now + 0.004);
    g.gain.setTargetAtTime(0, now + 0.01, 0.035);
    n.start(now, Math.random());
    n.stop(now + 0.3);
    n.onended = () => {
      n.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  /** Brief crank before the engine catches. */
  private starter(): void {
    const c = this.core;
    const now = c.now;
    const o = c.osc('sawtooth', 38);
    const f = c.filter('lowpass', 420, 2);
    const g = c.gain(0);
    o.connect(f);
    f.connect(g);
    g.connect(c.bus.machines);

    o.frequency.setValueAtTime(30, now);
    o.frequency.linearRampToValueAtTime(58, now + 0.35);
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.14, now + 0.03);
    g.gain.setValueAtTime(0.14, now + 0.3);
    g.gain.setTargetAtTime(0, now + 0.32, 0.05);
    o.start(now);
    o.stop(now + 0.6);
    o.onended = () => {
      o.disconnect();
      f.disconnect();
      g.disconnect();
    };
  }

  dispose(): void {
    this.car.dispose();
    this.boat.dispose();
    this.skid.stop();
    this.wash.stop();
  }
}

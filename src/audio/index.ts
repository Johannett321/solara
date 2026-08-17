import * as THREE from 'three';
import { AudioCore } from './core';
import { Ambience } from './ambience';
import { PlayerAudio, Surface } from './player';
import { MachineAudio } from './machines';
import {
  SHORELINE_X,
  PARK_EDGE,
  ROAD_HALF,
  WALK_R_OUTER,
  isRoadway,
  waterDepth,
} from '../world/layout';

/**
 * The single seam between the game and the audio system.
 *
 * `main.ts` calls `update()` once a frame with the current world state and fires
 * discrete events (`step`, `jump`, `impact`, …) as they happen. Nothing in the
 * audio modules reaches back into the game.
 */

export interface AudioFrame {
  mode: 'onFoot' | 'driving' | 'boating';
  /** Listener position — the camera, not the character. */
  listener: THREE.Vector3;
  /** Camera right vector, for panning. */
  right: THREE.Vector3;
  /** Position of whatever the player is controlling. */
  subject: THREE.Vector3;
  speed: number;
  /** Live pedestrian positions. */
  crowd: THREE.Vector3[];
  swimming: boolean;
  /** Water depth underfoot. */
  depth: number;
  /* Vehicle state, when driving. */
  throttle: number;
  handbrake: boolean;
  slip: number;
  /* Boat state, when boating. */
  boatTopSpeed: number;
  /** Rain intensity, 0..1. */
  rain: number;
  /** Wind strength, 0..1. */
  gust: number;
}

export class Audio {
  readonly core: AudioCore;
  private ambience: Ambience;
  private playerFx: PlayerAudio;
  private machines: MachineAudio;

  /** Crowd counting is O(n) over ~150 agents; no need to do it every frame. */
  private crowdTimer = 0;
  private crowdNearby = 0;
  private wasSwimming = false;

  constructor() {
    this.core = new AudioCore();
    this.ambience = new Ambience(this.core);
    this.playerFx = new PlayerAudio(this.core);
    this.machines = new MachineAudio(this.core);
  }

  unlock(): void {
    void this.core.unlock();
  }

  toggleMute(): boolean {
    return this.core.toggleMute();
  }

  get muted(): boolean {
    return this.core.isMuted;
  }

  /* -------------------------------------------------------------- events */

  /** Surface under a point, for footstep timbre. */
  surfaceAt(x: number, z: number): Surface {
    if (waterDepth(x, z) > 0.06) return 'shallow';
    if (x < PARK_EDGE) return x > -34 ? 'grass' : 'sand';
    if (isRoadway(x, z)) return 'road';
    return 'pavement';
  }

  step(pos: THREE.Vector3, effort: number): void {
    if (!this.core.running) return;
    this.playerFx.step(this.surfaceAt(pos.x, pos.z), effort);
  }

  /** Thunder from a strike `distance` metres away; the delay is the giveaway. */
  thunder(distance: number): void {
    this.ambience.thunder(distance);
  }

  jump(): void {
    if (this.core.running) this.playerFx.jump();
  }

  land(pos: THREE.Vector3, force: number): void {
    if (this.core.running) this.playerFx.land(this.surfaceAt(pos.x, pos.z), force);
  }

  enterCar(): void {
    if (this.core.running) this.machines.enterCar();
  }

  exitCar(): void {
    if (this.core.running) this.machines.exitCar();
  }

  enterBoat(): void {
    if (this.core.running) this.machines.enterBoat();
  }

  exitBoat(): void {
    if (this.core.running) this.machines.exitBoat();
  }

  impact(force: number): void {
    if (this.core.running) this.machines.impact(force);
  }

  hullSlap(force: number): void {
    if (this.core.running) this.machines.hullSlap(force);
  }

  /** Generic splash, e.g. stepping off a boat into the sea. */
  splash(size: number): void {
    if (this.core.running) this.playerFx.splash(size, 1);
  }

  /* --------------------------------------------------------------- frame */

  update(dt: number, f: AudioFrame): void {
    if (!this.core.running) return;

    /* ------------------------------------------------------- listener */

    // The shore is a straight line along Z, so cross-shore distance is just
    // the x difference — the same simplification the water shader relies on.
    const shoreDistance = Math.abs(f.listener.x - SHORELINE_X);
    // Positive when the sea lies to the listener's right.
    const toShore = Math.sign(SHORELINE_X - f.listener.x) || -1;
    const shorePan = THREE.MathUtils.clamp(f.right.x * toShore, -1, 1);

    // Distance from the built strip, measured from its centre line.
    const cityCentre = (ROAD_HALF + WALK_R_OUTER) / 2;
    const cityDistance = Math.max(0, Math.abs(f.listener.x - cityCentre) - 18);

    this.crowdTimer -= dt;
    if (this.crowdTimer <= 0) {
      this.crowdTimer = 0.3;
      let n = 0;
      for (const p of f.crowd) {
        if (p.distanceToSquared(f.listener) < 26 * 26) n++;
      }
      this.crowdNearby = n;
    }

    this.ambience.update(dt, {
      shoreDistance,
      shorePan,
      cityDistance,
      crowdNearby: this.crowdNearby,
      speed: f.speed,
      submerged: f.swimming,
      rain: f.rain,
      gust: f.gust,
    });

    /* --------------------------------------------------------- swimming */

    if (f.swimming !== this.wasSwimming) {
      this.playerFx.waterTransition(f.swimming);
      this.wasSwimming = f.swimming;
    }
    if (f.swimming) this.playerFx.swim(f.speed * dt);

    /* --------------------------------------------------------- machines */

    if (f.mode === 'driving') {
      this.machines.updateCar(dt, f.speed, f.throttle, f.handbrake, f.slip);
    } else if (f.mode === 'boating') {
      this.machines.updateBoat(dt, f.speed, f.throttle, f.boatTopSpeed);
    }
  }
}

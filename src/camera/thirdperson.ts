import * as THREE from 'three';
import { Input } from '../core/input';
import { Colliders } from '../world/collision';

const MIN_PITCH = THREE.MathUtils.degToRad(-32);
const MAX_PITCH = THREE.MathUtils.degToRad(62);

/**
 * Spring-arm chase camera. The pivot lags the character with a critically
 * damped follow, the arm shortens when geometry gets between camera and
 * subject, and the FOV opens at speed to sell the sprint.
 */
/** Camera rig geometry, swapped when Mara gets in or out of a car. */
export interface RigPreset {
  distance: number;
  /** Height of the follow point above the subject's origin. */
  pivotHeight: number;
  /** Extra lift applied to the camera itself. */
  lift: number;
  /** How fast the pivot chases the subject. */
  follow: number;
  fov: number;
}

export const ON_FOOT: RigPreset = {
  distance: 4.1,
  pivotHeight: 1.42,
  lift: 0.35,
  follow: 16,
  fov: 52,
};

/**
 * Boats need a rig sized to the hull — the car preset puts the camera inside a
 * 12 m catamaran. Callers scale `distance` by the vessel's half-length.
 */
export function inBoat(halfLength: number): RigPreset {
  return {
    distance: 4.5 + halfLength * 1.8,
    pivotHeight: 1.6 + halfLength * 0.12,
    lift: 1.6,
    follow: 8,
    fov: 62,
  };
}

export const IN_CAR: RigPreset = {
  distance: 7.6,
  pivotHeight: 1.5,
  lift: 1.0,
  follow: 11,
  fov: 60,
};

/**
 * Aim-down-sights rig.
 *
 * Pulling in and swinging the pivot to the right is what makes it read as
 * over-the-shoulder rather than just zoomed: the character has to move *off*
 * centre, or the thing you are trying to shoot stays hidden behind her head.
 */
const ADS = {
  /** Metres the pivot slides along the camera's right vector. */
  shoulder: 0.62,
  /** Camera arm length while aiming. */
  distance: 1.95,
  /** Lifted, so the sight line sits nearer the eye than the sternum. */
  pivotLift: 0.14,
  /** How fast the whole thing eases in and out, per second. */
  ease: 9,
} as const;

export class ThirdPersonCamera {
  yaw = Math.PI;
  pitch = THREE.MathUtils.degToRad(8);
  distance = 4.1;

  private rig: RigPreset = ON_FOOT;
  private pivot = new THREE.Vector3();
  private currentDist = 4.1;
  private baseFov: number;
  /** Eased 0..1 aim weight; the FOV to reach at 1. */
  private aim = 0;
  private aimWanted = false;
  private aimFov = 40;
  private right = new THREE.Vector3();
  /** Set while driving so the camera drifts back behind the car. */
  private alignYaw: number | null = null;
  private alignStrength = 0;

  private desired = new THREE.Vector3();
  private lookAt = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(
    private camera: THREE.PerspectiveCamera,
    private input: Input,
    private colliders: Colliders,
  ) {
    this.baseFov = camera.fov;
  }

  /** Swap between the on-foot and in-car rigs. */
  setRig(preset: RigPreset, snapTo?: THREE.Vector3): void {
    this.rig = preset;
    this.distance = preset.distance;
    this.baseFov = preset.fov;
    if (snapTo) {
      this.pivot.copy(snapTo).add(new THREE.Vector3(0, preset.pivotHeight, 0));
      this.currentDist = preset.distance;
    }
  }

  /**
   * Ask the camera to drift back behind a heading. Used while driving: you can
   * still look around, but let go and the view settles behind the car.
   */
  setAutoAlign(yaw: number | null, strength = 0): void {
    this.alignYaw = yaw;
    this.alignStrength = strength;
  }

  /**
   * Aim down sights.
   *
   * @param fov Field of view at full aim — per weapon, so a pistol and an SMG
   *   pull in by different amounts.
   */
  setAim(on: boolean, fov = 40): void {
    this.aimWanted = on;
    this.aimFov = fov;
  }

  /** Eased aim weight, so the crosshair and the animator agree with the view. */
  get aim01(): number {
    return this.aim;
  }

  /** Add camera kick. Recoil is applied to the look angles, not the arm. */
  kick(pitch: number, yaw: number): void {
    this.pitch = THREE.MathUtils.clamp(this.pitch - pitch, MIN_PITCH, MAX_PITCH);
    this.yaw += yaw;
  }

  /** Snap behind the subject, used on spawn and when getting in or out. */
  reset(target: THREE.Vector3, yaw: number): void {
    this.yaw = yaw;
    this.pivot.copy(target).add(new THREE.Vector3(0, this.rig.pivotHeight, 0));
    this.currentDist = this.distance;
    this.apply(0, 1);
  }

  update(dt: number, target: THREE.Vector3, speed: number, maxSpeed: number): void {
    this.aim += ((this.aimWanted ? 1 : 0) - this.aim) * Math.min(1, dt * ADS.ease);

    const m = this.input.takeMouse();
    // Slower look while aiming, in proportion to the zoom: the same hand
    // movement has to cover fewer degrees or fine aim is impossible.
    const sens = 0.0022 * (1 - this.aim * 0.45);
    this.yaw -= m.x * sens;
    this.pitch = THREE.MathUtils.clamp(this.pitch + m.y * sens, MIN_PITCH, MAX_PITCH);

    // Settle behind the car, but only when the player isn't actively looking.
    if (this.alignYaw !== null && this.alignStrength > 0 && Math.abs(m.x) < 1) {
      const delta = Math.atan2(
        Math.sin(this.alignYaw - this.yaw),
        Math.cos(this.alignYaw - this.yaw),
      );
      this.yaw += delta * Math.min(1, this.alignStrength * dt);
    }

    this.tmp.set(0, this.rig.pivotHeight + ADS.pivotLift * this.aim, 0);
    const goal = this.tmp.add(target);
    // Slide the follow point over the character's shoulder. Camera right is
    // (cos yaw, -sin yaw) for a yaw measured as (sin, cos) forward.
    if (this.aim > 0.001) {
      this.right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
      goal.addScaledVector(this.right, ADS.shoulder * this.aim);
    }
    // Damped follow gives a touch of lag without ever feeling loose.
    const f = this.rig.follow;
    this.pivot.x = THREE.MathUtils.damp(this.pivot.x, goal.x, f, dt);
    this.pivot.y = THREE.MathUtils.damp(this.pivot.y, goal.y, f * 0.6, dt);
    this.pivot.z = THREE.MathUtils.damp(this.pivot.z, goal.z, f, dt);

    this.apply(dt, speed / maxSpeed);
  }

  private apply(dt: number, speed01: number): void {
    // Pull back a little at speed for a sense of acceleration — but not while
    // aiming, where the arm length is the whole point.
    const hip = this.distance + speed01 * 0.85;
    const wanted = THREE.MathUtils.lerp(hip, ADS.distance, this.aim);

    // `yaw` is the direction the camera LOOKS; the rig sits opposite it, behind
    // the character. Same convention the controller uses to build move vectors.
    const cp = Math.cos(this.pitch);
    this.desired.set(
      this.pivot.x - Math.sin(this.yaw) * cp * wanted,
      this.pivot.y + Math.sin(this.pitch) * wanted + this.rig.lift,
      this.pivot.z - Math.cos(this.yaw) * cp * wanted,
    );

    // Shorten the arm if a building is in the way.
    const clear = this.colliders.raycastXZ(this.pivot, this.desired, this.pivot.y, 0.32);
    const flat = Math.hypot(this.desired.x - this.pivot.x, this.desired.z - this.pivot.z);
    let dist = wanted;
    if (flat > 1e-4 && clear < flat) dist = wanted * (clear / flat);
    dist = Math.max(1.25, dist);

    // Snap in fast when blocked, ease back out slowly.
    const rate = dist < this.currentDist ? 30 : 5;
    this.currentDist = dt > 0 ? THREE.MathUtils.damp(this.currentDist, dist, rate, dt) : dist;

    this.camera.position.set(
      this.pivot.x - Math.sin(this.yaw) * cp * this.currentDist,
      this.pivot.y + Math.sin(this.pitch) * this.currentDist + this.rig.lift,
      this.pivot.z - Math.cos(this.yaw) * cp * this.currentDist,
    );
    // Never let the camera drop through the pavement.
    this.camera.position.y = Math.max(this.camera.position.y, 0.45);

    // Aim a little past her so she sits low-centre rather than dead centre.
    this.lookAt
      .copy(this.pivot)
      .addScaledVector(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)), 0.6);
    this.camera.lookAt(this.lookAt);

    const fov = THREE.MathUtils.lerp(this.baseFov + speed01 * 6.5, this.aimFov, this.aim);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = dt > 0 ? THREE.MathUtils.damp(this.camera.fov, fov, 5, dt) : fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

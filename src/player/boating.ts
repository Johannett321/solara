import * as THREE from 'three';
import { Input } from '../core/input';
import { Boat } from '../world/boats';
import { waterDepth, WATER_Y } from '../world/layout';

/**
 * Boat handling.
 *
 * Unlike the car, a boat has no grip: the hull yaws about its own centre from
 * rudder/thrust, and it keeps sliding in the direction it was already going.
 * That lag is the whole feel of a boat, so lateral velocity is damped very
 * softly and steering only bites when the propeller is actually pushing water.
 *
 * The hull also rides the swell, sampling the ocean surface at the bow and
 * stern to work out pitch, and to port and starboard for roll.
 */

const ACCEL = 4.2;
const REVERSE_ACCEL = 1.8;
const DRAG = 0.55;
const TOP_SPEED: Record<string, number> = {
  jetski: 22,
  runabout: 17,
  catamaran: 13,
  yacht: 11,
};
const REVERSE_TOP = 4;
const MAX_RUDDER = THREE.MathUtils.degToRad(30);
/** Minimum depth under the keel before the hull grounds out. */
const MIN_DEPTH = 0.9;

export class BoatController {
  readonly position = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  rudder = 0;
  boat: Boat | null = null;

  /** Set when the hull drops off a wave hard enough to slam, 0..1. */
  slam = 0;
  private slamCooldown = 0;

  /** Sideways drift in the hull's frame. */
  private lateral = 0;
  private pitch = 0;
  private roll = 0;
  private bobPhase = 0;

  constructor(
    private input: Input,
    private waterHeight: (x: number, z: number) => number,
  ) {}

  get kph(): number {
    return Math.abs(this.speed) * 3.6;
  }

  get topSpeed(): number {
    return TOP_SPEED[this.boat?.build.kind ?? 'runabout'] ?? 15;
  }

  enter(boat: Boat): void {
    this.boat = boat;
    boat.occupied = true;
    this.position.copy(boat.position);
    this.yaw = boat.yaw;
    this.speed = 0;
    this.lateral = 0;
    this.rudder = 0;
  }

  exit(): Boat | null {
    const b = this.boat;
    if (b) {
      b.occupied = false;
      b.position.copy(this.position);
      b.yaw = this.yaw;
    }
    this.boat = null;
    return b;
  }

  /** Where Mara ends up when she steps off — in the water, beside the hull. */
  dismountPoint(out: THREE.Vector3): THREE.Vector3 {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const beam = (this.boat?.build.halfBeam ?? 1.5) + 0.7;
    out.copy(this.position).addScaledVector(right, -beam);
    out.y = WATER_Y;
    return out;
  }

  update(dt: number): void {
    const boat = this.boat;
    if (!boat) return;

    const axis = this.input.driveAxis();
    const throttle = axis.y;

    /* ---------------------------------------------------------- thrust */

    if (throttle > 0.01) {
      this.speed += (this.speed < -0.2 ? ACCEL * 2 : ACCEL) * throttle * dt;
    } else if (throttle < -0.01) {
      this.speed += (this.speed > 0.2 ? ACCEL * 2 : REVERSE_ACCEL) * throttle * dt;
    }

    // Hull drag, quadratic-ish so top speed settles on its own.
    const drag = DRAG * dt * (1 + Math.abs(this.speed) * 0.08);
    this.speed -= this.speed * Math.min(1, drag);
    this.speed = THREE.MathUtils.clamp(this.speed, -REVERSE_TOP, this.topSpeed);

    /* --------------------------------------------------------- steering */

    const rudderTarget = -axis.x * MAX_RUDDER;
    this.rudder += (rudderTarget - this.rudder) * Math.min(1, dt * 4);

    // A rudder does nothing without water moving past it, but the props still
    // give some authority at a standstill, so there's a small constant term.
    const authority = 0.25 + Math.min(1, Math.abs(this.speed) / 8) * 0.75;
    const dir = this.speed < -0.1 ? -1 : 1;
    const yawRate = this.rudder * authority * 0.85 * dir;
    this.yaw += yawRate * dt;

    /* ----------------------------------------------------------- drift */

    // Boats slide through turns; grip is deliberately feeble.
    this.lateral += yawRate * this.speed * dt * 0.5;
    this.lateral -= this.lateral * Math.min(1, 1.1 * dt);

    /* -------------------------------------------------------- integrate */

    const forward = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(forward.z, 0, -forward.x);

    const nx = this.position.x + (forward.x * this.speed + right.x * this.lateral) * dt;
    const nz = this.position.z + (forward.z * this.speed + right.z * this.lateral) * dt;

    // Run aground rather than sail up the beach.
    if (waterDepth(nx, nz) > MIN_DEPTH) {
      this.position.x = nx;
      this.position.z = nz;
    } else {
      this.speed *= 0.25;
      this.lateral = 0;
    }

    /* ------------------------------------------------------- ride swell */

    const half = boat.build.halfLength;
    const beam = boat.build.halfBeam;
    const bow = this.waterHeight(
      this.position.x + forward.x * half,
      this.position.z + forward.z * half,
    );
    const stern = this.waterHeight(
      this.position.x - forward.x * half,
      this.position.z - forward.z * half,
    );
    const port = this.waterHeight(
      this.position.x - right.x * beam,
      this.position.z - right.z * beam,
    );
    const starboard = this.waterHeight(
      this.position.x + right.x * beam,
      this.position.z + right.z * beam,
    );

    // Planing lifts the bow; a boat under power sits stern-down.
    const plane = Math.min(1, Math.abs(this.speed) / this.topSpeed) * 0.1;
    const targetPitch = Math.atan2(bow - stern, half * 2) - plane;
    const targetRoll = Math.atan2(starboard - port, beam * 2);

    // Heavier hulls answer the sea more slowly than a jet ski does.
    const inertia = boat.build.kind === 'jetski' ? 9 : boat.build.kind === 'yacht' ? 2.4 : 3.6;
    const prevPitch = this.pitch;
    this.pitch += (targetPitch - this.pitch) * Math.min(1, dt * inertia);

    // Bow dropping fast while under way: the hull is coming down off a wave.
    this.slam = 0;
    this.slamCooldown = Math.max(0, this.slamCooldown - dt);
    const pitchRate = dt > 1e-5 ? (this.pitch - prevPitch) / dt : 0;
    if (this.slamCooldown === 0 && pitchRate < -0.28 && Math.abs(this.speed) > 4) {
      this.slam = Math.min(1, -pitchRate / 1.2);
      this.slamCooldown = 0.35;
    }
    this.roll += (targetRoll - this.roll) * Math.min(1, dt * inertia);

    this.bobPhase += dt;
    const surface = (bow + stern + port + starboard) / 4;
    const y = surface - boat.build.draft * 0.55 + Math.sin(this.bobPhase * 1.7) * 0.02;

    /* --------------------------------------------------------- visuals */

    const g = boat.build.group;
    g.position.set(this.position.x, y, this.position.z);
    g.rotation.set(0, 0, 0);
    g.rotateY(this.yaw);
    g.rotateX(this.pitch);
    g.rotateZ(-this.roll);
    this.position.y = y;
  }
}

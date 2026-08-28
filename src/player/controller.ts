import * as THREE from 'three';
import { Input } from '../core/input';
import { Colliders } from '../world/collision';
import { groundHeight, waterDepth, WATER_Y, SPAWN } from '../world/layout';
import { GAIT } from './animator';

const RADIUS = 0.28;
const CREEP = 0.85;

const GRAVITY = 21;
/** Tuned for a ~0.62 m hop: a real standing vertical, not a moon jump. */
const JUMP_SPEED = 5.1;
/** Grace period after walking off a ledge where a jump still registers. */
const COYOTE = 0.12;
/** A jump pressed this long before landing still fires on touchdown. */
const JUMP_BUFFER = 0.15;

/** Deeper than this and she starts swimming. */
const SWIM_ENTER_DEPTH = 1.2;
/** Shallower than this and she finds her feet again. Hysteresis stops flicker. */
const SWIM_EXIT_DEPTH = 0.95;
const SWIM_SPEED = 1.55;
const SWIM_SPRINT = 2.7;
/** How far the head/shoulders ride above the surface. */
const SWIM_FLOAT = 1.02;

/**
 * Ground locomotion with GTA-style steering: she always turns to face the
 * direction of travel rather than strafing, and top speed is limited while she
 * is still rotating so hard reversals read as a real pivot.
 */
export class Controller {
  readonly position = new THREE.Vector3(SPAWN.x, 0, SPAWN.z);
  yaw = SPAWN.yaw;

  /** Horizontal velocity. */
  private vel = new THREE.Vector2();
  private groundY = 0;
  /** Metres covered this frame — drives the gait phase. */
  distance = 0;
  turnRate = 0;

  /** Airborne state, read by the animator. */
  grounded = true;
  vy = 0;
  /** Height above the surface, for blending the airborne pose. */
  airHeight = 0;
  /** Set for one frame on touchdown so the animator can play a landing dip. */
  justLanded = false;
  /** Set for the one frame a jump launches. */
  justJumped = false;

  /**
   * Face this heading instead of the direction of travel.
   *
   * Aiming turns the locomotion inside out: she holds the camera's heading and
   * strafes around it, because a gun that swings to point wherever the feet are
   * going cannot be aimed. Null restores the normal turn-into-your-run.
   */
  faceYaw: number | null = null;

  /** True once the water is deep enough to be out of her depth. */
  swimming = false;
  /** Depth of water underfoot, so the animator can wade convincingly. */
  depth = 0;

  private coyote = 0;
  private jumpBuffer = 0;
  private dir = new THREE.Vector2();

  constructor(
    private input: Input,
    private colliders: Colliders,
    private waterHeight: (x: number, z: number) => number = () => WATER_Y,
  ) {
    this.groundY = groundHeight(this.position.x, this.position.z);
    this.position.y = this.groundY;
  }

  get speed(): number {
    return this.vel.length();
  }

  /** Drop Mara at a new spot, e.g. stepping out of a car. */
  teleport(pos: THREE.Vector3, yaw: number): void {
    this.position.copy(pos);
    this.yaw = yaw;
    this.vel.set(0, 0);
    this.vy = 0;
    this.grounded = true;
    this.distance = 0;
    this.turnRate = 0;
    this.groundY = groundHeight(pos.x, pos.z);
    this.position.y = this.groundY;
  }

  update(dt: number, cameraYaw: number): void {
    this.depth = waterDepth(this.position.x, this.position.z);
    // Hysteresis: a single threshold makes her flicker between wading and
    // swimming every time a wave passes.
    if (this.swimming) {
      if (this.depth < SWIM_EXIT_DEPTH) this.swimming = false;
    } else if (this.depth > SWIM_ENTER_DEPTH) {
      this.swimming = true;
      this.vy = 0;
      this.grounded = true;
    }

    if (this.swimming) {
      this.swim(dt, cameraYaw);
      return;
    }

    const axis = this.input.moveAxis();
    const wants = axis.x !== 0 || axis.y !== 0;

    // Screen-space intent -> world direction. Camera forward is (sin, cos) in
    // XZ and camera right is (-cos, sin), which is where these signs come from.
    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    this.dir.set(axis.y * sin - axis.x * cos, axis.y * cos + axis.x * sin);

    let top = this.input.creep
      ? CREEP
      : this.input.sprint
        ? GAIT.runSpeed
        : GAIT.walkSpeed;

    // Wading: water drags hard on the legs long before she has to swim.
    if (this.depth > 0.1) {
      top *= THREE.MathUtils.lerp(1, 0.45, Math.min(1, this.depth / SWIM_ENTER_DEPTH));
    }

    /* ------------------------------------------------------------ turn */

    const prevYaw = this.yaw;
    const aiming = this.faceYaw !== null;
    if (aiming) {
      // Snap round to the camera fast: any lag here is lag between where the
      // crosshair is and where the character is pointed.
      const delta = Math.atan2(
        Math.sin((this.faceYaw as number) - this.yaw),
        Math.cos((this.faceYaw as number) - this.yaw),
      );
      this.yaw += THREE.MathUtils.clamp(delta * 14 * dt, -Math.abs(delta), Math.abs(delta));
    } else if (wants) {
      const target = Math.atan2(this.dir.x, this.dir.y);
      let delta = target - this.yaw;
      delta = Math.atan2(Math.sin(delta), Math.cos(delta));

      // Turn faster on the spot than at a sprint — same as real running.
      const agility = THREE.MathUtils.lerp(11.0, 4.2, Math.min(1, this.speed / GAIT.runSpeed));
      const step = THREE.MathUtils.clamp(delta * agility * dt, -Math.abs(delta), Math.abs(delta));
      this.yaw += step;
    }
    this.turnRate = dt > 1e-5 ? Math.atan2(Math.sin(this.yaw - prevYaw), Math.cos(this.yaw - prevYaw)) / dt : 0;

    /* --------------------------------------------------------- velocity */

    const facing = new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
    // Aiming moves along the input direction rather than along the facing, so
    // she can sidestep and back off while keeping the gun on target. Capped
    // lower, because a full sprint sideways looks like a glitch.
    const desired = aiming
      ? this.dir.clone().multiplyScalar(wants ? Math.min(top, GAIT.walkSpeed * 1.05) : 0)
      : facing
          .clone()
          // Bleed off speed while she is still swinging toward the new heading.
          .multiplyScalar(wants ? top * (0.35 + 0.65 * Math.max(0, facing.dot(this.dir))) : 0);

    // Much less authority in the air — you commit to a jump's trajectory.
    const accel = (wants ? 14 : 18) * (this.grounded ? 1 : 0.22);
    if (this.grounded || wants) this.vel.lerp(desired, Math.min(1, accel * dt));
    if (this.vel.lengthSq() < 1e-5) this.vel.set(0, 0);

    /* ------------------------------------------------------- integrate */

    const before = this.position.clone();
    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.y * dt;

    this.colliders.resolve(this.position, RADIUS, this.groundY);

    // Distance actually covered after collision, so she stops striding into walls.
    this.distance = Math.hypot(this.position.x - before.x, this.position.z - before.z);

    // If a wall ate the motion, kill the velocity into it too.
    if (this.distance < this.speed * dt * 0.4) this.vel.multiplyScalar(0.45);

    /* ---------------------------------------------------------- ground */

    const target = groundHeight(this.position.x, this.position.z);
    // Smooth the kerb step so she rises onto the pavement instead of popping.
    this.groundY = THREE.MathUtils.damp(this.groundY, target, 14, dt);
    if (Math.abs(target - this.groundY) < 0.002) this.groundY = target;

    /* ------------------------------------------------------------ jump */

    this.justLanded = false;
    this.justJumped = false;
    this.coyote = this.grounded ? COYOTE : Math.max(0, this.coyote - dt);
    this.jumpBuffer = this.input.takeJump()
      ? JUMP_BUFFER
      : Math.max(0, this.jumpBuffer - dt);

    if (this.jumpBuffer > 0 && this.coyote > 0) {
      this.vy = JUMP_SPEED;
      this.justJumped = true;
      this.grounded = false;
      this.jumpBuffer = 0;
      this.coyote = 0;
      // A running jump carries further than a standing one.
      this.vel.multiplyScalar(1.06);
    }

    if (this.grounded) {
      this.position.y = this.groundY;
      this.airHeight = 0;
    } else {
      this.vy -= GRAVITY * dt;
      this.position.y += this.vy * dt;
      if (this.position.y <= this.groundY) {
        this.position.y = this.groundY;
        this.vy = 0;
        this.grounded = true;
        this.justLanded = true;
      }
      this.airHeight = this.position.y - this.groundY;
    }
  }

  /**
   * Swimming: a simple surface glide. She always faces where she is going,
   * rides the wave surface, and has no gravity or jump while afloat.
   */
  private swim(dt: number, cameraYaw: number): void {
    const axis = this.input.moveAxis();
    const wants = axis.x !== 0 || axis.y !== 0;

    const sin = Math.sin(cameraYaw);
    const cos = Math.cos(cameraYaw);
    this.dir.set(axis.y * sin - axis.x * cos, axis.y * cos + axis.x * sin);

    const prevYaw = this.yaw;
    if (wants) {
      const target = Math.atan2(this.dir.x, this.dir.y);
      const delta = Math.atan2(Math.sin(target - this.yaw), Math.cos(target - this.yaw));
      this.yaw += THREE.MathUtils.clamp(delta * 3.4 * dt, -Math.abs(delta), Math.abs(delta));
    }
    this.turnRate = dt > 1e-5
      ? Math.atan2(Math.sin(this.yaw - prevYaw), Math.cos(this.yaw - prevYaw)) / dt
      : 0;

    const top = this.input.sprint ? SWIM_SPRINT : SWIM_SPEED;
    const facing = new THREE.Vector2(Math.sin(this.yaw), Math.cos(this.yaw));
    const desired = facing.clone().multiplyScalar(wants ? top : 0);
    // Water has far more inertia than pavement, in both directions.
    this.vel.lerp(desired, Math.min(1, 2.2 * dt));

    const before = this.position.clone();
    this.position.x += this.vel.x * dt;
    this.position.z += this.vel.y * dt;
    this.colliders.resolve(this.position, RADIUS, 10);
    this.distance = Math.hypot(this.position.x - before.x, this.position.z - before.z);

    // Float on the swell, with the body just under the surface.
    const surface = this.waterHeight(this.position.x, this.position.z);
    this.groundY = surface - SWIM_FLOAT;
    this.position.y = this.groundY;

    this.grounded = true;
    this.vy = 0;
    this.justLanded = false;
    this.justJumped = false;
    this.airHeight = 0;
  }
}

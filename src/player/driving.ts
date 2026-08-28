import * as THREE from 'three';
import { Input } from '../core/input';
import { Colliders } from '../world/collision';
import { Drivable } from '../world/cars';
import { groundHeight } from '../world/layout';

/**
 * Arcade car handling — a kinematic bicycle model with a grip/slip split.
 *
 * Not a physics simulation: there are no forces, no suspension and no tyre
 * curves. The car has a heading, a speed along that heading, and a lateral
 * velocity that decays fast when gripping and slowly when the handbrake is
 * pulled. That is enough for the thing a player actually feels — that the car
 * rotates about its rear axle and can be provoked into a slide.
 */

const ACCEL = 9.5;
const BRAKE = 18;
const REVERSE_ACCEL = 5.5;
const TOP_SPEED = 34;
const REVERSE_TOP = 9;
/** Engine braking / rolling resistance when off the throttle. */
const COAST = 4.2;
const MAX_STEER = THREE.MathUtils.degToRad(34);
/** Steering authority falls off with speed, or it's undriveable at 100 km/h. */
const STEER_FALLOFF = 0.028;
const GRIP = 9.0;
const SLIP_GRIP = 1.6;

export class VehicleController {
  readonly position = new THREE.Vector3();
  yaw = 0;

  /** Signed speed along the car's own heading, m/s. */
  speed = 0;
  /** Sideways velocity in the car's frame — this is what a slide is. */
  private lateral = 0;
  /** Current front-wheel angle, eased toward the input. */
  steer = 0;
  /** Accumulated wheel rotation, for rolling the visuals. */
  private spin = 0;
  handbrake = false;
  /** Collision severity this frame, 0..1. Cleared by whoever reads it. */
  impact = 0;
  /** How hard the car is sliding sideways, 0..1 — drives tyre scrub. */
  get slip(): number {
    return Math.min(1, Math.abs(this.lateral) / 6);
  }

  car: Drivable | null = null;

  private forward = new THREE.Vector3();
  private prev = new THREE.Vector3();

  constructor(
    private input: Input,
    private colliders: Colliders,
  ) {}

  /** km/h, for the HUD. */
  get kph(): number {
    return Math.abs(this.speed) * 3.6;
  }

  enter(car: Drivable): void {
    this.car = car;
    car.occupied = true;
    // Swap in the articulated body. A parked car has its wheels baked into the
    // body as one merged set — see `bakeVehicle` — which is identical to look
    // at right up until they have to turn, and costs four fewer draw calls.
    car.build.setRolling?.(true);
    // The parked footprint would otherwise block the car it belongs to.
    car.collider.disable();
    this.position.copy(car.position);
    this.yaw = car.yaw;
    this.speed = 0;
    this.lateral = 0;
    this.steer = 0;
  }

  exit(): Drivable | null {
    const car = this.car;
    if (car) {
      car.occupied = false;
      car.build.setRolling?.(false);
      car.position.copy(this.position);
      car.yaw = this.yaw;
      // Hand the footprint back where the car actually ended up.
      car.collider.move(this.position.x, this.position.z, this.yaw);
      car.collider.enable();
    }
    this.car = null;
    return car;
  }

  /** Where Mara should be put down when she gets out — driver's side. */
  dismountPoint(out: THREE.Vector3): THREE.Vector3 {
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    out.copy(this.position).addScaledVector(right, -1.55);
    out.y = groundHeight(out.x, out.z);
    // If that lands inside something, drop her on the other side instead.
    const test = out.clone();
    this.colliders.resolve(test, 0.3, out.y);
    if (test.distanceToSquared(out) > 0.09) {
      out.copy(this.position).addScaledVector(right, 1.55);
      out.y = groundHeight(out.x, out.z);
    }
    return out;
  }

  update(dt: number): void {
    const car = this.car;
    if (!car) return;

    // Raw, unnormalised: normalising would sap throttle whenever you steer.
    const axis = this.input.driveAxis();
    const throttle = axis.y;
    this.handbrake = this.input.handbrake;

    /* ------------------------------------------------------ longitudinal */

    if (throttle > 0.01) {
      // Pressing forward while rolling backwards is a brake, not a gear change.
      const rate = this.speed < -0.2 ? BRAKE : ACCEL;
      this.speed += rate * throttle * dt;
    } else if (throttle < -0.01) {
      const rate = this.speed > 0.2 ? BRAKE : REVERSE_ACCEL;
      this.speed += rate * throttle * dt;
    } else {
      // Coast down toward zero without overshooting into the other direction.
      const drop = COAST * dt;
      this.speed = Math.abs(this.speed) <= drop ? 0 : this.speed - Math.sign(this.speed) * drop;
    }

    if (this.handbrake) {
      const drop = BRAKE * 0.8 * dt;
      this.speed = Math.abs(this.speed) <= drop ? 0 : this.speed - Math.sign(this.speed) * drop;
    }

    this.speed = THREE.MathUtils.clamp(this.speed, -REVERSE_TOP, TOP_SPEED);

    /* ----------------------------------------------------------- steering */

    const steerTarget = -axis.x * MAX_STEER * (1 / (1 + Math.abs(this.speed) * STEER_FALLOFF));
    // Ease into lock rather than snapping — this is most of the "weight".
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 9);

    const wheelbase = car.build.spec.axle[1] - car.build.spec.axle[0];
    // Bicycle model: yaw rate follows from speed, wheelbase and steer angle.
    const yawRate = (this.speed / Math.max(0.1, Math.abs(wheelbase))) * Math.tan(this.steer);
    this.yaw += yawRate * dt;

    /* ------------------------------------------------------------- slide */

    // Cornering throws lateral velocity that grip has to eat back up.
    this.lateral += yawRate * this.speed * dt * 0.55;
    const grip = this.handbrake ? SLIP_GRIP : GRIP;
    this.lateral -= this.lateral * Math.min(1, grip * dt);

    /* --------------------------------------------------------- integrate */

    this.prev.copy(this.position);
    this.forward.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = new THREE.Vector3(this.forward.z, 0, -this.forward.x);

    this.position.addScaledVector(this.forward, this.speed * dt);
    this.position.addScaledVector(right, this.lateral * dt);

    /* ------------------------------------------------------- collision */

    const radius = car.build.spec.width * 0.5 + 0.1;
    const before = this.position.clone();
    this.colliders.resolve(this.position, radius, 0.2);

    this.impact = 0;
    if (before.distanceToSquared(this.position) > 1e-4) {
      // Scrub off most of the speed on contact and kill the slide.
      this.impact = Math.min(1, Math.abs(this.speed) / 18);
      this.speed *= 0.35;
      this.lateral = 0;
    }

    // Ride the surface rather than the road plane, so mounting the kerb lifts
    // the car instead of sinking it 16 cm into the pavement.
    const surface = groundHeight(this.position.x, this.position.z);
    this.position.y = THREE.MathUtils.damp(this.position.y, surface, 12, dt);
    if (Math.abs(surface - this.position.y) < 0.002) this.position.y = surface;

    /* ---------------------------------------------------------- visuals */

    car.build.group.position.copy(this.position);
    // `yaw` is a heading in Mara's convention (forward = sin,cos), but the car
    // model's nose runs along its local +X, so the mesh trails by a quarter turn.
    car.build.group.rotation.y = this.yaw + Math.PI / 2;

    this.spin -= (this.speed / car.build.spec.wheelR) * dt;
    const wheels = car.build.wheels;
    for (let i = 0; i < wheels.length; i++) {
      wheels[i].rotation.z = this.spin;
      // First pair is the front axle, and only it steers.
      wheels[i].rotation.y = i < 2 ? this.steer : 0;
    }
  }
}

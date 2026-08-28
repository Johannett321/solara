import * as THREE from 'three';
import { Input } from '../core/input';
import { Colliders } from '../world/collision';
import { Drivable } from '../world/cars';
import { groundHeight } from '../world/layout';
import { insideBody, VehicleBody } from '../world/traffic';

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
/** The handbrake locks the rear only — nothing like the brake pedal. */
const HANDBRAKE_BRAKE = 4.5;
const MAX_STEER = THREE.MathUtils.degToRad(34);
/** Steering authority falls off with speed, or it's undriveable at 100 km/h. */
const STEER_FALLOFF = 0.045;

/**
 * Front and rear grip budgets, in m/s². **These must differ.**
 *
 * The front number limits how hard the steering can drag the car into a turn —
 * ask for more and it understeers, which is what stops the car pivoting on the
 * spot at 100 km/h the way it used to.
 *
 * The rear number is how much sideways velocity the back tyres can kill per
 * second. If it is *lower* than the front, hard cornering generates lateral
 * faster than the rear can absorb, the tail comes out, and the oversteer term
 * below turns that into a held drift. Setting both to the same value — which is
 * what the first attempt did — makes the car corner exactly at the limit
 * forever and it can never slide at all, handbrake included.
 */
const FRONT_GRIP = 13.5;
const REAR_GRIP = 9.5;
/** With the handbrake in, the rear has almost nothing. */
const HANDBRAKE_REAR = 3.1;
/**
 * How much a slide steers the car on its own.
 *
 * The rear stepping out rotates the nose further into the corner, which is what
 * makes a drift hold itself rather than washing out the moment you stop
 * steering. Too high and the car spins on any provocation.
 */
const OVERSTEER = 0.42;
/** Sliding sideways scrubs speed. Enough to cost you, not enough to stop you. */
const SCRUB = 0.34;
/** Past this much lateral velocity the car counts as drifting, for the HUD. */
const DRIFT_AT = 3.2;

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

  /** True once the slide is wide enough to read as a drift. */
  get drifting(): boolean {
    return Math.abs(this.lateral) > DRIFT_AT;
  }

  /** Bleed speed on a soft impact — a body, not a wall. */
  scrubOnImpact(keep: number): void {
    this.speed *= keep;
    this.lateral *= keep;
  }

  /** Angle between where the car points and where it is going, in radians. */
  get slipAngle(): number {
    return Math.atan2(this.lateral, Math.max(0.5, Math.abs(this.speed)));
  }

  car: Drivable | null = null;

  /**
   * Moving traffic, for car-to-car contact.
   *
   * Parked cars are handled by `Colliders` — they are static, so a box in the
   * shared set is the right answer. Traffic is not: it moves, and 616 boxes
   * being rewritten and walked every frame is not. Set once by `main.ts`.
   */
  traffic: VehicleBody[] = [];

  private forward = new THREE.Vector3();
  private prev = new THREE.Vector3();

  constructor(
    private input: Input,
    private colliders: Colliders,
  ) {}

  /**
   * km/h, for the HUD.
   *
   * The *whole* velocity, not just the component along the nose. `speed` is
   * longitudinal only, so a car travelling sideways in a drift has almost none
   * of it — the speedo used to fall to nothing mid-slide while the car was
   * still doing 70.
   */
  get kph(): number {
    return Math.hypot(this.speed, this.lateral) * 3.6;
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
      // Rear wheels only, so far weaker than the brake pedal. At `BRAKE * 0.8`
      // a handbrake turn stopped the car dead in about a second and a half,
      // which is a spin rather than a slide — the momentum through the corner
      // is the whole point.
      const drop = HANDBRAKE_BRAKE * dt;
      this.speed = Math.abs(this.speed) <= drop ? 0 : this.speed - Math.sign(this.speed) * drop;
    }

    this.speed = THREE.MathUtils.clamp(this.speed, -REVERSE_TOP, TOP_SPEED);

    /* ----------------------------------------------------------- steering */

    const steerTarget = -axis.x * MAX_STEER * (1 / (1 + Math.abs(this.speed) * STEER_FALLOFF));
    // Ease into lock rather than snapping — this is most of the "weight".
    this.steer += (steerTarget - this.steer) * Math.min(1, dt * 9);

    const wheelbase = car.build.spec.axle[1] - car.build.spec.axle[0];
    // What the front wheels are asking for.
    let yawRate = (this.speed / Math.max(0.1, Math.abs(wheelbase))) * Math.tan(this.steer);

    /* -------------------------------------------------- grip and slide */

    const rearGrip = this.handbrake ? HANDBRAKE_REAR : REAR_GRIP;

    // Turning at speed needs lateral acceleration, and the front tyres only
    // have so much. Asking for more understeers: the car turns less than the
    // wheels say, which is the whole reason it no longer pivots on the spot at
    // 100 km/h.
    const demand = Math.abs(yawRate * this.speed);
    if (demand > FRONT_GRIP) yawRate *= FRONT_GRIP / demand;

    // The slide steers the car. A rear that has stepped out to the right
    // rotates the nose to the left, and this term is what makes a drift hold
    // itself instead of snapping straight the moment the steering is centred.
    yawRate -= (this.lateral * OVERSTEER) / Math.max(3, Math.abs(this.speed));

    const dYaw = yawRate * dt;
    this.yaw += dYaw;

    // Momentum does not turn with the car. Rotating the body-frame velocity by
    // -dYaw is what converts a change of heading into sideways motion, and it
    // is the entire reason a flick left then right builds a slide: each
    // reversal pours more of the car's speed into `lateral` than the tyres can
    // take back out.
    const c = Math.cos(dYaw);
    const sn = Math.sin(dYaw);
    const long = this.speed * c + this.lateral * sn;
    const lat = -this.speed * sn + this.lateral * c;
    this.speed = long;
    this.lateral = lat;

    // The rear pulls the slide back in at a fixed *rate*, not a fixed fraction.
    // A proportional decay can always keep up and so can never actually slide;
    // a budget is what lets a big enough provocation exceed it.
    const bite = rearGrip * dt;
    this.lateral -= THREE.MathUtils.clamp(this.lateral, -bite, bite);
    // Nothing survives a spin: cap the slide so a long drift settles into a
    // shape the player can hold rather than winding up forever.
    this.lateral = THREE.MathUtils.clamp(this.lateral, -13, 13);

    // Scrubbing sideways costs speed, which is what stops a drift being free.
    this.speed -= Math.sign(this.speed) * Math.min(
      Math.abs(this.speed),
      Math.abs(this.lateral) * SCRUB * dt,
    );

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

    /* ---------------------------------------------------- car to car */

    // Traffic, tested as oriented rectangles. Approximating the player's car
    // by three points down its centre line rather than one is what stops it
    // driving nose-first through a car it is clearly touching.
    const half = car.build.spec.length * 0.5;
    for (const b of this.traffic) {
      if (b.taken) continue;
      const dx = b.position.x - this.position.x;
      const dz = b.position.z - this.position.z;
      if (dx * dx + dz * dz > 64) continue;
      for (const t of [-half * 0.75, 0, half * 0.75]) {
        const px = this.position.x + this.forward.x * t;
        const pz = this.position.z + this.forward.z * t;
        if (!insideBody(b, px, pz, radius)) continue;
        // Push straight apart along the line of centres. Both cars are the
        // same mass here; the AI one is not simulated, so the player takes all
        // of the separation and all of the speed loss.
        const d = Math.max(0.001, Math.hypot(dx, dz));
        const overlap = b.halfLength + radius - d;
        if (overlap > 0) {
          this.position.x -= (dx / d) * overlap;
          this.position.z -= (dz / d) * overlap;
        }
        // Closing speed, not absolute speed: rear-ending someone doing your
        // own speed should barely register.
        const closing = Math.abs(this.speed - b.speed * Math.sign(this.forward.z * Math.cos(b.yaw) + this.forward.x * Math.sin(b.yaw) || 1));
        this.impact = Math.max(this.impact, Math.min(1, closing / 18));
        this.speed *= 0.45;
        this.lateral *= 0.4;
        break;
      }
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

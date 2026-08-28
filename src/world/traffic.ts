import * as THREE from 'three';
import { Rng } from '../core/rng';
import { buildCar, bakeVehicle, CarKind, Drivable } from './cars';
import { Colliders, ColliderHandle } from './collision';
import { EXPRESSWAY_X, EXPRESSWAY_Y } from './city';
import { carSpec } from './cars';
import type { Cullable } from './culling';
import type { Panic } from './panic';
import {
  STRIP_MIN_Z,
  STRIP_MAX_Z,
  AVENUES,
  CITY_MIN_Z,
  CITY_MAX_Z,
  groundHeight,
  riverInfluence,
} from './layout';

/**
 * Cars cruising the strip. Deliberately simple: each one owns a lane, drives at
 * a steady speed, brakes for whatever is directly ahead in the same lane, and
 * wraps around at the ends. No pathfinding, no junction logic — from the
 * pavement it reads as traffic, which is the whole job.
 */

interface Vehicle {
  group: THREE.Group;
  lane: number;
  /** Set for viaduct traffic, which ignores the ground entirely. */
  deckY?: number;
  /** +1 drives toward +z, -1 toward -z. */
  dir: number;
  z: number;
  zMin: number;
  zMax: number;
  speed: number;
  cruise: number;
  /** 0 calm, 1 flooring it. */
  panic: number;
  /** Phase offset so a panicking lane does not weave in unison. */
  wobble: number;
  /** Lateral displacement from being hit, easing back to the lane. */
  shoveX: number;
  /** Extra yaw from being hit, easing back to straight. */
  shoveSpin: number;
  wheels: THREE.Object3D[];
  wheelR: number;
  /** This car's entry in the culler; `near` is the range rule below. */
  cull: Cullable;
  /**
   * The player has taken this one. The AI stops driving it for good — an
   * abandoned car does not rejoin the flow of traffic — and it keeps its own
   * place in the culler.
   */
  taken: boolean;
  /** Still carrying its AI driver, who gets hauled out on the first carjack. */
  hasDriver: boolean;
  /** Body, for run-overs and car-to-car contact. */
  body: VehicleBody;
}

/**
 * A moving car, as an oriented rectangle.
 *
 * Traffic cannot use `Colliders`: those are axis-aligned boxes rebuilt on
 * `move`, and 616 of them would be walked by every `resolve` and every 25 cm
 * step of the camera arm. These are read directly by whatever needs them — the
 * crowd for run-overs, `player/driving.ts` for car-to-car contact — and every
 * field is written in place each frame, so the array never reallocates.
 */
export interface VehicleBody {
  position: THREE.Vector3;
  yaw: number;
  halfLength: number;
  halfWidth: number;
  /** Ground speed, m/s. Impact severity comes from this. */
  speed: number;
  /** The player is driving it; nothing should collide it with itself. */
  taken: boolean;
  /**
   * Impulse from being hit, in m/s, decaying to nothing.
   *
   * Written by whoever hit it and consumed by `traffic.update`. A car that has
   * been shoved slides off its lane and drifts back to it, rather than being
   * nailed to it while another car bounces off — being hit has to move you or
   * it does not read as a crash.
   */
  pushX: number;
  pushZ: number;
  /** Rad/s of spin from an off-centre hit, also decaying. */
  pushSpin: number;
}

/** Is `px,pz` inside the body's footprint, grown by `pad`? */
export function insideBody(b: VehicleBody, px: number, pz: number, pad = 0): boolean {
  const dx = px - b.position.x;
  const dz = pz - b.position.z;
  const f = Math.sin(b.yaw);
  const c = Math.cos(b.yaw);
  // Heading is (sin, cos); its right is (cos, -sin).
  const along = dx * f + dz * c;
  const across = dx * c - dz * f;
  return Math.abs(along) < b.halfLength + pad && Math.abs(across) < b.halfWidth + pad;
}

export interface Traffic {
  group: THREE.Group;
  /** One entry per car, for group-level culling. */
  cullable: Cullable[];
  /**
   * Every car on the road is enterable. These go into the same
   * `world.drivables` list the kerbside cars use, so `main.ts` does not have to
   * know the difference — the only thing that marks them out is `hasDriver`.
   */
  drivables: Drivable[];
  /** One per car, updated in place — see `VehicleBody`. */
  bodies: VehicleBody[];
  update(dt: number, playerPos: THREE.Vector3, panic: Panic): void;
}

/**
 * Driving lanes, derived from the avenue grid rather than hardcoded — adding an
 * avenue in layout.ts puts traffic on it automatically.
 *
 * Right-hand traffic: the +x half of each carriageway heads toward +z.
 */
interface Lane {
  x: number;
  dir: number;
  zMin: number;
  zMax: number;
  /** Fixed deck height for the elevated expressway; undefined follows ground. */
  y?: number;
}

function buildLanes(): Lane[] {
  const lanes: Lane[] = [];
  for (const a of AVENUES) {
    // Ocean Drive keeps its kerbside parking, so its lanes sit further in.
    const inner = a.x === 0 ? 2.1 : 2.4;
    const outer = a.x === 0 ? 4.9 : a.halfWidth - 2.4;
    const zMin = a.x === 0 ? STRIP_MIN_Z : CITY_MIN_Z;
    const zMax = a.x === 0 ? STRIP_MAX_Z : CITY_MAX_Z;
    for (const off of [inner, outer]) {
      if (off > a.halfWidth - 1) continue;
      lanes.push({ x: a.x - off, dir: -1, zMin, zMax });
      lanes.push({ x: a.x + off, dir: 1, zMin, zMax });
    }
  }
  // Elevated expressway: four lanes on the viaduct deck.
  for (const off of [-6.4, -2.2, 2.2, 6.4]) {
    lanes.push({
      x: EXPRESSWAY_X + off,
      dir: off > 0 ? 1 : -1,
      zMin: CITY_MIN_Z,
      zMax: CITY_MAX_Z,
      y: EXPRESSWAY_Y + 0.3,
    });
  }

  return lanes;
}

const PALETTE: Array<[CarKind, number]> = [
  ['sedan', 0xdedde2],
  ['suv', 0x2b3138],
  ['coupe', 0xb8241f],
  ['sedan', 0x2f5fa8],
  ['supercar', 0xe8c020],
  ['suv', 0xe6e3da],
  ['coupe', 0x1b6f5a],
  ['sedan', 0x8a8f96],
];

const LENGTH = 5.0;
/** Bumper-to-bumper gap a driver will tolerate before lifting off. */
const HEADWAY = 9.5;

export function buildTraffic(colliders: Colliders): Traffic {
  const group = new THREE.Group();
  group.name = 'traffic';
  const rng = new Rng(90210);
  const vehicles: Vehicle[] = [];
  const cullable: Cullable[] = [];
  const drivables: Drivable[] = [];
  const bodies: VehicleBody[] = [];

  /**
   * A collider that does not exist until the car is abandoned.
   *
   * Traffic drives *through* the player rather than colliding, so a moving car
   * needs no footprint — and 621 permanent boxes would be paid for on every
   * `resolve` and on every step of the camera arm's `raycastXZ`, which walks at
   * 25 cm and is O(colliders). Only the handful the player actually parks ever
   * become real.
   */
  const lazyCollider = (kind: CarKind, x: number, z: number, yaw: number): ColliderHandle => {
    let real: ColliderHandle | null = null;
    const spec = carSpec(kind);
    const make = (cx: number, cz: number, cy: number): ColliderHandle => {
      real ??= colliders.addSwitchableBox(cx, cz, spec.length, spec.width, cy, spec.roofY);
      return real;
    };
    return {
      enable: () => make(x, z, yaw).enable(),
      disable: () => real?.disable(),
      move: (cx, cz, cy) => {
        x = cx;
        z = cz;
        yaw = cy;
        make(cx, cz, cy).move(cx, cz, cy);
      },
    };
  };

  let i = 0;
  for (const lane of buildLanes()) {
    const { x: laneX, dir } = lane;
    // Stagger the starting positions so they don't spawn in a convoy.
    for (let z = lane.zMin + rng.range(0, 40); z < lane.zMax; z += rng.range(34, 70)) {
      // Don't spawn a car floating in the middle of the channel (the viaduct
      // deck is the one place that's fine, because it bridges it).
      if (lane.y === undefined && riverInfluence(laneX, z) > 0.4) continue;
      const [kind, color] = PALETTE[i++ % PALETTE.length];
      const build = bakeVehicle(buildCar(kind, color, rng));

      // Heading convention: forward = (sin yaw, cos yaw). The model's nose runs
      // along its local **-X**, so the mesh leads the heading by a quarter turn.
      const heading = dir > 0 ? 0 : Math.PI;
      build.group.rotation.y = heading + Math.PI / 2;
      build.group.position.set(laneX, 0, z);
      group.add(build.group);

      const cull: Cullable = {
        object: build.group,
        // Half the diagonal of the longest body, plus the roof.
        radius: Math.hypot(LENGTH, 2.2) * 0.5 + 1.6,
        near: true,
      };
      cullable.push(cull);

      const body: VehicleBody = {
        position: build.group.position,
        yaw: heading,
        halfLength: carSpec(kind).length * 0.5,
        halfWidth: carSpec(kind).width * 0.5,
        speed: 0,
        taken: false,
        pushX: 0,
        pushZ: 0,
        pushSpin: 0,
      };
      bodies.push(body);

      const v: Vehicle = {
        group: build.group,
        cull,
        taken: false,
        hasDriver: true,
        body,
        lane: laneX,
        deckY: lane.y,
        dir,
        z,
        zMin: lane.zMin,
        zMax: lane.zMax,
        speed: 0,
        cruise: rng.range(7.5, 12.5),
        panic: 0,
        wobble: rng.range(0, Math.PI * 2),
        shoveX: 0,
        shoveSpin: 0,
        wheels: build.wheels,
        wheelR: build.spec.wheelR,
      };
      vehicles.push(v);

      // Live references: `position` is the group's own vector, so the entry
      // tracks the car down the road without anything having to copy it.
      drivables.push({
        build,
        collider: lazyCollider(kind, laneX, z, heading),
        position: build.group.position,
        yaw: heading,
        occupied: false,
        hasDriver: true,
        onTaken: () => {
          v.taken = true;
          v.speed = 0;
          v.cull.near = true;
          body.taken = true;
          body.speed = 0;
        },
      });
    }
  }



  return {
    group,
    cullable,
    drivables,
    bodies,
    update(dt, playerPos, panic) {
      for (const v of vehicles) {
        // Taken cars belong to the player now; the driving model owns their
        // transform and the culler owns their visibility.
        if (v.taken) continue;
        /* ------------------------------------------------ car following */

        const span = v.zMax - v.zMin;
        let gap = Infinity;
        for (const o of vehicles) {
          if (o === v || o.lane !== v.lane) continue;
          // Signed distance ahead, wrapped around the loop.
          let d = (o.z - v.z) * v.dir;
          if (d < 0) d += span;
          gap = Math.min(gap, d - LENGTH);
        }

        // Also yield if the player has wandered into this lane.
        const px = playerPos.x - v.lane;
        if (Math.abs(px) < 1.6) {
          let d = (playerPos.z - v.z) * v.dir;
          if (d < 0) d += span;
          gap = Math.min(gap, d - LENGTH * 0.5);
        }

        /* ---------------------------------------------------------- panic */

        // Drivers who have seen a gun stop driving like drivers: they floor it,
        // they tailgate, and they wander out of lane. Eased in, and eased out
        // over several seconds so the street settles rather than snapping back.
        const fear = panic.at(v.lane, v.z);
        v.panic += (fear - v.panic) * Math.min(1, dt * (fear > v.panic ? 2.5 : 0.6));

        const cruise = v.cruise * (1 + v.panic * 1.15);
        // Headway compliance goes with the panic — but never to zero, or the
        // lane telescopes into one pile of cars at the first red light.
        const headway = HEADWAY * (1 - v.panic * 0.45);
        const target = gap < headway ? cruise * Math.max(0, gap / headway) : cruise;
        // Brake harder than you accelerate, and harder still when frightened.
        const rate = target < v.speed ? 9 : 3.2 + v.panic * 5;
        v.speed += THREE.MathUtils.clamp(target - v.speed, -rate * dt, rate * dt);

        /* ------------------------------------------------------- motion */

        v.z += v.dir * v.speed * dt;
        if (v.z > v.zMax) v.z -= span;
        if (v.z < v.zMin) v.z += span;
        // Follow the surface, so traffic climbs the bridges instead of
        // driving straight through the riverbed.
        /* ---------------------------------------------------------- shoved */

        // Knocked out of lane by a collision, and recovering. The push is a
        // velocity that decays; `shoveX` is where it has carried the car so
        // far, and that in turn eases back to zero once the push has gone.
        const b = v.body;
        if (b.pushX !== 0 || b.pushZ !== 0 || b.pushSpin !== 0) {
          v.shoveX += b.pushX * dt;
          v.z += b.pushZ * dt;
          v.shoveSpin += b.pushSpin * dt;
          const decay = Math.max(0, 1 - 3.2 * dt);
          b.pushX *= decay;
          b.pushZ *= decay;
          b.pushSpin *= decay;
          if (Math.abs(b.pushX) < 0.05) b.pushX = 0;
          if (Math.abs(b.pushZ) < 0.05) b.pushZ = 0;
          if (Math.abs(b.pushSpin) < 0.02) b.pushSpin = 0;
        }
        // Pull back into lane and straighten up, but slowly enough to see.
        v.shoveX -= v.shoveX * Math.min(1, dt * 0.9);
        v.shoveSpin -= v.shoveSpin * Math.min(1, dt * 1.4);

        // Swerve. The wander is driven off `z` rather than a clock so a car
        // weaves along the road instead of shimmying on the spot in traffic.
        const swerve = v.panic * Math.sin(v.z * 0.22 + v.wobble) * 1.35;
        const x = v.lane + swerve + v.shoveX;
        v.group.position.set(x, v.deckY ?? groundHeight(x, v.z), v.z);
        // Point where it is actually going, so a swerving car leans into it.
        const drift = v.panic * Math.cos(v.z * 0.22 + v.wobble) * 0.3;
        v.group.rotation.y =
          (v.dir > 0 ? 0 : Math.PI) + Math.PI / 2 - drift * v.dir + v.shoveSpin;

        // Keep the body in step with what was just drawn.
        v.body.yaw = (v.dir > 0 ? 0 : Math.PI) - v.shoveSpin;
        v.body.speed = v.speed;

        // Roll the wheels to match ground speed.
        const spin = (v.speed / v.wheelR) * dt * v.dir;
        for (const w of v.wheels) w.rotation.z -= spin;

        // Hide anything past the junction haze rather than paying for it. The
        // culler ANDs this with the view and shadow frusta, so it stays the one
        // range rule while there is only ever one writer of `visible`.
        v.cull.near = Math.abs(v.z - playerPos.z) <= 90;
      }
    },
  };
}

import * as THREE from 'three';
import { Rng } from '../core/rng';
import { buildCar, bakeVehicle, CarKind } from './cars';
import { EXPRESSWAY_X, EXPRESSWAY_Y } from './city';
import type { Cullable } from './culling';
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
  wheels: THREE.Object3D[];
  wheelR: number;
  /** This car's entry in the culler; `near` is the range rule below. */
  cull: Cullable;
}

export interface Traffic {
  group: THREE.Group;
  /** One entry per car, for group-level culling. */
  cullable: Cullable[];
  update(dt: number, playerPos: THREE.Vector3): void;
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

export function buildTraffic(): Traffic {
  const group = new THREE.Group();
  group.name = 'traffic';
  const rng = new Rng(90210);
  const vehicles: Vehicle[] = [];
  const cullable: Cullable[] = [];

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
      // along its local +X, so the mesh trails the heading by a quarter turn.
      const heading = dir > 0 ? 0 : Math.PI;
      build.group.rotation.y = heading - Math.PI / 2;
      build.group.position.set(laneX, 0, z);
      group.add(build.group);

      const cull: Cullable = {
        object: build.group,
        // Half the diagonal of the longest body, plus the roof.
        radius: Math.hypot(LENGTH, 2.2) * 0.5 + 1.6,
        near: true,
      };
      cullable.push(cull);

      vehicles.push({
        group: build.group,
        cull,
        lane: laneX,
        deckY: lane.y,
        dir,
        z,
        zMin: lane.zMin,
        zMax: lane.zMax,
        speed: 0,
        cruise: rng.range(7.5, 12.5),
        wheels: build.wheels,
        wheelR: build.spec.wheelR,
      });
    }
  }



  return {
    group,
    cullable,
    update(dt, playerPos) {
      for (const v of vehicles) {
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

        const target = gap < HEADWAY ? v.cruise * Math.max(0, gap / HEADWAY) : v.cruise;
        // Brake harder than you accelerate.
        const rate = target < v.speed ? 9 : 3.2;
        v.speed += THREE.MathUtils.clamp(target - v.speed, -rate * dt, rate * dt);

        /* ------------------------------------------------------- motion */

        v.z += v.dir * v.speed * dt;
        if (v.z > v.zMax) v.z -= span;
        if (v.z < v.zMin) v.z += span;
        // Follow the surface, so traffic climbs the bridges instead of
        // driving straight through the riverbed.
        v.group.position.set(v.lane, v.deckY ?? groundHeight(v.lane, v.z), v.z);

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

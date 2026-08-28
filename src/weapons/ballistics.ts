import * as THREE from 'three';
import { Colliders } from '../world/collision';
import { groundHeight } from '../world/layout';

/**
 * Where a bullet stops.
 *
 * There is no mesh-level raycast anywhere in this: the world is a few hundred
 * merged meshes holding 14M triangles with no BVH over them, so asking three to
 * intersect it would cost more than the whole frame. Bullets test the same
 * three things the rest of the game uses for physics — the terrain function,
 * the collider set, and the agents' own positions — which also means a bullet
 * can never disagree with what the player can walk into.
 */

export type HitKind = 'ground' | 'wall' | 'person' | 'vehicle' | 'sky';

/** Where on a person a round landed. A head shot is not a body shot. */
export type HitZone = 'head' | 'body';

export interface Hit {
  kind: HitKind;
  point: THREE.Vector3;
  distance: number;
  /** Rough surface normal, for orienting the impact puff. */
  normal: THREE.Vector3;
  /** Index into `Targets.people` when `kind` is 'person', else -1. */
  person: number;
  /** Set with `person`; null otherwise. */
  zone: HitZone | null;
}

/**
 * A pedestrian, as two spheres.
 *
 * Heights are stored per person rather than assumed, because the crowd varies
 * height by ±10% and a fixed head sphere would sit in the neck of the tall ones
 * and above the hair of the short ones.
 */
export interface PersonTarget {
  /** Feet position, held by reference and written by the crowd each frame. */
  position: THREE.Vector3;
  headY: number;
  headR: number;
  bodyY: number;
  bodyR: number;
  /** Bodies on the ground stop being targets. */
  dead: boolean;
}

export interface Targets {
  people: PersonTarget[];
  /** Vehicles, as centre plus an enclosing radius. */
  vehicles: Array<{ position: THREE.Vector3; radius: number }>;
}

/**
 * Colliders are only consulted within this range.
 *
 * Every metre of collider testing is O(colliders), and essentially every shot
 * that matters lands well inside this. Past it a bullet can still hit the
 * ground or a person; it just stops being stopped by walls, which is invisible
 * because at 80 m the tracer is a couple of pixels long anyway.
 */
const COLLIDER_RANGE = 80;

/** Fine steps close in, coarse ones further out, and a hard cap on the walk. */
const NEAR_STEP = 0.35;
const FAR_STEP = 1.8;
const NEAR_RANGE = 30;
const MAX_STEPS = 200;

const UP = new THREE.Vector3(0, 1, 0);

/** Ray vs. a sphere standing on `base`, returning entry distance or -1. */
function sphereHit(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  centre: THREE.Vector3,
  radius: number,
  maxDist: number,
): number {
  const ox = origin.x - centre.x;
  const oy = origin.y - centre.y;
  const oz = origin.z - centre.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  // Origin inside the sphere: the shooter's own body, never a hit.
  if (c < 0) return -1;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t >= 0 && t <= maxDist ? t : -1;
}

const probe = new THREE.Vector3();
const centre = new THREE.Vector3();

/**
 * @param origin Start of the shot — the camera, not the muzzle, so the round
 *   goes exactly where the crosshair is.
 * @param dir Normalised, already spread.
 */
export function traceShot(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  range: number,
  colliders: Colliders,
  targets: Targets,
  out: Hit,
): Hit {
  // Agents first, analytically — stepping the ray and testing 424 pedestrians
  // per step would be four orders of magnitude more work than closing the form.
  let best = range;
  let bestKind: HitKind = 'sky';
  let bestCentre: THREE.Vector3 | null = null;
  let bestPerson = -1;
  let bestZone: HitZone | null = null;

  for (let i = 0; i < targets.people.length; i++) {
    const p = targets.people[i];
    if (p.dead) continue;
    // Head first: it is inside the body sphere's vertical span, so testing the
    // body alone would swallow every head shot.
    centre.set(p.position.x, p.position.y + p.headY, p.position.z);
    let t = sphereHit(origin, dir, centre, p.headR, best);
    let zone: HitZone | null = t >= 0 ? 'head' : null;
    if (t < 0) {
      centre.set(p.position.x, p.position.y + p.bodyY, p.position.z);
      t = sphereHit(origin, dir, centre, p.bodyR, best);
      if (t >= 0) zone = 'body';
    }
    if (t >= 0) {
      best = t;
      bestKind = 'person';
      bestCentre = centre.clone();
      bestPerson = i;
      bestZone = zone;
    }
  }
  for (const v of targets.vehicles) {
    centre.set(v.position.x, v.position.y + 0.7, v.position.z);
    const t = sphereHit(origin, dir, centre, v.radius, best);
    if (t >= 0) {
      best = t;
      bestKind = 'vehicle';
      bestCentre = centre.clone();
      bestPerson = -1;
      bestZone = null;
    }
  }

  // Then the world, marched. Stops at `best` — no point walking past a body.
  let travelled = 0;
  let steps = 0;
  while (travelled < best && steps++ < MAX_STEPS) {
    travelled = Math.min(best, travelled + (travelled < NEAR_RANGE ? NEAR_STEP : FAR_STEP));
    probe.copy(origin).addScaledVector(dir, travelled);

    const ground = groundHeight(probe.x, probe.z);
    if (probe.y <= ground) {
      // Bisect back to the surface so the puff sits on it rather than under it.
      let lo = travelled - NEAR_STEP;
      let hi = travelled;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        probe.copy(origin).addScaledVector(dir, mid);
        if (probe.y <= groundHeight(probe.x, probe.z)) hi = mid;
        else lo = mid;
      }
      out.kind = 'ground';
      out.person = -1;
      out.zone = null;
      out.distance = hi;
      out.point.copy(origin).addScaledVector(dir, hi);
      out.point.y = groundHeight(out.point.x, out.point.z);
      out.normal.copy(UP);
      return out;
    }

    if (travelled < COLLIDER_RANGE && colliders.hits(probe.x, probe.z, probe.y)) {
      out.kind = 'wall';
      out.person = -1;
      out.zone = null;
      out.distance = travelled;
      out.point.copy(origin).addScaledVector(dir, travelled);
      // Face the shooter. A real normal would need the collider's face, and at
      // the size these puffs are drawn nobody can tell.
      out.normal.copy(dir).multiplyScalar(-1);
      return out;
    }
  }

  out.kind = bestKind;
  out.person = bestPerson;
  out.zone = bestZone;
  out.distance = best;
  out.point.copy(origin).addScaledVector(dir, best);
  if (bestCentre) out.normal.copy(out.point).sub(bestCentre).normalize();
  else out.normal.copy(dir).multiplyScalar(-1);
  return out;
}

/**
 * Scatter a direction inside a cone of half-angle `spread`.
 *
 * Uniform over the disc rather than over the angle: sampling the angle flat
 * piles rounds into the centre and the cone stops reading as a cone.
 */
export function spreadDir(dir: THREE.Vector3, spread: number, out: THREE.Vector3): THREE.Vector3 {
  out.copy(dir);
  if (spread <= 0) return out;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(Math.random()) * spread;
  // Any two axes perpendicular to the shot will do.
  const side = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP;
  const right = new THREE.Vector3().crossVectors(dir, side).normalize();
  const up = new THREE.Vector3().crossVectors(right, dir).normalize();
  out.addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r);
  return out.normalize();
}

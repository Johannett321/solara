import * as THREE from 'three';
import { bakeStatic } from '../util/bake';
import type { WeaponId } from './specs';

/**
 * Weapon geometry, built from primitives like everything else in the project.
 *
 * These are held at arm's length and never fill more than a few hundred pixels,
 * so they are deliberately blocky: enough silhouette to read as a pistol or an
 * SMG over the shoulder, and no more. Each is baked down to one mesh per
 * material — a gun the player is holding is drawn every single frame, and it is
 * the one mesh in the world that is never culled.
 *
 * Models point down **local -Z** with the grip at the origin, which is how they
 * hang from the wrist joint: the hand closes around the origin and the barrel
 * runs away from the body.
 */

const cache = new Map<string, THREE.Material>();

function mat(key: string, make: () => THREE.Material): THREE.Material {
  let m = cache.get(key);
  if (!m) {
    m = make();
    cache.set(key, m);
  }
  return m;
}

const gunmetal = () =>
  mat('gunmetal', () =>
    new THREE.MeshStandardMaterial({ color: 0x2a2e34, roughness: 0.42, metalness: 0.85 }),
  );
const blued = () =>
  mat('blued', () =>
    new THREE.MeshStandardMaterial({ color: 0x14171b, roughness: 0.3, metalness: 0.9 }),
  );
const polymer = () =>
  mat('polymer', () =>
    new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.78, metalness: 0.05 }),
  );
function box(
  w: number,
  h: number,
  d: number,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  m.position.set(x, y, z);
  return m;
}

function tube(
  r: number,
  len: number,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 10), material);
  // Cylinders stand on Y; every barrel here runs along -Z.
  m.rotation.x = Math.PI / 2;
  m.position.set(x, y, z);
  return m;
}

function buildPistol(): THREE.Group {
  const g = new THREE.Group();

  // Grip, raked back the way a pistol grip actually sits in the hand.
  const grip = box(0.036, 0.125, 0.052, polymer(), 0, -0.055, 0.012);
  grip.rotation.x = -0.22;
  g.add(grip);

  // Frame and slide.
  g.add(box(0.034, 0.038, 0.185, gunmetal(), 0, 0.022, -0.062));
  g.add(box(0.036, 0.022, 0.19, blued(), 0, 0.048, -0.066));
  // Ejection port, so the slide reads as a slide.
  g.add(box(0.038, 0.012, 0.042, polymer(), 0.001, 0.052, -0.028));

  // Trigger guard: a thin loop under the frame.
  g.add(box(0.014, 0.008, 0.044, gunmetal(), 0, -0.006, -0.03));
  g.add(box(0.014, 0.03, 0.008, gunmetal(), 0, -0.02, -0.05));
  g.add(box(0.008, 0.022, 0.008, blued(), 0, -0.006, -0.036));

  // Sights — the things the player lines up when aiming.
  g.add(box(0.01, 0.008, 0.008, blued(), 0, 0.064, -0.152));
  g.add(box(0.018, 0.008, 0.008, blued(), 0, 0.064, 0.018));

  return g;
}

function buildSmg(): THREE.Group {
  const g = new THREE.Group();

  const grip = box(0.038, 0.115, 0.05, polymer(), 0, -0.05, 0.03);
  grip.rotation.x = -0.16;
  g.add(grip);

  // Receiver, running well forward of the grip.
  g.add(box(0.05, 0.072, 0.3, polymer(), 0, 0.03, -0.09));
  g.add(box(0.044, 0.03, 0.315, gunmetal(), 0, 0.062, -0.095));

  // Barrel and shroud.
  g.add(tube(0.011, 0.13, blued(), 0, 0.03, -0.3));
  g.add(box(0.036, 0.036, 0.09, gunmetal(), 0, 0.03, -0.275));

  // Magazine forward of the grip — the silhouette cue that says SMG.
  const magazine = box(0.03, 0.14, 0.05, polymer(), 0, -0.055, -0.055);
  magazine.rotation.x = 0.08;
  g.add(magazine);

  // Folding stock.
  g.add(box(0.014, 0.014, 0.13, gunmetal(), -0.02, 0.03, 0.12));
  g.add(box(0.014, 0.014, 0.13, gunmetal(), 0.02, 0.03, 0.12));
  g.add(box(0.058, 0.05, 0.016, polymer(), 0, 0.03, 0.185));

  // Foregrip, so the support hand has something to sit on.
  const fore = box(0.03, 0.075, 0.036, polymer(), 0, -0.02, -0.24);
  fore.rotation.x = 0.12;
  g.add(fore);

  // Sights.
  g.add(box(0.01, 0.014, 0.008, blued(), 0, 0.086, -0.235));
  g.add(box(0.026, 0.012, 0.008, blued(), 0, 0.086, -0.02));

  return g;
}

/** Where the muzzle flash sits and the tracer starts, in model space. */
export const MUZZLE: Record<WeaponId, THREE.Vector3> = {
  pistol: new THREE.Vector3(0, 0.048, -0.166),
  smg: new THREE.Vector3(0, 0.03, -0.372),
};

/**
 * Where the support hand grips a two-handed weapon, in model space.
 *
 * Reference data, not read at runtime: this is the point `AIM_POSE`'s support
 * arm was solved against, and the point to re-solve against when a new
 * two-handed weapon is added. The magazine well, not the foregrip — with the
 * gun arm extended the foregrip ends up further from the left shoulder than the
 * whole left arm is long, so no support pose can reach it.
 */
export const SUPPORT_GRIP: Record<WeaponId, THREE.Vector3> = {
  pistol: new THREE.Vector3(0, -0.02, -0.02),
  smg: new THREE.Vector3(0, -0.055, -0.055),
};

const BUILDERS: Record<WeaponId, () => THREE.Group> = {
  pistol: buildPistol,
  smg: buildSmg,
};

/** Build a weapon, baked to one mesh per material. */
export function buildWeapon(id: WeaponId): THREE.Group {
  const baked = bakeStatic(BUILDERS[id]());
  baked.name = `weapon:${id}`;
  for (const child of baked.children) {
    const m = child as THREE.Mesh;
    m.castShadow = true;
    m.receiveShadow = true;
  }
  return baked;
}

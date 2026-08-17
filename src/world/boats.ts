import * as THREE from 'three';
import { loft, Section } from '../util/loft';
import { Rng } from '../core/rng';
import { bakeStatic } from '../util/bake';
import { SHORELINE_X } from './layout';

/**
 * Boats: catamarans, motor yachts, runabouts and jet skis.
 *
 * Hulls are lofted stations — a stack of elliptical cross-sections along the
 * length, exactly like Mara's limbs — then rotated so the length runs along
 * +Z. Boats therefore use the *heading* convention directly (`rotation.y = yaw`,
 * forward = sin/cos) with none of the quarter-turn offset the cars need.
 */

export type BoatKind = 'catamaran' | 'yacht' | 'runabout' | 'jetski';

/* ------------------------------------------------------------- materials */

const M = {
  hullWhite: new THREE.MeshPhysicalMaterial({
    color: 0xf4f5f3,
    roughness: 0.22,
    metalness: 0.0,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.2,
  }),
  hullNavy: new THREE.MeshPhysicalMaterial({
    color: 0x1d3a5c,
    roughness: 0.2,
    metalness: 0.1,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.2,
  }),
  antifoul: new THREE.MeshStandardMaterial({ color: 0x14232e, roughness: 0.6 }),
  glass: new THREE.MeshPhysicalMaterial({
    color: 0x0e1a20,
    roughness: 0.04,
    metalness: 0,
    reflectivity: 0.9,
    clearcoat: 1,
    envMapIntensity: 2.0,
    side: THREE.DoubleSide,
  }),
  teak: new THREE.MeshStandardMaterial({ color: 0xc09a63, roughness: 0.72 }),
  chrome: new THREE.MeshStandardMaterial({
    color: 0xd6d9dd,
    metalness: 1,
    roughness: 0.1,
    envMapIntensity: 1.6,
  }),
  canvasTop: new THREE.MeshStandardMaterial({
    color: 0xf0efe8,
    roughness: 0.85,
    side: THREE.DoubleSide,
  }),
  dark: new THREE.MeshStandardMaterial({ color: 0x22262b, roughness: 0.5, metalness: 0.3 }),
};

const skiCache = new Map<number, THREE.MeshPhysicalMaterial>();
function skiPaint(color: number): THREE.MeshPhysicalMaterial {
  let m = skiCache.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color,
      roughness: 0.2,
      metalness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      envMapIntensity: 1.2,
    });
    skiCache.set(color, m);
  }
  return m;
}

/* ------------------------------------------------------------------ hull */

/**
 * A hull from stations. `t` runs 0 (stern) to 1 (bow); `halfBeam` and `draft`
 * are the section's half-width and depth below the sheer line.
 */
function hull(
  length: number,
  stations: Array<{ t: number; halfBeam: number; draft: number; rise?: number }>,
  material: THREE.Material,
): THREE.Mesh {
  const sections: Section[] = stations.map((s) => ({
    y: s.t * length,
    w: s.halfBeam,
    d: s.draft / 2,
    // Section z becomes -y after the rotation below, so this sinks the keel.
    z: s.draft / 2 - (s.rise ?? 0),
  }));

  const geo = loft(sections, { rings: 26, radial: 18, capScale: 0.45 });
  // +Y (station axis) -> +Z, so the boat points along +Z like every heading.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -length / 2);

  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function box(
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Stanchions + a top wire, the thing that makes a deck read as a real boat. */
function railing(g: THREE.Group, pts: Array<[number, number]>, y: number, h = 0.72): void {
  for (let i = 0; i < pts.length; i++) {
    const [x, z] = pts[i];
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, h, 6), M.chrome);
    post.position.set(x, y + h / 2, z);
    post.castShadow = true;
    g.add(post);

    if (i < pts.length - 1) {
      const [nx, nz] = pts[i + 1];
      const dx = nx - x;
      const dz = nz - z;
      const len = Math.hypot(dx, dz);
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 5), M.chrome);
      wire.position.set(x + dx / 2, y + h, z + dz / 2);
      wire.rotation.set(Math.PI / 2, 0, 0);
      wire.rotation.y = Math.atan2(dx, dz);
      g.add(wire);
    }
  }
}

/* ------------------------------------------------------------- catamaran */

function catamaran(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const L = 12.5;
  const beamHalf = 2.9;

  // Twin slender hulls.
  for (const s of [-1, 1]) {
    const h = hull(
      L,
      [
        { t: 0.0, halfBeam: 0.44, draft: 0.72 },
        { t: 0.18, halfBeam: 0.52, draft: 0.86 },
        { t: 0.45, halfBeam: 0.5, draft: 0.9 },
        { t: 0.72, halfBeam: 0.42, draft: 0.8 },
        { t: 0.9, halfBeam: 0.28, draft: 0.6, rise: 0.12 },
        { t: 1.0, halfBeam: 0.1, draft: 0.4, rise: 0.28 },
      ],
      M.hullWhite,
    );
    h.position.x = s * beamHalf;
    g.add(h);

    // Boot stripe along the waterline.
    const stripe = box(0.06, 0.16, L * 0.86, M.hullNavy, s * (beamHalf + 0.5), -0.3, -0.3);
    g.add(stripe);
  }

  // Bridge deck spanning the hulls.
  const deck = box(beamHalf * 2 + 0.9, 0.22, L * 0.78, M.hullWhite, 0, 0.16, -0.4);
  g.add(deck);
  g.add(box(beamHalf * 2 - 0.6, 0.04, L * 0.34, M.teak, 0, 0.29, -3.4));

  // Saloon: wide, low, wraparound glass.
  const cabW = beamHalf * 2 - 0.5;
  g.add(box(cabW, 1.5, 4.6, M.hullWhite, 0, 1.02, 0.6));
  g.add(box(cabW + 0.06, 0.72, 3.4, M.glass, 0, 1.28, 0.9));
  for (const s of [-1, 1]) {
    const side = box(0.05, 0.66, 4.2, M.glass, s * (cabW / 2 + 0.02), 1.24, 0.5);
    g.add(side);
  }

  // Raked windscreen at the front of the saloon.
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(cabW - 0.2, 1.15), M.glass);
  ws.position.set(0, 1.3, 2.92);
  ws.rotation.x = 0.42;
  g.add(ws);

  // Flybridge with a soft top.
  g.add(box(cabW - 1.0, 0.16, 2.4, M.hullWhite, 0, 1.85, 0.2));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.1, 6), M.chrome);
      post.position.set(sx * (cabW / 2 - 0.7), 2.45, 0.2 + sz * 1.05);
      g.add(post);
    }
  }
  g.add(box(cabW - 0.7, 0.08, 2.7, M.canvasTop, 0, 3.02, 0.2));

  // Bow trampoline and pulpit.
  g.add(box(beamHalf * 2 - 0.4, 0.05, 2.6, M.canvasTop, 0, 0.18, 4.6));
  railing(
    g,
    [
      [-beamHalf - 0.4, 3.0],
      [-beamHalf - 0.2, 5.2],
      [0, 6.1],
      [beamHalf + 0.2, 5.2],
      [beamHalf + 0.4, 3.0],
    ],
    0.28,
    0.62,
  );

  // Outboards.
  for (const s of [-1, 1]) {
    g.add(box(0.42, 0.7, 0.5, M.dark, s * beamHalf, 0.1, -5.9));
    g.add(box(0.16, 0.7, 0.16, M.dark, s * beamHalf, -0.5, -6.0));
  }

  if (rng.chance(0.5)) g.add(box(0.05, 1.9, 0.05, M.chrome, 0, 3.9, 0.2));
  return g;
}

/* ----------------------------------------------------------------- yacht */

function yacht(): THREE.Group {
  const g = new THREE.Group();
  const L = 17;

  g.add(
    hull(
      L,
      [
        { t: 0.0, halfBeam: 1.72, draft: 1.15 },
        { t: 0.14, halfBeam: 1.95, draft: 1.3 },
        { t: 0.38, halfBeam: 2.05, draft: 1.35 },
        { t: 0.62, halfBeam: 1.9, draft: 1.25 },
        { t: 0.82, halfBeam: 1.4, draft: 1.05, rise: 0.18 },
        { t: 0.94, halfBeam: 0.8, draft: 0.85, rise: 0.42 },
        { t: 1.0, halfBeam: 0.16, draft: 0.6, rise: 0.66 },
      ],
      M.hullWhite,
    ),
  );

  // Dark boot top and antifouling below the waterline.
  g.add(box(4.2, 0.18, L * 0.9, M.hullNavy, 0, -0.62, -0.2));

  // Main deck and superstructure, stepped back toward the bow.
  g.add(box(3.9, 0.14, L * 0.86, M.teak, 0, 0.12, -0.4));
  g.add(box(3.5, 1.55, 6.2, M.hullWhite, 0, 0.95, -1.2));
  g.add(box(3.56, 0.7, 5.0, M.glass, 0, 1.2, -1.0));
  for (const s of [-1, 1]) {
    g.add(box(0.04, 0.62, 5.4, M.glass, s * 1.78, 1.18, -1.2));
  }

  // Wheelhouse windscreen.
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 1.3), M.glass);
  ws.position.set(0, 1.32, 1.98);
  ws.rotation.x = 0.4;
  g.add(ws);

  // Upper deck + hardtop.
  g.add(box(3.0, 0.14, 4.4, M.hullWhite, 0, 1.78, -1.6));
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.2, 6), M.chrome);
      post.position.set(sx * 1.25, 2.45, -1.6 + sz * 1.9);
      g.add(post);
    }
  }
  g.add(box(3.2, 0.1, 4.6, M.canvasTop, 0, 3.06, -1.6));

  // Radar arch and mast.
  g.add(box(0.12, 1.0, 0.12, M.chrome, -1.2, 3.55, -3.2));
  g.add(box(0.12, 1.0, 0.12, M.chrome, 1.2, 3.55, -3.2));
  g.add(box(2.5, 0.12, 0.12, M.chrome, 0, 4.05, -3.2));
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 8), M.canvasTop);
  dome.position.set(0, 4.3, -3.2);
  g.add(dome);

  // Bow rail and swim platform.
  railing(
    g,
    [
      [-1.9, 2.6],
      [-1.5, 5.6],
      [0, 7.4],
      [1.5, 5.6],
      [1.9, 2.6],
    ],
    0.2,
    0.68,
  );
  g.add(box(3.4, 0.12, 1.2, M.teak, 0, -0.3, -8.9));

  return g;
}

/* -------------------------------------------------------------- runabout */

function runabout(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const L = 6.4;
  const paint = rng.chance(0.5) ? M.hullWhite : skiPaint(rng.pick([0xd8321f, 0x1c4fa8, 0x18191d]));

  g.add(
    hull(
      L,
      [
        { t: 0.0, halfBeam: 1.05, draft: 0.62 },
        { t: 0.2, halfBeam: 1.15, draft: 0.7 },
        { t: 0.5, halfBeam: 1.08, draft: 0.68 },
        { t: 0.78, halfBeam: 0.82, draft: 0.58, rise: 0.14 },
        { t: 0.94, halfBeam: 0.4, draft: 0.44, rise: 0.34 },
        { t: 1.0, halfBeam: 0.1, draft: 0.32, rise: 0.5 },
      ],
      paint,
    ),
  );

  g.add(box(1.9, 0.08, 2.2, M.teak, 0, 0.1, -1.1));
  // Cockpit well.
  g.add(box(1.7, 0.5, 2.0, M.dark, 0, -0.18, -1.1));
  // Wraparound screen.
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.5), M.glass);
  ws.position.set(0, 0.36, 0.15);
  ws.rotation.x = 0.5;
  g.add(ws);
  // Bench seats.
  for (const z of [-1.0, -1.9]) {
    g.add(box(1.5, 0.16, 0.5, M.canvasTop, 0, 0.2, z));
    g.add(box(1.5, 0.42, 0.12, M.canvasTop, 0, 0.42, z - 0.28));
  }
  // Outboard.
  g.add(box(0.5, 0.8, 0.6, M.dark, 0, 0.16, -3.35));
  g.add(box(0.18, 0.8, 0.18, M.dark, 0, -0.46, -3.45));

  return g;
}

/* ---------------------------------------------------------------- jetski */

function jetski(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const L = 3.2;
  const paint = skiPaint(rng.pick([0xe8452c, 0x2f9fd0, 0xe8c22c, 0x46c07a, 0x18191d, 0xf07a35]));

  g.add(
    hull(
      L,
      [
        { t: 0.0, halfBeam: 0.52, draft: 0.4 },
        { t: 0.25, halfBeam: 0.6, draft: 0.46 },
        { t: 0.55, halfBeam: 0.55, draft: 0.44, rise: 0.06 },
        { t: 0.8, halfBeam: 0.4, draft: 0.36, rise: 0.2 },
        { t: 1.0, halfBeam: 0.1, draft: 0.26, rise: 0.4 },
      ],
      paint,
    ),
  );

  // Saddle and handlebar column.
  const seat = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.9, 4, 10), M.dark);
  seat.rotation.x = Math.PI / 2;
  seat.scale.set(1, 1, 0.6);
  seat.position.set(0, 0.3, -0.45);
  seat.castShadow = true;
  g.add(seat);

  g.add(box(0.36, 0.42, 0.3, paint, 0, 0.34, 0.55));
  const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.62, 6), M.dark);
  bar.rotation.z = Math.PI / 2;
  bar.position.set(0, 0.58, 0.62);
  g.add(bar);

  return g;
}

/* ------------------------------------------------------------- placement */

export interface BoatBuild {
  group: THREE.Group;
  kind: BoatKind;
  /** Half-length and half-beam, for collision and wake sizing. */
  halfLength: number;
  halfBeam: number;
  /** How far the hull sits below the waterline at rest. */
  draft: number;
}

export interface Boat {
  build: BoatBuild;
  position: THREE.Vector3;
  yaw: number;
  occupied: boolean;
}

const SPECS: Record<BoatKind, { halfLength: number; halfBeam: number; draft: number }> = {
  catamaran: { halfLength: 6.3, halfBeam: 3.6, draft: 0.55 },
  yacht: { halfLength: 8.6, halfBeam: 2.2, draft: 0.85 },
  runabout: { halfLength: 3.3, halfBeam: 1.2, draft: 0.4 },
  jetski: { halfLength: 1.7, halfBeam: 0.65, draft: 0.22 },
};

export function buildBoat(kind: BoatKind, rng: Rng): BoatBuild {
  const raw =
    kind === 'catamaran'
      ? catamaran(rng)
      : kind === 'yacht'
        ? yacht()
        : kind === 'runabout'
          ? runabout(rng)
          : jetski(rng);
  // Boats never articulate, so the whole thing can bake down to a few meshes.
  const group = bakeStatic(raw);
  return { group, kind, ...SPECS[kind] };
}

export interface BoatsResult {
  group: THREE.Group;
  boats: Boat[];
}

export function buildBoats(): BoatsResult {
  const group = new THREE.Group();
  group.name = 'boats';
  const rng = new Rng(770077);
  const boats: Boat[] = [];

  const add = (kind: BoatKind, x: number, z: number, yaw: number) => {
    const build = buildBoat(kind, rng);
    build.group.position.set(x, 0, z);
    build.group.rotation.y = yaw;
    group.add(build.group);
    boats.push({ build, position: new THREE.Vector3(x, 0, z), yaw, occupied: false });
  };

  // Jet skis parked in the shallows right off the beach, as in the reference.
  for (let i = 0; i < 9; i++) {
    add(
      'jetski',
      SHORELINE_X - rng.range(8, 20),
      rng.range(-140, 150),
      rng.range(0, Math.PI * 2),
    );
  }

  // Runabouts a little further out.
  for (let i = 0; i < 6; i++) {
    add('runabout', SHORELINE_X - rng.range(30, 70), rng.range(-160, 170), rng.range(0, Math.PI * 2));
  }

  // The big stuff sits off the sandbar where there's water under the keel.
  for (let i = 0; i < 5; i++) {
    add('catamaran', SHORELINE_X - rng.range(80, 190), rng.range(-190, 200), rng.range(0, Math.PI * 2));
  }
  for (let i = 0; i < 4; i++) {
    add('yacht', SHORELINE_X - rng.range(120, 260), rng.range(-210, 220), rng.range(0, Math.PI * 2));
  }

  return { group, boats };
}

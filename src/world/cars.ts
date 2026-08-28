import * as THREE from 'three';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import {
  ROAD_HALF,
  CROSS_Z,
  CROSS_HALF,
  STRIP_MIN_Z,
  STRIP_MAX_Z,
  AVENUES,
  CROSS_STREETS,
  riverInfluence,
} from './layout';
import { ColliderHandle } from './collision';
import { bakeStatic } from '../util/bake';
import type { Cullable } from './culling';

/* ------------------------------------------------------------- materials */

const paintCache = new Map<number, THREE.MeshPhysicalMaterial>();

/** Metallic basecoat under a clearcoat — the reason a car reads as painted metal. */
function paintMat(color: number): THREE.MeshPhysicalMaterial {
  let m = paintCache.get(color);
  if (!m) {
    m = new THREE.MeshPhysicalMaterial({
      color,
      metalness: 0.65,
      roughness: 0.26,
      clearcoat: 1.0,
      clearcoatRoughness: 0.035,
      envMapIntensity: 1.35,
    });
    paintCache.set(color, m);
  }
  return m;
}

const rimCache = new Map<number, THREE.MeshStandardMaterial>();

function rimMat(color: number): THREE.MeshStandardMaterial {
  let m = rimCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.98,
      roughness: 0.16,
      envMapIntensity: 1.6,
    });
    rimCache.set(color, m);
  }
  return m;
}

const glass = new THREE.MeshPhysicalMaterial({
  color: 0x0d1418,
  metalness: 0,
  roughness: 0.045,
  reflectivity: 0.85,
  clearcoat: 1,
  clearcoatRoughness: 0.02,
  envMapIntensity: 2.0,
  side: THREE.DoubleSide,
});

const chrome = new THREE.MeshStandardMaterial({
  color: 0xd8dade,
  metalness: 1.0,
  roughness: 0.08,
  envMapIntensity: 1.8,
});

const rubber = new THREE.MeshStandardMaterial({
  color: 0x14151a,
  roughness: 0.92,
  metalness: 0,
});

const disc = new THREE.MeshStandardMaterial({
  color: 0x5b5f63,
  metalness: 0.9,
  roughness: 0.5,
});

const darkTrim = new THREE.MeshStandardMaterial({
  color: 0x0f1113,
  roughness: 0.55,
  metalness: 0.3,
});

/** Inside the wheel arches: near-black so the arch reads as a cavity. */
const archLiner = new THREE.MeshStandardMaterial({
  color: 0x0a0b0d,
  roughness: 0.95,
  metalness: 0,
  side: THREE.DoubleSide,
});

const lampWhite = new THREE.MeshStandardMaterial({
  color: 0xf2f6ff,
  emissive: 0xdfe9ff,
  emissiveIntensity: 0.35,
  roughness: 0.12,
  metalness: 0.2,
});

// Shared, not per car: a fresh material per number plate would give every
// statically-baked parked car its own draw call.
const plateMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.6 });

const lampRed = new THREE.MeshStandardMaterial({
  color: 0x8e1218,
  emissive: 0xd8202a,
  emissiveIntensity: 1.1,
  roughness: 0.2,
});

/* -------------------------------------------------------------------- spec */

export type CarKind = 'sedan' | 'supercar' | 'suv' | 'coupe';

interface Spec {
  length: number;
  width: number;
  wheelR: number;
  wheelW: number;
  /** How far the tyre sits inboard of the body flank. */
  wheelInset: number;
  axle: [number, number];
  /** Height of the rocker/sill line running between the arches. */
  rocker: number;
  /** Extra arch radius over the tyre radius. */
  archGap: number;
  /** Vertical span of the side glass. */
  glassY: [number, number];
  glassX: [number, number];
  /** Headlight centre height. */
  lampY: number;
  /** Roof height, for rails and aerials. */
  roofY: number;
  /** Windscreen rake, radians from vertical. */
  rake: number;
  /**
   * Upper silhouette ONLY — front lower corner, up over the roof, to the rear
   * lower corner. Both ends must sit at `rocker`. The lower edge is generated
   * from the rocker line and the wheel arches.
   */
  profile: Array<[number, number]>;
}

const SPECS: Record<CarKind, Spec> = {
  sedan: {
    length: 4.82,
    width: 1.86,
    wheelR: 0.36,
    wheelW: 0.25,
    wheelInset: 0.05,
    axle: [-1.48, 1.42],
    rocker: 0.24,
    archGap: 0.05,
    glassY: [1.0, 1.36],
    glassX: [-0.66, 1.16],
    lampY: 0.74,
    roofY: 1.45,
    rake: 0.62,
    profile: [
      [-2.41, 0.24],
      [-2.4, 0.64],
      [-2.2, 0.85],
      [-1.55, 0.92],
      [-0.88, 0.97],
      [-0.44, 1.26],
      [0.1, 1.44],
      [0.82, 1.45],
      [1.42, 1.26],
      [1.88, 1.02],
      [2.26, 0.94],
      [2.41, 0.76],
      [2.42, 0.24],
    ],
  },
  supercar: {
    length: 4.56,
    width: 2.04,
    wheelR: 0.35,
    wheelW: 0.32,
    wheelInset: 0.02,
    axle: [-1.42, 1.36],
    rocker: 0.18,
    archGap: 0.05,
    glassY: [0.8, 1.06],
    glassX: [-0.34, 0.72],
    lampY: 0.56,
    roofY: 1.14,
    rake: 0.9,
    profile: [
      [-2.28, 0.18],
      [-2.27, 0.5],
      [-1.95, 0.6],
      [-1.25, 0.63],
      [-0.75, 0.72],
      [-0.3, 1.02],
      [0.35, 1.14],
      [0.95, 1.1],
      [1.62, 0.88],
      [2.12, 0.78],
      [2.28, 0.68],
      [2.28, 0.18],
    ],
  },
  suv: {
    length: 4.94,
    width: 1.98,
    wheelR: 0.42,
    wheelW: 0.27,
    wheelInset: 0.05,
    axle: [-1.52, 1.5],
    rocker: 0.34,
    archGap: 0.06,
    glassY: [1.22, 1.68],
    glassX: [-0.6, 1.48],
    lampY: 0.98,
    roofY: 1.78,
    rake: 0.58,
    profile: [
      [-2.47, 0.34],
      [-2.45, 0.86],
      [-2.26, 1.08],
      [-1.55, 1.14],
      [-0.9, 1.18],
      [-0.52, 1.5],
      [0.2, 1.76],
      [1.3, 1.78],
      [1.86, 1.7],
      [2.22, 1.5],
      [2.38, 1.12],
      [2.46, 0.82],
      [2.46, 0.34],
    ],
  },
  coupe: {
    length: 4.42,
    width: 1.88,
    wheelR: 0.36,
    wheelW: 0.26,
    wheelInset: 0.04,
    axle: [-1.32, 1.3],
    rocker: 0.22,
    archGap: 0.05,
    glassY: [0.94, 1.24],
    glassX: [-0.5, 0.84],
    lampY: 0.66,
    roofY: 1.32,
    rake: 0.7,
    profile: [
      [-2.21, 0.22],
      [-2.2, 0.6],
      [-1.98, 0.78],
      [-1.36, 0.83],
      [-0.78, 0.88],
      [-0.34, 1.14],
      [0.28, 1.32],
      [0.86, 1.28],
      [1.44, 1.04],
      [1.98, 0.88],
      [2.2, 0.74],
      [2.21, 0.22],
    ],
  },
};

/* ---------------------------------------------------------------- profile */

/**
 * Side-profile outline with the wheel arches cut into it.
 *
 * The upper silhouette is a spline through hand-placed control points; the
 * lower edge is the rocker line, interrupted by a semicircular arch centred on
 * each axle. Without those arches the extruded body is a solid slab that
 * completely swallows the wheels.
 */
function bodyShape(s: Spec): THREE.Shape {
  const curve = new THREE.CatmullRomCurve3(
    s.profile.map(([x, y]) => new THREE.Vector3(x, y, 0)),
    false,
    'catmullrom',
    0.4,
  );
  const shape = new THREE.Shape(
    curve.getPoints(s.profile.length * 9).map((v) => new THREE.Vector2(v.x, v.y)),
  );

  const archR = s.wheelR + s.archGap;
  // Angle at which the arch circle crosses the rocker line.
  const a0 = Math.asin(THREE.MathUtils.clamp((s.rocker - s.wheelR) / archR, -1, 1));
  const dx = Math.cos(a0) * archR;

  // We finished the silhouette at the rear, so walk the lower edge forward.
  for (const ax of [...s.axle].sort((a, b) => b - a)) {
    shape.lineTo(ax + dx, s.rocker);
    // Counter-clockwise: up and over the top of the arch, then back down.
    shape.absarc(ax, s.wheelR, archR, a0, Math.PI - a0, false);
  }
  shape.lineTo(s.profile[0][0], s.rocker);
  shape.closePath();

  return shape;
}

/* ------------------------------------------------------------------ wheel */

/**
 * Wheel built with its axle along Z, matching the body extrusion direction.
 * (Getting this axis wrong turns every car into a paddle steamer.)
 */
function wheel(r: number, width: number, rim: THREE.Material): THREE.Group {
  const g = new THREE.Group();

  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 24, 1), rubber);
  tire.rotation.x = Math.PI / 2;
  tire.castShadow = true;
  tire.receiveShadow = true;
  g.add(tire);

  const brake = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.58, r * 0.58, 0.03, 16), disc);
  brake.rotation.x = Math.PI / 2;
  g.add(brake);

  for (const s of [-1, 1]) {
    // An annulus, not a disc: a filled circle turns the wheel into a flat
    // coin and hides the spokes it sits in front of.
    const face = new THREE.Mesh(new THREE.RingGeometry(r * 0.32, r * 0.72, 20), rim);
    face.position.z = s * (width / 2 + 0.002);
    if (s < 0) face.rotation.y = Math.PI;
    g.add(face);

    // Spokes, sunk just inside the rim face.
    for (let i = 0; i < 5; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.036, r * 1.24, 0.06), rim);
      spoke.rotation.z = (i / 5) * Math.PI;
      spoke.position.z = s * (width / 2 - 0.03);
      g.add(spoke);
    }

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.16, r * 0.16, 0.05, 12), chrome);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = s * (width / 2 + 0.012);
    g.add(hub);
  }

  return g;
}

/* -------------------------------------------------------------------- car */

export interface CarBuild {
  group: THREE.Group;
  /** Front pair first, then rear. Steering applies to the front two only. */
  wheels: THREE.Object3D[];
  kind: CarKind;
  spec: Spec;
  /**
   * Switch between the parked and driving forms of the wheels — see
   * `bakeVehicle`. Absent on cars that were never given a parked form.
   */
  setRolling?(on: boolean): void;
}

/** Public read-only view of a spec, for the driving model. */
export function carSpec(kind: CarKind): Readonly<Spec> {
  return SPECS[kind];
}

export function buildCar(kind: CarKind, color: number, rng: Rng): CarBuild {
  const s = SPECS[kind];
  const g = new THREE.Group();
  const wheels: THREE.Object3D[] = [];

  const bevel = 0.055;
  const geo = new THREE.ExtrudeGeometry(bodyShape(s), {
    depth: s.width - bevel * 2,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
    curveSegments: 6,
  });
  geo.translate(0, 0, -(s.width - bevel * 2) / 2);
  geo.computeVertexNormals();

  const body = new THREE.Mesh(geo, paintMat(color));
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  /* --------------------------------------------------------- glasshouse */

  const [gy0, gy1] = s.glassY;
  const [gx0, gx1] = s.glassX;
  const beltY = (gy0 + gy1) / 2;

  for (const side of [-1, 1]) {
    // The pane spans the car's LENGTH (local X) and faces outward along Z, so
    // it needs no rotation at all — turning it 90° makes it stick out sideways
    // as a slab wider than the car.
    const w = new THREE.Mesh(new THREE.PlaneGeometry(gx1 - gx0, gy1 - gy0), glass);
    w.position.set((gx0 + gx1) / 2, beltY, side * (s.width / 2 - 0.015));
    g.add(w);

    // B-pillar so the flank isn't one long slab of glass.
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.07, gy1 - gy0 + 0.02, 0.02), darkTrim);
    pil.position.set(THREE.MathUtils.lerp(gx0, gx1, 0.44), beltY, side * (s.width / 2 - 0.005));
    g.add(pil);
  }

  // Raked windscreen and backlight. -PI/2 about X (not +) so the surface
  // normal ends up pointing forward-and-up rather than forward-and-down —
  // otherwise the screen leans the wrong way over the bonnet.
  const wsH = (gy1 - gy0) * 1.6;
  const ws = new THREE.Mesh(new THREE.PlaneGeometry(wsH, s.width * 0.84), glass);
  ws.rotation.set(-Math.PI / 2, s.rake, 0);
  ws.position.set(gx0 - 0.12, beltY + 0.02, 0);
  g.add(ws);

  const bl = new THREE.Mesh(new THREE.PlaneGeometry(wsH * 0.85, s.width * 0.78), glass);
  bl.rotation.set(-Math.PI / 2, -(kind === 'suv' ? 1.25 : 0.75), 0);
  bl.position.set(gx1 + 0.1, beltY + 0.01, 0);
  g.add(bl);

  /* -------------------------------------------------------------- wheels */

  const rim = rimMat(rng.chance(0.28) ? 0x2a2d31 : rng.chance(0.5) ? 0xc8ccd2 : 0xd9bf7a);
  const archR = s.wheelR + s.archGap;
  const trackZ = s.width / 2 - s.wheelInset - s.wheelW / 2;

  // s.axle is [front, rear]; keep that ordering so the driving model can pick
  // out the steered pair.
  for (const ax of s.axle) {
    for (const side of [-1, 1]) {
      const w = wheel(s.wheelR, s.wheelW, rim);
      w.position.set(ax, s.wheelR, side * trackZ);
      g.add(w);
      wheels.push(w);
    }

    // Liner spanning the full body width, closing off the arch tunnel.
    const liner = new THREE.Mesh(
      new THREE.CylinderGeometry(archR, archR, s.width - 0.04, 20, 1, true, 0, Math.PI),
      archLiner,
    );
    liner.rotation.set(Math.PI / 2, 0, 0);
    liner.position.set(ax, s.wheelR, 0);
    g.add(liner);
  }

  /* --------------------------------------------------------------- trim */

  const front = s.profile[0][0];
  const rear = s.profile[s.profile.length - 1][0];

  for (const side of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.13, 0.4), lampWhite);
    hl.position.set(front + 0.09, s.lampY, side * s.width * 0.29);
    g.add(hl);

    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.44), lampRed);
    tl.position.set(rear - 0.07, gy0 - 0.06, side * s.width * 0.3);
    g.add(tl);

    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.085, 0.07), darkTrim);
    mir.position.set(gx0 + 0.06, beltY - 0.05, side * (s.width / 2 + 0.1));
    mir.castShadow = true;
    g.add(mir);

    // Rocker sill along the bottom of the doors.
    const sill = new THREE.Mesh(new THREE.BoxGeometry(s.length * 0.4, 0.08, 0.05), darkTrim);
    sill.position.set(0, s.rocker + 0.03, side * (s.width / 2 - 0.02));
    g.add(sill);

    // Door shut lines — without them the flank is one continuous blob.
    for (const dx of [gx0 + 0.02, THREE.MathUtils.lerp(gx0, gx1, 0.46)]) {
      const cut = new THREE.Mesh(new THREE.BoxGeometry(0.012, gy0 - s.rocker - 0.06, 0.02), darkTrim);
      cut.position.set(dx, (gy0 + s.rocker) / 2 + 0.02, side * (s.width / 2 - 0.005));
      g.add(cut);
    }

    // Door handle.
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.03, 0.025), chrome);
    handle.position.set(THREE.MathUtils.lerp(gx0, gx1, 0.24), gy0 - 0.1, side * (s.width / 2 - 0.005));
    g.add(handle);

    const ex = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.11, 10), chrome);
    ex.rotation.z = Math.PI / 2;
    ex.position.set(rear - 0.03, s.rocker + 0.05, side * s.width * 0.26);
    g.add(ex);
  }

  const grille = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, s.width * 0.5), darkTrim);
  grille.position.set(front + 0.03, s.lampY - 0.16, 0);
  g.add(grille);

  const splitter = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.05, s.width * 0.8), darkTrim);
  splitter.position.set(front + 0.13, s.rocker + 0.02, 0);
  g.add(splitter);

  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.13, 0.4), plateMat);
  plate.position.set(rear - 0.02, gy0 - 0.3, 0);
  g.add(plate);

  if (kind === 'supercar') {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.045, s.width * 0.8), paintMat(color));
    wing.position.set(rear - 0.55, s.roofY + 0.1, 0);
    wing.rotation.z = -0.12;
    wing.castShadow = true;
    g.add(wing);
    for (const side of [-1, 1]) {
      const stay = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.22, 0.04), darkTrim);
      stay.position.set(rear - 0.55, s.roofY - 0.02, side * s.width * 0.3);
      g.add(stay);
    }
  }

  if (kind === 'suv') {
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(s.length * 0.42, 0.05, 0.06), chrome);
      rail.position.set(0.3, s.roofY + 0.03, side * s.width * 0.33);
      rail.castShadow = true;
      g.add(rail);
    }
  }

  return { group: g, wheels, kind, spec: s };
}

/**
 * Merges a car's ~45 loose meshes down to a handful, while keeping each wheel
 * as its own pivot so it can still steer and spin.
 *
 * Cars can't go through the world-wide bake: a drivable one has to stay an
 * individual object, and a baked-in wheel can't turn.
 */
export function bakeVehicle(build: CarBuild, parkable = false): CarBuild {
  const wheels = build.wheels as THREE.Group[];
  for (const w of wheels) w.removeFromParent();

  // A wheel is four meshes — tyre, rim, spokes, disc — so four of them are two
  // thirds of the car's draw calls. Each merges into its own pivot, which is
  // what lets the front pair steer and all four spin. `bakeStatic` returns
  // geometry relative to its root, so the merged wheel lands in the pivot's
  // local space with the axle still on Z.
  const pivots = wheels.map((w) => {
    const pivot = new THREE.Group();
    pivot.position.copy(w.position);
    hoist(bakeStatic(w), pivot);
    return pivot;
  });

  const out = new THREE.Group();

  // Traffic rolls constantly, so it only ever needs the articulated form.
  if (!parkable) {
    hoist(bakeStatic(build.group), out);
    for (const p of pivots) out.add(p);
    return { group: out, wheels: pivots, kind: build.kind, spec: build.spec };
  }

  /* ------------------------------------------------------- parked form */

  // Body on its own, for when this car is the one being driven. Held detached:
  // 236 parked cars carrying an unused second body is 236 subtrees that
  // `updateMatrixWorld` would walk every frame for nothing.
  const rollingBody = new THREE.Group();
  hoist(bakeStatic(build.group), rollingBody);

  // A *parked* car's wheels never turn, so they do not have to be separate
  // objects at all — baked into the body they merge into its own material
  // buckets, and a wheel's chrome, tyre black and hub gold are all colours the
  // body is already drawing. Four extra draw calls become zero, which across
  // the kerbside cars in view on Ocean Drive is ~240 of them.
  //
  // Only the car being driven needs the articulated form, and there is never
  // more than one of those, so the two forms swap on entry and exit.
  for (const w of wheels) build.group.add(w);
  hoist(bakeStatic(build.group), out);
  const parkedBody = [...out.children];

  let rolling = false;
  return {
    group: out,
    wheels: pivots,
    kind: build.kind,
    spec: build.spec,
    setRolling: (on) => {
      if (on === rolling) return;
      rolling = on;
      if (on) {
        for (const m of parkedBody) m.removeFromParent();
        for (const m of rollingBody.children.slice()) out.add(m);
        for (const p of pivots) out.add(p);
      } else {
        for (const p of pivots) p.removeFromParent();
        for (const m of out.children.slice()) rollingBody.add(m);
        for (const m of parkedBody) out.add(m);
      }
    },
  };
}

/**
 * Move a baked group's meshes straight into `target` and drop the group.
 *
 * There are ~860 cars in the world and every intermediate node is one more
 * object for `updateMatrixWorld` and the culler to walk, three times a frame.
 * The baked children sit at identity, so the level is pure overhead.
 */
function hoist(baked: THREE.Group, target: THREE.Object3D): void {
  for (const child of [...baked.children]) target.add(child);
}

/**
 * Headlamps and tail lamps come on after dark.
 *
 * Both are shared materials, so this lights every car in the world — parked,
 * driven and AI traffic alike — with two writes.
 */
export function setCarNight(f: number): void {
  const t = Math.min(1, Math.max(0, f));
  lampWhite.emissiveIntensity = 0.35 + t * 4;
  lampRed.emissiveIntensity = 1.1 + t * 2;
}

/* ---------------------------------------------------------------- parking */

const PALETTE: Array<[CarKind, number]> = [
  ['supercar', 0x6ee019],
  ['sedan', 0xd8321f],
  ['coupe', 0xd9dde2],
  ['sedan', 0x1c4fa8],
  ['suv', 0xf1f2f4],
  ['coupe', 0x18191d],
  ['sedan', 0xe8b41c],
  ['supercar', 0xff6a1f],
  ['suv', 0x2f3a44],
  ['coupe', 0x8e2f6b],
  ['sedan', 0x1d7d6a],
  ['supercar', 0xf5f7fa],
];

/** A parked car the player can walk up to and get into. */
export interface Drivable {
  build: CarBuild;
  /** Its footprint in the collision world, switched off while being driven. */
  collider: ColliderHandle;
  position: THREE.Vector3;
  yaw: number;
  occupied: boolean;
}

export interface CarsResult {
  /** Drivable cars. Each is baked on its own so it can still be driven away. */
  group: THREE.Group;
  /**
   * Kerbside cars that are scenery only. Held separately so the caller can
   * merge them into the street — see the note in `cityParking`.
   */
  staticGroup: THREE.Group;
  drivables: Drivable[];
  /** One entry per drivable car, for group-level culling. */
  cullable: Cullable[];
}

/**
 * A sphere at the car's origin that swallows the whole body. Generous on
 * purpose — the culler only decides whether three gets to look at the car at
 * all, and three then does the exact per-mesh test.
 */
function carRadius(s: (typeof SPECS)[CarKind]): number {
  return Math.hypot(s.length, s.width) * 0.5 + s.roofY;
}

/** Everyday kerbside colours — duller than the hero cars on Ocean Drive. */
const CITY_PALETTE: Array<[CarKind, number]> = [
  ['sedan', 0xd9dde2], ['suv', 0x2f3a44], ['coupe', 0x18191d], ['sedan', 0x8f9aa4],
  ['suv', 0xf1f2f4], ['sedan', 0x1c4fa8], ['coupe', 0x7a2320], ['sedan', 0x1d7d6a],
  ['suv', 0x6d6257], ['coupe', 0xd8d2c4], ['sedan', 0x2b2f3a], ['supercar', 0xe8b41c],
];

/**
 * One car in every `DRIVABLE_EVERY` along the kerb can actually be driven.
 *
 * There are several kilometres of kerb in this city. A drivable car has to stay
 * out of the static bake — a wheel merged into the street cannot steer — so it
 * costs around twenty draw calls of its own, where a scenery car costs
 * effectively nothing once merged. Making every one of them drivable is a few
 * thousand extra draw calls; this ratio keeps one within a few parking bays
 * anywhere in the city at a fraction of the cost.
 */
const DRIVABLE_EVERY = 3;

/** A block face gets a full row of parked cars, or none at all. */
const RUN_CHANCE = 0.26;

export function buildCars(colliders: Colliders): CarsResult {
  const g = new THREE.Group();
  g.name = 'cars';
  const rng = new Rng(31337);
  const drivables: Drivable[] = [];
  const cullable: Cullable[] = [];

  let i = 0;
  const park = (kind: CarKind, color: number, x: number, z: number, yaw: number) => {
    const build = bakeVehicle(buildCar(kind, color, rng), true);
    build.group.position.set(x, 0, z);
    // `yaw` is a heading (forward = sin,cos); the model's nose is local +X.
    build.group.rotation.y = yaw - Math.PI / 2;
    g.add(build.group);

    const s = SPECS[kind];
    // Kerbside parking runs the length of the city and none of it was ever
    // culled: every one of these was submitted three times a frame from
    // anywhere on the map.
    cullable.push({ object: build.group, radius: carRadius(s), near: true });
    drivables.push({
      build,
      collider: colliders.addSwitchableBox(x, z, s.length, s.width, yaw, s.roofY),
      position: new THREE.Vector3(x, 0, z),
      yaw,
      occupied: false,
    });
  };

  // Parallel parking in the kerbside lane on both sides of the street.
  for (const side of [-1, 1]) {
    for (let z = STRIP_MIN_Z + 12; z < STRIP_MAX_Z - 12; z += 6.4) {
      if (Math.abs(z - CROSS_Z) < CROSS_HALF + 8) continue;
      if (rng.chance(0.22)) continue;

      const [kind, color] = PALETTE[i++ % PALETTE.length];
      // Right-hand traffic: the +x half of the road heads toward +z.
      const yaw = (side > 0 ? 0 : Math.PI) + rng.range(-0.03, 0.03);
      park(kind, color, side * (ROAD_HALF - 1.35) + rng.range(-0.1, 0.1), z, yaw);
    }
  }

  // The hero pair outside the Dominion, matching the reference frame.
  park('supercar', 0x74e51c, ROAD_HALF - 1.5, 6.5, 0.05);
  park('sedan', 0xe03a1e, ROAD_HALF - 1.5, -0.6, 0.02);

  /* ------------------------------------------------- city kerbside parking */

  const staticGroup = new THREE.Group();
  staticGroup.name = 'cityparking';

  let k = 0;
  const kerbCar = (x: number, z: number, yaw: number) => {
    if (riverInfluence(x, z) > 0.05) return;
    const [kind, colour] = CITY_PALETTE[k % CITY_PALETTE.length];
    const drivable = k % DRIVABLE_EVERY === 0;
    k++;

    if (drivable) {
      park(kind, colour, x, z, yaw);
      return;
    }

    const build = buildCar(kind, colour, rng);
    build.group.position.set(x, 0, z);
    // `yaw` is a heading (forward = sin,cos); the model's nose is local +X.
    build.group.rotation.y = yaw - Math.PI / 2;
    staticGroup.add(build.group);

    const s = SPECS[kind];
    colliders.addRotatedBox(x, z, s.length, s.width, yaw, s.roofY);
  };

  /**
   * Cars go down a block face in *runs* rather than being sprinkled per slot.
   * Scattering the same budget uniformly gives a lonely car every 40 m, which
   * reads as a dead city; a quarter of the block faces getting a full row is
   * both cheaper and closer to how kerbside parking actually looks.
   */
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const side of [-1, 1]) {
      for (let ci = 0; ci < CROSS_STREETS.length - 1; ci++) {
        if (!rng.chance(RUN_CHANCE)) continue;
        const z0 = CROSS_STREETS[ci].z + CROSS_STREETS[ci].halfWidth + 9;
        const z1 = CROSS_STREETS[ci + 1].z - CROSS_STREETS[ci + 1].halfWidth - 9;
        for (let z = z0; z < z1; z += 6.6) {
          if (rng.chance(0.12)) continue;
          kerbCar(a.x + side * (a.halfWidth - 1.35), z, side > 0 ? 0 : Math.PI);
        }
      }
    }
  }
  for (const c of CROSS_STREETS) {
    for (const side of [-1, 1]) {
      for (let ai = 1; ai < AVENUES.length - 1; ai++) {
        if (!rng.chance(RUN_CHANCE)) continue;
        const x0 = AVENUES[ai].x + AVENUES[ai].halfWidth + 9;
        const x1 = AVENUES[ai + 1].x - AVENUES[ai + 1].halfWidth - 9;
        for (let x = x0; x < x1; x += 6.6) {
          if (rng.chance(0.12)) continue;
          kerbCar(x, c.z + side * (c.halfWidth - 1.35), side > 0 ? -Math.PI / 2 : Math.PI / 2);
        }
      }
    }
  }

  return { group: g, staticGroup, drivables, cullable };
}

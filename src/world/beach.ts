import * as THREE from 'three';
import * as T from '../render/textures';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import { groundHeight, SHORELINE_X, STRIP_MIN_Z, STRIP_MAX_Z } from './layout';

/**
 * Everything on the sand: umbrella fields, lounger rows, lifeguard towers,
 * cabanas, volleyball, towels and the small litter of a busy Miami beach.
 *
 * All of it is placed against `groundHeight`, so props sit on the real dune and
 * beach slope — including the sand ripple, which is why nothing sinks in.
 */

/* ------------------------------------------------------------- materials */

const shared = {
  pole: new THREE.MeshStandardMaterial({ color: 0xe8e4da, roughness: 0.4, metalness: 0.65 }),
  wood: new THREE.MeshStandardMaterial({ color: 0xa9855a, roughness: 0.85 }),
  darkMetal: new THREE.MeshStandardMaterial({
    color: 0x35393d,
    roughness: 0.45,
    metalness: 0.7,
  }),
  rope: new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 0.9 }),
  net: new THREE.MeshStandardMaterial({
    color: 0x20242a,
    roughness: 0.9,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
  }),
  plasticWhite: new THREE.MeshStandardMaterial({ color: 0xf2f1ec, roughness: 0.45 }),
};

/** Canvas-weave fabric, tinted per colour and shared across every prop. */
let fabricMaps: T.SurfaceMaps | null = null;
const fabricCache = new Map<number, THREE.MeshStandardMaterial>();

function fabric(color: number): THREE.MeshStandardMaterial {
  let m = fabricCache.get(color);
  if (!m) {
    if (!fabricMaps) {
      fabricMaps = T.asColor(T.awningFabric(1));
      for (const t of [fabricMaps.map, fabricMaps.normalMap, fabricMaps.roughnessMap]) {
        t.repeat.set(3, 3);
      }
    }
    m = new THREE.MeshStandardMaterial({
      ...fabricMaps,
      color,
      roughness: 0.86,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    fabricCache.set(color, m);
  }
  return m;
}

const flatCache = new Map<number, THREE.MeshStandardMaterial>();
function flat(color: number, rough = 0.8): THREE.MeshStandardMaterial {
  const key = color * 10 + Math.round(rough * 9);
  let m = flatCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    flatCache.set(key, m);
  }
  return m;
}

/* -------------------------------------------------------------- umbrella */

/**
 * Beach umbrella with alternating panels, built as one vertex-coloured mesh.
 *
 * Two materials would mean two draw calls per umbrella and would block the
 * bake pass from merging them; vertex colours keep the whole field on one
 * material while still giving the striped look from the reference.
 */
function umbrellaCanopy(radius: number, a: THREE.Color, b: THREE.Color): THREE.BufferGeometry {
  const panels = 8;
  const rings = 3;
  const pos: number[] = [];
  const col: number[] = [];
  const apex = new THREE.Vector3(0, 0.46, 0);

  for (let p = 0; p < panels; p++) {
    const c = p % 2 === 0 ? a : b;
    const a0 = (p / panels) * Math.PI * 2;
    const a1 = ((p + 1) / panels) * Math.PI * 2;

    // Panels sag between ribs and flare down at the hem.
    const at = (ang: number, t: number) => {
      const sag = Math.sin((ang - a0) / (a1 - a0) * Math.PI) * 0.055 * t;
      const r = radius * t;
      // Quadratic droop toward the rim.
      const y = apex.y - Math.pow(t, 1.7) * 0.52 - sag;
      return new THREE.Vector3(Math.cos(ang) * r, y, Math.sin(ang) * r);
    };

    for (let i = 0; i < rings; i++) {
      const t0 = i / rings;
      const t1 = (i + 1) / rings;
      const p00 = at(a0, t0);
      const p01 = at(a1, t0);
      const p10 = at(a0, t1);
      const p11 = at(a1, t1);
      const tris =
        i === 0
          ? [apex, p10, p11]
          : [p00, p10, p11, p00, p11, p01];
      for (const v of tris) {
        pos.push(v.x, v.y, v.z);
        col.push(c.r, c.g, c.b);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

const umbrellaMat = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.84,
  metalness: 0,
  side: THREE.DoubleSide,
});

const UMBRELLA_PAIRS: Array<[number, number]> = [
  [0x2f7fc4, 0xf4f6f8], // the blue/white beach-club standard
  [0x2f7fc4, 0xf4f6f8],
  [0xe23f7a, 0xf7e9ef],
  [0xe8c22c, 0xf6f2df],
  [0x2fa06a, 0xf2f7f0],
  [0xf4f6f8, 0xdde4ea],
  [0xe8622c, 0xf7ede4],
];

function umbrella(rng: Rng, radius: number): THREE.Group {
  const g = new THREE.Group();
  const [ca, cb] = rng.pick(UMBRELLA_PAIRS);
  const height = rng.range(2.1, 2.45);

  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.032, 0.038, height, 8),
    rng.chance(0.4) ? shared.wood : shared.pole,
  );
  pole.position.y = height / 2;
  pole.castShadow = true;
  g.add(pole);

  const canopy = new THREE.Mesh(
    umbrellaCanopy(radius, new THREE.Color(ca), new THREE.Color(cb)),
    umbrellaMat,
  );
  canopy.position.y = height - 0.12;
  canopy.castShadow = true;
  canopy.receiveShadow = true;
  g.add(canopy);

  // Umbrellas are never dead upright on a beach.
  g.rotation.z = rng.range(-0.16, 0.16);
  g.rotation.x = rng.range(-0.14, 0.14);
  return g;
}

/* --------------------------------------------------------------- lounger */

function lounger(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const frame = shared.plasticWhite;
  const cushion = fabric(
    rng.pick([0x2f7fc4, 0xf2efe6, 0x2fa06a, 0xe8c22c, 0x455a70, 0xe23f7a]),
  );

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 1.24), frame);
  seat.position.set(0, 0.36, 0.06);
  seat.castShadow = true;
  seat.receiveShadow = true;
  g.add(seat);

  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 1.16), cushion);
  pad.position.set(0, 0.41, 0.06);
  pad.castShadow = true;
  g.add(pad);

  // Reclined back, at a lazy angle.
  const recline = rng.range(0.5, 1.15);
  const back = new THREE.Group();
  back.position.set(0, 0.38, -0.58);
  back.rotation.x = -recline;
  const backPlate = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.05, 0.86), frame);
  backPlate.position.z = -0.43;
  backPlate.castShadow = true;
  back.add(backPlate);
  const backPad = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.05, 0.8), cushion);
  backPad.position.set(0, 0.05, -0.43);
  back.add(backPad);
  g.add(back);

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.36, 6), frame);
      leg.position.set(sx * 0.26, 0.18, 0.06 + sz * 0.5);
      leg.castShadow = true;
      g.add(leg);
    }
  }

  return g;
}

/* -------------------------------------------------------- lifeguard tower */

/** The Miami Beach icon: bright stilted cabin with a jaunty pitched roof. */
function lifeguardTower(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const body = rng.pick([0xe8c22c, 0x2f9fd0, 0xe2467a, 0x46c07a, 0xf07a35, 0xf2f1ea]);
  const trim = rng.pick([0xf2f1ea, 0x2b3b4a, 0xe8452c, 0x2f9fd0]);
  const bodyMat = flat(body, 0.62);
  const trimMat = flat(trim, 0.6);

  const deckY = 1.75;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.16, deckY, 0.16), shared.wood);
      leg.position.set(sx * 1.1, deckY / 2, sz * 1.1);
      leg.castShadow = true;
      leg.receiveShadow = true;
      g.add(leg);
    }
  }

  const deck = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.14, 2.7), shared.wood);
  deck.position.y = deckY + 0.07;
  deck.castShadow = true;
  deck.receiveShadow = true;
  g.add(deck);

  // Cabin: open front, solid back and sides.
  const cabH = 1.65;
  const cabY = deckY + 0.14 + cabH / 2;
  const back = new THREE.Mesh(new THREE.BoxGeometry(2.4, cabH, 0.12), bodyMat);
  back.position.set(0, cabY, -1.14);
  back.castShadow = true;
  back.receiveShadow = true;
  g.add(back);

  for (const sx of [-1, 1]) {
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.12, cabH, 2.4), bodyMat);
    side.position.set(sx * 1.14, cabY, 0);
    side.castShadow = true;
    side.receiveShadow = true;
    g.add(side);
    // Porthole, straight out of the Art Deco playbook.
    const port = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.16, 14), trimMat);
    port.rotation.z = Math.PI / 2;
    port.position.set(sx * 1.16, cabY + 0.2, 0);
    g.add(port);
  }

  // Front rail, so the opening reads as a lookout.
  const rail = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.1, 0.1), trimMat);
  rail.position.set(0, deckY + 0.75, 1.14);
  rail.castShadow = true;
  g.add(rail);

  // Pitched roof with a deep overhang.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.35, 0.85, 4), trimMat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = cabY + cabH / 2 + 0.4;
  roof.castShadow = true;
  roof.receiveShadow = true;
  g.add(roof);

  // Access ramp.
  const ramp = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.1, 2.6), shared.wood);
  ramp.position.set(0, deckY / 2 + 0.1, 2.1);
  ramp.rotation.x = -Math.atan2(deckY, 2.4);
  ramp.castShadow = true;
  g.add(ramp);

  // Flag on a whip mast.
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.2, 6), shared.pole);
  mast.position.set(-1.2, cabY + cabH / 2 + 1.2, -1.1);
  g.add(mast);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.42), flat(0xe8452c, 0.85));
  flag.position.set(-0.88, cabY + cabH / 2 + 1.95, -1.1);
  flag.rotation.y = Math.PI / 2;
  flag.castShadow = true;
  g.add(flag);

  return g;
}

/* ---------------------------------------------------------------- cabana */

/** Square shade tent — the pink and white ones dotted along the reference. */
function cabana(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const col = rng.pick([0xe8709c, 0xf2f1ea, 0x2f7fc4, 0xe8c22c]);
  const mat = fabric(col);
  const h = 2.35;
  const half = 1.7;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, h, 8), shared.pole);
      post.position.set(sx * half, h / 2, sz * half);
      post.castShadow = true;
      g.add(post);
    }
  }

  // Pyramid canopy.
  const roof = new THREE.Mesh(new THREE.ConeGeometry(half * 1.48, 0.62, 4), mat);
  roof.rotation.y = Math.PI / 4;
  roof.position.y = h + 0.28;
  roof.castShadow = true;
  roof.receiveShadow = true;
  g.add(roof);

  // A back wall on some of them, for shade.
  if (rng.chance(0.55)) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, h * 0.82), mat);
    wall.position.set(0, h * 0.45, -half);
    wall.castShadow = true;
    g.add(wall);
  }

  return g;
}

/* -------------------------------------------------------------- assembly */

export interface BeachResult {
  group: THREE.Group;
  /** Spots where beach NPCs should be placed: towels, loungers, groups. */
  seats: Array<{ x: number; z: number; yaw: number; kind: 'lounger' | 'towel' }>;
}

export function buildBeach(colliders: Colliders): BeachResult {
  const g = new THREE.Group();
  g.name = 'beach';
  const rng = new Rng(60613);
  const seats: BeachResult['seats'] = [];

  /** Put an object on the sand at the right height. */
  const place = (o: THREE.Object3D, x: number, z: number, yaw = 0) => {
    o.position.set(x, groundHeight(x, z), z);
    o.rotation.y += yaw;
    g.add(o);
  };

  const zMin = STRIP_MIN_Z - 40;
  const zMax = STRIP_MAX_Z + 40;

  /* ------------------------------------------------------ umbrella field */

  // Loose rows running along the beach, in clusters with gaps between them,
  // rather than a perfect grid.
  for (let z = zMin; z < zMax; z += rng.range(4.2, 7.0)) {
    // Occasional clear stretches so it doesn't read as wallpaper.
    if (rng.chance(0.16)) {
      z += rng.range(6, 16);
      continue;
    }
    const rows = rng.int(1, 3);
    for (let r = 0; r < rows; r++) {
      const x = -41.5 - r * 3.6 + rng.range(-1.1, 1.1);
      const zz = z + rng.range(-1.2, 1.2);
      const radius = rng.range(1.25, 1.65);
      place(umbrella(rng, radius), x, zz);
      colliders.addCircle(x, zz, 0.2, 1.2);

      // Loungers under most of them, in pairs facing the water.
      if (rng.chance(0.78)) {
        for (const s of [-1, 1]) {
          if (s > 0 && rng.chance(0.3)) continue;
          const lx = x + rng.range(-0.35, 0.35);
          const lz = zz + s * rng.range(0.75, 1.05);
          const l = lounger(rng);
          // Loungers point seaward (-x), which is -PI/2 in heading terms.
          place(l, lx, lz, -Math.PI / 2 + rng.range(-0.25, 0.25));
          colliders.addCircle(lx, lz, 0.45, 0.5);
          if (rng.chance(0.5)) seats.push({ x: lx, z: lz, yaw: -Math.PI / 2, kind: 'lounger' });
        }
      }
    }
  }

  /* ----------------------------------------------------- lifeguard towers */

  for (let z = zMin + 30; z < zMax; z += rng.range(62, 88)) {
    const x = -47 + rng.range(-1.5, 1.5);
    const t = lifeguardTower(rng);
    // Front opening faces the sea.
    place(t, x, z, -Math.PI / 2);
    colliders.addBoxAt(x, z, 2.8, 2.8, 1.8);
  }

  /* --------------------------------------------------------------- cabanas */

  for (let z = zMin + 18; z < zMax; z += rng.range(38, 62)) {
    const x = -38.5 + rng.range(-1.2, 1.2);
    place(cabana(rng), x, z, rng.range(-0.2, 0.2));
    colliders.addBoxAt(x, z, 3.4, 3.4, 2.2);
    if (rng.chance(0.6)) seats.push({ x: x + 1.4, z: z + 0.6, yaw: -Math.PI / 2, kind: 'towel' });
  }

  /* ------------------------------------------------------------- volleyball */

  for (let z = -110; z < zMax; z += 150) {
    const x = -40;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 2.5, 8), shared.pole);
      post.position.set(x, groundHeight(x, z) + 1.25, z + s * 4.5);
      post.castShadow = true;
      g.add(post);
      colliders.addCircle(x, z + s * 4.5, 0.16, 2.2);
    }
    const net = new THREE.Mesh(new THREE.PlaneGeometry(9, 0.95), shared.net);
    net.position.set(x, groundHeight(x, z) + 1.85, z);
    net.rotation.y = Math.PI / 2;
    g.add(net);
    // Tape along the top of the net.
    const tape = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.09, 9), shared.plasticWhite);
    tape.position.set(x, groundHeight(x, z) + 2.32, z);
    g.add(tape);
  }

  /* ------------------------------------------------------- towels + kit */

  const towelColors = [
    0xe8452c, 0x2f7fc4, 0xe8c22c, 0xf2f1ea, 0x46c07a, 0xe2467a, 0xf07a35, 0x7a5ad0,
  ];

  for (let i = 0; i < 260; i++) {
    const x = rng.range(-53.5, -40);
    const z = rng.range(zMin, zMax);
    const yaw = rng.range(0, Math.PI * 2);

    const towel = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 1.9), flat(rng.pick(towelColors), 0.92));
    towel.rotation.x = -Math.PI / 2;
    towel.rotation.z = yaw;
    towel.position.set(x, groundHeight(x, z) + 0.015, z);
    towel.receiveShadow = true;
    g.add(towel);

    if (rng.chance(0.55)) {
      seats.push({ x, z, yaw: yaw - Math.PI / 2, kind: 'towel' });
    }

    // Cooler, bag or ball beside it.
    if (rng.chance(0.4)) {
      const ox = x + rng.range(-0.9, 0.9);
      const oz = z + rng.range(-0.9, 0.9);
      const roll = rng.next();
      let item: THREE.Mesh;
      if (roll < 0.4) {
        item = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.34, 0.34), flat(0xdfe6ec, 0.5));
        item.position.set(ox, groundHeight(ox, oz) + 0.17, oz);
      } else if (roll < 0.75) {
        item = new THREE.Mesh(new THREE.SphereGeometry(0.19, 12, 10), flat(rng.pick(towelColors), 0.5));
        item.position.set(ox, groundHeight(ox, oz) + 0.19, oz);
      } else {
        item = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.26, 0.22), flat(0x8a6a4a, 0.85));
        item.position.set(ox, groundHeight(ox, oz) + 0.13, oz);
      }
      item.rotation.y = rng.range(0, Math.PI);
      item.castShadow = true;
      g.add(item);
    }
  }

  /* --------------------------------------------------- boards in the sand */

  const boardColors = [0xf2f1ea, 0xe8c22c, 0x2f9fd0, 0xe2467a, 0x46c07a];
  for (let i = 0; i < 40; i++) {
    const x = rng.range(-54, -42);
    const z = rng.range(zMin, zMax);
    const board = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.24, 1.7, 3, 10),
      flat(rng.pick(boardColors), 0.35),
    );
    board.scale.set(1, 1, 0.16);
    if (rng.chance(0.45)) {
      // Planted upright in the sand.
      board.position.set(x, groundHeight(x, z) + 1.0, z);
      board.rotation.set(rng.range(-0.16, 0.16), rng.range(0, Math.PI), rng.range(-0.2, 0.2));
      colliders.addCircle(x, z, 0.3, 1.4);
    } else {
      // Lying flat.
      board.position.set(x, groundHeight(x, z) + 0.05, z);
      board.rotation.set(Math.PI / 2, 0, rng.range(0, Math.PI));
    }
    board.castShadow = true;
    g.add(board);
  }

  /* --------------------------------------------------- bins, showers, flags */

  for (let z = zMin + 25; z < zMax; z += 34) {
    const bx = -39.5;
    const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.32, 1.0, 12), flat(0x4a4640, 0.7));
    bin.position.set(bx, groundHeight(bx, z) + 0.5, z);
    bin.castShadow = true;
    bin.receiveShadow = true;
    g.add(bin);
    colliders.addCircle(bx, z, 0.38, 1.0);

    // Rinse-off shower every other bin.
    if (rng.chance(0.5)) {
      const sx = -37.5;
      const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 2.4, 8), shared.pole);
      stand.position.set(sx, groundHeight(sx, z + 4) + 1.2, z + 4);
      stand.castShadow = true;
      g.add(stand);
      const head = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.1, 0.1, 10), shared.pole);
      head.position.set(sx - 0.32, groundHeight(sx, z + 4) + 2.35, z + 4);
      g.add(head);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.05), shared.pole);
      arm.position.set(sx - 0.17, groundHeight(sx, z + 4) + 2.4, z + 4);
      g.add(arm);
      colliders.addCircle(sx, z + 4, 0.16, 2.2);
    }
  }

  // Swim-zone marker flags along the waterline.
  for (let z = zMin; z < zMax; z += 26) {
    const x = SHORELINE_X + 3.5;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.0, 6), shared.pole);
    mast.position.set(x, groundHeight(x, z) + 1.0, z);
    mast.castShadow = true;
    g.add(mast);
    const flag = new THREE.Mesh(
      new THREE.PlaneGeometry(0.5, 0.36),
      flat(rng.chance(0.5) ? 0xe8452c : 0xe8c22c, 0.85),
    );
    flag.position.set(x, groundHeight(x, z) + 1.78, z + 0.25);
    flag.castShadow = true;
    g.add(flag);
  }

  return { group: g, seats };
}

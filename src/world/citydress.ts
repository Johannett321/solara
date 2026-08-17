import * as THREE from 'three';
import * as T from '../render/textures';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import {
  AVENUES,
  CROSS_STREETS,
  CURB_H,
  CITY_MIN_Z,
  CITY_MAX_Z,
  CITY_MAX_X,
  riverInfluence,
} from './layout';

/**
 * Street-level dressing for the city: bins, bags of rubbish, benches, café
 * terraces, planters and bushes, bikes leaning on walls, parking meters, news
 * boxes, hydrants, bollards, A-boards, signs and utility clutter.
 *
 * None of this changes the city's shape. It is entirely what you notice while
 * walking, which is exactly the thing a grid of boxes is missing.
 */

/* ------------------------------------------------------------ materials */

const cache = new Map<string, THREE.MeshStandardMaterial>();
function mat(
  key: string,
  color: number,
  roughness = 0.8,
  metalness = 0,
): THREE.MeshStandardMaterial {
  let m = cache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
    cache.set(key, m);
  }
  return m;
}

const M = {
  get steel() {
    return mat('steel', 0x7c8288, 0.45, 0.8);
  },
  get darkSteel() {
    return mat('darkSteel', 0x35393e, 0.5, 0.6);
  },
  get plasticGreen() {
    return mat('plGreen', 0x2f6b3a, 0.7);
  },
  get plasticBlue() {
    return mat('plBlue', 0x27528f, 0.7);
  },
  get timber() {
    return mat('timber', 0x9a7448, 0.85);
  },
  get bagBlack() {
    return mat('bag', 0x232529, 0.85);
  },
  get concrete() {
    return mat('conc', 0xa8a29a, 0.92);
  },
  get soil() {
    return mat('soil', 0x4a3a2a, 1);
  },
  get leaf() {
    return mat('leaf', 0x3f6b2c, 0.88);
  },
  get leafPale() {
    return mat('leafPale', 0x548438, 0.88);
  },
  get cloth() {
    return mat('cloth', 0xd8d3c6, 0.9);
  },
  get paper() {
    return mat('paper', 0xdfd9c8, 0.92);
  },
};

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* ----------------------------------------------------------------- props */

/** Wheelie bin with a lid, and sometimes an open one. */
function wheelieBin(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const body = rng.chance(0.5) ? M.plasticGreen : M.plasticBlue;
  g.add(box(0.72, 1.0, 0.62, 0, 0.5, 0, body));
  const lid = box(0.76, 0.08, 0.66, 0, 1.02, 0, body);
  if (rng.chance(0.25)) {
    lid.rotation.x = -0.9;
    lid.position.z = -0.28;
    lid.position.y = 1.2;
  }
  g.add(lid);
  for (const s of [-1, 1]) {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.06, 10), M.darkSteel);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(s * 0.3, 0.09, -0.24);
    g.add(wheel);
  }
  return g;
}

/** Mesh litter basket on a post — the classic city bin. */
function litterBin(): THREE.Group {
  const g = new THREE.Group();
  const basket = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.24, 0.62, 12, 1, true),
    M.darkSteel,
  );
  basket.position.y = 0.72;
  basket.castShadow = true;
  g.add(basket);
  g.add(box(0.1, 0.42, 0.1, 0, 0.21, 0, M.steel));
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.025, 6, 14), M.steel);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 1.03;
  g.add(rim);
  return g;
}

/** Bin bags piled at the kerb. */
function rubbishBags(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < rng.int(2, 5); i++) {
    const r = rng.range(0.24, 0.36);
    const bag = new THREE.Mesh(new THREE.SphereGeometry(r, 8, 6), M.bagBlack);
    bag.scale.set(1, rng.range(0.8, 1.2), rng.range(0.85, 1.15));
    bag.position.set(rng.range(-0.5, 0.5), r * 0.85, rng.range(-0.4, 0.4));
    bag.castShadow = true;
    g.add(bag);
  }
  return g;
}

/** Street bench, timber slats on cast ends. */
function cityBench(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    g.add(box(1.7, 0.06, 0.13, 0, 0.44, -0.16 + i * 0.16, M.timber));
  }
  for (let i = 0; i < 3; i++) {
    g.add(box(1.7, 0.13, 0.05, 0, 0.6 + i * 0.15, -0.3, M.timber));
  }
  for (const s of [-1, 1]) {
    g.add(box(0.07, 0.44, 0.6, s * 0.8, 0.22, -0.06, M.darkSteel));
  }
  return g;
}

/** Planter box with a shrub. */
function planter(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const w = rng.range(1.0, 1.8);
  g.add(box(w, 0.55, 0.9, 0, 0.28, 0, M.concrete));
  g.add(box(w - 0.16, 0.06, 0.76, 0, 0.57, 0, M.soil));
  for (let i = 0; i < rng.int(3, 6); i++) {
    const r = rng.range(0.22, 0.36);
    const blob = new THREE.Mesh(
      new THREE.SphereGeometry(r, 7, 6),
      rng.chance(0.5) ? M.leaf : M.leafPale,
    );
    blob.position.set(rng.range(-w / 2 + 0.3, w / 2 - 0.3), 0.62 + r * 0.6, rng.range(-0.2, 0.2));
    blob.scale.y = 0.85;
    blob.castShadow = true;
    g.add(blob);
  }
  return g;
}

/** Free-standing bush, for verges and building bases. */
function bush(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const s = rng.range(0.6, 1.25);
  for (let i = 0; i < rng.int(3, 6); i++) {
    const r = rng.range(0.3, 0.5) * s;
    const blob = new THREE.Mesh(
      new THREE.SphereGeometry(r, 7, 6),
      rng.chance(0.5) ? M.leaf : M.leafPale,
    );
    const a = (i / 4) * Math.PI * 2;
    blob.position.set(Math.cos(a) * 0.25 * s, r * 0.75, Math.sin(a) * 0.25 * s);
    blob.scale.y = 0.8;
    blob.castShadow = true;
    blob.receiveShadow = true;
    g.add(blob);
  }
  return g;
}

/** A bike leaning against a wall — frame, wheels, bars. */
function bike(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const frameMat = mat(`bike${rng.int(0, 5)}`, rng.pick([0x2f6ea8, 0xb5342a, 0x2f7a4a, 0x1f2328, 0xd8942a, 0xe8e4da]), 0.45, 0.5);
  const R = 0.34;

  for (const s of [-1, 1]) {
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(R, 0.03, 6, 18), M.darkSteel);
    wheel.position.set(s * 0.52, R, 0);
    wheel.castShadow = true;
    g.add(wheel);
    // A couple of spokes read as a wheel without paying for thirty.
    for (let k = 0; k < 3; k++) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, R * 2, 4), M.steel);
      sp.rotation.z = (k / 3) * Math.PI;
      sp.position.set(s * 0.52, R, 0);
      g.add(sp);
    }
  }
  // Frame triangle.
  for (const [ax, ay, bx, by] of [
    [-0.52, R, 0.1, R + 0.36],
    [0.1, R + 0.36, 0.52, R],
    [-0.52, R, 0.16, R - 0.02],
    [0.16, R - 0.02, 0.1, R + 0.36],
  ] as const) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, len, 6), frameMat);
    bar.position.set((ax + bx) / 2, (ay + by) / 2, 0);
    bar.rotation.z = Math.atan2(dy, dx) - Math.PI / 2;
    bar.castShadow = true;
    g.add(bar);
  }
  // Bars and saddle.
  const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 6), M.darkSteel);
  bars.rotation.x = Math.PI / 2;
  bars.position.set(-0.5, R + 0.5, 0);
  g.add(bars);
  g.add(box(0.22, 0.05, 0.12, 0.2, R + 0.44, 0, M.darkSteel));

  // Leaning.
  g.rotation.z = rng.range(-0.12, 0.12);
  g.rotation.x = rng.range(0.16, 0.3);
  return g;
}

/** Pavement café: tables, chairs, a parasol and a rope barrier. */
function cafeTerrace(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const cloth = mat(
    `cafe${rng.int(0, 4)}`,
    rng.pick([0xc4402f, 0x2f6b7a, 0xd8b23a, 0xe8e2d2, 0x3f7a4a]),
    0.88,
  );

  for (let i = 0; i < rng.int(2, 4); i++) {
    const tx = i * 2.1;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 14), cloth);
    top.position.set(tx, 0.74, 0);
    top.castShadow = true;
    g.add(top);
    g.add(box(0.07, 0.72, 0.07, tx, 0.36, 0, M.darkSteel));
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.03, 12), M.darkSteel);
    foot.position.set(tx, 0.02, 0);
    g.add(foot);

    for (let c = 0; c < 2; c++) {
      const a = c * Math.PI + rng.range(-0.4, 0.4);
      const cx = tx + Math.cos(a) * 0.8;
      const cz = Math.sin(a) * 0.8;
      g.add(box(0.38, 0.04, 0.38, cx, 0.44, cz, M.timber));
      g.add(box(0.38, 0.42, 0.04, cx, 0.66, cz - 0.17, M.timber));
      for (const [ox, oz] of [
        [-0.15, -0.15],
        [0.15, -0.15],
        [-0.15, 0.15],
        [0.15, 0.15],
      ] as const) {
        g.add(box(0.03, 0.42, 0.03, cx + ox, 0.21, cz + oz, M.darkSteel));
      }
    }

    if (rng.chance(0.5)) {
      g.add(box(0.05, 2.2, 0.05, tx, 1.1, 0, M.darkSteel));
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.1, 0.34, 8, 1, true), cloth);
      canopy.position.set(tx, 2.3, 0);
      canopy.castShadow = true;
      g.add(canopy);
    }
  }
  return g;
}

/** Parking meter. */
function parkingMeter(): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.1, 1.15, 0.1, 0, 0.58, 0, M.steel));
  g.add(box(0.2, 0.34, 0.16, 0, 1.32, 0, M.darkSteel));
  return g;
}

/** Fire hydrant. */
function hydrant(): THREE.Group {
  const g = new THREE.Group();
  const red = mat('hydrant', 0xb83a2c, 0.6, 0.25);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.56, 10), red);
  body.position.y = 0.28;
  g.add(body);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 7), red);
  dome.position.y = 0.56;
  dome.scale.y = 0.7;
  g.add(dome);
  for (const s of [-1, 1]) {
    const n = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 8), red);
    n.rotation.z = Math.PI / 2;
    n.position.set(s * 0.13, 0.36, 0);
    g.add(n);
  }
  return g;
}

/** Street sign on a pole: a coloured plate, no legible text at this scale. */
function streetSign(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  g.add(box(0.07, 2.6, 0.07, 0, 1.3, 0, M.steel));
  const kind = rng.next();
  if (kind < 0.4) {
    g.add(box(0.9, 0.24, 0.04, 0.3, 2.5, 0, mat('signGreen', 0x1f6b3a, 0.5)));
  } else if (kind < 0.7) {
    const plate = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 16),
      mat('signRed', 0xb5342a, 0.5),
    );
    plate.position.set(0, 2.4, 0.04);
    g.add(plate);
  } else {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), mat('signYellow', 0xd8b021, 0.5));
    plate.position.set(0, 2.4, 0.04);
    plate.rotation.z = Math.PI / 4;
    g.add(plate);
  }
  return g;
}

/** Loose litter: paper, cans, a coffee cup. */
function litter(rng: Rng): THREE.Mesh {
  const roll = rng.next();
  if (roll < 0.4) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.2), M.paper);
    m.rotation.x = -Math.PI / 2 + rng.range(-0.3, 0.3);
    m.rotation.z = rng.range(0, Math.PI);
    m.position.y = 0.012;
    return m;
  }
  if (roll < 0.75) {
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.033, 0.033, 0.12, 8),
      mat('can', rng.pick([0xb5342a, 0x2f6ea8, 0xd8d2c4]), 0.35, 0.7),
    );
    m.rotation.z = Math.PI / 2;
    m.rotation.y = rng.range(0, Math.PI);
    m.position.y = 0.033;
    return m;
  }
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.03, 0.11, 8), M.cloth);
  cup.rotation.z = rng.range(1.2, 1.9);
  cup.position.y = 0.04;
  return cup;
}

/** A row of newspaper vending boxes, chained together at the kerb. */
function newsBoxes(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const colours = [0xb5342a, 0x27528f, 0x2f6b3a, 0xd8b021, 0x35393e];
  const n = rng.int(2, 4);
  for (let i = 0; i < n; i++) {
    const c = colours[(i + rng.int(0, 4)) % colours.length];
    const body = mat(`news${c}`, c, 0.6);
    const x = (i - (n - 1) / 2) * 0.52;
    g.add(box(0.46, 0.72, 0.42, x, 0.72, 0, body));
    g.add(box(0.34, 0.3, 0.03, x, 0.86, 0.22, M.paper));
    for (const s of [-1, 1]) g.add(box(0.06, 0.36, 0.06, x + s * 0.16, 0.18, 0, M.darkSteel));
  }
  return g;
}

/** Drum-shaped mail box. */
function mailbox(): THREE.Group {
  const g = new THREE.Group();
  const blue = mat('mailBlue', 0x21497e, 0.55);
  g.add(box(0.62, 0.78, 0.52, 0, 0.72, 0, blue));
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.52, 12, 1, false, 0, Math.PI), blue);
  top.rotation.z = Math.PI / 2;
  top.rotation.y = Math.PI / 2;
  top.position.y = 1.11;
  g.add(top);
  g.add(box(0.36, 0.2, 0.04, 0, 1.06, 0.27, M.darkSteel));
  for (const s of [-1, 1]) g.add(box(0.08, 0.33, 0.08, s * 0.2, 0.17, 0, M.darkSteel));
  return g;
}

/** Glass phone booth with a hood. */
function phoneBooth(): THREE.Group {
  const g = new THREE.Group();
  const glassMat = mat('boothGlass', 0xa9c6cf, 0.1, 0.1);
  glassMat.transparent = true;
  glassMat.opacity = 0.4;
  glassMat.side = THREE.DoubleSide;
  for (const [w, d, x, z] of [
    [0.9, 0.06, 0, -0.42],
    [0.06, 0.85, -0.44, 0],
    [0.06, 0.85, 0.44, 0],
  ] as const) {
    g.add(box(w, 2.0, d, x, 1.1, z, glassMat));
  }
  g.add(box(1.0, 0.16, 0.95, 0, 2.2, 0, mat('boothHood', 0xb5342a, 0.55)));
  g.add(box(0.5, 0.5, 0.16, 0, 1.35, -0.32, M.darkSteel));
  return g;
}

/** Short cast bollard. */
function bollard(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.9, 8), M.darkSteel);
  m.position.y = 0.45;
  m.castShadow = true;
  return m;
}

/** Sandwich board outside a shop. */
function aBoard(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const face = mat('chalk', 0x2b2a28, 0.9);
  for (const s of [-1, 1]) {
    const p = box(0.62, 0.9, 0.04, 0, 0.5, s * 0.16, face);
    p.rotation.x = s * 0.32;
    g.add(p);
  }
  g.add(box(0.66, 0.05, 0.36, 0, 0.06, 0, M.timber));
  if (rng.chance(0.5)) g.add(box(0.5, 0.12, 0.02, 0, 0.72, 0.19, M.cloth));
  return g;
}

/** Traffic cone. */
function cone(): THREE.Group {
  const g = new THREE.Group();
  const orange = mat('coneOrange', 0xd9591f, 0.75);
  const c = new THREE.Mesh(new THREE.ConeGeometry(0.19, 0.62, 10), orange);
  c.position.y = 0.31;
  c.castShadow = true;
  g.add(c);
  g.add(box(0.4, 0.04, 0.4, 0, 0.02, 0, orange));
  return g;
}

/** Roadworks: barriers, cones and a spoil heap. */
function roadWorks(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const orange = mat('coneOrange', 0xd9591f, 0.75);
  const white = mat('barrierWhite', 0xdcd6c8, 0.75);
  for (let i = 0; i < 3; i++) {
    const x = (i - 1) * 1.5;
    g.add(box(1.4, 0.14, 0.06, x, 0.95, 0, orange));
    g.add(box(1.4, 0.14, 0.06, x, 0.66, 0, white));
    for (const s of [-1, 1]) g.add(box(0.07, 1.0, 0.3, x + s * 0.65, 0.5, 0, white));
  }
  for (let i = 0; i < rng.int(2, 5); i++) {
    const c = cone();
    c.position.set(rng.range(-2.4, 2.4), 0, rng.range(0.6, 1.8));
    g.add(c);
  }
  return g;
}

/** Covered market stall with crates. */
function marketStall(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  // Keyed by colour, not by a separate index: `mat` only honours the colour on
  // the first call for a key, so a mismatched key/colour pair silently gives
  // every stall whichever colour happened to be drawn first.
  const colour = rng.pick([0xd0625f, 0x2f7f74, 0xd9a23c, 0xdedad0]);
  const canvasMat = mat(`stall${colour}`, colour, 0.9);
  canvasMat.side = THREE.DoubleSide;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(box(0.07, 2.2, 0.07, sx * 1.4, 1.1, sz * 0.75, M.steel));
    }
  }
  const roof = box(3.1, 0.05, 1.8, 0, 2.24, 0, canvasMat);
  g.add(roof);
  g.add(box(3.0, 0.3, 0.05, 0, 2.05, 0.9, canvasMat));
  g.add(box(2.8, 0.08, 1.2, 0, 0.9, 0, M.timber));
  for (let i = 0; i < rng.int(3, 7); i++) {
    const c = box(
      rng.range(0.3, 0.5),
      0.22,
      rng.range(0.3, 0.45),
      rng.range(-1.2, 1.2),
      1.05,
      rng.range(-0.4, 0.4),
      rng.chance(0.5) ? M.timber : M.leafPale,
    );
    g.add(c);
  }
  return g;
}

/** Scaffolding against a building. */
function scaffold(rng: Rng, height: number): THREE.Group {
  const g = new THREE.Group();
  const lifts = Math.max(2, Math.floor(height / 2.2));
  const w = rng.range(5, 9);
  for (let l = 0; l <= lifts; l++) {
    const y = l * 2.2;
    g.add(box(w, 0.06, 0.06, 0, y, 0.1, M.steel));
    g.add(box(w, 0.06, 0.06, 0, y, 1.2, M.steel));
    if (l > 0) g.add(box(w, 0.05, 1.1, 0, y - 0.06, 0.65, M.timber));
  }
  const posts = Math.max(2, Math.round(w / 2.2));
  for (let p = 0; p <= posts; p++) {
    const x = -w / 2 + (w / posts) * p;
    for (const z of [0.1, 1.2]) {
      g.add(box(0.07, lifts * 2.2, 0.07, x, (lifts * 2.2) / 2, z, M.steel));
    }
  }
  return g;
}

/* ------------------------------------------------------- ground patches */

/**
 * Alternative paving — tile, cobble and brick — laid over the concrete in
 * plaza-sized patches so the city floor isn't one endless grey sheet.
 */
function pavingMaterials(): THREE.MeshStandardMaterial[] {
  const out: THREE.MeshStandardMaterial[] = [];

  // Square tiles.
  {
    const maps = T.asColor(T.sidewalk(1));
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(10, 10);
    out.push(new THREE.MeshStandardMaterial({ ...maps, color: 0xa9a49b, roughness: 1 }));
  }
  // Warm terracotta tile.
  {
    const maps = T.asColor(T.sidewalk(1));
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(8, 8);
    out.push(new THREE.MeshStandardMaterial({ ...maps, color: 0xb07a5c, roughness: 1 }));
  }
  // Cobbles: the stucco noise at a tight repeat reads as stone setts.
  {
    const maps = T.asColor(T.stucco(1));
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(26, 26);
    out.push(
      new THREE.MeshStandardMaterial({
        ...maps,
        color: 0x7e7a74,
        normalScale: new THREE.Vector2(2.2, 2.2),
        roughness: 1,
      }),
    );
  }
  // Dark asphalt apron.
  {
    const maps = T.asColor(T.asphalt(1));
    for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(6, 6);
    out.push(new THREE.MeshStandardMaterial({ ...maps, roughness: 1 }));
  }
  return out;
}

/* ------------------------------------------------------------- assembly */

export function buildCityDress(colliders: Colliders): THREE.Group {
  const g = new THREE.Group();
  g.name = 'citydress';
  const rng = new Rng(770123);
  const paving = pavingMaterials();

  const place = (o: THREE.Object3D, x: number, z: number, yaw = 0) => {
    o.position.set(x, CURB_H, z);
    o.rotation.y += yaw;
    g.add(o);
  };

  /* ------------------------------------------------ paving patches */

  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const c of CROSS_STREETS) {
      if (!rng.chance(0.55)) continue;
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cx = a.x + sx * (a.halfWidth + 9);
          const cz = c.z + sz * (c.halfWidth + 9);
          if (riverInfluence(cx, cz) > 0.02) continue;
          const p = new THREE.Mesh(
            new THREE.PlaneGeometry(rng.range(10, 16), rng.range(10, 16)),
            rng.pick(paving),
          );
          p.rotation.x = -Math.PI / 2;
          p.position.set(cx, CURB_H + 0.012, cz);
          p.receiveShadow = true;
          g.add(p);
        }
      }
    }
  }

  /* --------------------------------------------- pavement furniture */

  /**
   * One pass over one kerb line.
   *
   * `along` is the axis the street runs down; `fixed` is the street's centre on
   * the other axis. This used to be inlined for avenues only, which is why every
   * cross street in the city — half the grid you actually walk down — had not a
   * single bin, bench or sign on it.
   */
  const dressKerb = (
    along: 'x' | 'z',
    fixed: number,
    half: number,
    side: 1 | -1,
    tMin: number,
    tMax: number,
  ) => {
    // Position on the kerb line, `off` metres back from the carriageway edge.
    const at = (t: number, off: number): [number, number] =>
      along === 'z'
        ? [fixed + side * (half + off), t]
        : [t, fixed + side * (half + off)];

    // Props face the road: their local +Z points at the carriageway.
    const yaw = along === 'z'
      ? side > 0 ? -Math.PI / 2 : Math.PI / 2
      : side > 0 ? Math.PI : 0;

    for (let t = tMin; t < tMax; t += rng.range(6, 12)) {
      const [kx, kz] = at(t, 1.1);
      if (riverInfluence(kx, kz) > 0.02) continue;

      // Junction corners get signs and hydrants, never seating.
      let onJunction = false;
      if (along === 'z') {
        for (const c of CROSS_STREETS) if (Math.abs(t - c.z) < c.halfWidth + 4) onJunction = true;
      } else {
        for (const a of AVENUES) if (Math.abs(t - a.x) < a.halfWidth + 4) onJunction = true;
      }
      if (onJunction) {
        if (rng.chance(0.3)) place(hydrant(), kx, kz);
        if (rng.chance(0.35)) place(streetSign(rng), kx, kz, yaw);
        if (rng.chance(0.2)) place(bollard(), kx, kz);
        continue;
      }

      const [wx, wz] = at(t, 4.4);

      const roll = rng.next();
      if (roll < 0.1) {
        place(litterBin(), kx, kz);
        colliders.addCircle(kx, kz, 0.3, 1.1);
      } else if (roll < 0.17) {
        const [bx, bz] = at(t, 1.7);
        place(cityBench(), bx, bz, yaw);
        colliders.addBoxAt(bx, bz, 1.8, 1.8, 0.7);
      } else if (roll < 0.23) {
        place(parkingMeter(), kx, kz);
      } else if (roll < 0.29) {
        place(planter(rng), wx, wz, yaw);
        colliders.addBoxAt(wx, wz, 1.6, 1.6, 0.6);
      } else if (roll < 0.34) {
        place(wheelieBin(rng), wx, wz, yaw + rng.range(-0.3, 0.3));
        colliders.addCircle(wx, wz, 0.42, 1.1);
      } else if (roll < 0.38) {
        place(rubbishBags(rng), wx, wz);
      } else if (roll < 0.43) {
        place(bush(rng), wx, wz);
        colliders.addCircle(wx, wz, 0.5, 1.0);
      } else if (roll < 0.48) {
        // Bikes lean on the building line, so they face the wall.
        const b = bike(rng);
        b.rotation.y = yaw + Math.PI / 2;
        place(b, wx, wz);
      } else if (roll < 0.53) {
        place(streetSign(rng), kx, kz, yaw);
      } else if (roll < 0.59) {
        const tr = cafeTerrace(rng);
        tr.rotation.y = yaw;
        place(tr, wx, wz);
        colliders.addBoxAt(wx, wz, 3.4, 3.4, 0.8);
      } else if (roll < 0.64) {
        place(newsBoxes(rng), kx, kz, yaw);
      } else if (roll < 0.67) {
        place(mailbox(), kx, kz, yaw);
      } else if (roll < 0.7) {
        place(phoneBooth(), wx, wz, yaw);
        colliders.addCircle(wx, wz, 0.6, 2.2);
      } else if (roll < 0.75) {
        place(aBoard(rng), wx, wz, yaw + rng.range(-0.4, 0.4));
      } else if (roll < 0.78) {
        place(marketStall(rng), wx, wz, yaw);
        colliders.addBoxAt(wx, wz, 3.2, 3.2, 2.2);
      } else if (roll < 0.8) {
        const [rx, rz] = at(t, -1.6);
        place(roadWorks(rng), rx, rz, yaw);
        colliders.addBoxAt(rx, rz, 4.6, 4.6, 1.0);
      } else if (roll < 0.83) {
        place(scaffold(rng, rng.range(6, 12)), wx, wz, yaw);
      } else if (roll < 0.9) {
        // A run of bollards along the kerb.
        for (let k = -2; k <= 2; k++) {
          const [bx, bz] = at(t + k * 1.6, 1.0);
          place(bollard(), bx, bz);
        }
      }

      // Loose litter, thickest near the bins.
      if (rng.chance(0.5)) {
        const l = litter(rng);
        const [lx, lz] = at(t + rng.range(-2.5, 2.5), rng.range(0.4, 4));
        l.position.set(lx, CURB_H + l.position.y, lz);
        g.add(l);
      }
    }
  };

  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const side of [-1, 1] as const) {
      dressKerb('z', a.x, a.halfWidth, side, CITY_MIN_Z + 6, CITY_MAX_Z);
    }
  }
  for (const c of CROSS_STREETS) {
    for (const side of [-1, 1] as const) {
      dressKerb('x', c.z, c.halfWidth, side, AVENUES[1].x - 40, CITY_MAX_X);
    }
  }

  // Kerbside parking is NOT here. It lives in `world/cars.ts`, which walks the
  // same block faces and decides per car whether it is drivable or scenery —
  // two modules independently placing cars on one kerb would park them inside
  // each other.

  return g;
}

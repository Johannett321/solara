import * as THREE from 'three';
import * as T from '../render/textures';
import { rippleNormals } from '../render/water';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import { loft } from '../util/loft';
import { ensureUpward } from '../util/bake';
import {
  BRIDGES,
  RIVER_END_X,
  WATER_Y,
  CURB_H,
  riverCentreZ,
  riverHalfWidth,
  terrainHeight,
} from './layout';

/**
 * The river: channel, banks, quay walls, bridges, the container port on one
 * side and a marina on the other.
 *
 * The channel geometry is generated from the same `riverCentreZ` /
 * `riverHalfWidth` functions the ground height uses, so the water always sits
 * inside the cut rather than beside it.
 */

const RIVER_MOUTH_X = -90;

/* ------------------------------------------------------------ materials */

const M = {
  concrete: new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.92 }),
  quay: new THREE.MeshStandardMaterial({ color: 0x8d887e, roughness: 0.95 }),
  steel: new THREE.MeshStandardMaterial({
    color: 0x6a7076,
    roughness: 0.5,
    metalness: 0.75,
  }),
  paintedSteel: new THREE.MeshStandardMaterial({
    color: 0xc8442c,
    roughness: 0.6,
    metalness: 0.35,
  }),
  craneYellow: new THREE.MeshStandardMaterial({
    color: 0xd8a521,
    roughness: 0.55,
    metalness: 0.3,
  }),
  timber: new THREE.MeshStandardMaterial({ color: 0x8a6c48, roughness: 0.92 }),
  darkTimber: new THREE.MeshStandardMaterial({ color: 0x5f4a32, roughness: 0.94 }),
  hullRed: new THREE.MeshStandardMaterial({ color: 0x8e2f26, roughness: 0.62 }),
  hullBlack: new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.6 }),
  white: new THREE.MeshStandardMaterial({ color: 0xeceae2, roughness: 0.55 }),
  rail: new THREE.MeshStandardMaterial({
    color: 0xb8bcc0,
    roughness: 0.4,
    metalness: 0.8,
  }),
};

const CONTAINER_COLOURS = [
  0xb5342a, 0x2f6ea8, 0xd8942a, 0x2f7a4a, 0x8f8f96, 0x7a3f7a, 0xd8d2c4, 0x1f4f6f,
];
const containerCache = new Map<number, THREE.MeshStandardMaterial>();
function containerMat(c: number): THREE.MeshStandardMaterial {
  let m = containerCache.get(c);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: c, roughness: 0.72, metalness: 0.2 });
    containerCache.set(c, m);
  }
  return m;
}

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  mat: THREE.Material,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/* ---------------------------------------------------------- the channel */

/**
 * Riverbed and banks as one heightfield strip that follows the meander. Only
 * the corridor is meshed; the flat city ground handles everything outside it.
 */
function channel(g: THREE.Group): void {
  const NX = 150;
  const NZ = 30;

  const bedMaps = T.asColor(T.sand(1));
  for (const t of [bedMaps.map, bedMaps.normalMap, bedMaps.roughnessMap]) t.repeat.set(40, 6);
  const bedMat = new THREE.MeshStandardMaterial({
    ...bedMaps,
    color: 0x6d6552,
    roughness: 1,
    metalness: 0,
  });

  const pos: number[] = [];
  const uv: number[] = [];
  for (let ix = 0; ix < NX; ix++) {
    const x = THREE.MathUtils.lerp(RIVER_MOUTH_X, RIVER_END_X, ix / (NX - 1));
    const c = riverCentreZ(x);
    const halfOuter = riverHalfWidth(x) + 16;
    for (let iz = 0; iz < NZ; iz++) {
      // Runs -1..1 across the channel, so z increases with the column index.
      const t = (iz / (NZ - 1)) * 2 - 1;
      const z = c + t * halfOuter;
      pos.push(x, terrainHeight(x, z), z);
      uv.push(x / 24, z / 24);
    }
  }

  const idx: number[] = [];
  for (let ix = 0; ix < NX - 1; ix++) {
    for (let iz = 0; iz < NZ - 1; iz++) {
      const a = ix * NZ + iz;
      const b = a + 1;
      const c2 = a + NZ;
      const d = c2 + 1;
      // x increases with ix and z increases with iz, so this winding faces up.
      idx.push(a, c2, b, b, c2, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  ensureUpward(geo);
  const bed = new THREE.Mesh(geo, bedMat);
  bed.receiveShadow = true;
  g.add(bed);
}

export interface RiverWater {
  mesh: THREE.Mesh;
  update(t: number): void;
}

/** Flat water surface following the channel, with scrolling ripples. */
function riverWater(): RiverWater {
  const uniforms = {
    uTime: { value: 0 },
    uRippleA: { value: rippleNormals(4411, 2.0) },
    uRippleB: { value: rippleNormals(7717, 1.4) },
  };

  const material = new THREE.MeshStandardMaterial({
    // Harbour water: greener and murkier than the open sea.
    color: 0x2c5a5c,
    roughness: 0.14,
    metalness: 0,
    envMapIntensity: 0.75,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldR;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>\n vWorldR = (modelMatrix * vec4(transformed, 1.0)).xyz;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform sampler2D uRippleA;
         uniform sampler2D uRippleB;
         varying vec3 vWorldR;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `vec2 rA = vWorldR.xz * 0.09 + vec2(uTime * 0.016, uTime * 0.006);
         vec2 rB = vWorldR.xz * 0.031 - vec2(uTime * 0.009, 0.0);
         vec3 nA = texture2D(uRippleA, rA).xyz * 2.0 - 1.0;
         vec3 nB = texture2D(uRippleB, rB).xyz * 2.0 - 1.0;
         vec3 rip = normalize(nA * 0.6 + nB * 0.5);
         normal = normalize(normal + vec3(rip.x, 0.0, rip.y) * 0.34);`,
      );
  };

  // A ribbon of quads down the middle of the channel.
  const NX = 150;
  const pos: number[] = [];
  const uv: number[] = [];
  for (let ix = 0; ix < NX; ix++) {
    const x = THREE.MathUtils.lerp(RIVER_MOUTH_X, RIVER_END_X, ix / (NX - 1));
    const c = riverCentreZ(x);
    const half = riverHalfWidth(x) + 6;
    for (const t of [-1, 1]) {
      pos.push(x, WATER_Y, c + t * half);
      uv.push(x / 30, t);
    }
  }
  const idx: number[] = [];
  for (let ix = 0; ix < NX - 1; ix++) {
    const a = ix * 2;
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  ensureUpward(geo);

  const mesh = new THREE.Mesh(geo, material);
  mesh.renderOrder = 1;
  mesh.name = 'river';
  return { mesh, update: (t) => (uniforms.uTime.value = t) };
}

/* ---------------------------------------------------------------- quays */

/** Vertical concrete wall along a bank, with bollards and fenders. */
function quayWall(
  g: THREE.Group,
  colliders: Colliders,
  x0: number,
  x1: number,
  side: 1 | -1,
  rng: Rng,
): void {
  const step = 8;
  for (let x = x0; x < x1; x += step) {
    const c = riverCentreZ(x);
    const z = c + side * riverHalfWidth(x);
    const h = 5.2;
    const wall = box(step + 0.4, h, 2.2, x + step / 2, WATER_Y + h / 2 - 3.4, z - side * 1.1, M.quay);
    g.add(wall);
    colliders.addBoxAt(x + step / 2, z - side * 1.1, step, 2.2, WATER_Y + h / 2);

    // Bollards and tyre fenders.
    if (rng.chance(0.5)) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.7, 10), M.hullBlack);
      b.position.set(x + step / 2, terrainHeight(x, z - side * 2.4) + 0.35, z - side * 2.4);
      b.castShadow = true;
      g.add(b);
    }
    if (rng.chance(0.4)) {
      const tyre = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.14, 6, 12), M.hullBlack);
      tyre.position.set(x + step / 2, WATER_Y + 0.5, z - side * 0.05);
      tyre.rotation.y = Math.PI / 2;
      g.add(tyre);
    }
  }
}

/* -------------------------------------------------------------- bridges */

function bridges(g: THREE.Group, rng: Rng): void {
  for (const b of BRIDGES) {
    const len = (b.spanHalf + b.ramp) * 2;
    const w = b.halfWidth * 2;

    // Deck, following the same ramp profile the ground height uses.
    const NZ = 60;
    const pos: number[] = [];
    const uv: number[] = [];
    for (let i = 0; i < NZ; i++) {
      const z = b.centreZ - (b.spanHalf + b.ramp) + (len * i) / (NZ - 1);
      const d = Math.abs(z - b.centreZ);
      const y =
        d <= b.spanHalf
          ? b.deckY
          : (() => {
              const t = Math.max(0, 1 - (d - b.spanHalf) / b.ramp);
              return CURB_H + (b.deckY - CURB_H) * (t * t * (3 - 2 * t));
            })();
      for (const s of [-1, 1]) {
        pos.push(b.x + s * b.halfWidth, y, z);
        uv.push(s * 0.5 + 0.5, z / 10);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < NZ - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    ensureUpward(geo);

    const asphaltMaps = T.asColor(T.asphalt(1));
    for (const t of [asphaltMaps.map, asphaltMaps.normalMap, asphaltMaps.roughnessMap]) {
      t.repeat.set(2, 30);
    }
    const deck = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ ...asphaltMaps, roughness: 1 }),
    );
    deck.castShadow = true;
    deck.receiveShadow = true;
    g.add(deck);

    // Underside beam, so it doesn't read as a floating sheet.
    g.add(box(w - 1, 0.9, b.spanHalf * 2, b.x, b.deckY - 0.7, b.centreZ, M.concrete));

    // Piers standing in the water.
    for (const s of [-1, 1]) {
      const pz = b.centreZ + s * b.spanHalf * 0.55;
      g.add(box(w - 2, b.deckY + 6, 3.2, b.x, b.deckY / 2 - 3, pz, M.concrete));
    }

    // Parapets and lamps.
    for (const s of [-1, 1]) {
      const rail = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 1.0, b.spanHalf * 2 + b.ramp),
        M.concrete,
      );
      rail.position.set(b.x + s * b.halfWidth, b.deckY + 0.5, b.centreZ);
      rail.castShadow = true;
      g.add(rail);
    }
    for (let i = -2; i <= 2; i++) {
      if (i === 0 && !rng.chance(0.5)) continue;
      const lz = b.centreZ + (i * b.spanHalf) / 2.2;
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 6, 8), M.rail);
      mast.position.set(b.x + b.halfWidth - 0.4, b.deckY + 3, lz);
      mast.castShadow = true;
      g.add(mast);
    }
  }
}

/* ----------------------------------------------------------------- port */

/** Gantry crane: legs, boom over the water, trolley. */
function gantryCrane(): THREE.Group {
  const g = new THREE.Group();
  const legH = 26;
  const gauge = 16;

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(1.2, legH, 1.2), M.craneYellow);
      leg.position.set(sx * 6, legH / 2, sz * (gauge / 2));
      leg.castShadow = true;
      g.add(leg);
    }
  }
  // Portal beams.
  for (const sz of [-1, 1]) {
    g.add(box(14, 1.6, 1.4, 0, legH, sz * (gauge / 2), M.craneYellow));
  }
  // Boom reaching out over the water, plus the counterweight arm.
  g.add(box(2.2, 1.6, 62, 0, legH + 4, -16, M.craneYellow));
  g.add(box(2.6, 4, 8, 0, legH + 7, 16, M.hullBlack));
  // A-frame and stays.
  g.add(box(1.2, 14, 1.2, 0, legH + 8, 6, M.craneYellow));
  // Trolley and spreader.
  g.add(box(2.6, 1.6, 3.2, 0, legH + 2.4, -26, M.steel));
  g.add(box(2.4, 0.5, 6.2, 0, legH - 6, -26, M.steel));

  return g;
}

/** Stacked containers, the port's signature block of colour. */
function containerStack(g: THREE.Group, rng: Rng, x: number, z: number, yaw: number): void {
  const cols = rng.int(2, 5);
  const rows = rng.int(1, 3);
  const high = rng.int(1, 4);
  const L = 12.2;
  const W = 2.44;
  const H = 2.6;

  const stack = new THREE.Group();
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const n = Math.max(1, high - rng.int(0, 2));
      for (let h = 0; h < n; h++) {
        const b = box(
          L,
          H - 0.06,
          W - 0.06,
          c * (L + 0.5),
          h * H + H / 2,
          r * (W + 0.4),
          containerMat(rng.pick(CONTAINER_COLOURS)),
        );
        stack.add(b);
      }
    }
  }
  stack.position.set(x, terrainHeight(x, z), z);
  stack.rotation.y = yaw;
  g.add(stack);
}

/** A docked container ship: hull, house aft, and a deck load of boxes. */
function containerShip(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const L = 150;

  // Hull, lofted along its length like the smaller boats.
  const sections = [
    { t: 0.0, w: 9, d: 9 },
    { t: 0.08, w: 12.5, d: 10.5 },
    { t: 0.3, w: 13.5, d: 11 },
    { t: 0.62, w: 13.5, d: 11 },
    { t: 0.84, w: 10.5, d: 10 },
    { t: 0.95, w: 5.5, d: 9 },
    { t: 1.0, w: 1.2, d: 8 },
  ].map((s) => ({ y: s.t * L, w: s.w, d: s.d / 2, z: s.d / 2 - 2.5 }));

  const geo = loft(sections, { rings: 30, radial: 16, capScale: 0.4 });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -L / 2);
  const hull = new THREE.Mesh(geo, M.hullRed);
  hull.castShadow = true;
  hull.receiveShadow = true;
  g.add(hull);

  // Black topsides above the waterline.
  g.add(box(26, 4.5, L * 0.88, 0, 4.2, -4, M.hullBlack));
  // Main deck.
  g.add(box(24, 0.6, L * 0.86, 0, 6.6, -4, M.concrete));

  // Deck cargo.
  for (let r = -3; r <= 3; r++) {
    for (let c = -4; c <= 3; c++) {
      const n = rng.int(1, 4);
      for (let h = 0; h < n; h++) {
        g.add(
          box(
            2.38,
            2.54,
            12.0,
            r * 2.5,
            7.2 + h * 2.6,
            c * 12.6 - 6,
            containerMat(rng.pick(CONTAINER_COLOURS)),
          ),
        );
      }
    }
  }

  // Accommodation block and funnel, aft.
  g.add(box(20, 14, 12, 0, 13.5, L / 2 - 18, M.white));
  g.add(box(21, 1.2, 13, 0, 20, L / 2 - 18, M.white));
  g.add(box(6, 8, 6, 0, 24, L / 2 - 22, M.paintedSteel));
  // Bridge wings.
  for (const s of [-1, 1]) {
    g.add(box(4, 0.7, 8, s * 12, 19.4, L / 2 - 18, M.white));
  }

  return g;
}

/* --------------------------------------------------------------- marina */

/** Floating pontoon with piles and cleats. */
function pontoon(g: THREE.Group, x: number, z: number, len: number, yaw: number): void {
  const deck = box(3.2, 0.35, len, 0, WATER_Y + 0.35, 0, M.timber);
  const grp = new THREE.Group();
  grp.add(deck);
  for (let i = -len / 2 + 4; i < len / 2; i += 9) {
    for (const s of [-1, 1]) {
      const pile = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.24, 7, 8), M.darkTimber);
      pile.position.set(s * 1.9, WATER_Y + 1.4, i);
      pile.castShadow = true;
      grp.add(pile);
    }
  }
  grp.position.set(x, 0, z);
  grp.rotation.y = yaw;
  g.add(grp);
}

/* ------------------------------------------------------------- assembly */

export interface HarbourResult {
  group: THREE.Group;
  water: RiverWater;
}

export function buildHarbour(colliders: Colliders): HarbourResult {
  const g = new THREE.Group();
  g.name = 'harbour';
  const rng = new Rng(88991);

  channel(g);
  bridges(g, rng);

  const water = riverWater();

  /* --------------------------------------------------- port, north bank */

  const portX0 = 60;
  const portX1 = 250;
  quayWall(g, colliders, portX0, portX1, -1, rng);

  for (let x = portX0 + 30; x < portX1; x += 62) {
    const c = riverCentreZ(x);
    const z = c - riverHalfWidth(x) - 12;
    const crane = gantryCrane();
    crane.position.set(x, terrainHeight(x, z), z);
    // Boom points across the water.
    crane.rotation.y = Math.PI / 2;
    g.add(crane);
    colliders.addBoxAt(x, z, 16, 18, 24);
  }

  // Container yard behind the cranes.
  for (let x = portX0; x < portX1; x += rng.range(20, 34)) {
    const c = riverCentreZ(x);
    for (let row = 0; row < 3; row++) {
      const z = c - riverHalfWidth(x) - 34 - row * 16;
      if (rng.chance(0.25)) continue;
      containerStack(g, rng, x, z, Math.PI / 2 + rng.range(-0.05, 0.05));
      colliders.addBoxAt(x, z, 18, 14, 6);
    }
  }

  // A ship alongside.
  {
    const x = 150;
    const c = riverCentreZ(x);
    const ship = containerShip(rng);
    ship.position.set(x, WATER_Y - 1.5, c - riverHalfWidth(x) + 16);
    ship.rotation.y = Math.PI / 2;
    g.add(ship);
    colliders.addBoxAt(x, c - riverHalfWidth(x) + 16, 150, 28, 8);
  }

  /* ------------------------------------------------- marina, south bank */

  const marX0 = 20;
  const marX1 = 200;
  quayWall(g, colliders, marX0, marX1, 1, rng);

  for (let x = marX0 + 20; x < marX1; x += 46) {
    const c = riverCentreZ(x);
    const z = c + riverHalfWidth(x) - 22;
    pontoon(g, x, z, 40, Math.PI / 2);
    colliders.addBoxAt(x, z, 40, 3.4, WATER_Y + 0.5);
  }

  // Harbourmaster hut and a string of lamps on the marina promenade.
  {
    const x = 110;
    const c = riverCentreZ(x);
    const z = c + riverHalfWidth(x) + 8;
    const y = terrainHeight(x, z);
    g.add(box(7, 3.4, 5, x, y + 1.7, z, M.white));
    const roof = new THREE.Mesh(new THREE.ConeGeometry(5.6, 1.6, 4), M.paintedSteel);
    roof.rotation.y = Math.PI / 4;
    roof.position.set(x, y + 4.2, z);
    roof.castShadow = true;
    g.add(roof);
    colliders.addBoxAt(x, z, 7, 5, 3.4);
  }

  return { group: g, water };
}

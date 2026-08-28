import * as THREE from 'three';
import * as T from '../render/textures';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import {
  AVENUES,
  CROSS_STREETS,
  CITY_MAX_X,
  CITY_MIN_Z,
  CITY_MAX_Z,

  WALK_W,
  CURB_H,
  HOTEL_X,
  riverInfluence,
  STRIP_MIN_Z,
  STRIP_MAX_Z,
} from './layout';
import type { Footprint } from './buildings';
import { shadeTree } from './park';
import { palm } from './props';
import { buildCar, carSpec, CarKind } from './cars';
import {
  retailFrontage,
  upperWallKit,
  balconyRow,
  rooftopKit,
  neonMat,
  NEON_COLOURS,
  zebra,
  busShelter,
  lampHeadMat,
  lightPool,
} from './facades';

/**
 * The city inland of Ocean Drive: street grid, blocks, and everything from
 * mid-rise mixed-use up to the round downtown condo towers.
 *
 * These buildings do NOT build their windows as geometry the way the
 * beachfront hotels do — a hundred of them cannot afford it. They are boxes and
 * cylinders carrying a tiling facade texture, with the wall colour stored in
 * *vertex colours*. That means every building in a district shares one material
 * and the whole lot merges into a single draw call per chunk.
 */

/* ------------------------------------------------------------ materials */

function facadeMaterial(maps: T.SurfaceMaps, rough: number, metal: number) {
  return new THREE.MeshStandardMaterial({
    ...maps,
    vertexColors: true,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: rough,
    metalness: metal,
    envMapIntensity: 1.1,
  });
}

let mats: {
  stucco: THREE.MeshStandardMaterial;
  curtain: THREE.MeshStandardMaterial;
  balcony: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  foliage: THREE.MeshStandardMaterial;
  /** Shared with the road surface, so gap-site car parks merge with the roads. */
  roadSurface: THREE.MeshStandardMaterial;
  walkSurface: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  chainlink: THREE.MeshStandardMaterial;
  hoarding: THREE.MeshStandardMaterial;
  skip: THREE.MeshStandardMaterial;
  dirt: THREE.MeshStandardMaterial;
  grass: THREE.MeshStandardMaterial;
  paving: THREE.MeshStandardMaterial;
  signalLens: THREE.MeshStandardMaterial;
} | null = null;

function materials() {
  if (!mats) {
    // Punched windows in a plaster wall: the mid-rise workhorse.
    const stuccoMaps = T.asColor(T.facade({ glass: 0.52, tint: 0.45, spandrel: false, seed: 5 }));
    // Curtain wall: mostly glass, thin mullions — downtown towers.
    const curtainMaps = T.asColor(T.facade({ glass: 0.86, tint: 0.78, spandrel: true, seed: 9 }));
    const roofMaps = T.asColor(T.roofDeck());
    for (const t of [roofMaps.map, roofMaps.normalMap, roofMaps.roughnessMap]) {
      t.repeat.set(6, 6);
    }

    // Concrete, not the pink promenade: the neutral stucco texture tinted grey
    // rather than the sidewalk texture, whose pink is baked into the map.
    const walkMaps = T.asColor(T.stucco(1));
    for (const t of [walkMaps.map, walkMaps.normalMap, walkMaps.roughnessMap]) {
      t.repeat.set(24, 24);
    }
    const asphaltMaps = T.asColor(T.asphalt(1));
    for (const t of [asphaltMaps.map, asphaltMaps.normalMap, asphaltMaps.roughnessMap]) {
      t.repeat.set(40, 60);
    }

    mats = {
      stucco: facadeMaterial(stuccoMaps, 0.82, 0.0),
      curtain: facadeMaterial(curtainMaps, 0.22, 0.15),
      balcony: new THREE.MeshStandardMaterial({
        color: 0xe9e6dd,
        roughness: 0.7,
        metalness: 0,
      }),
      roof: new THREE.MeshStandardMaterial({ ...roofMaps, roughness: 0.95, metalness: 0 }),
      trim: new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.7 }),
      concrete: new THREE.MeshStandardMaterial({ color: 0xb8b2a8, roughness: 0.9 }),
      foliage: new THREE.MeshStandardMaterial({ color: 0x4e7c46, roughness: 0.95 }),
      roadSurface: new THREE.MeshStandardMaterial({ ...asphaltMaps, roughness: 1, metalness: 0 }),
      walkSurface: new THREE.MeshStandardMaterial({
        ...walkMaps,
        color: 0x9d9890,
        roughness: 1,
        metalness: 0,
      }),
      paint: new THREE.MeshStandardMaterial({
        color: 0xdedad2,
        roughness: 0.7,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
      chainlink: new THREE.MeshStandardMaterial({
        color: 0x8d9298,
        roughness: 0.5,
        metalness: 0.7,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      }),
      hoarding: new THREE.MeshStandardMaterial({ color: 0x2f6b8f, roughness: 0.8 }),
      skip: new THREE.MeshStandardMaterial({ color: 0x8a4a24, roughness: 0.85 }),
      dirt: new THREE.MeshStandardMaterial({ color: 0x9a8a72, roughness: 1 }),
      grass: new THREE.MeshStandardMaterial({ color: 0x5c8a44, roughness: 0.98 }),
      paving: new THREE.MeshStandardMaterial({ color: 0xb5aFa4, roughness: 0.95 }),
      signalLens: new THREE.MeshStandardMaterial({
        color: 0x1a2a1e,
        emissive: 0x30ff70,
        emissiveIntensity: 0,
        roughness: 0.5,
      }),
    };

    // Lit windows after dark. The emissive map is a 4x4 block of bays, so the
    // pattern does not repeat with the same period as the colour map — every
    // window in the district lighting up in lockstep is the giveaway.
    mats.stucco.emissive.setHex(0xffffff);
    mats.stucco.emissiveMap = T.facadeLit({ glass: 0.52, spandrel: false, seed: 21, cells: 4 });
    mats.stucco.emissiveIntensity = 0;
    mats.curtain.emissive.setHex(0xffffff);
    mats.curtain.emissiveMap = T.facadeLit({ glass: 0.86, spandrel: true, seed: 34, cells: 4 });
    mats.curtain.emissiveIntensity = 0;
  }
  return mats;
}

/**
 * Switch the city between day and night.
 *
 * Everything here is a shared material, so this is a handful of scalar writes
 * for the whole map — no traversal, no per-object work.
 */
export function setCityNight(f: number): void {
  const t = Math.min(1, Math.max(0, f));
  const m = materials();
  // Windows come on over the last part of dusk rather than tracking the sun
  // linearly: people turn lights on when it gets dark, not at sunset.
  const lit = Math.pow(t, 0.7);
  m.stucco.emissiveIntensity = lit * 1.5;
  m.curtain.emissiveIntensity = lit * 1.5;
  m.signalLens.emissiveIntensity = lit * 1.5;
}

/**
 * Wet the road and pavement when it rains.
 *
 * Full wet-surface rendering is out of scope, but almost all of the read comes
 * from two things: wet asphalt is *darker* and much *glossier* than dry. Both
 * are single properties on the shared ground materials, so the whole city's
 * road surface changes with four writes.
 */
export function setCityWet(f: number): void {
  const t = Math.min(1, Math.max(0, f));
  const m = materials();
  m.roadSurface.roughness = 1 - t * 0.72;
  m.roadSurface.color.setRGB(1 - t * 0.45, 1 - t * 0.45, 1 - t * 0.42);
  m.roadSurface.envMapIntensity = 1 + t * 2.2;
  m.walkSurface.roughness = 1 - t * 0.5;
  m.walkSurface.color.setRGB(
    0.615 * (1 - t * 0.35),
    0.596 * (1 - t * 0.35),
    0.565 * (1 - t * 0.32),
  );
  m.walkSurface.envMapIntensity = 1 + t * 1.4;
}

/* ---------------------------------------------------------------- helpers */

/** Paint every vertex of a geometry one colour, for the shared-material trick. */
function tint(geo: THREE.BufferGeometry, color: THREE.Color): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}

/**
 * Rescale a box's UVs so the facade texture repeats once per bay and once per
 * floor, instead of stretching one window across the whole wall.
 */
function tileBoxUVs(
  geo: THREE.BoxGeometry,
  w: number,
  h: number,
  d: number,
  bay: number,
  floor: number,
): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry emits faces in the order +X, -X, +Y, -Y, +Z, -Z, 4 verts each.
  const spans: Array<[number, number]> = [
    [d / bay, h / floor],
    [d / bay, h / floor],
    [w / bay, d / bay],
    [w / bay, d / bay],
    [w / bay, h / floor],
    [w / bay, h / floor],
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = spans[f];
    for (let i = 0; i < 4; i++) {
      const k = f * 4 + i;
      uv.setXY(k, uv.getX(k) * su, uv.getY(k) * sv);
    }
  }
  uv.needsUpdate = true;
}

function boxAt(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  mat: THREE.Material,
  color?: THREE.Color,
  bay?: number,
  floor?: number,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, d);
  if (bay && floor) tileBoxUVs(geo, w, h, d, bay, floor);
  if (color) tint(geo, color);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/* ------------------------------------------------------------ buildings */

// Miami pastels, not office grey. The city read as dull mostly because every
// wall was within a few percent of the same off-white; these are far enough
// apart that a row of blocks has actual rhythm.
const WALL_COLOURS = [
  0xf4e7d3, 0xf0d9c8, 0xe7d2df, 0xd3e4e2, 0xcfdcea, 0xf2ecd4, 0xdfe6d2, 0xeed6cc,
  0xc9dbe2, 0xe8dcea, 0xf6e2b8, 0xd8e8dd, 0xefc9b6, 0xc6d8d2,
];

/** Ground-floor plinth colours: a shade off the wall above, never the same. */
const PLINTH_COLOURS = [
  0xf7f2e6, 0xe4ded0, 0xd8cfc2, 0xe9e2ea, 0xd2dee0, 0xf2e6d2, 0xcdc8bd,
];

const GLASS_COLOURS = [
  0x9fb8c4, 0x8fa8bc, 0xa8bcc0, 0x7f9aae, 0xb0c2c8, 0x86a89a, 0xb3a894, 0x94a6c6,
];

/**
 * Two-storey retail podium under a tower.
 *
 * A tower landing straight on the pavement is the other reason downtown felt
 * dead: nothing at eye level. Real towers sit on a shop-lined base, and that
 * base is all the player ever sees from the street.
 */
function podium(rng: Rng, w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const hh = 8.6;
  const inset = 0.6;
  const shopH = 5.2;

  const wall = new THREE.Color(rng.pick(PLINTH_COLOURS));
  g.add(boxAt(w, hh - shopH, d, 0, shopH + (hh - shopH) / 2, 0, m.stucco, wall, 3.4, 3.4));
  g.add(
    boxAt(w - inset * 2, shopH, d - inset * 2, 0, shopH / 2, 0, m.stucco, wall, 60, 60),
  );

  // Shops on all four sides: a podium is walked right around.
  const faces: Array<[number, number, number, number]> = [
    [(Math.PI * 1) / 2, w / 2 - inset, 0, d - inset * 2],
    [(-Math.PI * 1) / 2, -(w / 2 - inset), 0, d - inset * 2],
    [0, 0, d / 2 - inset, w - inset * 2],
    [Math.PI, 0, -(d / 2 - inset), w - inset * 2],
  ];
  for (const [yaw, px, pz, span] of faces) {
    const f = retailFrontage(
      { span, height: shopH, project: inset, awningChance: 0.45, bladeChance: 0.12 },
      rng,
    );
    f.rotation.y = yaw;
    f.position.set(px, 0, pz);
    g.add(f);
  }

  // Cornice and a planted terrace on the podium roof.
  g.add(boxAt(w + 0.7, 0.4, d + 0.7, 0, hh + 0.2, 0, m.trim));
  g.add(boxAt(w - 0.6, 0.9, d - 0.6, 0, hh + 0.75, 0, m.balcony));
  for (let i = 0; i < rng.int(3, 7); i++) {
    const px = rng.range(-w / 2 + 2, w / 2 - 2);
    const pz = rng.range(-d / 2 + 2, d / 2 - 2);
    g.add(boxAt(1.4, 0.7, 1.4, px, hh + 0.75, pz, m.concrete));
    const bushMesh = new THREE.Mesh(new THREE.SphereGeometry(0.75, 7, 5), m.foliage);
    bushMesh.position.set(px, hh + 1.5, pz);
    bushMesh.castShadow = true;
    g.add(bushMesh);
  }
  return g;
}

/**
 * The round condo tower — the silhouette that defines the skyline in the
 * reference: a cylinder ringed by continuous balcony slabs.
 */
function roundTower(rng: Rng, floors: number, radius: number): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const floorH = 3.2;
  const h = floors * floorH;
  const wall = new THREE.Color(rng.pick(GLASS_COLOURS));

  const core = new THREE.CylinderGeometry(radius, radius, h, 26, 1);
  // Cylinder UVs already run 0..1 around and up; scale to bays and floors.
  const uv = core.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) * (radius * 2.2), uv.getY(i) * floors);
  }
  tint(core, wall);
  const body = new THREE.Mesh(core, m.curtain);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  g.add(body);

  // Balcony slabs every floor: the horizontal banding is most of the look.
  const slab = new THREE.CylinderGeometry(radius + 0.85, radius + 0.85, 0.16, 26, 1);
  for (let f = 1; f <= floors; f++) {
    const s = new THREE.Mesh(slab, m.balcony);
    s.position.y = f * floorH;
    s.castShadow = true;
    s.receiveShadow = true;
    g.add(s);
  }

  // Core stack and roof plant.
  g.add(
    boxAt(radius * 0.7, 3.2, radius * 0.7, 0, h + 1.6, 0, m.concrete),
  );
  const cap = new THREE.CylinderGeometry(radius + 0.9, radius + 0.9, 0.4, 26);
  const capMesh = new THREE.Mesh(cap, m.roof);
  capMesh.position.y = h + 0.2;
  capMesh.receiveShadow = true;
  g.add(capMesh);

  return g;
}

/** Rectilinear glass high-rise, with a setback partway up. */
function glassTower(rng: Rng, floors: number, w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const floorH = 3.6;
  const wall = new THREE.Color(rng.pick(GLASS_COLOURS));

  const setbackAt = Math.floor(floors * rng.range(0.55, 0.78));
  const lower = setbackAt * floorH;
  const upper = (floors - setbackAt) * floorH;

  g.add(boxAt(w, lower, d, 0, lower / 2, 0, m.curtain, wall, 3.4, floorH));
  const w2 = w * rng.range(0.6, 0.82);
  const d2 = d * rng.range(0.6, 0.82);
  g.add(boxAt(w2, upper, d2, 0, lower + upper / 2, 0, m.curtain, wall, 3.4, floorH));

  // Setback terrace where the tower steps in — planted, like every condo here.
  g.add(boxAt(w + 0.6, 0.5, d + 0.6, 0, lower + 0.25, 0, m.trim));
  for (let i = 0; i < rng.int(2, 5); i++) {
    const px = rng.range(-w / 2 + 1.5, w / 2 - 1.5);
    const pz = rng.range(-d / 2 + 1.5, d / 2 - 1.5);
    if (Math.abs(px) < w2 / 2 && Math.abs(pz) < d2 / 2) continue;
    const bushMesh = new THREE.Mesh(new THREE.SphereGeometry(0.8, 7, 5), m.foliage);
    bushMesh.position.set(px, lower + 1.1, pz);
    bushMesh.castShadow = true;
    g.add(bushMesh);
  }

  // Crown and mast, with a lit band picking out the top of the tower.
  g.add(boxAt(w2 + 0.8, 0.5, d2 + 0.8, 0, lower + upper + 0.25, 0, m.trim));
  const crown = neonMat(rng.pick(NEON_COLOURS));
  for (const s of [-1, 1]) {
    g.add(boxAt(0.14, 0.5, d2 + 0.9, (s * (w2 + 0.9)) / 2, lower + upper - 0.6, 0, crown));
    g.add(boxAt(w2 + 0.9, 0.5, 0.14, 0, lower + upper - 0.6, (s * (d2 + 0.9)) / 2, crown));
  }
  if (rng.chance(0.6)) {
    g.add(boxAt(0.4, rng.range(6, 16), 0.4, 0, lower + upper + 8, 0, m.concrete));
  }
  g.add(rooftopKit(w2 * 0.8, d2 * 0.8, lower + upper + 0.5, rng));
  return g;
}

/**
 * Mixed-use mid-rise: a proper row of shops below, flats above.
 *
 * The ground floor is deliberately *narrower* than the floors above. That one
 * detail is what was missing: the earlier version put the ground floor proud of
 * the wall, so the shopfront glazing was a painted stripe on a flush box and the
 * street read as a blank plaster canyon. Setting it back means the upper mass
 * overhangs, the piers and fascia project forward to meet it, and every shop
 * sits in its own shadow.
 */
function midRise(rng: Rng, floors: number, w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const floorH = 3.4;
  const groundH = 4.9;
  const h = groundH + (floors - 1) * floorH;
  const wall = new THREE.Color(rng.pick(WALL_COLOURS));
  const inset = 0.55;

  const upper = h - groundH;
  g.add(boxAt(w, upper, d, 0, groundH + upper / 2, 0, m.stucco, wall, 3.6, floorH));

  // Recessed ground-floor mass.
  const plinth = new THREE.Color(rng.pick(PLINTH_COLOURS));
  g.add(
    boxAt(w - inset * 2, groundH, d - inset * 2, 0, groundH / 2, 0, m.stucco, plinth, 60, 60),
  );

  // Shops on all four faces. Blocks here are surrounded by streets on every
  // side, so a building with two blank ends turns half the grid — every cross
  // street — into a plaster canyon.
  const faces: Array<[number, number, number, number]> = [
    [Math.PI / 2, w / 2 - inset, 0, d - inset * 2],
    [-Math.PI / 2, -(w / 2 - inset), 0, d - inset * 2],
    [0, 0, d / 2 - inset, w - inset * 2],
    [Math.PI, 0, -(d / 2 - inset), w - inset * 2],
  ];
  for (const [yaw, px, pz, span] of faces) {
    const f = retailFrontage(
      { span, height: groundH, project: inset, awningChance: 0.6, bladeChance: 0.22 },
      rng,
    );
    f.rotation.y = yaw;
    f.position.set(px, 0, pz);
    g.add(f);
  }

  // Pipework, plant and fire escapes on the wall above.
  for (const [yaw, , , span] of faces) {
    if (rng.chance(0.45)) continue;
    const k = upperWallKit(span, h, groundH, rng);
    k.rotation.y = yaw;
    k.position.set(
      Math.sin(yaw) * (w / 2),
      0,
      Math.cos(yaw) * (d / 2),
    );
    g.add(k);
  }

  // Balconies. Continuous slabs are what make these read as flats rather than
  // as an office block with the windows painted on.
  if (rng.chance(0.62)) {
    const glassRail = rng.chance(0.4);
    // One axis only: balconies on all four faces of every block is both a lot
    // of geometry and not how these buildings are actually laid out.
    const acrossX = rng.chance(0.5);
    for (const s of [-1, 1]) {
      const span = (acrossX ? d : w) * 0.82;
      const b = balconyRow(span, floors - 1, floorH, groundH + floorH * 0.72, glassRail);
      b.rotation.y = acrossX ? (s * Math.PI) / 2 : s > 0 ? 0 : Math.PI;
      b.position.set(acrossX ? (s * w) / 2 : 0, 0, acrossX ? 0 : (s * d) / 2);
      g.add(b);
    }
  }

  // Corner pilasters, running the full height of the upper mass.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      g.add(
        boxAt(0.55, upper, 0.55, (sx * w) / 2, groundH + upper / 2, (sz * d) / 2, m.trim),
      );
    }
  }

  // Cornice, parapet and roof deck.
  g.add(boxAt(w + 0.8, 0.35, d + 0.8, 0, h + 0.17, 0, m.trim));
  g.add(boxAt(w + 0.3, 0.75, d + 0.3, 0, h + 0.72, 0, m.trim));
  g.add(boxAt(w - 1, 0.2, d - 1, 0, h + 0.5, 0, m.roof));

  // A neon rule under the cornice on some blocks — pure Ocean Drive, and it
  // picks out the roofline right across the district.
  if (rng.chance(0.35)) {
    const neon = neonMat(rng.pick(NEON_COLOURS));
    for (const s of [-1, 1]) {
      g.add(boxAt(0.1, 0.1, d + 0.7, (s * (w + 0.7)) / 2, h - 0.1, 0, neon));
      g.add(boxAt(w + 0.7, 0.1, 0.1, 0, h - 0.1, (s * (d + 0.7)) / 2, neon));
    }
  }

  g.add(rooftopKit(w, d, h + 0.6, rng));
  return g;
}

/** Low, wide, flat — the warehouse district, with a painted end wall. */
function warehouse(rng: Rng, w: number, d: number): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const h = rng.range(5.5, 8);
  const wall = new THREE.Color(rng.pick([0xd8cfc0, 0xc9c2b6, 0xdad3c4]));

  g.add(boxAt(w, h, d, 0, h / 2, 0, m.stucco, wall, 60, 60));
  g.add(boxAt(w + 0.6, 0.5, d + 0.6, 0, h + 0.25, 0, m.trim));

  // Murals on both long walls, straight out of the reference. A warehouse with
  // one painted side and three blank ones is a blank slab from most angles.
  const mural = muralMaterial(rng);
  for (const s of [-1, 1]) {
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.92, h * 0.72), mural);
    face.position.set(0, h * 0.42, s * (d / 2 + 0.06));
    face.rotation.y = s > 0 ? 0 : Math.PI;
    face.receiveShadow = true;
    g.add(face);
  }

  // Loading dock: a raised platform at lorry-bed height with roller shutters
  // over it, plus a ramp at one end.
  const dockY = 1.15;
  g.add(boxAt(w * 0.8, dockY, 3.2, 0, dockY / 2, d / 2 + 1.6, m.concrete));
  const ramp = boxAt(4, 0.3, 4.6, -w * 0.4 - 1.6, dockY * 0.5, d / 2 + 1.6, m.concrete);
  ramp.rotation.x = Math.atan2(dockY, 4.6);
  g.add(ramp);
  for (let i = -1; i <= 1; i++) {
    const x = i * (w / 3.4);
    g.add(boxAt(3.2, 3.6, 0.12, x, dockY + 1.8, d / 2 + 0.07, m.trim));
    // Rubber dock bumpers either side of each shutter.
    for (const s of [-1, 1]) {
      g.add(boxAt(0.3, 0.4, 0.25, x + s * 1.8, dockY - 0.3, d / 2 + 1.6 + 1.5, m.skip));
    }
    // Canopy over the shutter.
    g.add(boxAt(3.8, 0.18, 1.6, x, dockY + 3.9, d / 2 + 0.8, m.trim));
  }

  // Pallets and drums stacked on the dock.
  for (let i = 0; i < rng.int(2, 6); i++) {
    g.add(
      boxAt(
        rng.range(0.9, 1.3),
        rng.range(0.7, 1.6),
        rng.range(0.9, 1.3),
        rng.range(-w * 0.35, w * 0.35),
        dockY + 0.6,
        d / 2 + 1.6 + rng.range(-0.8, 0.8),
        rng.chance(0.5) ? m.skip : m.trim,
      ),
    );
  }

  // Wall packs, and roof plant so it isn't a flat lid from the towers above.
  for (let i = -1; i <= 1; i++) {
    g.add(boxAt(0.5, 0.22, 0.35, i * (w / 3.4), h - 0.9, d / 2 + 0.2, m.trim));
  }
  g.add(rooftopKit(w, d, h + 0.5, rng));
  return g;
}

/* ------------------------------------------------------------ vacant lots */

/** Everyday cars, for the gap-site car parks. */
const LOT_PALETTE: Array<[CarKind, number]> = [
  ['sedan', 0xd9dde2], ['suv', 0x2f3a44], ['coupe', 0x18191d], ['sedan', 0x8f9aa4],
  ['suv', 0xf1f2f4], ['sedan', 0x1c4fa8], ['coupe', 0x7a2320], ['sedan', 0x1d7d6a],
];
let lotCar = 0;

/**
 * What goes on a plot with no building on it.
 *
 * Leaving a lot empty used to mean a 30 m expanse of blank pavement, which is
 * worse than the building would have been. Real gap sites are surface car
 * parks, hoarded-off building sites and scrappy pocket parks, and all three are
 * more interesting to walk past than a wall.
 */
function vacantLot(
  rng: Rng,
  w: number,
  d: number,
  cx: number,
  cz: number,
  colliders: Colliders,
): THREE.Group {
  const g = new THREE.Group();
  const m = materials();
  const kind = rng.next();

  const surface = (mat: THREE.Material, y: number) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    p.rotation.x = -Math.PI / 2;
    p.position.y = y;
    p.receiveShadow = true;
    g.add(p);
  };

  /** Chain-link or hoarding along the plot boundary. */
  const fence = (height: number, panel: THREE.Material, post: THREE.Material) => {
    for (const [len, x, z, rot] of [
      [w, 0, -d / 2, 0],
      [w, 0, d / 2, 0],
      [d, -w / 2, 0, Math.PI / 2],
      [d, w / 2, 0, Math.PI / 2],
    ] as const) {
      // Leave one side open so the lot reads as accessible.
      if (rot === 0 && z > 0) continue;
      const wall = boxAt(len, height, 0.08, x, height / 2, z, panel);
      wall.rotation.y = rot;
      g.add(wall);
      for (let t = -len / 2; t <= len / 2; t += 3) {
        const p = boxAt(0.1, height + 0.15, 0.1, x, (height + 0.15) / 2, z, post);
        p.position.x += Math.cos(rot) * t;
        p.position.z -= Math.sin(rot) * t;
        g.add(p);
      }
    }
  };

  if (kind < 0.45) {
    /* ------------------------------------------------- surface car park */
    surface(m.roadSurface, 0.02);
    // Bay markings, in two rows off a central aisle.
    for (const s of [-1, 1]) {
      for (let x = -w / 2 + 2; x < w / 2 - 2; x += 2.6) {
        const bay = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 5), m.paint);
        bay.rotation.x = -Math.PI / 2;
        bay.position.set(x, 0.03, s * (d / 2 - 2.8));
        g.add(bay);
      }
    }
    // Cars in about half the bays. An empty car park is as dull as bare
    // pavement, which is the thing this lot exists to avoid.
    for (const s of [-1, 1]) {
      for (let x = -w / 2 + 3.3; x < w / 2 - 3; x += 2.6) {
        if (rng.chance(0.45)) continue;
        const [kind, colour] = LOT_PALETTE[lotCar++ % LOT_PALETTE.length];
        const car = buildCar(kind, colour, rng);
        const z = s * (d / 2 - 2.8);
        car.group.position.set(x, 0.02, z);
        // Nosed into the bay. Bays run along Z, and the model's nose is local
        // **-X**, so a heading of 0 (facing +Z) means rotating by +PI/2.
        car.group.rotation.y = s > 0 ? Math.PI / 2 : -Math.PI / 2;
        g.add(car.group);
        const spec = carSpec(kind);
        colliders.addBoxAt(cx + x, cz + z, spec.width, spec.length, spec.roofY);
      }
    }
    fence(2.1, m.chainlink, m.concrete);
    // Lighting mast and a skip in the corner.
    g.add(boxAt(0.2, 8, 0.2, w / 2 - 1.5, 4, -d / 2 + 1.5, m.concrete));
    g.add(boxAt(1.4, 0.25, 0.6, w / 2 - 1.5, 8, -d / 2 + 1.5, m.trim));
    g.add(boxAt(2.4, 1.3, 1.6, rng.range(-w / 4, w / 4), 0.65, d / 2 - 2, m.skip));
  } else if (kind < 0.75) {
    /* --------------------------------------------------- building site */
    surface(m.dirt, 0.02);
    fence(2.6, m.hoarding, m.hoarding);
    // Foundation slab and a pit.
    g.add(boxAt(w * 0.6, 0.4, d * 0.6, 0, 0.2, 0, m.concrete));
    for (let i = 0; i < rng.int(2, 5); i++) {
      // Stacked materials.
      g.add(
        boxAt(
          rng.range(1.2, 3),
          rng.range(0.4, 1.2),
          rng.range(1.2, 2.4),
          rng.range(-w / 2 + 3, w / 2 - 3),
          0.6,
          rng.range(-d / 2 + 3, d / 2 - 3),
          rng.chance(0.5) ? m.concrete : m.skip,
        ),
      );
    }
    // Site cabin on blocks.
    g.add(boxAt(6, 2.6, 3, -w / 2 + 5, 1.6, d / 2 - 3, m.trim));
    // Tower of scaffolding.
    for (let l = 0; l < rng.int(2, 5); l++) {
      g.add(boxAt(3, 0.08, 3, w / 4, 0.6 + l * 2.1, -d / 4, m.concrete));
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          g.add(boxAt(0.08, 2.1, 0.08, w / 4 + sx * 1.5, 1.65 + l * 2.1, -d / 4 + sz * 1.5, m.trim));
        }
      }
    }
  } else {
    /* ---------------------------------------------------- pocket park */
    surface(m.grass, 0.02);
    // Diagonal path across it.
    const path = new THREE.Mesh(new THREE.PlaneGeometry(Math.hypot(w, d) * 0.9, 2.2), m.paving);
    path.rotation.x = -Math.PI / 2;
    path.rotation.z = Math.atan2(d, w);
    path.position.y = 0.035;
    g.add(path);
    for (let i = 0; i < rng.int(2, 5); i++) {
      const t = shadeTree(rng);
      t.position.set(rng.range(-w / 2 + 2, w / 2 - 2), 0, rng.range(-d / 2 + 2, d / 2 - 2));
      t.rotation.y = rng.range(0, 6.28);
      g.add(t);
    }
    for (let i = 0; i < rng.int(1, 3); i++) {
      const bx = rng.range(-w / 2 + 3, w / 2 - 3);
      const bz = rng.range(-d / 2 + 3, d / 2 - 3);
      g.add(boxAt(1.7, 0.08, 0.45, bx, 0.45, bz, m.trim));
      for (const s of [-1, 1]) g.add(boxAt(0.12, 0.45, 0.4, bx + s * 0.7, 0.22, bz, m.concrete));
    }
  }

  return g;
}

/* ------------------------------------------------------------------ mural */

const muralCache: THREE.MeshStandardMaterial[] = [];

/**
 * Big flat blocks of saturated colour with looping shapes over them. Not any
 * particular artwork — just enough to read as a painted wall at driving speed.
 */
function muralMaterial(rng: Rng): THREE.MeshStandardMaterial {
  if (muralCache.length >= 4) return rng.pick(muralCache);

  const w = 512;
  const h = 256;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;

  const palette = [
    ['#b4282c', '#1f3f8f', '#e8c22c', '#1f7a4a'],
    ['#c2185b', '#00897b', '#f4a62a', '#3949ab'],
    ['#d84315', '#2e7d32', '#1565c0', '#f9a825'],
  ][muralCache.length % 3];

  // Panels.
  let x = 0;
  while (x < w) {
    const pw = rng.range(70, 170);
    ctx.fillStyle = rng.pick(palette);
    ctx.fillRect(x, 0, pw, h);
    x += pw;
  }

  // Loops and blobs over the top.
  for (let i = 0; i < 26; i++) {
    ctx.strokeStyle = rng.chance(0.5) ? 'rgba(245,240,230,0.85)' : 'rgba(20,18,22,0.6)';
    ctx.lineWidth = rng.range(4, 16);
    ctx.beginPath();
    const cx = rng.range(0, w);
    const cy = rng.range(0, h);
    ctx.ellipse(cx, cy, rng.range(15, 70), rng.range(12, 55), rng.range(0, 3), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = rng.pick(palette);
    ctx.beginPath();
    ctx.arc(rng.range(0, w), rng.range(0, h), rng.range(8, 34), 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 });
  muralCache.push(mat);
  return mat;
}

/* --------------------------------------------------------------- ground */

function cityGround(g: THREE.Group): void {
  const m = materials();

  const walkMat = m.walkSurface;
  const roadMat = m.roadSurface;

  const plane = (w: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    p.rotation.x = -Math.PI / 2;
    p.position.set(x, y, z);
    p.receiveShadow = true;
    g.add(p);
    return p;
  };

  /**
   * Lay a surface as tiles, skipping any that fall in the river. A single big
   * plane would simply roof the channel over.
   */
  const tiled = (
    xa: number,
    xb: number,
    za: number,
    zb: number,
    y: number,
    mat: THREE.Material,
    tile = 22,
  ) => {
    const nx = Math.max(1, Math.ceil((xb - xa) / tile));
    const nz = Math.max(1, Math.ceil((zb - za) / tile));
    const tw = (xb - xa) / nx;
    const td = (zb - za) / nz;
    for (let i = 0; i < nx; i++) {
      for (let j = 0; j < nz; j++) {
        const cx = xa + tw * (i + 0.5);
        const cz = za + td * (j + 0.5);
        // Test the corners too, so tiles clipping the bank are dropped as well.
        let wet = riverInfluence(cx, cz);
        wet = Math.max(wet, riverInfluence(cx - tw / 2, cz - td / 2));
        wet = Math.max(wet, riverInfluence(cx + tw / 2, cz + td / 2));
        wet = Math.max(wet, riverInfluence(cx - tw / 2, cz + td / 2));
        wet = Math.max(wet, riverInfluence(cx + tw / 2, cz - td / 2));
        if (wet > 0.22) continue;
        plane(tw + 0.05, td + 0.05, cx, y, cz, mat);
      }
    }
  };

  const x0 = HOTEL_X - 3;

  // Asphalt under the entire city at road level, laid as tiles so the river can
  // be cut out of it. The pavement then goes on top block by block, so streets
  // are simply the gaps — cheaper and more robust than cutting holes per road.
  tiled(x0, CITY_MAX_X, CITY_MIN_Z, CITY_MAX_Z, 0, roadMat, 26);

  // Block bands: between consecutive avenues, and between cross streets.
  const xBands: Array<[number, number]> = [];
  let prev = x0;
  for (const a of AVENUES) {
    if (a.x <= x0) continue;
    if (a.x - a.halfWidth > prev) xBands.push([prev, a.x - a.halfWidth]);
    prev = a.x + a.halfWidth;
  }
  if (CITY_MAX_X > prev) xBands.push([prev, CITY_MAX_X]);

  const zBands: Array<[number, number]> = [];
  let pz = CITY_MIN_Z;
  for (const c of CROSS_STREETS) {
    if (c.z - c.halfWidth > pz) zBands.push([pz, c.z - c.halfWidth]);
    pz = c.z + c.halfWidth;
  }
  if (CITY_MAX_Z > pz) zBands.push([pz, CITY_MAX_Z]);

  const kerbMat = m.concrete.clone();
  kerbMat.color.setHex(0xc2bcb2);
  const kerbGeo = new THREE.BoxGeometry(1, 1, 1);
  const kerb = (w: number, d: number, x: number, z: number) => {
    const k = new THREE.Mesh(kerbGeo, kerbMat);
    k.scale.set(w, CURB_H, d);
    k.position.set(x, CURB_H / 2, z);
    k.castShadow = true;
    k.receiveShadow = true;
    g.add(k);
  };

  for (const [xa, xb] of xBands) {
    for (const [za, zb] of zBands) {
      const w = xb - xa;
      const d = zb - za;
      if (w < 1 || d < 1) continue;
      tiled(xa, xb, za, zb, CURB_H, walkMat, 24);
      // Kerb around the block edge, skipped where the river has eaten it.
      if (riverInfluence(xa, (za + zb) / 2) < 0.2) kerb(0.35, d, xa + 0.17, (za + zb) / 2);
      if (riverInfluence(xb, (za + zb) / 2) < 0.2) kerb(0.35, d, xb - 0.17, (za + zb) / 2);
      if (riverInfluence((xa + xb) / 2, za) < 0.2) kerb(w, 0.35, (xa + xb) / 2, za + 0.17);
      if (riverInfluence((xa + xb) / 2, zb) < 0.2) kerb(w, 0.35, (xa + xb) / 2, zb + -0.17);
    }
  }

  /* ------------------------------------------------------- markings */

  const paintMat = m.paint;
  const yellowMat = new THREE.MeshStandardMaterial({
    color: 0xe0b431,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  for (const a of AVENUES) {
    if (a.x === 0) continue;

    if (a.lanes === 2) {
      // Planted median down the boulevard, in segments so the river breaks it.
      for (let z = CITY_MIN_Z; z < CITY_MAX_Z; z += 20) {
        if (riverInfluence(a.x, z + 10) > 0.05) continue;
        const med = new THREE.Mesh(new THREE.BoxGeometry(2.6, CURB_H, 20), kerbMat);
        med.position.set(a.x, CURB_H / 2, z + 10);
        med.receiveShadow = true;
        g.add(med);
      }
    } else {
      for (let z = CITY_MIN_Z; z < CITY_MAX_Z; z += 20) {
        if (riverInfluence(a.x, z + 10) > 0.05) continue;
        for (const off of [-0.18, 0.18]) {
          plane(0.14, 20, a.x + off, 0.008, z + 10, yellowMat);
        }
      }
    }

    // Dashed lane lines either side of the centre.
    for (const side of [-1, 1]) {
      for (let z = CITY_MIN_Z; z < CITY_MAX_Z; z += 8) {
        let onCross = false;
        for (const c of CROSS_STREETS) {
          if (Math.abs(z - c.z) < c.halfWidth + 2) onCross = true;
        }
        if (onCross) continue;
        if (riverInfluence(a.x, z) > 0.05) continue;
        plane(0.12, 3.4, a.x + side * (a.halfWidth * 0.5), 0.008, z, paintMat);
      }
    }
  }

  // Cross streets get the same treatment as the avenues. They had no markings
  // at all, which is half the road surface in the city reading as bare tarmac.
  for (const c of CROSS_STREETS) {
    for (let x = HOTEL_X; x < CITY_MAX_X; x += 8) {
      let onAve = false;
      for (const a of AVENUES) {
        if (Math.abs(x - a.x) < a.halfWidth + 2) onAve = true;
      }
      if (onAve || riverInfluence(x, c.z) > 0.05) continue;
      for (const off of [-0.18, 0.18]) {
        plane(3.4, 0.14, x, 0.008, c.z + off, yellowMat);
      }
    }
  }

  // Stop bars where cross streets meet the avenues.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const c of CROSS_STREETS) {
      for (const s of [-1, 1]) {
        plane(a.halfWidth - 0.3, 0.34, a.x + s * a.halfWidth * 0.5, 0.009, c.z + s * (c.halfWidth + 0.9), paintMat);
      }
    }
  }
}

/* ------------------------------------------------------------- furniture */

function streetFurniture(
  g: THREE.Group,
  colliders: Colliders,
  rng: Rng,
  /** Collects the world position of every lamp head placed here. */
  lamps: THREE.Vector3[],
): void {
  const m = materials();
  const poleMat = new THREE.MeshStandardMaterial({
    color: 0x8e9298,
    roughness: 0.45,
    metalness: 0.8,
  });
  const lampMat = lampHeadMat();

  /** Cobra-head streetlight, arm reaching over the carriageway. */
  const streetlight = (x: number, z: number, yaw: number) => {
    const grp = new THREE.Group();
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 8.2, 8), poleMat);
    mast.position.y = 4.1;
    mast.castShadow = true;
    grp.add(mast);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.6, 6), poleMat);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(1.3, 8.1, 0);
    grp.add(arm);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.18, 0.34), lampMat);
    head.position.set(2.5, 8.0, 0);
    head.castShadow = true;
    grp.add(head);

    // The pool the lamp throws on the road. Hundreds of real point lights are
    // out of the question, and an emissive lamp head on its own lights nothing
    // — this is what actually makes the street read as lit at night. It is one
    // shared additive material, so the whole city's worth merges into a single
    // draw call and switches on with one opacity change.
    const pool = lightPool(15);
    pool.position.set(2.5, -CURB_H + 0.03, 0);
    grp.add(pool);

    grp.position.set(x, CURB_H, z);
    grp.rotation.y = yaw;
    g.add(grp);
    colliders.addCircle(x, z, 0.16, 2.2);

    // The head hangs off the end of the arm, 2.5 m out and 8 m up, and the arm
    // swings with the mast — so the light is not above the post it stands on.
    lamps.push(
      new THREE.Vector3(
        x + Math.cos(yaw) * 2.5,
        CURB_H + 8.0,
        z - Math.sin(yaw) * 2.5,
      ),
    );
  };

  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (let z = CITY_MIN_Z + 20; z < CITY_MAX_Z; z += 34) {
      const side = ((z / 34) | 0) % 2 === 0 ? 1 : -1;
      if (riverInfluence(a.x, z) > 0.02) continue;
      streetlight(a.x + side * (a.halfWidth + 1.4), z, side > 0 ? Math.PI : 0);
    }
  }

  /**
   * Overhead power lines along one avenue — the sagging cables cutting across
   * the sky are a signature of the reference frame.
   */
  const cableMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2c, roughness: 0.8 });
  const av = AVENUES[2];
  const poleZs: number[] = [];
  for (let z = CITY_MIN_Z; z < CITY_MAX_Z; z += 42) poleZs.push(z);

  for (const z of poleZs) {
    if (riverInfluence(av.x, z) > 0.02) continue;
    const x = av.x + av.halfWidth + 2.2;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.22, 11, 7), m.concrete);
    pole.position.set(x, CURB_H + 5.5, z);
    pole.castShadow = true;
    g.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.14, 0.14), m.concrete);
    arm.position.set(x, CURB_H + 10.4, z);
    g.add(arm);
    colliders.addCircle(x, z, 0.25, 3);
  }

  // Catenaries between consecutive poles.
  for (let i = 0; i < poleZs.length - 1; i++) {
    if (riverInfluence(av.x, poleZs[i]) > 0.02) continue;
    if (riverInfluence(av.x, poleZs[i + 1]) > 0.02) continue;
    const x = av.x + av.halfWidth + 2.2;
    for (const off of [-0.9, 0, 0.9]) {
      const a = new THREE.Vector3(x + off, CURB_H + 10.4, poleZs[i]);
      const b = new THREE.Vector3(x + off, CURB_H + 10.4, poleZs[i + 1]);
      const sag = new THREE.Vector3().lerpVectors(a, b, 0.5).setY(CURB_H + 9.1);
      const curve = new THREE.CatmullRomCurve3([a, sag, b]);
      const wire = new THREE.Mesh(new THREE.TubeGeometry(curve, 10, 0.035, 4, false), cableMat);
      g.add(wire);
    }
  }

  /* ------------------------------------------------------- street trees */

  // Palms near the coast, canopy trees further inland — the same gradient the
  // reference shows between the beach highway and downtown.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (let z = CITY_MIN_Z + 8; z < CITY_MAX_Z; z += rng.range(7.5, 11)) {
      let onCross = false;
      for (const c of CROSS_STREETS) {
        if (Math.abs(z - c.z) < c.halfWidth + 5) onCross = true;
      }
      if (onCross) continue;

      if (riverInfluence(a.x, z) > 0.02) continue;
      for (const side of [-1, 1]) {
        if (rng.chance(0.12)) continue;
        const x = a.x + side * (a.halfWidth + 2.4);
        const tree = a.x < 150 && rng.chance(0.6) ? palm(rng, rng.range(7, 11)).group : shadeTree(rng);
        tree.position.set(x, CURB_H, z);
        tree.rotation.y = rng.range(0, Math.PI * 2);
        g.add(tree);
        colliders.addCircle(x, z, 0.4, 2.4);
      }
    }
  }

  // Palms down the boulevard median.
  const boulevard = AVENUES.find((a) => a.lanes === 2);
  if (boulevard) {
    for (let z = CITY_MIN_Z + 14; z < CITY_MAX_Z; z += 16) {
      let onCross = false;
      for (const c of CROSS_STREETS) {
        if (Math.abs(z - c.z) < c.halfWidth + 6) onCross = true;
      }
      if (onCross || riverInfluence(boulevard.x, z) > 0.02) continue;
      const { group } = palm(rng, rng.range(8, 12));
      group.position.set(boulevard.x, CURB_H, z);
      group.rotation.y = rng.range(0, Math.PI * 2);
      g.add(group);
    }
  }

  /* ------------------------------------------------ crossings & shelters */

  // Zebras on all four arms of every junction. Junction markings are most of
  // what tells you a road grid is a road grid rather than tarmac between boxes.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const c of CROSS_STREETS) {
      if (riverInfluence(a.x, c.z) > 0.02) continue;
      for (const s of [-1, 1]) {
        const across = zebra(a.halfWidth * 2, 3.2);
        across.position.set(a.x, 0.012, c.z + s * (c.halfWidth + 2.4));
        g.add(across);

        const along = zebra(c.halfWidth * 2, 3.2);
        along.rotation.y = Math.PI / 2;
        along.position.set(a.x + s * (a.halfWidth + 2.4), 0.012, c.z);
        g.add(along);
      }
    }
  }

  // Bus shelters, on the kerb between junctions.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (let z = CITY_MIN_Z + 55; z < CITY_MAX_Z; z += 170) {
      if (riverInfluence(a.x, z) > 0.02) continue;
      const side = rng.chance(0.5) ? 1 : -1;
      const sh = busShelter(rng);
      sh.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      sh.position.set(a.x + side * (a.halfWidth + 2.6), CURB_H, z);
      g.add(sh);
      colliders.addBoxAt(a.x + side * (a.halfWidth + 2.6), z, 1.8, 4.4, 2.6);
    }
  }

  // Traffic signals on the bigger junctions.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const c of CROSS_STREETS) {
      if (!rng.chance(0.75)) continue;
      if (riverInfluence(a.x, c.z) > 0.02) continue;
      for (const sx of [-1, 1]) {
        const x = a.x + sx * (a.halfWidth + 1.2);
        const z = c.z + sx * (c.halfWidth + 1.2);
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.1, 5.4, 8), poleMat);
        mast.position.set(x, CURB_H + 2.7, z);
        mast.castShadow = true;
        g.add(mast);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.8, 0.28), m.signalLens);
        head.position.set(x - sx * 1.6, CURB_H + 4.6, z);
        head.castShadow = true;
        g.add(head);
        colliders.addCircle(x, z, 0.16, 2.2);
      }
    }
  }
}

/* ---------------------------------------------------------- expressway */

/** Deck height of the elevated expressway. */
export const EXPRESSWAY_Y = 11.5;
/** It straddles this avenue, the way a real urban viaduct does. */
export const EXPRESSWAY_X = 292;

/**
 * Elevated expressway on concrete piers, with barriers and overhead sign
 * gantries — the viaduct from the reference frame.
 *
 * Deliberately NOT registered in `groundHeight`: the ground is a single-valued
 * heightfield, so putting the deck in it would mean walking *under* the viaduct
 * teleported you on top of it. It carries its own traffic instead, and the
 * player stays on the surface streets.
 */
function expressway(g: THREE.Group, colliders: Colliders, rng: Rng): void {
  const m = materials();
  const halfW = 9.5;
  const y = EXPRESSWAY_Y;
  const x = EXPRESSWAY_X;

  const asphaltMaps = T.asColor(T.asphalt(1));
  for (const t of [asphaltMaps.map, asphaltMaps.normalMap, asphaltMaps.roughnessMap]) {
    t.repeat.set(2, 120);
  }
  const deckMat = new THREE.MeshStandardMaterial({ ...asphaltMaps, roughness: 1 });

  const barrier = new THREE.MeshStandardMaterial({ color: 0xb0aaa0, roughness: 0.9 });

  // Deck and soffit, in segments so the river gap can be skipped.
  for (let z = CITY_MIN_Z; z < CITY_MAX_Z; z += 40) {
    const len = 40;
    const cz = z + len / 2;
    g.add(boxAt(halfW * 2, 0.55, len, x, y, cz, deckMat));
    g.add(boxAt(halfW * 2 - 2.4, 1.1, len, x, y - 0.8, cz, m.concrete));
    for (const s of [-1, 1]) {
      g.add(boxAt(0.42, 1.15, len, x + s * (halfW - 0.2), y + 0.85, cz, barrier));
    }
  }

  // Piers, straddling the avenue below.
  for (let z = CITY_MIN_Z + 13; z < CITY_MAX_Z; z += 26) {
    if (riverInfluence(x, z) > 0.02) continue;
    const col = boxAt(2.4, y - 1.4, 2.4, x, (y - 1.4) / 2 + CURB_H, z, m.concrete);
    g.add(col);
    // Hammerhead cap.
    g.add(boxAt(halfW * 2 - 3, 1.0, 2.6, x, y - 1.7, z, m.concrete));
    colliders.addBoxAt(x, z, 2.6, 2.6, y);
  }

  // Overhead sign gantries: the big green boards from the reference.
  const signGreen = new THREE.MeshStandardMaterial({ color: 0x1c6b3c, roughness: 0.6 });
  const signYellow = new THREE.MeshStandardMaterial({ color: 0xd8b021, roughness: 0.6 });
  for (let z = CITY_MIN_Z + 60; z < CITY_MAX_Z; z += 190) {
    if (riverInfluence(x, z) > 0.02) continue;
    for (const s of [-1, 1]) {
      g.add(boxAt(0.34, 6.2, 0.34, x + s * (halfW - 0.4), y + 3.6, z, m.concrete));
    }
    g.add(boxAt(halfW * 2, 0.4, 0.4, x, y + 6.5, z, m.concrete));
    // Three boards, one per lane group.
    for (let i = -1; i <= 1; i++) {
      const board = boxAt(5.2, 2.4, 0.16, x + i * 6.0, y + 5.0, z, i === 1 ? signYellow : signGreen);
      g.add(board);
    }
    // Roadside gantry lights.
    if (rng.chance(0.5)) {
      g.add(boxAt(0.7, 0.16, 0.3, x - halfW + 1.2, y + 6.2, z, m.trim));
    }
  }

  // Street lighting along the deck.
  for (let z = CITY_MIN_Z + 20; z < CITY_MAX_Z; z += 48) {
    if (riverInfluence(x, z) > 0.02) continue;
    g.add(boxAt(0.16, 7.5, 0.16, x + halfW - 0.6, y + 4.5, z, m.concrete));
  }
}

/* --------------------------------------------------------------- blocks */

interface District {
  /** Inland range this district covers. */
  minX: number;
  maxX: number;
  kind: 'midrise' | 'tower' | 'warehouse';
}

const DISTRICTS: District[] = [
  { minX: 74, maxX: 120, kind: 'midrise' },
  { minX: 136, maxX: 194, kind: 'midrise' },
  { minX: 213, maxX: 284, kind: 'tower' },
  { minX: 301, maxX: CITY_MAX_X, kind: 'tower' },
];

export interface CityResult {
  group: THREE.Group;
  footprints: Footprint[];
  /** World positions of the cobra heads, for `render/lights.ts`. */
  lamps: THREE.Vector3[];
}

export function buildCity(colliders: Colliders): CityResult {
  const g = new THREE.Group();
  g.name = 'city';
  const rng = new Rng(505050);
  const lamps: THREE.Vector3[] = [];
  const footprints: Footprint[] = [];

  cityGround(g);
  streetFurniture(g, colliders, rng, lamps);
  expressway(g, colliders, rng);

  /** Register a building: geometry is already added; this does the bookkeeping. */
  const claim = (cx: number, cz: number, w: number, d: number, floors: number) => {
    colliders.addBox(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2);
    footprints.push({
      minX: cx - w / 2,
      maxX: cx + w / 2,
      minZ: cz - d / 2,
      maxZ: cz + d / 2,
      floors,
      label: null,
    });
  };

  for (const district of DISTRICTS) {
    for (let ci = 0; ci < CROSS_STREETS.length - 1; ci++) {
      const zA = CROSS_STREETS[ci].z + CROSS_STREETS[ci].halfWidth + WALK_W;
      const zB = CROSS_STREETS[ci + 1].z - CROSS_STREETS[ci + 1].halfWidth - WALK_W;
      const blockD = zB - zA;
      if (blockD < 12) continue;

      const xA = district.minX;
      const xB = district.maxX;
      const blockW = xB - xA;

      // Split each block along its length into 1-3 plots.
      const plots = district.kind === 'tower' ? rng.int(1, 2) : rng.int(2, 3);
      let z = zA;
      for (let p = 0; p < plots; p++) {
        const share = p === plots - 1 ? zB - z : blockD / plots + rng.range(-6, 6);
        const depth = Math.max(14, Math.min(share, zB - z)) - 3;
        if (depth < 12) break;
        const cz = z + depth / 2 + 1.5;
        const cx = xA + blockW / 2 + rng.range(-3, 3);

        // Nothing gets built in the river, or on its banks.
        if (riverInfluence(cx, cz) > 0.02) {
          z += depth + 3;
          continue;
        }

        // Leave the odd gap site; a wall-to-wall city reads as a wall. It gets
        // a car park, a hoarded building site or a pocket park — never just
        // bare pavement.
        if (rng.chance(0.16)) {
          const lot = vacantLot(rng, blockW - rng.range(3, 8), depth - 2, cx, cz, colliders);
          lot.position.set(cx, CURB_H, cz);
          g.add(lot);
          z += depth + 3;
          continue;
        }

        const w = blockW - rng.range(6, 14);
        let floors: number;
        let obj: THREE.Group;

        if (district.kind === 'tower') {
          floors = rng.int(14, 34);
          // Every tower gets a shop-lined podium. From the pavement the podium
          // *is* the building — the shaft above is only ever seen from a
          // distance, and a bare shaft meeting the kerb is what made downtown
          // feel like a car park.
          const podW = Math.min(w, 46);
          const podD = Math.min(depth, 46);
          const pod = podium(rng, podW, podD);
          pod.position.set(cx, CURB_H, cz);
          g.add(pod);
          claim(cx, cz, podW, podD, floors);

          if (rng.chance(0.45)) {
            const r = Math.min(w, depth) * 0.42;
            obj = roundTower(rng, floors, r);
          } else {
            const tw = Math.min(w, 34);
            const td = Math.min(depth, 34);
            obj = glassTower(rng, floors, tw, td);
          }
        } else if (rng.chance(0.16)) {
          floors = 1;
          obj = warehouse(rng, w, depth);
          claim(cx, cz, w, depth, floors);
        } else {
          floors = rng.int(3, 9);
          obj = midRise(rng, floors, w, depth);
          claim(cx, cz, w, depth, floors);
        }

        obj.position.set(cx, CURB_H, cz);
        obj.rotation.y = rng.chance(0.5) ? 0 : Math.PI;
        g.add(obj);

        z += depth + 3;
      }
    }
  }

  /* --------------------------------------------- fill behind the hotels */

  // The first inland block, between the hotel backs and Collins Avenue.
  //
  // This walks the cross-street grid exactly like the districts above. The
  // earlier version just stepped along z at a fixed interval, which dropped
  // buildings straight across the side streets and walled the city off.
  const backX0 = 34;
  const backX1 = AVENUES[1].x - AVENUES[1].halfWidth - WALK_W;
  for (let ci = 0; ci < CROSS_STREETS.length - 1; ci++) {
    const zA = CROSS_STREETS[ci].z + CROSS_STREETS[ci].halfWidth + WALK_W;
    const zB = CROSS_STREETS[ci + 1].z - CROSS_STREETS[ci + 1].halfWidth - WALK_W;
    if (zB - zA < 14) continue;

    let z = zA;
    while (z < zB - 12) {
      const depth = Math.min(rng.range(18, 32), zB - z) - 2;
      if (depth < 12) break;
      const cz = z + depth / 2;
      const cx = (backX0 + backX1) / 2 + rng.range(-2, 2);

      const skipForHotels = cz > STRIP_MIN_Z - 20 && cz < STRIP_MAX_Z + 20 && rng.chance(0.4);
      if (!skipForHotels && riverInfluence(cx, cz) < 0.02 && !rng.chance(0.14)) {
        const w = backX1 - backX0 - rng.range(2, 8);
        const floors = rng.int(2, 6);
        const obj = midRise(rng, floors, w, depth);
        obj.position.set(cx, CURB_H, cz);
        g.add(obj);
        claim(cx, cz, w, depth, floors);
      }
      z += depth + 2 + rng.range(0, 6);
    }
  }

  return { group: g, footprints, lamps };
}

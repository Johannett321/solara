import * as THREE from 'three';
import * as T from '../render/textures';
import { Colliders } from './collision';
import {
  ROAD_HALF,
  CURB_H,
  WALK_R_OUTER,
  WALK_L_OUTER,
  CROSS_Z,
  CROSS_HALF,
  STRIP_MIN_Z,
  STRIP_MAX_Z,
} from './layout';

const LEN = STRIP_MAX_Z - STRIP_MIN_Z;
const MID_Z = (STRIP_MAX_Z + STRIP_MIN_Z) / 2;

function ground(
  w: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

/** Thin unlit-ish decal used for paint on the road; sits just above the surface. */
function paint(
  w: number,
  d: number,
  color: number,
  x: number,
  z: number,
  y = 0.008,
  rough = 0.55,
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), paintMat(color, rough));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y, z);
  m.receiveShadow = true;
  return m;
}

/**
 * Road markings share a material per colour and finish.
 *
 * There are a hundred-odd separate markings down the strip. Built one material
 * each they cannot be merged by the bake — `bakeStatic` buckets by material
 * identity — so every stripe and arrow stayed its own draw call.
 */
const paintCache = new Map<string, THREE.MeshStandardMaterial>();

function paintMat(color: number, rough: number): THREE.MeshStandardMaterial {
  const key = `${color}:${rough}`;
  let m = paintCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color,
      roughness: rough,
      metalness: 0,
      // Markings are coplanar with the road; the offset is what stops them
      // z-fighting with it.
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    paintCache.set(key, m);
  }
  return m;
}

export function buildStreet(_colliders: Colliders): THREE.Group {
  const g = new THREE.Group();
  g.name = 'street';

  const asphaltMaps = T.asColor(T.asphalt(1));
  asphaltMaps.map.repeat.set(3, LEN / 5);
  asphaltMaps.normalMap.repeat.copy(asphaltMaps.map.repeat);
  asphaltMaps.roughnessMap.repeat.copy(asphaltMaps.map.repeat);

  const roadMat = new THREE.MeshStandardMaterial({
    ...asphaltMaps,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughness: 1,
    metalness: 0,
    color: 0xffffff,
  });

  const walkMaps = T.asColor(T.sidewalk(1));
  const walkRepeatMain = new THREE.Vector2(4, LEN / 4);
  walkMaps.map.repeat.copy(walkRepeatMain);
  walkMaps.normalMap.repeat.copy(walkRepeatMain);
  walkMaps.roughnessMap.repeat.copy(walkRepeatMain);

  const walkMat = new THREE.MeshStandardMaterial({
    ...walkMaps,
    normalScale: new THREE.Vector2(1.0, 1.0),
    roughness: 1,
    metalness: 0,
  });

  const concreteMat = new THREE.MeshStandardMaterial({
    color: 0xbdb3a8,
    roughness: 0.92,
    metalness: 0,
  });

  /* ------------------------------------------------------------- surfaces */

  // Backdrop so the horizon never shows void through the haze.
  const backdropMaps = T.asColor(T.sand(1));
  backdropMaps.map.repeat.set(60, 60);
  backdropMaps.normalMap.repeat.set(60, 60);
  backdropMaps.roughnessMap.repeat.set(60, 60);
  // Landward only — west of the park the real terrain takes over, and a plane
  // out there would slice straight through the sea.
  g.add(
    ground(
      900,
      1400,
      new THREE.MeshStandardMaterial({ ...backdropMaps, roughness: 1, color: 0x9d968b }),
      420,
      -0.05,
      MID_Z,
    ),
  );

  g.add(ground(ROAD_HALF * 2, LEN, roadMat, 0, 0, MID_Z));

  // Cross street, running out to both facade lines.
  const crossMat = roadMat.clone();
  crossMat.map = roadMat.map!.clone();
  crossMat.map.repeat.set(12, 2.5);
  crossMat.map.needsUpdate = true;
  g.add(ground(70, CROSS_HALF * 2, crossMat, 0, -0.001, CROSS_Z));

  // Promenade slabs, split around the cross street.
  const walkW_R = WALK_R_OUTER - ROAD_HALF;
  const walkW_L = ROAD_HALF + WALK_L_OUTER;
  const segments: Array<[number, number]> = [
    [STRIP_MIN_Z, CROSS_Z - CROSS_HALF],
    [CROSS_Z + CROSS_HALF, STRIP_MAX_Z],
  ];

  for (const [z0, z1] of segments) {
    const d = z1 - z0;
    const cz = (z0 + z1) / 2;

    const r = walkMat.clone();
    r.map = walkMat.map!.clone();
    r.normalMap = walkMat.normalMap!.clone();
    r.roughnessMap = walkMat.roughnessMap!.clone();
    for (const t of [r.map, r.normalMap, r.roughnessMap]) {
      t.repeat.set(walkW_R / 2.2, d / 2.2);
      t.needsUpdate = true;
    }
    g.add(ground(walkW_R, d, r, ROAD_HALF + walkW_R / 2, CURB_H, cz));

    const l = walkMat.clone();
    l.map = walkMat.map!.clone();
    l.normalMap = walkMat.normalMap!.clone();
    l.roughnessMap = walkMat.roughnessMap!.clone();
    for (const t of [l.map, l.normalMap, l.roughnessMap]) {
      t.repeat.set(Math.abs(walkW_L) / 2.2, d / 2.2);
      t.needsUpdate = true;
    }
    g.add(ground(Math.abs(walkW_L), d, l, -ROAD_HALF - Math.abs(walkW_L) / 2, CURB_H, cz));
  }

  /* ----------------------------------------------------------------- kerbs */

  const kerbMat = concreteMat.clone();
  kerbMat.color.setHex(0xcac0b4);

  const kerbGeo = new THREE.BoxGeometry(1, 1, 1);
  const addKerb = (x: number, z0: number, z1: number) => {
    const d = z1 - z0;
    const m = new THREE.Mesh(kerbGeo, kerbMat);
    m.scale.set(0.34, CURB_H, d);
    m.position.set(x, CURB_H / 2, (z0 + z1) / 2);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };

  for (const [z0, z1] of segments) {
    addKerb(ROAD_HALF + 0.17, z0, z1);
    addKerb(-ROAD_HALF - 0.17, z0, z1);
  }

  // Kerb returns along the cross street.
  for (const s of [-1, 1]) {
    for (const side of [-1, 1]) {
      const m = new THREE.Mesh(kerbGeo, kerbMat);
      m.scale.set(24, CURB_H, 0.34);
      m.position.set(side * (ROAD_HALF + 12.2), CURB_H / 2, CROSS_Z + s * (CROSS_HALF + 0.17));
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    }
  }

  /* -------------------------------------------------------- road markings */

  // Double yellow centre line.
  for (const off of [-0.18, 0.18]) {
    for (const [z0, z1] of segments) {
      g.add(paint(0.14, z1 - z0, 0xe0b431, off, (z0 + z1) / 2, 0.008, 0.7));
    }
  }

  // Dashed white lane divider on each carriageway.
  for (const side of [-1, 1]) {
    for (let z = STRIP_MIN_Z; z < STRIP_MAX_Z; z += 8) {
      if (Math.abs(z - CROSS_Z) < CROSS_HALF + 2) continue;
      g.add(paint(0.12, 3.4, 0xdedad2, side * 3.5, z, 0.008, 0.7));
    }
  }

  // Solid parking-lane edge lines.
  for (const side of [-1, 1]) {
    for (const [z0, z1] of segments) {
      g.add(paint(0.12, z1 - z0, 0xdedad2, side * (ROAD_HALF - 2.6), (z0 + z1) / 2, 0.008, 0.7));
    }
  }

  // Zebra crossing + stop bars either side of the junction.
  for (const s of [-1, 1]) {
    const zc = CROSS_Z + s * (CROSS_HALF - 1.4);
    for (let i = -6; i <= 6; i++) {
      g.add(paint(0.62, 2.4, 0xe6e2da, i * 1.06, zc, 0.009, 0.68));
    }
    g.add(paint(ROAD_HALF - 0.2, 0.34, 0xe6e2da, s * (ROAD_HALF / 2 + 0.1) * -1, CROSS_Z + s * (CROSS_HALF + 1.1), 0.009, 0.7));
  }

  /* ----------------------------------------------- tactile paving corners */

  const tactileMaps = T.asColor(T.tactilePaving());
  const tactileMat = new THREE.MeshStandardMaterial({
    ...tactileMaps,
    normalScale: new THREE.Vector2(1.4, 1.4),
    roughness: 1,
    metalness: 0,
  });
  for (const t of [tactileMaps.map, tactileMaps.normalMap, tactileMaps.roughnessMap]) {
    t.repeat.set(1.4, 1);
  }

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const pad = ground(
        3.0,
        1.9,
        tactileMat,
        sx * (ROAD_HALF + 1.6),
        CURB_H + 0.004,
        CROSS_Z + sz * (CROSS_HALF + 1.4),
      );
      g.add(pad);
    }
  }

  // Dropped-kerb ramps down to the crossing.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const ramp = new THREE.Mesh(new THREE.BoxGeometry(3.0, CURB_H, 0.9), kerbMat);
      ramp.position.set(
        sx * (ROAD_HALF + 1.6),
        CURB_H / 2,
        CROSS_Z + sz * (CROSS_HALF + 0.35),
      );
      ramp.receiveShadow = true;
      g.add(ramp);
    }
  }

  /* -------------------------------------------------------------- drains  */

  const drainMat = new THREE.MeshStandardMaterial({
    color: 0x2b2a27,
    roughness: 0.62,
    metalness: 0.75,
  });
  for (let z = STRIP_MIN_Z + 20; z < STRIP_MAX_Z; z += 30) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 3) continue;
    for (const side of [-1, 1]) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.05, 0.42), drainMat);
      d.position.set(side * (ROAD_HALF - 0.45), 0.02, z);
      d.receiveShadow = true;
      g.add(d);
    }
  }

  /* ------------------------------------------------------------ colliders */

  // No bounds here any more. The old fences ran along x=46 and z=+/-150, which
  // was the edge of the world when Ocean Drive *was* the world — once the city
  // went in behind them they became an invisible wall across every route
  // inland. The world edge is enforced once, in world/index.ts.

  return g;
}

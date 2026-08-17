import * as THREE from 'three';
import * as T from '../render/textures';
import { Rng } from '../core/rng';
import { bakeChunked, ensureUpward } from '../util/bake';
import {
  PARK_EDGE,
  OCEAN_EDGE,
  SHORELINE_X,
  groundHeight,
  beachEdgeAt,
  STRIP_MIN_Z,
  STRIP_MAX_Z,
} from './layout';

/**
 * Beach, dune and seabed as one heightfield, plus the grass park strip that
 * separates the promenade from the sand.
 *
 * The surface comes straight from `shoreHeight`, the same function the player
 * controller and the ocean shader use, so the sand, the collision and the surf
 * line can never disagree with each other.
 */

const Z_PAD = 240;

function sandMaterial(): THREE.MeshStandardMaterial {
  const maps = T.asColor(T.sand(1));
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(60, 90);
  return new THREE.MeshStandardMaterial({
    ...maps,
    color: 0xdccca8,
    normalScale: new THREE.Vector2(1.1, 1.1),
    roughness: 1,
    metalness: 0,
  });
}

/**
 * Wet sand: a darker, glossier strip that tracks the waterline. Sold as its own
 * thin mesh laid over the beach rather than a texture blend, which keeps the
 * sand material simple.
 */
function wetSandMaterial(): THREE.MeshStandardMaterial {
  const maps = T.asColor(T.sand(1));
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(24, 90);
  return new THREE.MeshStandardMaterial({
    ...maps,
    color: 0x9d8a6b,
    roughness: 0.42,
    metalness: 0,
    transparent: true,
    opacity: 0.85,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

export interface Terrain {
  group: THREE.Group;
}

export function buildTerrain(): Terrain {
  const g = new THREE.Group();
  g.name = 'terrain';
  const rng = new Rng(1789);

  /* ------------------------------------------------------- beach + seabed */

  // Dense across the shore where the profile bends, coarse out to sea.
  const NX = 200;
  const NZ = 120;
  const zMin = STRIP_MIN_Z - Z_PAD;
  const zMax = STRIP_MAX_Z + Z_PAD;

  const xs = new Float32Array(NX);
  for (let i = 0; i < NX; i++) {
    const t = i / (NX - 1);
    xs[i] = THREE.MathUtils.lerp(PARK_EDGE, OCEAN_EDGE, Math.pow(t, 2.4));
  }

  const pos = new Float32Array(NX * NZ * 3);
  const uv = new Float32Array(NX * NZ * 2);
  let p = 0;
  let q = 0;
  for (let iz = 0; iz < NZ; iz++) {
    const z = THREE.MathUtils.lerp(zMin, zMax, iz / (NZ - 1));
    for (let ix = 0; ix < NX; ix++) {
      const x = xs[ix];
      // Straight from groundHeight, so the mesh and the collision agree.
      pos[p++] = x;
      pos[p++] = groundHeight(x, z);
      pos[p++] = z;
      uv[q++] = x / 30;
      uv[q++] = z / 30;
    }
  }

  const idx: number[] = [];
  for (let iz = 0; iz < NZ - 1; iz++) {
    for (let ix = 0; ix < NX - 1; ix++) {
      const a = iz * NX + ix;
      const b = a + 1;
      const c = a + NX;
      const d = c + 1;
      // x decreases with ix, so this winding — not the obvious one — is what
      // puts the face normals up. Reversed, the sun lights the underside and
      // the sand samples the sky's lower hemisphere, which blows out white.
      idx.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  ensureUpward(geo);
  geo.computeBoundingSphere();

  const beach = new THREE.Mesh(geo, sandMaterial());
  beach.receiveShadow = true;
  g.add(beach);

  /* --------------------------------------------------------- wet sand band */

  {
    const wGeo = new THREE.PlaneGeometry(1, 1, 26, 90);
    // Lay it flat FIRST; displacing a vertical plane and rotating afterwards
    // mirrors it in z and inverts the winding.
    wGeo.rotateX(-Math.PI / 2);
    const wp = wGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < wp.count; i++) {
      // x must INCREASE with local X or the winding flips and the strip faces
      // down — the same trap as the beach and ocean grids.
      const x = SHORELINE_X - 6 + (wp.getX(i) + 0.5) * 13;
      const z = THREE.MathUtils.lerp(zMin, zMax, wp.getZ(i) + 0.5);
      wp.setXYZ(i, x, groundHeight(x, z) + 0.012, z);
    }
    wp.needsUpdate = true;
    wGeo.computeVertexNormals();
    ensureUpward(wGeo);
    const wet = new THREE.Mesh(wGeo, wetSandMaterial());
    wet.receiveShadow = true;
    g.add(wet);
  }

  /* ------------------------------------------------------------ park strip */

  // Grass between the promenade and the dune, Lummus Park style.
  const grassMaps = T.asColor(T.sand(1));
  for (const t of [grassMaps.map, grassMaps.normalMap, grassMaps.roughnessMap]) {
    t.repeat.set(30, 90);
  }
  const grassMat = new THREE.MeshStandardMaterial({
    ...grassMaps,
    // The sand map underneath is very bright, so the tint has to be pushed hard
    // to read as grass rather than as pale scrub.
    color: 0x3f6b22,
    roughness: 0.98,
    metalness: 0,
  });

  // 220 divisions along z so the curved seaward edge stays smooth.
  const parkGeo = new THREE.PlaneGeometry(1, 1, 24, 220);
  parkGeo.rotateX(-Math.PI / 2);
  const pp = parkGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pp.count; i++) {
    const z = THREE.MathUtils.lerp(zMin, zMax, pp.getZ(i) + 0.5);
    // Seaward edge first so x increases with local X: reversed, the whole park
    // faces downwards and is invisible from above.
    const x = THREE.MathUtils.lerp(beachEdgeAt(z), PARK_EDGE, pp.getX(i) + 0.5);
    pp.setXYZ(i, x, groundHeight(x, z) + 0.02, z);
  }
  pp.needsUpdate = true;
  parkGeo.computeVertexNormals();
  ensureUpward(parkGeo);

  const park = new THREE.Mesh(parkGeo, grassMat);
  park.receiveShadow = true;
  g.add(park);

  /* -------------------------------------------------------- dune planting */

  // Sea oats along the dune crest — the visual break between park and sand.
  const oatMat = new THREE.MeshStandardMaterial({
    color: 0x93a054,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  // Small and tightly clumped: sparse tall blades read as litter on the sand
  // rather than as dune grass.
  //
  // There are ~9000 of these. They go into their own group and get baked here
  // rather than left loose — as individual meshes they were, on their own, more
  // draw calls than the entire rest of the world put together.
  const oats = new THREE.Group();
  oats.name = 'oats';
  const oatGeo = new THREE.PlaneGeometry(0.035, 0.42);
  oatGeo.translate(0, 0.21, 0);

  for (let z = zMin + 20; z < zMax; z += 0.8) {
    if (!rng.chance(0.7)) continue;
    // Tufts hug the wandering sand edge rather than a straight line.
    const cx = beachEdgeAt(z) - 3 + rng.range(-2.2, 2.2);
    for (let i = 0; i < rng.int(10, 20); i++) {
      const x = cx + rng.range(-0.5, 0.5);
      const zz = z + rng.range(-0.35, 0.35);
      const blade = new THREE.Mesh(oatGeo, oatMat);
      blade.position.set(x, groundHeight(x, zz), zz);
      blade.rotation.set(rng.range(-0.24, 0.24), rng.range(0, Math.PI), rng.range(-0.3, 0.3));
      blade.scale.setScalar(rng.range(0.7, 1.4));
      blade.castShadow = true;
      oats.add(blade);
    }
  }
  g.add(bakeChunked(oats, (o) => Math.floor(o.position.z / 40)));

  return { group: g };
}

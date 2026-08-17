import * as THREE from 'three';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import { palm } from './props';
import { groundHeight, beachEdgeAt, PARK_EDGE, STRIP_MIN_Z, STRIP_MAX_Z } from './layout';

/**
 * The green belt between the sand and the promenade — Lummus Park in all but
 * name: a wandering tree line along the curved beach edge, a serpentine path,
 * and a small park with an outdoor gym and a basketball court.
 *
 * The boundary itself is `beachEdgeAt(z)` in layout.ts. Everything here is
 * planted relative to that curve, so the greenery follows the coastline rather
 * than sitting in a straight band.
 */

const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6f5a44, roughness: 0.92 });
const leafMat = new THREE.MeshStandardMaterial({
  color: 0x4f7a38,
  roughness: 0.85,
  side: THREE.DoubleSide,
});
const leafLight = new THREE.MeshStandardMaterial({
  color: 0x67944a,
  roughness: 0.85,
  side: THREE.DoubleSide,
});
const pathMat = new THREE.MeshStandardMaterial({ color: 0xb8ada0, roughness: 0.95 });
const benchWood = new THREE.MeshStandardMaterial({ color: 0x9c7a4e, roughness: 0.85 });
const steel = new THREE.MeshStandardMaterial({
  color: 0x3a3f45,
  roughness: 0.45,
  metalness: 0.75,
});
const rubberMat = new THREE.MeshStandardMaterial({ color: 0x2b3138, roughness: 0.95 });
const courtMat = new THREE.MeshStandardMaterial({ color: 0x2f6f8f, roughness: 0.9 });

/**
 * A broadleaf shade tree — sea grape / ficus. Palms alone read as a resort;
 * the reference has real canopy behind the beach.
 */
export function shadeTree(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const h = rng.range(3.6, 6.4);

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(h * 0.035, h * 0.06, h * 0.55, 7),
    trunkMat,
  );
  trunk.position.y = h * 0.275;
  trunk.castShadow = true;
  g.add(trunk);

  // Canopy from overlapping blobs, so the silhouette isn't a single sphere.
  const blobs = rng.int(4, 7);
  for (let i = 0; i < blobs; i++) {
    const r = h * rng.range(0.2, 0.34);
    const blob = new THREE.Mesh(
      new THREE.SphereGeometry(r, 8, 6),
      rng.chance(0.5) ? leafMat : leafLight,
    );
    const a = (i / blobs) * Math.PI * 2 + rng.range(-0.4, 0.4);
    const d = h * rng.range(0.05, 0.22);
    blob.position.set(
      Math.cos(a) * d,
      h * rng.range(0.6, 0.82),
      Math.sin(a) * d,
    );
    blob.scale.y = rng.range(0.7, 0.95);
    blob.castShadow = true;
    blob.receiveShadow = true;
    g.add(blob);
  }
  return g;
}

/** Bench with slatted seat and cast ends. */
function bench(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.05, 0.11), benchWood);
    slat.position.set(0, 0.45, -0.18 + i * 0.13);
    slat.castShadow = true;
    g.add(slat);
  }
  for (let i = 0; i < 3; i++) {
    const slat = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.11, 0.05), benchWood);
    slat.position.set(0, 0.62 + i * 0.14, -0.28);
    slat.castShadow = true;
    g.add(slat);
  }
  for (const s of [-1, 1]) {
    const end = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.45, 0.62), steel);
    end.position.set(s * 0.85, 0.22, -0.06);
    end.castShadow = true;
    g.add(end);
  }
  return g;
}

/** Muscle-Beach style outdoor gym: rigs, benches, plates. */
function outdoorGym(rng: Rng): THREE.Group {
  const g = new THREE.Group();

  // Pull-up rig.
  const rigW = 5.2;
  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.5, 8), steel);
    post.position.set(s * rigW * 0.5, 1.25, 0);
    post.castShadow = true;
    g.add(post);
    const post2 = post.clone();
    post2.position.z = -1.6;
    g.add(post2);
  }
  for (const z of [0, -1.6]) {
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, rigW, 8), steel);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, 2.45, z);
    bar.castShadow = true;
    g.add(bar);
  }
  // Monkey bars between the two beams.
  for (let i = 0; i <= 5; i++) {
    const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 1.6, 6), steel);
    rung.rotation.x = Math.PI / 2;
    rung.position.set(-rigW / 2 + (i * rigW) / 5, 2.45, -0.8);
    g.add(rung);
  }

  // Weight benches with loaded bars.
  for (let b = 0; b < 2; b++) {
    const bx = rng.range(-3, 3);
    const bz = 2.6 + b * 2.2;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.16, 1.5), rubberMat);
    pad.position.set(bx, 0.5, bz);
    pad.castShadow = true;
    g.add(pad);
    for (const s of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.42, 0.08), steel);
      leg.position.set(bx, 0.21, bz + s * 0.6);
      g.add(leg);
    }
    // Uprights and a bar with plates.
    for (const s of [-1, 1]) {
      const up = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.1, 8), steel);
      up.position.set(bx + s * 0.55, 0.55, bz - 0.55);
      g.add(up);
    }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.0, 8), steel);
    bar.rotation.z = Math.PI / 2;
    bar.position.set(bx, 1.12, bz - 0.55);
    bar.castShadow = true;
    g.add(bar);
    for (const s of [-1, 1]) {
      const plateMat = new THREE.MeshStandardMaterial({
        color: rng.pick([0x2f7a3f, 0x1f4f9f, 0xb42a2a, 0x1b1d20]),
        roughness: 0.7,
      });
      for (let p = 0; p < 2; p++) {
        const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.05, 16), plateMat);
        plate.rotation.z = Math.PI / 2;
        plate.position.set(bx + s * (0.72 + p * 0.07), 1.12, bz - 0.55);
        plate.castShadow = true;
        g.add(plate);
      }
    }
  }

  // Loose plates on the ground.
  for (let i = 0; i < 5; i++) {
    const plate = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, 0.05, 16),
      new THREE.MeshStandardMaterial({ color: rng.pick([0x2f7a3f, 0x1f4f9f, 0x1b1d20]), roughness: 0.7 }),
    );
    plate.position.set(rng.range(-4, 4), 0.03, rng.range(-2, 6));
    plate.rotation.x = Math.PI / 2;
    plate.castShadow = true;
    g.add(plate);
  }

  return g;
}

/** Half-court with hoops at each end. */
function basketballCourt(): THREE.Group {
  const g = new THREE.Group();
  const w = 15;
  const d = 24;

  const surface = new THREE.Mesh(new THREE.PlaneGeometry(w, d), courtMat);
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.02;
  surface.receiveShadow = true;
  g.add(surface);

  const lineMat = new THREE.MeshStandardMaterial({ color: 0xe8e4d8, roughness: 0.85 });
  const line = (lw: number, ld: number, x: number, z: number) => {
    const l = new THREE.Mesh(new THREE.PlaneGeometry(lw, ld), lineMat);
    l.rotation.x = -Math.PI / 2;
    l.position.set(x, 0.03, z);
    g.add(l);
  };
  line(w - 1, 0.12, 0, 0);
  line(0.12, d - 1, 0, 0);
  for (const s of [-1, 1]) line(w - 1, 0.12, 0, s * (d / 2 - 0.6));

  for (const s of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 3.6, 8), steel);
    post.position.set(0, 1.8, s * (d / 2 - 0.4));
    post.castShadow = true;
    g.add(post);
    const board = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.05, 0.06), lineMat);
    board.position.set(0, 3.4, s * (d / 2 - 1.1));
    board.castShadow = true;
    g.add(board);
    const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.025, 6, 16), new THREE.MeshStandardMaterial({ color: 0xd8622a, roughness: 0.5, metalness: 0.6 }));
    hoop.rotation.x = Math.PI / 2;
    hoop.position.set(0, 3.05, s * (d / 2 - 1.4));
    g.add(hoop);
  }
  return g;
}

/* ------------------------------------------------------------- assembly */

export function buildPark(colliders: Colliders): THREE.Group {
  const g = new THREE.Group();
  g.name = 'park';
  const rng = new Rng(31415);

  const zMin = STRIP_MIN_Z - 120;
  const zMax = STRIP_MAX_Z + 120;

  /* ------------------------------------------------------- the tree line */

  // Palms and shade trees following the curved sand boundary, drifting inland
  // and seaward with it.
  for (let z = zMin; z < zMax; z += rng.range(3.4, 7.5)) {
    const edge = beachEdgeAt(z);

    // Two loose rows: palms right on the boundary, canopy trees set back.
    if (rng.chance(0.72)) {
      const x = edge + rng.range(0.5, 4.5);
      const { group } = palm(rng, rng.range(7, 12));
      group.position.set(x, groundHeight(x, z), z);
      group.rotation.y = rng.range(0, Math.PI * 2);
      g.add(group);
      colliders.addCircle(x, z, 0.42);
    }

    if (rng.chance(0.55)) {
      const x = edge + rng.range(4, 13);
      if (x < PARK_EDGE - 1) {
        const t = shadeTree(rng);
        t.position.set(x, groundHeight(x, z), z);
        t.rotation.y = rng.range(0, Math.PI * 2);
        g.add(t);
        colliders.addCircle(x, z, 0.5, 2.2);
      }
    }
  }

  /* ---------------------------------------------------------- the path */

  // A serpentine walkway weaving through the green belt.
  const pathGeo = new THREE.PlaneGeometry(1, 1, 1, 220);
  pathGeo.rotateX(-Math.PI / 2);
  const pp = pathGeo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pp.count; i++) {
    const t = pp.getZ(i) + 0.5;
    const z = THREE.MathUtils.lerp(zMin, zMax, t);
    // Centre of the belt, wandering on its own rhythm.
    const mid = (beachEdgeAt(z) + PARK_EDGE) / 2 + Math.sin(z * 0.043) * 2.6;
    const half = 1.5;
    const x = mid + pp.getX(i) * 2 * half;
    pp.setXYZ(i, x, groundHeight(x, z) + 0.03, z);
  }
  pp.needsUpdate = true;
  pathGeo.computeVertexNormals();
  const path = new THREE.Mesh(pathGeo, pathMat);
  path.receiveShadow = true;
  g.add(path);

  // Benches facing the sea, beside the path.
  for (let z = zMin + 12; z < zMax; z += rng.range(22, 40)) {
    const mid = (beachEdgeAt(z) + PARK_EDGE) / 2 + Math.sin(z * 0.043) * 2.6;
    const x = mid - 2.6;
    const b = bench();
    b.position.set(x, groundHeight(x, z), z);
    // Backrest inland, so you sit looking at the water.
    b.rotation.y = -Math.PI / 2;
    g.add(b);
    colliders.addBoxAt(x, z, 0.8, 2.0, 0.7);
  }

  /* ------------------------------------------------- the park proper */

  // Outdoor gym on the sand side, as in the reference.
  {
    const z = -62;
    const x = beachEdgeAt(z) - 7;
    const gym = outdoorGym(rng);
    gym.position.set(x, groundHeight(x, z), z);
    gym.rotation.y = 0.3;
    g.add(gym);
    colliders.addBoxAt(x, z, 7, 9, 2.4);
  }

  // Basketball court set into the green belt.
  {
    const z = 86;
    const x = (beachEdgeAt(z) + PARK_EDGE) / 2 - 1;
    const court = basketballCourt();
    court.position.set(x, groundHeight(x, z), z);
    g.add(court);
    colliders.addBoxAt(x, z, 15, 24, 0.05);
  }

  return g;
}

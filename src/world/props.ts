import * as THREE from 'three';
import * as T from '../render/textures';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import { ROAD_HALF, CURB_H, CROSS_Z, CROSS_HALF, STRIP_MIN_Z, STRIP_MAX_Z } from './layout';

/* ------------------------------------------------------------------ palms */

let frondGeo: THREE.PlaneGeometry | null = null;
let frondMat: THREE.MeshStandardMaterial | null = null;
let barkMat: THREE.MeshStandardMaterial | null = null;

/**
 * A frond that arches: flat quads read as spiky agave leaves, and the downward
 * curve along the rachis is most of what makes a palm look like a palm.
 */
function curvedFrond(width: number, length: number): THREE.PlaneGeometry {
  const geo = new THREE.PlaneGeometry(width, length, 3, 10);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    // 0 at the base, 1 at the tip. Clamped because the bottom row lands on
    // exactly -length/2 and float error can push t microscopically negative,
    // which makes Math.pow(t, 1.85) return NaN and poisons the whole geometry.
    const t = Math.max(0, Math.min(1, (pos.getY(i) + length / 2) / length));
    const arch = Math.pow(t, 1.85);
    // Sweep back and down toward the tip...
    pos.setZ(i, -arch * length * 0.42);
    pos.setY(i, pos.getY(i) - arch * length * 0.2);
    // ...and fold the two halves down about the rachis into a shallow V.
    pos.setZ(i, pos.getZ(i) - Math.abs(x) * 0.28 * (0.35 + t));
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function palmAssets() {
  if (!frondGeo) {
    frondGeo = curvedFrond(2.6, 4.8);
    // Pivot at the base of the frond so it swings from the crown.
    frondGeo.translate(0, 2.4, 0);

    const { map, alphaMap } = T.frondAlpha();
    frondMat = new THREE.MeshStandardMaterial({
      map,
      alphaMap,
      transparent: false,
      alphaTest: 0.3,
      side: THREE.DoubleSide,
      roughness: 0.66,
      metalness: 0,
      color: 0xc4d67f,
    });

    const bark = T.asColor(T.palmBark());
    bark.map.repeat.set(2, 5);
    bark.normalMap.repeat.set(2, 5);
    bark.roughnessMap.repeat.set(2, 5);
    barkMat = new THREE.MeshStandardMaterial({
      ...bark,
      normalScale: new THREE.Vector2(1.3, 1.3),
      roughness: 1,
      metalness: 0,
    });
  }
  return { frondGeo: frondGeo!, frondMat: frondMat!, barkMat: barkMat! };
}

/** A leaning coconut palm. Returns the group plus its frond meshes for wind. */
export function palm(rng: Rng, height = 9): { group: THREE.Group; fronds: THREE.Mesh[] } {
  const a = palmAssets();
  const g = new THREE.Group();

  // Curved trunk swept along a spline — palms are never straight.
  const lean = rng.range(0.6, 2.1) * (rng.chance(0.5) ? 1 : -1);
  const leanAxis = rng.range(0, Math.PI * 2);
  const pts: THREE.Vector3[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const bend = Math.pow(t, 1.9) * lean;
    pts.push(
      new THREE.Vector3(
        Math.cos(leanAxis) * bend,
        t * height,
        Math.sin(leanAxis) * bend,
      ),
    );
  }
  const curve = new THREE.CatmullRomCurve3(pts);
  const trunk = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 20, 1, 10, false).scale(1, 1, 1),
    a.barkMat,
  );
  // Taper: shrink the tube radius from base to crown.
  {
    const pos = trunk.geometry.attributes.position as THREE.BufferAttribute;
    const tubular = 21;
    const radial = 11;
    const v = new THREE.Vector3();
    for (let i = 0; i < tubular; i++) {
      const t = i / (tubular - 1);
      const r = THREE.MathUtils.lerp(0.26, 0.175, Math.pow(t, 0.7));
      const c = curve.getPoint(t);
      for (let j = 0; j < radial; j++) {
        const idx = i * radial + j;
        v.fromBufferAttribute(pos, idx).sub(c).normalize().multiplyScalar(r).add(c);
        pos.setXYZ(idx, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    trunk.geometry.computeVertexNormals();
  }
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  // Crown.
  const top = curve.getPoint(1);
  const crown = new THREE.Group();
  crown.position.copy(top);
  g.add(crown);

  const fronds: THREE.Mesh[] = [];
  const n = rng.int(16, 21);
  for (let i = 0; i < n; i++) {
    const f = new THREE.Mesh(a.frondGeo, a.frondMat);
    const az = (i / n) * Math.PI * 2 + rng.range(-0.2, 0.2);
    // Crown layers: a few young spears near vertical, most of the canopy
    // spread wide, and the oldest fronds hanging below the horizontal.
    const rank = i / n;
    const droop = THREE.MathUtils.degToRad(
      rank < 0.18 ? rng.range(8, 34) : rank < 0.7 ? rng.range(52, 88) : rng.range(88, 116),
    );
    f.rotation.order = 'YXZ';
    f.rotation.y = az;
    f.rotation.x = droop;
    f.rotation.z = rng.range(-0.2, 0.2);
    f.scale.setScalar(rng.range(0.82, 1.18));
    f.castShadow = true;
    f.receiveShadow = true;
    crown.add(f);
    fronds.push(f);
  }

  // Coconut cluster and shag of dead fronds at the crown base.
  for (let i = 0; i < rng.int(3, 6); i++) {
    const nut = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), NUT_MAT);
    const a2 = rng.range(0, Math.PI * 2);
    nut.position.set(
      top.x + Math.cos(a2) * 0.26,
      top.y - rng.range(0.1, 0.3),
      top.z + Math.sin(a2) * 0.26,
    );
    nut.castShadow = true;
    g.add(nut);
  }

  return { group: g, fronds };
}

/* ---------------------------------------------------------------- signage */

/** The yellow diagonal-arrow warning sign from the reference shot. */
function arrowSign(): THREE.Mesh {
  const px = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = px;
  const ctx = cv.getContext('2d')!;

  ctx.fillStyle = '#e8b524';
  ctx.beginPath();
  ctx.roundRect(4, 4, px - 8, px - 8, 16);
  ctx.fill();
  ctx.strokeStyle = '#1a1a18';
  ctx.lineWidth = 6;
  ctx.stroke();

  // Thick down-right arrow.
  ctx.fillStyle = '#141412';
  ctx.save();
  ctx.translate(px / 2, px / 2);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-24, -84, 48, 112);
  ctx.beginPath();
  ctx.moveTo(-72, 20);
  ctx.lineTo(72, 20);
  ctx.lineTo(0, 100);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.78),
    new THREE.MeshStandardMaterial({
      map: tex,
      roughness: 0.42,
      metalness: 0.1,
      side: THREE.DoubleSide,
    }),
  );
  m.castShadow = true;
  return m;
}

const poleMat = new THREE.MeshStandardMaterial({
  color: 0x9a9a96,
  roughness: 0.42,
  metalness: 0.9,
});

/**
 * Shared bodies for everything below.
 *
 * These all used to be built inside the function that placed the prop, which
 * looks harmless and is not: `bakeStatic` buckets by material *identity*, so a
 * fresh material per palm or per café table stops the bake merging any of them
 * and costs a draw call each. The coconuts alone were 325 copies of the same
 * brown, in three different modules, because they all build their palms here.
 */
const NUT_MAT = new THREE.MeshStandardMaterial({ color: 0x7d6a48, roughness: 0.8 });
const PIT_MAT = new THREE.MeshStandardMaterial({ color: 0x8d7f72, roughness: 0.95 });
const CAFE_METAL = new THREE.MeshStandardMaterial({
  color: 0x2e2c2a,
  roughness: 0.45,
  metalness: 0.7,
});
const CAFE_TOP = new THREE.MeshStandardMaterial({
  color: 0xe9e2d4,
  roughness: 0.35,
  metalness: 0.05,
});
const CAFE_SEAT = new THREE.MeshStandardMaterial({
  color: 0xd8cdb8,
  roughness: 0.7,
  metalness: 0.05,
});
const SIGNAL_SHELL = new THREE.MeshStandardMaterial({
  color: 0x1e2a24,
  roughness: 0.6,
  metalness: 0.2,
});

function signPost(height: number): THREE.Mesh {
  const p = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.062, height, 10), poleMat);
  p.position.y = height / 2;
  p.castShadow = true;
  p.receiveShadow = true;
  return p;
}

/* ------------------------------------------------------------ café tables */

function cafeSet(rng: Rng, umbrellaColor: number, parasol: boolean): THREE.Group {
  const g = new THREE.Group();

  const metal = CAFE_METAL;
  const topMat = CAFE_TOP;

  const table = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 20), topMat);
  table.position.y = 0.74;
  table.castShadow = true;
  table.receiveShadow = true;
  g.add(table);

  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 0.74, 10), metal);
  stem.position.y = 0.37;
  stem.castShadow = true;
  g.add(stem);

  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.28, 0.03, 16), metal);
  foot.position.y = 0.015;
  foot.receiveShadow = true;
  g.add(foot);

  // Chairs.
  const seatMat = CAFE_SEAT;
  for (let i = 0; i < 2; i++) {
    const a = rng.range(0, Math.PI * 2) + i * Math.PI;
    const c = new THREE.Group();
    c.position.set(Math.cos(a) * 0.78, 0, Math.sin(a) * 0.78);
    c.rotation.y = -a + Math.PI / 2;

    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 0.42), seatMat);
    seat.position.y = 0.44;
    seat.castShadow = true;
    seat.receiveShadow = true;
    c.add(seat);

    const back = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.5, 0.05), seatMat);
    back.position.set(0, 0.69, -0.19);
    back.castShadow = true;
    c.add(back);

    for (const [dx, dz] of [
      [-0.17, -0.17],
      [0.17, -0.17],
      [-0.17, 0.17],
      [0.17, 0.17],
    ]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.44, 6), metal);
      leg.position.set(dx, 0.22, dz);
      leg.castShadow = true;
      c.add(leg);
    }
    g.add(c);
  }

  // Parasol.
  if (parasol) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 2.45, 8), metal);
    pole.position.y = 1.22;
    pole.castShadow = true;
    g.add(pole);

    const canopyMat = parasolMat(umbrellaColor);

    // Octagonal canopy with a slight droop at the ribs, plus a valance skirt.
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.06, 0.4, 8, 1, true), canopyMat);
    canopy.position.y = 2.2;
    canopy.castShadow = true;
    canopy.receiveShadow = true;
    g.add(canopy);

    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(1.06, 1.04, 0.14, 8, 1, true),
      canopyMat,
    );
    skirt.position.y = 1.87;
    skirt.castShadow = true;
    g.add(skirt);

    const finial = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 6), metal);
    finial.position.y = 2.5;
    g.add(finial);
  }

  return g;
}

// Parasol fabric is shared per colour; each one minting its own material would
// defeat the material-merge in the bake pass.
const parasolCache = new Map<number, THREE.MeshStandardMaterial>();

function parasolMat(color: number): THREE.MeshStandardMaterial {
  let m = parasolCache.get(color);
  if (!m) {
    const fabric = T.asColor(T.awningFabric(3));
    m = new THREE.MeshStandardMaterial({
      ...fabric,
      color,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    parasolCache.set(color, m);
  }
  return m;
}

/* --------------------------------------------------------------- assembly */

/**
 * Every frond in the city drawn as one InstancedMesh. Around 800 of them would
 * otherwise be 800 draw calls in the main pass and 800 more in the shadow pass.
 * Wind is applied by rewriting the instance matrices each frame, which is a few
 * hundred microseconds of CPU and buys a completely static-free canopy.
 */
export class FrondField {
  readonly mesh: THREE.InstancedMesh;

  private pos: THREE.Vector3[] = [];
  private quat: THREE.Quaternion[] = [];
  private scale: number[] = [];
  private phase: number[] = [];

  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private s = new THREE.Vector3();

  constructor(samples: Array<{ matrix: THREE.Matrix4; phase: number }>) {
    const a = palmAssets();
    this.mesh = new THREE.InstancedMesh(a.frondGeo, a.frondMat, samples.length);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;

    for (const { matrix, phase } of samples) {
      const p = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      matrix.decompose(p, q, s);
      this.pos.push(p);
      this.quat.push(q);
      this.scale.push(s.x);
      this.phase.push(phase);
    }
    this.update(0);
  }

  update(t: number): void {
    const n = this.pos.length;
    for (let i = 0; i < n; i++) {
      const ph = this.phase[i];
      // Two detuned oscillators so the canopy never pulses in unison.
      const a = Math.sin(t * 1.15 + ph) * 0.07 + Math.sin(t * 2.6 + ph * 1.7) * 0.028;
      const b = Math.sin(t * 1.7 + ph * 0.8) * 0.055;
      this.e.set(a, 0, b);
      // Applied after the rest orientation, i.e. in the frond's own frame.
      this.q.copy(this.quat[i]).multiply(new THREE.Quaternion().setFromEuler(this.e));
      this.s.setScalar(this.scale[i]);
      this.mesh.setMatrixAt(i, this.m.compose(this.pos[i], this.q, this.s));
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

export interface PropsResult {
  /** Static dressing, safe to bake. */
  group: THREE.Group;
  fronds: FrondField;
}

export function buildProps(colliders: Colliders): PropsResult {
  const g = new THREE.Group();
  g.name = 'props';
  const rng = new Rng(555);
  const frondSamples: Array<{ matrix: THREE.Matrix4; phase: number }> = [];

  const addPalm = (x: number, z: number, h: number) => {
    const { group, fronds } = palm(rng, h);
    group.position.set(x, CURB_H, z);
    group.rotation.y = rng.range(0, Math.PI * 2);
    g.add(group);
    colliders.addCircle(x, z, 0.42);

    // Lift the fronds out of the hierarchy into the instanced field, keeping
    // the world transform the crown gave them.
    group.updateMatrixWorld(true);
    for (const f of fronds) {
      frondSamples.push({
        matrix: f.matrixWorld.clone(),
        phase: rng.range(0, Math.PI * 2),
      });
      f.removeFromParent();
    }
    // Tree pit ring in the pavement.
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.85, 20), PIT_MAT);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, CURB_H + 0.005, z);
    ring.receiveShadow = true;
    g.add(ring);
  };

  // Palms line both kerbs at a regular rhythm, skipping the junction.
  for (let z = STRIP_MIN_Z + 10; z < STRIP_MAX_Z; z += 12) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 4) continue;
    addPalm(ROAD_HALF + 1.5, z + rng.range(-0.8, 0.8), rng.range(6.5, 9.5));
    addPalm(-ROAD_HALF - 1.5, z + rng.range(-0.8, 0.8) + 6, rng.range(6, 9));
  }

  // Taller palms set back on the promenade.
  for (let z = STRIP_MIN_Z + 24; z < STRIP_MAX_Z; z += 26) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 6) continue;
    addPalm(ROAD_HALF + 6.4, z, rng.range(8.5, 11.5));
  }

  /* ------------------------------------------------------------- signage */

  // Hero sign on the corner, matching the reference framing.
  {
    const post = signPost(3.5);
    const grp = new THREE.Group();
    grp.add(post);
    const s = arrowSign();
    s.position.set(0, 2.85, 0.06);
    grp.add(s);
    grp.position.set(ROAD_HALF + 0.9, CURB_H, CROSS_Z - CROSS_HALF - 2.6);
    grp.rotation.y = -Math.PI / 2;
    g.add(grp);
    colliders.addCircle(ROAD_HALF + 0.9, CROSS_Z - CROSS_HALF - 2.6, 0.16, 2.0);
  }

  // Traffic signals at the junction.
  const lensMat = (c: number, on: boolean) =>
    new THREE.MeshStandardMaterial({
      color: c,
      emissive: on ? c : 0x000000,
      emissiveIntensity: on ? 2.4 : 0,
      roughness: 0.3,
    });

  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const grp = new THREE.Group();
      const mast = signPost(4.6);
      grp.add(mast);

      const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4.4, 8), poleMat);
      arm.rotation.z = Math.PI / 2;
      arm.position.set(2.2, 4.5, 0);
      arm.castShadow = true;
      grp.add(arm);

      const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.86, 0.3), SIGNAL_SHELL);
      head.position.set(4.1, 4.1, 0);
      head.castShadow = true;
      grp.add(head);

      const states: Array<[number, boolean, number]> = [
        [0xd8342a, false, 0.3],
        [0xd8a12a, false, 0],
        [0x36c45a, true, -0.3],
      ];
      for (const [c, on, dy] of states) {
        const lens = new THREE.Mesh(new THREE.CircleGeometry(0.1, 14), lensMat(c, on));
        lens.position.set(4.1, 4.1 + dy, 0.16);
        grp.add(lens);
      }

      const x = sx * (ROAD_HALF + 1.1);
      const z = CROSS_Z + sz * (CROSS_HALF + 1.1);
      grp.position.set(x, CURB_H, z);
      grp.rotation.y = sx > 0 ? (sz > 0 ? Math.PI : Math.PI / 2) : sz > 0 ? -Math.PI / 2 : 0;
      g.add(grp);
      colliders.addCircle(x, z, 0.18, 2.0);
    }
  }

  /* ------------------------------------------------------- street fitting */

  const meterMat = new THREE.MeshStandardMaterial({
    color: 0x3c4a52,
    roughness: 0.45,
    metalness: 0.6,
  });
  for (let z = STRIP_MIN_Z + 16; z < STRIP_MAX_Z; z += 18) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 4) continue;
    for (const side of [-1, 1]) {
      const grp = new THREE.Group();
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.25, 8), poleMat);
      p.position.y = 0.62;
      p.castShadow = true;
      grp.add(p);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.32, 0.12), meterMat);
      head.position.y = 1.38;
      head.castShadow = true;
      grp.add(head);
      grp.position.set(side * (ROAD_HALF + 0.75), CURB_H, z);
      g.add(grp);
      colliders.addCircle(side * (ROAD_HALF + 0.75), z, 0.14, 1.1);
    }
  }

  // Bins and planters along the promenade.
  const binMat = new THREE.MeshStandardMaterial({
    color: 0x4a4640,
    roughness: 0.6,
    metalness: 0.35,
  });
  const soilMat = new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x4e7a37, roughness: 0.8 });
  const planterMat = new THREE.MeshStandardMaterial({ color: 0xd9cdbb, roughness: 0.9 });

  for (let z = STRIP_MIN_Z + 30; z < STRIP_MAX_Z; z += 34) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 6) continue;

    const bin = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.3, 0.95, 14), binMat);
    bin.position.set(ROAD_HALF + 2.3, CURB_H + 0.47, z);
    bin.castShadow = true;
    bin.receiveShadow = true;
    g.add(bin);
    colliders.addCircle(ROAD_HALF + 2.3, z, 0.36, 0.95);

    const pz = z + 12;
    if (Math.abs(pz - CROSS_Z) > CROSS_HALF + 6 && pz < STRIP_MAX_Z) {
      const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.5, 0.72, 16), planterMat);
      pot.position.set(ROAD_HALF + 2.6, CURB_H + 0.36, pz);
      pot.castShadow = true;
      pot.receiveShadow = true;
      g.add(pot);

      const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.56, 0.06, 16), soilMat);
      soil.position.set(ROAD_HALF + 2.6, CURB_H + 0.72, pz);
      g.add(soil);

      for (let i = 0; i < 7; i++) {
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.09, rng.range(0.7, 1.3), 5), leafMat);
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(0, 0.36);
        blade.position.set(
          ROAD_HALF + 2.6 + Math.cos(a) * r,
          CURB_H + 1.15,
          pz + Math.sin(a) * r,
        );
        blade.rotation.z = rng.range(-0.35, 0.35);
        blade.rotation.x = rng.range(-0.35, 0.35);
        blade.castShadow = true;
        g.add(blade);
      }
      colliders.addCircle(ROAD_HALF + 2.6, pz, 0.64, 0.75);
    }
  }

  /* ------------------------------------------------ hotel café frontage */

  // A continuous run of terrace tables and coral parasols along every awninged
  // frontage — in the reference this row, not the buildings, is what reads.
  const umbrellaColors = [0xd9736f, 0xe0857f, 0xcf6f6b, 0xd8695f];
  const terraces: Array<[number, number, number]> = [
    // [zStart, zEnd, x]
    [-16, 16, 13.3], // Dominion
    [-48, -19, 13.1], // Colony
    [-82, -51, 13.0],
    [42, 71, 13.1], // Avalon
    [18, 27, 13.6], // corner shop
  ];

  for (const [z0, z1, baseX] of terraces) {
    for (let z = z0; z <= z1; z += 3.3) {
      const x = baseX + rng.range(-0.35, 0.35);
      const set = cafeSet(rng, rng.pick(umbrellaColors), rng.chance(0.62));
      set.position.set(x, CURB_H, z + rng.range(-0.3, 0.3));
      set.rotation.y = rng.range(0, Math.PI * 2);
      g.add(set);
      colliders.addCircle(x, z, 0.48, 0.8);
    }
  }

  // Velvet rope and stanchions at the hotel entrance.
  const ropeMat = new THREE.MeshStandardMaterial({ color: 0x8c2b3a, roughness: 0.85 });
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xb8912f,
    roughness: 0.3,
    metalness: 0.9,
  });
  for (let i = 0; i < 4; i++) {
    const z = -3.6 + i * 2.4;
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.11, 1.0, 12), brassMat);
    st.position.set(11.0, CURB_H + 0.5, z);
    st.castShadow = true;
    g.add(st);
    if (i < 3) {
      // A catenary between posts. A torus here lies flat on the ground instead
      // of hanging, which is exactly as wrong as it sounds.
      const a = new THREE.Vector3(11.0, CURB_H + 0.86, z);
      const b = new THREE.Vector3(11.0, CURB_H + 0.86, z + 2.4);
      const sag = new THREE.Vector3().lerpVectors(a, b, 0.5).setY(CURB_H + 0.62);
      const rope = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, sag, b]), 12, 0.017, 6, false),
        ropeMat,
      );
      rope.castShadow = true;
      g.add(rope);
    }
  }

  addDressing(g, colliders, rng);

  return { group: g, fronds: new FrondField(frondSamples) };
}

/* --------------------------------------------------------------- dressing */

/**
 * The small stuff: hydrants, bike racks, news boxes, A-boards, gutter weeds and
 * litter. Individually trivial, collectively the difference between a street
 * and an architectural render of a street.
 */
function addDressing(g: THREE.Group, colliders: Colliders, rng: Rng): void {
  const hydrantMat = new THREE.MeshStandardMaterial({
    color: 0xc4342a,
    roughness: 0.55,
    metalness: 0.25,
  });
  const steel = new THREE.MeshStandardMaterial({
    color: 0x8e9298,
    roughness: 0.4,
    metalness: 0.85,
  });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0x3a2c22, roughness: 0.85 });
  const paperMat = new THREE.MeshStandardMaterial({ color: 0xe8e2d4, roughness: 0.9 });
  const weedMat = new THREE.MeshStandardMaterial({
    color: 0x5d7a33,
    roughness: 0.9,
    side: THREE.DoubleSide,
  });
  const litterMats = [
    new THREE.MeshStandardMaterial({ color: 0xd9d4c8, roughness: 0.9 }),
    new THREE.MeshStandardMaterial({ color: 0xb8352c, roughness: 0.85 }),
    new THREE.MeshStandardMaterial({ color: 0x3f6ba8, roughness: 0.85 }),
  ];

  /* ------------------------------------------------------------ hydrants */

  for (let z = STRIP_MIN_Z + 26; z < STRIP_MAX_Z; z += 42) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 5) continue;
    const x = ROAD_HALF + 1.05;
    const grp = new THREE.Group();

    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.13, 0.56, 12), hydrantMat);
    body.position.y = 0.28;
    grp.add(body);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.115, 12, 8), hydrantMat);
    dome.position.y = 0.56;
    dome.scale.y = 0.7;
    grp.add(dome);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.09, 8), hydrantMat);
    cap.position.y = 0.66;
    grp.add(cap);
    for (const s of [-1, 1]) {
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 8), hydrantMat);
      nozzle.rotation.z = Math.PI / 2;
      nozzle.position.set(s * 0.13, 0.36, 0);
      grp.add(nozzle);
    }
    grp.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
    grp.position.set(x, CURB_H, z);
    g.add(grp);
    colliders.addCircle(x, z, 0.2, 0.7);
  }

  /* ---------------------------------------------------------- bike racks */

  for (let z = STRIP_MIN_Z + 44; z < STRIP_MAX_Z; z += 56) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 6) continue;
    for (let k = 0; k < 3; k++) {
      const zz = z + k * 0.85;
      // Inverted-U stand.
      const hoop = new THREE.Mesh(
        new THREE.TorusGeometry(0.34, 0.028, 6, 14, Math.PI),
        steel,
      );
      hoop.position.set(ROAD_HALF + 3.4, CURB_H + 0.42, zz);
      hoop.rotation.y = Math.PI / 2;
      hoop.castShadow = true;
      g.add(hoop);
      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.44, 6), steel);
        leg.position.set(ROAD_HALF + 3.4, CURB_H + 0.22, zz + s * 0.34);
        leg.castShadow = true;
        g.add(leg);
      }
    }
    colliders.addBoxAt(ROAD_HALF + 3.4, z + 0.85, 0.8, 3.0, 0.75);
  }

  /* ---------------------------------------------------------- news boxes */

  const newsColors = [0x2f6fb0, 0xc4442e, 0x3f8f5a, 0xd8a832];
  for (let z = STRIP_MIN_Z + 38; z < STRIP_MAX_Z; z += 47) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 5) continue;
    for (let k = 0; k < 2; k++) {
      const x = ROAD_HALF + 1.5;
      const zz = z + k * 0.62;
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.44, 0.78, 0.52),
        new THREE.MeshStandardMaterial({
          color: newsColors[(k + z) % newsColors.length | 0] ?? 0x2f6fb0,
          roughness: 0.5,
          metalness: 0.3,
        }),
      );
      box.position.set(x, CURB_H + 0.52, zz);
      box.castShadow = true;
      box.receiveShadow = true;
      g.add(box);

      const win = new THREE.Mesh(new THREE.PlaneGeometry(0.3, 0.3), paperMat);
      win.position.set(x - 0.225, CURB_H + 0.7, zz);
      win.rotation.y = -Math.PI / 2;
      g.add(win);

      for (const s of [-1, 1]) {
        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.26, 6), steel);
        leg.position.set(x + s * 0.15, CURB_H + 0.13, zz);
        g.add(leg);
      }
    }
    colliders.addBoxAt(ROAD_HALF + 1.5, z + 0.31, 0.5, 1.3, 0.85);
  }

  /* ------------------------------------------------------------ A-boards */

  for (let z = STRIP_MIN_Z + 30; z < STRIP_MAX_Z; z += 33) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 5) continue;
    const x = 13.6 + rng.range(-0.3, 0.3);
    for (const s of [-1, 1]) {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.85, 0.62), boardMat);
      panel.position.set(x + s * 0.13, CURB_H + 0.46, z);
      panel.rotation.z = s * 0.28;
      panel.castShadow = true;
      panel.receiveShadow = true;
      g.add(panel);
    }
    colliders.addCircle(x, z, 0.35, 0.9);
  }

  /* -------------------------------------------------- gutter weeds/litter */

  // Tufts growing where the kerb meets the asphalt, straight out of the ref.
  for (let z = STRIP_MIN_Z; z < STRIP_MAX_Z; z += 1.4) {
    if (!rng.chance(0.4)) continue;
    const side = rng.chance(0.5) ? 1 : -1;
    const x = side * (ROAD_HALF - 0.06) + rng.range(-0.06, 0.06);
    const n = rng.int(3, 6);
    for (let i = 0; i < n; i++) {
      const blade = new THREE.Mesh(
        new THREE.PlaneGeometry(rng.range(0.02, 0.045), rng.range(0.1, 0.26)),
        weedMat,
      );
      const h = blade.geometry.parameters.height;
      blade.position.set(x + rng.range(-0.07, 0.07), h / 2, z + rng.range(-0.16, 0.16));
      blade.rotation.set(rng.range(-0.4, 0.4), rng.range(0, Math.PI), rng.range(-0.35, 0.35));
      blade.castShadow = true;
      g.add(blade);
    }
  }

  // Occasional cup or wrapper on the pavement.
  for (let i = 0; i < 40; i++) {
    const east = rng.chance(0.6);
    const x = east ? rng.range(ROAD_HALF + 0.8, 15.4) : rng.range(-15, -(ROAD_HALF + 0.8));
    const z = rng.range(STRIP_MIN_Z + 10, STRIP_MAX_Z - 10);
    if (Math.abs(z - CROSS_Z) < CROSS_HALF) continue;
    const bit = new THREE.Mesh(
      rng.chance(0.5)
        ? new THREE.CylinderGeometry(0.03, 0.038, 0.09, 8)
        : new THREE.BoxGeometry(0.09, 0.008, 0.06),
      rng.pick(litterMats),
    );
    bit.position.set(x, CURB_H + 0.02, z);
    bit.rotation.set(rng.range(0, 1.6), rng.range(0, Math.PI * 2), rng.range(0, 1.6));
    bit.castShadow = true;
    g.add(bit);
  }

  /* ----------------------------------------------------------- manholes */

  const manholeMat = new THREE.MeshStandardMaterial({
    color: 0x35322c,
    roughness: 0.62,
    metalness: 0.7,
  });
  for (let z = STRIP_MIN_Z + 18; z < STRIP_MAX_Z; z += 37) {
    if (Math.abs(z - CROSS_Z) < CROSS_HALF + 3) continue;
    const cover = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.02, 20), manholeMat);
    cover.position.set(rng.range(-3.5, 3.5), 0.012, z);
    cover.receiveShadow = true;
    g.add(cover);
  }
}

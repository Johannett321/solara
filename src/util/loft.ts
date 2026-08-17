import * as THREE from 'three';

/**
 * A horizontal cross-section: an ellipse of half-width `w` (x) and half-depth
 * `d` (z), centred at height `y` with an optional forward offset `z`.
 */
export interface Section {
  y: number;
  w: number;
  d: number;
  z?: number;
}

/** Uniform Catmull-Rom through four scalars. */
function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

function channel(vals: number[], u: number): number {
  const n = vals.length;
  if (n === 1) return vals[0];
  const f = u * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  const t = f - i;
  const p0 = vals[Math.max(0, i - 1)];
  const p1 = vals[i];
  const p2 = vals[i + 1];
  const p3 = vals[Math.min(n - 1, i + 2)];
  return cr(p0, p1, p2, p3, t);
}

export interface LoftOpts {
  /** Rings sampled along the length. More = smoother silhouette. */
  rings?: number;
  /** Points around each ring. */
  radial?: number;
  /** Add a hemispherical dome instead of a flat cap. */
  capTop?: boolean;
  capBottom?: boolean;
  /** Squash the domes; 1 = hemisphere. */
  capScale?: number;
}

/**
 * Builds a closed surface through a stack of elliptical sections. This is the
 * workhorse for Mara's body — a torso that actually narrows at the waist and
 * flares at the hips reads as human in a way stacked capsules never do.
 */
export function loft(sections: Section[], opts: LoftOpts = {}): THREE.BufferGeometry {
  const rings = opts.rings ?? 24;
  const radial = opts.radial ?? 20;
  const capTop = opts.capTop ?? true;
  const capBottom = opts.capBottom ?? true;
  const capScale = opts.capScale ?? 1;

  const ys = sections.map((s) => s.y);
  const ws = sections.map((s) => s.w);
  const ds = sections.map((s) => s.d);
  const zs = sections.map((s) => s.z ?? 0);

  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];

  const capRings = 5;
  const totalRows = rings + (capBottom ? capRings : 0) + (capTop ? capRings : 0);

  const pushRing = (y: number, w: number, d: number, z: number, v: number) => {
    for (let j = 0; j <= radial; j++) {
      const a = (j / radial) * Math.PI * 2;
      pos.push(Math.cos(a) * w, y, z + Math.sin(a) * d);
      uv.push(j / radial, v);
    }
  };

  // Bottom dome.
  if (capBottom) {
    const w0 = channel(ws, 0);
    const d0 = channel(ds, 0);
    const y0 = channel(ys, 0);
    const z0 = channel(zs, 0);
    const h = Math.max(w0, d0) * capScale;
    for (let i = 0; i < capRings; i++) {
      const t = i / capRings;
      const a = (1 - t) * (Math.PI / 2);
      pushRing(y0 - Math.sin(a) * h, w0 * Math.cos(a), d0 * Math.cos(a), z0, 0);
    }
  }

  for (let i = 0; i < rings; i++) {
    const u = i / (rings - 1);
    pushRing(channel(ys, u), channel(ws, u), channel(ds, u), channel(zs, u), u);
  }

  // Top dome.
  if (capTop) {
    const w1 = channel(ws, 1);
    const d1 = channel(ds, 1);
    const y1 = channel(ys, 1);
    const z1 = channel(zs, 1);
    const h = Math.max(w1, d1) * capScale;
    for (let i = 1; i <= capRings; i++) {
      const t = i / capRings;
      const a = t * (Math.PI / 2);
      pushRing(y1 + Math.sin(a) * h, w1 * Math.cos(a), d1 * Math.cos(a), z1, 1);
    }
  }

  const stride = radial + 1;
  for (let r = 0; r < totalRows - 1; r++) {
    for (let j = 0; j < radial; j++) {
      const a = r * stride + j;
      const b = a + stride;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

/**
 * A limb segment lofted along -Y from the joint at the origin, so the mesh
 * hangs from its parent bone and rotates naturally about the joint.
 */
export function limb(
  length: number,
  profile: Array<[number, number]>,
  squash = 1,
  /**
   * Resolution scale. Limbs are most of a body's geometry, and this used to be
   * fixed at full resolution — so the crowd's `detail: 'crowd'` setting, which
   * halves every *other* loft in the rig, was barely reducing the cost of a
   * pedestrian at all.
   */
  res = 1,
): THREE.BufferGeometry {
  const sections: Section[] = profile.map(([t, r]) => ({
    y: -t * length,
    w: r,
    d: r * squash,
  }));
  // Sections must run bottom-to-top for the caps to face outward.
  sections.reverse();
  return loft(sections, {
    rings: Math.max(4, Math.round(16 * res)),
    radial: Math.max(6, Math.round(16 * res)),
    capScale: 0.85,
  });
}

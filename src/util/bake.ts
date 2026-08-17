import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Collapses a subtree of static meshes into one merged mesh per material.
 *
 * The world is authored as thousands of small readable meshes — every window
 * ledge, café chair leg and wheel spoke its own object. That is the right way
 * to write it and the wrong way to draw it: each mesh costs a draw call in the
 * main pass AND another in the shadow pass. Baking turns ~8000 draw calls into
 * a few dozen without changing how any of the builders are written.
 *
 * Only pass groups that never move. Anything animated belongs in its own group.
 */
/**
 * Bakes a group's children in buckets rather than all at once.
 *
 * One giant merged mesh per material would draw the entire 300 m strip every
 * frame, including in the shadow pass. Bucketing by position keeps chunks small
 * enough that frustum culling still throws most of the street away.
 */
export function bakeChunked(
  root: THREE.Object3D,
  key: (o: THREE.Object3D) => string | number,
): THREE.Group {
  const out = new THREE.Group();
  out.name = `${root.name || 'group'}:chunked`;

  const buckets = new Map<string | number, THREE.Object3D[]>();
  for (const child of [...root.children]) {
    const k = key(child);
    const list = buckets.get(k);
    if (list) list.push(child);
    else buckets.set(k, [child]);
  }

  for (const [k, children] of buckets) {
    const holder = new THREE.Group();
    holder.name = `${root.name}:${k}`;
    for (const c of children) holder.add(c);
    out.add(bakeStatic(holder));
  }

  return out;
}

function needsColor(m: THREE.Material): boolean {
  return (m as THREE.MeshStandardMaterial).vertexColors === true;
}

/**
 * Give a geometry an index if it hasn't got one, so a bucket can be merged
 * without flattening the ones that have.
 *
 * The trivial index costs four bytes a vertex and welds nothing; it is only
 * there so `mergeGeometries` sees a consistent set.
 */
function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (g.index) return g;
  const n = g.attributes.position.count;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

export function bakeStatic(root: THREE.Object3D): THREE.Group {
  const out = new THREE.Group();
  out.name = `${root.name || 'group'}:baked`;

  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const instanced: THREE.InstancedMesh[] = [];

  root.updateMatrixWorld(true);
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const xform = new THREE.Matrix4();

  root.traverse((o) => {
    // InstancedMesh is already a single draw call; carry it over untouched.
    if ((o as THREE.InstancedMesh).isInstancedMesh) {
      instanced.push(o as THREE.InstancedMesh);
      return;
    }
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;

    const geo = m.geometry.clone();
    geo.applyMatrix4(xform.multiplyMatrices(toLocal, m.matrixWorld));

    // Merging requires every input to carry the same attribute set. `color`
    // stays: dropping it leaves vertex-coloured materials (the beach umbrellas)
    // reading an attribute that no longer exists, and rendering black.
    for (const name of Object.keys(geo.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'color') {
        geo.deleteAttribute(name);
      }
    }
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) {
      const n = geo.attributes.position.count;
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
    }
    if (needsColor(m.material as THREE.Material) && !geo.attributes.color) {
      // A bucket has to be all-or-nothing on colour; default the stragglers.
      const n = geo.attributes.position.count;
      geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
    }

    const material = m.material as THREE.Material;
    const list = byMaterial.get(material);
    if (list) list.push(geo);
    else byMaterial.set(material, [geo]);
  });

  for (const [material, geos] of byMaterial) {
    // mergeGeometries needs all inputs to agree on indexed-ness. Agreeing on
    // *indexed* rather than non-indexed matters a great deal: almost everything
    // here comes from a three primitive, and those share vertices heavily — a
    // SphereGeometry(8, 6) is 63 vertices for 84 triangles. Expanding those to
    // three vertices per triangle, which is what `toNonIndexed` does, was
    // tripling the vertex data for the whole world.
    const flat = geos.map(indexed);
    const merged = mergeGeometries(flat, false);
    for (const g of flat) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    out.add(mesh);
  }

  // Re-parent instanced meshes, folding their world transform into themselves.
  for (const im of instanced) {
    im.removeFromParent();
    xform.multiplyMatrices(toLocal, im.matrixWorld);
    xform.decompose(im.position, im.quaternion, im.scale);
    out.add(im);
  }

  return out;
}

/**
 * Force a generated ground surface to face upward.
 *
 * Hand-written grids get their triangle winding inverted whenever a coordinate
 * runs backwards (x decreasing with the column index, say), and the symptoms
 * are wildly inconsistent: the beach blew out white, the ocean and the river
 * water vanished entirely, the park was simply invisible. That has now cost
 * five separate debugging sessions, so rather than getting the winding right by
 * inspection every time, generate whatever order is convenient and call this.
 *
 * Averages the face normals; if the surface points down, reverses every
 * triangle and recomputes.
 */
export function ensureUpward(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const index = geo.getIndex();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const n = new THREE.Vector3();

  const count = index ? index.count : pos.count;
  const at = (i: number) => (index ? index.getX(i) : i);

  let sum = 0;
  // Sampling is plenty — these grids are uniform, so a few hundred faces
  // settle the question without walking a 100k-triangle mesh.
  const step = Math.max(3, Math.floor(count / 900) * 3);
  for (let i = 0; i + 2 < count; i += step) {
    a.fromBufferAttribute(pos, at(i));
    b.fromBufferAttribute(pos, at(i + 1));
    c.fromBufferAttribute(pos, at(i + 2));
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    n.crossVectors(ab, ac);
    sum += n.y;
  }

  if (sum >= 0) return geo;

  if (index) {
    const arr = index.array as unknown as number[];
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const t = arr[i + 1];
      arr[i + 1] = arr[i + 2];
      arr[i + 2] = t;
    }
    index.needsUpdate = true;
  } else {
    // Non-indexed: swap the second and third vertex of every triangle.
    const arr = pos.array as Float32Array;
    for (let i = 0; i + 8 < arr.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = arr[i + 3 + k];
        arr[i + 3 + k] = arr[i + 6 + k];
        arr[i + 6 + k] = t;
      }
    }
    pos.needsUpdate = true;
  }
  geo.computeVertexNormals();
  return geo;
}

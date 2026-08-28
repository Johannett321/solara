import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Collapse an articulated rig into a single SkinnedMesh.
 *
 * `buildMara` authors the body as ~40 loose meshes hanging off a tree of joint
 * groups, which is the right way to write a rig and the wrong way to draw four
 * hundred of them: every limb is its own draw call in the beauty pass and again
 * in the shadow pass, and none of it can be baked because all of it moves.
 * Measured on the strip, the crowd alone was 849 draw calls and 5.8 ms of a
 * 32 ms frame.
 *
 * Nothing here changes the pose. Every mesh is *rigidly* attached to exactly
 * one joint already, so binding all of its vertices to that joint with weight 1
 * reproduces the hierarchy exactly — this is the same transform chain, moved
 * from the scene graph onto the GPU. The joints stay ordinary Object3Ds that
 * the animator keeps rotating; only the meshes go away.
 *
 * Two things have to be true for the maths to work out, and both are load-
 * bearing:
 *
 * - **Geometry is baked into root-local space**, and the SkinnedMesh is added
 *   to `root` with an identity transform. three recomputes `bindMatrixInverse`
 *   from `matrixWorld` every frame (the default `AttachedBindMode`), so the
 *   root's own motion cancels out and the agent can still be walked around the
 *   world by writing `root.position`.
 * - **The skeleton is built at the rest pose**, before anything has posed the
 *   rig, because `Skeleton` captures each joint's inverse bind matrix from its
 *   current `matrixWorld`.
 *
 * `THREE.Skeleton` only ever reads `matrixWorld` off its bones, so the joints
 * do not have to be `THREE.Bone` — keeping them as the groups they already are
 * leaves `MaraRig`, the animator and the crowd's posing code untouched.
 */

const KEEP = ['position', 'normal', 'uv'] as const;

/** Attribute set every geometry in a merge has to agree on. */
function normalise(geo: THREE.BufferGeometry, bone: number): THREE.BufferGeometry {
  for (const name of Object.keys(geo.attributes)) {
    if (!KEEP.includes(name as (typeof KEEP)[number])) geo.deleteAttribute(name);
  }
  if (!geo.attributes.normal) geo.computeVertexNormals();

  const n = geo.attributes.position.count;
  if (!geo.attributes.uv) {
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(n * 2), 2));
  }

  // Rigid binding: one bone per vertex at full weight. Slots 1..3 stay empty,
  // which costs a little bandwidth and saves needing a second code path.
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    index[i * 4] = bone;
    weight[i * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));

  // `mergeGeometries` needs every input to agree on indexed-ness, and agreeing
  // the other way triples the vertex data — see `util/bake.ts`.
  if (!geo.index) {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

/**
 * @param root  The rig root. The SkinnedMesh is parented here and the geometry
 *   is baked into its local space.
 * @param joints Every joint the animator moves, in any order. A mesh binds to
 *   its nearest ancestor in this list.
 * @returns The SkinnedMesh, or null if the rig held no meshes.
 */
export function skinRig(
  root: THREE.Object3D,
  joints: THREE.Object3D[],
): THREE.SkinnedMesh | null {
  root.updateMatrixWorld(true);

  const boneOf = new Map<THREE.Object3D, number>();
  joints.forEach((j, i) => boneOf.set(j, i));

  const rootInverse = root.matrixWorld.clone().invert();
  const toRoot = new THREE.Matrix4();

  // Bucket by material first. Merging per material and only then merging the
  // buckets *with* groups gives one group — one draw call — per material;
  // merging all forty at once with groups would keep all forty draws.
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const meshes: THREE.Mesh[] = [];

  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;

    let bone = -1;
    for (let p: THREE.Object3D | null = m.parent; p; p = p.parent) {
      const i = boneOf.get(p);
      if (i !== undefined) {
        bone = i;
        break;
      }
    }
    // A mesh hanging off the root itself has nothing to ride; leave it alone
    // rather than binding it to an arbitrary joint.
    if (bone < 0) return;

    meshes.push(m);
    const geo = normalise(m.geometry.clone(), bone);
    geo.applyMatrix4(toRoot.multiplyMatrices(rootInverse, m.matrixWorld));

    const material = m.material as THREE.Material;
    const list = byMaterial.get(material);
    if (list) list.push(geo);
    else byMaterial.set(material, [geo]);
  });

  if (!meshes.length) return null;

  const perMaterial: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  for (const [material, geos] of byMaterial) {
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    if (geos.length > 1) for (const g of geos) g.dispose();
    if (!merged) continue;
    perMaterial.push(merged);
    materials.push(material);
  }

  const geometry = mergeGeometries(perMaterial, true);
  for (const g of perMaterial) g.dispose();
  if (!geometry) return null;

  for (const m of meshes) {
    m.removeFromParent();
    m.geometry.dispose();
  }

  const skinned = new THREE.SkinnedMesh(geometry, materials);
  skinned.name = 'skin';
  skinned.castShadow = true;
  skinned.receiveShadow = true;
  // `world/culling.ts` is the single writer of visibility for a pedestrian —
  // it tests the view frustum and the sun's shadow volume against one sphere
  // enclosing the whole agent. A second, per-mesh test here would only repeat
  // that work against a bind-pose bounding sphere the animation walks out of.
  skinned.frustumCulled = false;
  root.add(skinned);

  // Bind last: `Skeleton` reads the inverse bind matrices off the joints as
  // they stand right now, and `bind` reads `bindMatrix` off the SkinnedMesh's
  // world matrix, so both need the mesh parented and the rig at rest.
  skinned.bind(new THREE.Skeleton(joints as THREE.Bone[]));

  return skinned;
}

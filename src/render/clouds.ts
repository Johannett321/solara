import * as THREE from 'three';
import { Rng } from '../core/rng';

/**
 * Volumetric-ish cumulus.
 *
 * The old clouds were a single alpha-mapped plane at y = 620 with a tiling
 * texture on it. From the ground that reads as a ceiling with a visible edge —
 * the "cut" across the sky — and it is not in any sense in the world: you could
 * never pass through it, and it never changed colour as the sun went down.
 *
 * These are real clusters of soft billboard puffs sitting between 190 m and
 * 430 m, spread across several kilometres. You could fly straight through one.
 * Every puff is an instance of the same quad, so the whole sky is one draw
 * call, and each is shaded from the direction it sits relative to its own
 * cluster centre — so the sun rims the tops and the undersides stay in shadow,
 * and both track the time of day.
 */

/**
 * Clusters are generated up front and revealed progressively by cover: cluster
 * `i` becomes visible once cover passes `i / CLUSTERS`. The later ones sit
 * lower and flatter, so a clear sky shows a handful of fair-weather cumulus and
 * an overcast one closes into a continuous deck overhead.
 */
const CLUSTERS = 78;
const PUFFS_PER_CLUSTER = 24;

const VERT = /* glsl */ `
  attribute vec3 iOffset;
  attribute vec3 iDir;
  attribute float iScale;
  attribute float iSeed;
  attribute float iThreshold;

  uniform float uTime;
  uniform float uWind;
  uniform float uSpan;
  uniform float uCover;

  varying vec2 vUv;
  varying vec3 vDir;
  varying float vSeed;
  varying float vFade;

  void main() {
    vUv = uv;
    vDir = iDir;
    vSeed = iSeed;

    // Below its threshold a cluster is not in the sky at all. Collapsing the
    // quad is cheaper than any branch that still rasterises.
    if (iThreshold > uCover) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vFade = 0.0;
      return;
    }
    // Puffs grow in as their cluster arrives, so cover does not pop.
    // Edges must be in increasing order — smoothstep with edge0 > edge1 is
    // undefined in GLSL, and returned zero here, which hid every cloud.
    float grow = smoothstep(iThreshold - 0.12, iThreshold, uCover);

    // Drift downwind, wrapping so the field never runs out. The wrap is in
    // world space rather than per-cluster, so clusters stay intact as they go.
    vec3 world = iOffset;
    world.x = mod(world.x + uTime * uWind + uSpan * 0.5, uSpan) - uSpan * 0.5;

    vec4 mv = modelViewMatrix * vec4(world, 1.0);
    // View-space billboard: the quad always faces the camera without needing a
    // per-instance matrix rebuild on the CPU.
    mv.xy += position.xy * iScale * grow;

    // Fade the far edge of the field instead of ending it at a hard boundary.
    vFade = (1.0 - smoothstep(1900.0, 3000.0, length(mv.xyz))) * grow;

    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uLit;
  uniform vec3 uBase;
  uniform float uOpacity;

  varying vec2 vUv;
  varying vec3 vDir;
  varying float vSeed;
  varying float vFade;

  void main() {
    // Soft round puff. The falloff is deliberately gentle — a hard-edged blob
    // reads as a sphere, and a cloud has no edge.
    float r = length(vUv - 0.5) * 2.0;
    float a = 1.0 - smoothstep(0.15, 1.0, r);
    a *= a;
    a *= uOpacity * vFade * (0.7 + 0.3 * fract(vSeed * 13.7));
    if (a < 0.004) discard;

    // Shade by where this puff sits in its cluster: the side facing the sun
    // catches the light, the underside stays in shadow.
    float lit = smoothstep(-0.55, 0.75, dot(vDir, uSunDir));
    // Bottoms are darker than tops regardless of where the sun is.
    lit *= 0.45 + 0.55 * smoothstep(-0.8, 0.6, vDir.y);
    vec3 col = mix(uBase, uLit, lit);

    // Premultiplied: the blend mode below expects colour already scaled by a.
    gl_FragColor = vec4(col * a, a);
  }
`;

export interface CloudField {
  mesh: THREE.Mesh;
  /** Recolour for the current time of day. */
  setLight(sunDir: THREE.Vector3, lit: THREE.Color, base: THREE.Color, opacity: number): void;
  /** 0 clear, ~0.4 partly cloudy, 1 solid overcast. */
  setCover(cover: number): void;
  /** Drift speed in m/s, from the weather's wind. */
  setWind(speed: number): void;
  update(dt: number): void;
}

export function buildClouds(): CloudField {
  const rng = new Rng(60704);
  const total = CLUSTERS * PUFFS_PER_CLUSTER;
  const span = 5200;

  const offsets = new Float32Array(total * 3);
  const dirs = new Float32Array(total * 3);
  const scales = new Float32Array(total);
  const seeds = new Float32Array(total);

  const thresholds = new Float32Array(total);

  let i = 0;
  for (let c = 0; c < CLUSTERS; c++) {
    const threshold = c / CLUSTERS;
    // Fair-weather cumulus first, then progressively lower, wider, flatter
    // cloud as the sky closes in.
    const deck = threshold;
    const cx = rng.range(-span / 2, span / 2);
    const cy = rng.range(190, 430) - deck * 130;
    const cz = rng.range(-2200, 2200);
    // Cumulus are far wider than they are tall, and taller than they are deep.
    const rx = rng.range(150, 420) * (1 + deck * 0.7);
    const ry = rng.range(45, 130) * (1 - deck * 0.45);
    const rz = rng.range(120, 320) * (1 + deck * 0.7);

    for (let p = 0; p < PUFFS_PER_CLUSTER; p++) {
      // Pack toward the middle so the cluster has a dense core and a ragged rim.
      const u = Math.pow(rng.next(), 0.55);
      const theta = rng.range(0, Math.PI * 2);
      const phi = Math.acos(rng.range(-1, 1));
      const dx = Math.sin(phi) * Math.cos(theta) * u;
      // Squashed vertically, and biased upward: cumulus have flat bottoms.
      const dy = Math.cos(phi) * u * 0.85 + 0.15;
      const dz = Math.sin(phi) * Math.sin(theta) * u;

      offsets[i * 3] = cx + dx * rx;
      offsets[i * 3 + 1] = cy + dy * ry;
      offsets[i * 3 + 2] = cz + dz * rz;

      const len = Math.hypot(dx, dy, dz) || 1;
      dirs[i * 3] = dx / len;
      dirs[i * 3 + 1] = dy / len;
      dirs[i * 3 + 2] = dz / len;

      // Puffs near the core are the big ones; the rim breaks up into small ones.
      scales[i] = rng.range(70, 165) * (1.25 - u * 0.5) * (1 + deck * 0.35);
      seeds[i] = rng.next();
      thresholds[i] = threshold;
      i++;
    }
  }

  const base = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.attributes.position = base.attributes.position;
  geo.attributes.uv = base.attributes.uv;
  geo.setAttribute('iOffset', new THREE.InstancedBufferAttribute(offsets, 3));
  geo.setAttribute('iDir', new THREE.InstancedBufferAttribute(dirs, 3));
  geo.setAttribute('iScale', new THREE.InstancedBufferAttribute(scales, 1));
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 1));
  geo.setAttribute('iThreshold', new THREE.InstancedBufferAttribute(thresholds, 1));
  geo.instanceCount = total;

  const uniforms = {
    uTime: { value: 0 },
    uWind: { value: 2.4 },
    uSpan: { value: span },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uLit: { value: new THREE.Color(0xffffff) },
    uBase: { value: new THREE.Color(0x8fa4bc) },
    uOpacity: { value: 0.85 },
    uCover: { value: 0.3 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    // Premultiplied "over". Instances cannot be depth-sorted, and straight
    // alpha blending makes the ordering errors obvious as popping edges;
    // premultiplied compositing hides almost all of it on soft shapes.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -900;

  return {
    mesh,
    setLight(sunDir, lit, baseCol, opacity) {
      uniforms.uSunDir.value.copy(sunDir);
      uniforms.uLit.value.copy(lit);
      uniforms.uBase.value.copy(baseCol);
      uniforms.uOpacity.value = opacity;
    },
    setCover(cover) {
      uniforms.uCover.value = Math.min(1, Math.max(0, cover));
    },
    setWind(speed) {
      uniforms.uWind.value = speed;
    },
    update(dt) {
      uniforms.uTime.value += dt;
    },
  };
}

import * as THREE from 'three';
import { fbm } from './textures';
import { ensureUpward } from '../util/bake';
import {
  PROFILE_GLSL,
  WATER_Y,
  OCEAN_EDGE,
  SHORELINE_X,
  shoreHeight,
} from '../world/layout';

/**
 * The ocean.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial so it keeps
 * the whole existing pipeline for free — image-based lighting off the sky,
 * the sun's specular, fog, shadows and ACES tone mapping. `onBeforeCompile`
 * then injects:
 *
 *  - summed Gerstner waves in the vertex stage, with analytic normals;
 *  - two scrolling ripple normal maps for the fine surface detail;
 *  - depth-based colour, from turquoise over the sand bar to deep teal;
 *  - shore foam, driven by the *same* height profile the terrain uses, so the
 *    surf line always sits exactly on the waterline with no depth prepass.
 *
 * The shore running dead straight along Z is what makes that last trick work:
 * depth is a function of world x alone, so the shader can evaluate it directly.
 */

export interface Ocean {
  mesh: THREE.Mesh;
  update(t: number): void;
  /** Darken the water body after dark; reflections track the sky on their own. */
  setNight(f: number): void;
  /** Surface height at a world point, including swell — for floating things. */
  heightAt(x: number, z: number): number;
}

/* ----------------------------------------------------------------- waves */

/** dir x, dir z, wavelength, steepness, amplitude. */
const WAVES: Array<[number, number, number, number, number]> = [
  [1.0, 0.16, 46, 0.42, 0.5],
  [0.86, -0.5, 27, 0.34, 0.28],
  [1.0, 0.62, 15.5, 0.3, 0.15],
  [0.72, -0.84, 8.5, 0.24, 0.07],
];

const WAVE_GLSL = /* glsl */ `
  // Gerstner: crests sharpen and troughs flatten, which is what separates a
  // real swell from a stack of sine waves.
  vec3 gerstner(vec2 p, vec2 dir, float wavelength, float steep, float amp,
                float time, inout vec3 tangent, inout vec3 binormal) {
    float k = 6.28318530718 / wavelength;
    float c = sqrt(9.81 / k);
    vec2 d = normalize(dir);
    float f = k * (dot(d, p) - c * time);
    float a = steep / k;

    tangent += vec3(
      -d.x * d.x * (steep * sin(f)),
      d.x * (steep * cos(f)),
      -d.x * d.y * (steep * sin(f))
    );
    binormal += vec3(
      -d.x * d.y * (steep * sin(f)),
      d.y * (steep * cos(f)),
      -d.y * d.y * (steep * sin(f))
    );

    return vec3(d.x * (a * cos(f)), amp * sin(f), d.y * (a * cos(f)));
  }
`;

/* -------------------------------------------------------------- geometry */

/**
 * A grid that is dense at the shoreline and coarse out to sea. A uniform grid
 * fine enough for the surf line would be tens of millions of triangles.
 */
function oceanGeometry(): THREE.BufferGeometry {
  const NX = 240;
  const NZ = 300;
  const zHalf = 760;

  const xs = new Float32Array(NX);
  for (let i = 0; i < NX; i++) {
    const t = i / (NX - 1);
    // Cubic bias packs samples toward the beach.
    xs[i] = THREE.MathUtils.lerp(SHORELINE_X + 26, OCEAN_EDGE, Math.pow(t, 2.6));
  }

  const zs = new Float32Array(NZ);
  for (let i = 0; i < NZ; i++) {
    const t = (i / (NZ - 1)) * 2 - 1;
    zs[i] = Math.sign(t) * Math.pow(Math.abs(t), 1.9) * zHalf;
  }

  const pos = new Float32Array(NX * NZ * 3);
  const uv = new Float32Array(NX * NZ * 2);
  let p = 0;
  let q = 0;
  for (let iz = 0; iz < NZ; iz++) {
    for (let ix = 0; ix < NX; ix++) {
      pos[p++] = xs[ix];
      pos[p++] = 0;
      pos[p++] = zs[iz];
      uv[q++] = xs[ix] / 40;
      uv[q++] = zs[iz] / 40;
    }
  }

  const idx: number[] = [];
  for (let iz = 0; iz < NZ - 1; iz++) {
    for (let ix = 0; ix < NX - 1; ix++) {
      const a = iz * NX + ix;
      const b = a + 1;
      const c = a + NX;
      const d = c + 1;
      // xs run seaward (decreasing), so this ordering is the one that faces up.
      // Reversed, the whole ocean is backface-culled when seen from the beach.
      idx.push(a, b, c, b, d, c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(NX * NZ * 3), 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  ensureUpward(geo);
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------- textures */

/** Tileable ripple normals, two octaves of the shared fBm helper. */
export function rippleNormals(seed: number, strength: number): THREE.Texture {
  const size = 256;
  const h = fbm(size, 32, 4, seed, 0.55);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const at = (x: number, y: number) =>
    h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/** Soft blobby mask so foam breaks up instead of banding. */
function foamMask(): THREE.Texture {
  const size = 256;
  const h = fbm(size, 12, 4, 4242, 0.6);
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < h.length; i++) {
    const v = Math.round(h[i] * 255);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/* ----------------------------------------------------------------- build */

export function buildOcean(): Ocean {
  const uniforms = {
    uTime: { value: 0 },
    uRippleA: { value: rippleNormals(701, 2.4) },
    uRippleB: { value: rippleNormals(913, 1.6) },
    uFoamMask: { value: foamMask() },
    uShallow: { value: new THREE.Color(0x2fc3b0) },
    uMid: { value: new THREE.Color(0x0b8f92) },
    uDeep: { value: new THREE.Color(0x053f52) },
    uSandTint: { value: new THREE.Color(0xd8c79a) },
    uFoam: { value: new THREE.Color(0xf2f8f8) },
  };

  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    // Glossy but not a mirror: at eye level a mirror-smooth sea reflects the
    // sky at grazing angles and reads as a sheet of white.
    roughness: 0.1,
    metalness: 0.0,
    envMapIntensity: 0.8,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        varying vec3 vWorld;
        varying float vCrest;
        ${WAVE_GLSL}
      `,
      )
      .replace(
        '#include <begin_vertex>',
        /* glsl */ `
        vec3 transformed = vec3(position);
        vec3 waveTangent = vec3(1.0, 0.0, 0.0);
        vec3 waveBinormal = vec3(0.0, 0.0, 1.0);
        vec2 wp = position.xz;
        vec3 disp = vec3(0.0);
        ${WAVES.map(
          ([dx, dz, len, steep, amp]) => `
        disp += gerstner(wp, vec2(${dx.toFixed(3)}, ${dz.toFixed(3)}), ${len.toFixed(
          2,
        )}, ${steep.toFixed(3)}, ${amp.toFixed(3)}, uTime, waveTangent, waveBinormal);`,
        ).join('')}

        // Swell has to die out as the water shoals, or waves march up the sand.
        float depthHere = ${WATER_Y.toFixed(2)} - shoreHeight(position.x);
        float shoal = smoothstep(0.0, 3.2, depthHere);
        disp *= shoal;

        transformed += disp;
        vCrest = disp.y;
        objectNormal = normalize(cross(waveBinormal, waveTangent));
        objectNormal = normalize(mix(vec3(0.0, 1.0, 0.0), objectNormal, shoal));
        vNormal = normalize(normalMatrix * objectNormal);
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
      `,
      );

    // shoreHeight has to exist before the vertex stage uses it.
    shader.vertexShader = shader.vertexShader.replace(
      'void main() {',
      `${PROFILE_GLSL}\nvoid main() {`,
    );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        uniform float uTime;
        uniform sampler2D uRippleA;
        uniform sampler2D uRippleB;
        uniform sampler2D uFoamMask;
        uniform vec3 uShallow, uMid, uDeep, uSandTint, uFoam;
        varying vec3 vWorld;
        varying float vCrest;
        ${PROFILE_GLSL}
      `,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
        // Two ripple layers scrolling at different rates and scales; a single
        // layer reads as a repeating pattern the moment the camera moves.
        vec2 rA = vWorld.xz * 0.075 + vec2(uTime * 0.021, uTime * 0.014);
        vec2 rB = vWorld.xz * 0.021 - vec2(uTime * 0.011, uTime * 0.017);
        vec3 nA = texture2D(uRippleA, rA).xyz * 2.0 - 1.0;
        vec3 nB = texture2D(uRippleB, rB).xyz * 2.0 - 1.0;
        vec3 ripple = normalize(nA * 0.65 + nB * 0.45);

        float depth = ${WATER_Y.toFixed(2)} - shoreHeight(vWorld.x);
        // Calm the ripples right at the edge so the wet sand isn't jittery.
        float rippleFade = smoothstep(0.05, 1.4, depth);
        normal = normalize(normal + vec3(ripple.x, 0.0, ripple.y) * (0.42 * rippleFade));
      `,
      )
      .replace(
        '#include <color_fragment>',
        /* glsl */ `
        #include <color_fragment>
        float d = ${WATER_Y.toFixed(2)} - shoreHeight(vWorld.x);

        // Depth ramp. These thresholds are tight on purpose: this shore shelves
        // so gently that a "shallow" band of 1.5 m covers 60 m of ocean and
        // washes the whole view out to pale sand.
        vec3 water = mix(uShallow, uMid, smoothstep(0.5, 2.5, d));
        water = mix(water, uDeep, smoothstep(2.5, 9.0, d));
        // Only the last few metres read as seabed through the water.
        water = mix(uSandTint, water, smoothstep(0.0, 0.45, d));

        /* ------------------------------------------------------- foam */

        // Foam is keyed to DISTANCE from the waterline, not depth. On a shore
        // this gently shelving, a depth-based band would be 60 m of white.
        float shoreDist = ${SHORELINE_X.toFixed(2)} - vWorld.x;

        float mask = texture2D(uFoamMask, vWorld.xz * 0.045 + vec2(uTime * 0.004, 0.0)).r;
        float mask2 = texture2D(uFoamMask, vWorld.xz * 0.11 - vec2(0.0, uTime * 0.02)).r;

        // Sets rolling in: the surf line breathes in and out along the beach.
        float surge = sin(uTime * 0.5 + vWorld.z * 0.035) * 3.0
                    + sin(uTime * 0.31 - vWorld.z * 0.017) * 2.0;
        float band = 1.0 - smoothstep(1.5, 11.0 + surge, shoreDist);
        float surf = band * smoothstep(0.36, 0.66, mask * 0.6 + mask2 * 0.55);

        // The swash right at the edge is always white.
        float edge = 1.0 - smoothstep(-1.0, 2.2 + surge * 0.25, shoreDist);

        // Whitecaps on the steepest crests, out past the break.
        float caps = smoothstep(0.30, 0.58, vCrest)
                   * smoothstep(25.0, 70.0, shoreDist)
                   * smoothstep(0.5, 0.82, mask2);

        // Declared here so the roughness chunk below can still see it.
        float foam = clamp(max(max(surf, edge * 0.95), caps * 0.65), 0.0, 1.0);
        diffuseColor.rgb = mix(water, uFoam, foam);
      `,
      )
      // roughnessFactor is only declared by this chunk, which runs *after*
      // color_fragment — assigning it any earlier fails to compile.
      .replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
        #include <roughnessmap_fragment>
        // Foam is rough and diffuse; open water is glassy.
        roughnessFactor = mix(0.1, 0.85, foam);
      `,
      );
  };

  const mesh = new THREE.Mesh(oceanGeometry(), material);
  mesh.position.y = WATER_Y;
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  // The grid is authored in world space and always surrounds the player.
  mesh.frustumCulled = false;
  mesh.renderOrder = 1;
  mesh.name = 'ocean';

  // Daytime water colours, kept so the night grade can be reapplied from the
  // originals each time rather than compounding on the previous darkening.
  const dayShallow = uniforms.uShallow.value.clone();
  const dayMid = uniforms.uMid.value.clone();
  const dayDeep = uniforms.uDeep.value.clone();
  const dayFoam = uniforms.uFoam.value.clone();
  const nightWater = new THREE.Color(0x0a1830);
  const nightFoam = new THREE.Color(0x5a6a86);

  return {
    mesh,
    update(t) {
      uniforms.uTime.value = t;
    },
    setNight(f) {
      const t = Math.min(1, Math.max(0, f));
      // The body of the water goes almost black; what you actually see at night
      // is the sky and the city reflected in it, which the env map handles.
      uniforms.uShallow.value.copy(dayShallow).lerp(nightWater, t * 0.88);
      uniforms.uMid.value.copy(dayMid).lerp(nightWater, t * 0.9);
      uniforms.uDeep.value.copy(dayDeep).lerp(nightWater, t * 0.92);
      uniforms.uFoam.value.copy(dayFoam).lerp(nightFoam, t);
      material.envMapIntensity = 0.8 + t * 1.6;
    },
    heightAt(x, z) {
      // Mirrors the vertex shader closely enough for boats and swimmers.
      const depth = WATER_Y - shoreHeight(x);
      const shoal = THREE.MathUtils.smoothstep(depth, 0, 3.2);
      let y = 0;
      const time = uniforms.uTime.value;
      for (const [dx, dz, len, , amp] of WAVES) {
        const k = (Math.PI * 2) / len;
        const c = Math.sqrt(9.81 / k);
        const n = Math.hypot(dx, dz);
        const f = k * ((dx / n) * x + (dz / n) * z - c * time);
        y += amp * Math.sin(f);
      }
      return WATER_Y + y * shoal;
    },
  };
}

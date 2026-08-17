import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

/**
 * The grade is doing a lot of the "GTA trailer" work: a warm highlight roll,
 * teal push in the shadows, gentle saturation lift, then lens artefacts
 * (vignette, chromatic aberration, grain) to break up the CG cleanliness.
 * Runs in linear HDR — OutputPass applies ACES + sRGB after it.
 */
const GradeShader: THREE.ShaderMaterialParameters & { uniforms: Record<string, THREE.IUniform> } = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 0.42 },
    uAberration: { value: 0.0011 },
    uGrain: { value: 0.035 },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.06 },
    uLift: { value: new THREE.Vector3(0.006, 0.009, 0.018) },
    uGain: { value: new THREE.Vector3(1.045, 1.005, 0.955) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uVignette, uAberration, uGrain, uSaturation, uContrast;
    uniform vec3 uLift, uGain;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec2 uv = vUv;
      vec2 c = uv - 0.5;
      float r2 = dot(c, c);

      // Chromatic aberration, scaled by distance from centre like a real lens.
      vec2 off = c * uAberration * (0.35 + r2 * 2.6);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;

      // Lift / gain colour balance.
      col = uLift + col * uGain;

      // Saturation around Rec.709 luma.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // Contrast pivoted at mid grey.
      col = (col - 0.18) * uContrast + 0.18;

      // Vignette.
      col *= 1.0 - uVignette * smoothstep(0.12, 0.78, r2);

      // Animated grain, weighted toward the shadows where sensors are noisiest.
      float g = hash(uv * 1024.0 + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (1.0 - smoothstep(0.0, 0.9, luma));

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/** Resolution multipliers for the two heaviest passes. */
const AO_SCALE = 0.5;
const BLOOM_SCALE = 0.5;

/**
 * How far ambient occlusion is allowed to see, in metres.
 *
 * GTAO re-renders the entire scene into a normal/depth buffer, and submitting
 * the city twice was the most expensive thing in the frame by a wide margin.
 * The AO radius is 0.55 m, so at this distance an occluder subtends a fraction
 * of a pixel — everything past this plane was contributing shading nobody could
 * see. Giving the pass its own camera with a short far plane hands all of it to
 * three's own frustum cull and leaves the AO you can actually see identical.
 *
 * It buys depth precision as well, which is what AO is most sensitive to.
 */
const AO_FAR = 120;

export interface PostFx {
  composer: EffectComposer;
  setSize(w: number, h: number, dpr: number): void;
  /**
   * Bloom runs *before* tone mapping, so its threshold is in pre-exposure
   * linear HDR. That means the day threshold (5.5, above a sunlit white
   * surface) would never let a neon sign bloom at night, when the whole frame
   * sits far lower — the time-of-day system drives both from its keyframes.
   */
  setBloom(threshold: number, strength: number): void;
  /** Warm/cool the grade with the time of day. */
  setGrade(saturation: number, gain: THREE.Vector3): void;
  update(dt: number): void;
}

export function buildPost(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostFx {
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  const composer = new EffectComposer(
    renderer,
    new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
      samples: 4,
      colorSpace: THREE.LinearSRGBColorSpace,
    }),
  );

  composer.addPass(new RenderPass(scene, camera));

  // Ambient occlusion: grounds Mara's feet and darkens the awning undersides.
  //
  // GTAO re-renders the whole scene into a normal buffer every frame, making it
  // the most expensive pass here by a wide margin. At half resolution it costs a
  // quarter of the fill and looks the same — AO is inherently low-frequency.
  const gtao = new GTAOPass(scene, camera, size.x * AO_SCALE, size.y * AO_SCALE);

  // GTAOPass brackets its normal pass with `scene.traverse` calls that hide
  // every Points and Line object, because neither can occlude anything. There
  // is not a single one in this world — it is all meshes — so the only thing
  // those two traversals do here is walk 60000-odd nodes twice a frame, which
  // measured at ~16 ms, more than the AO they were guarding. Both become no-ops.
  const guarded = gtao as unknown as { _overrideVisibility(): void; _restoreVisibility(): void };
  guarded._overrideVisibility = () => {};
  guarded._restoreVisibility = () => {};

  // The pass reads *everything* off its camera — the normal render, the depth
  // linearisation and the reprojection — so a near-sighted clone of the real
  // one is all it takes to bound the work. It rides the chase camera in
  // `update` below.
  const aoCamera = new THREE.PerspectiveCamera(camera.fov, camera.aspect, camera.near, AO_FAR);
  gtao.camera = aoCamera;

  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 0.9;
  gtao.updateGtaoMaterial({
    radius: 0.55,
    distanceExponent: 1.4,
    thickness: 0.55,
    scale: 1.0,
    samples: 8,
  });
  composer.addPass(gtao);

  // Threshold is in linear HDR, where a mid-grey sits near 3.0 at our exposure.
  // A "1.0" threshold here would bloom the entire frame into milk.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * BLOOM_SCALE, size.y * BLOOM_SCALE),
    0.42,
    0.5,
    5.5,
  );
  composer.addPass(bloom);

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  composer.addPass(new OutputPass());
  composer.addPass(new SMAAPass());

  return {
    composer,
    setSize(w, h, dpr) {
      composer.setPixelRatio(dpr);
      composer.setSize(w, h);
      gtao.setSize(w * dpr * AO_SCALE, h * dpr * AO_SCALE);
      bloom.setSize(w * dpr * BLOOM_SCALE, h * dpr * BLOOM_SCALE);
      aoCamera.fov = camera.fov;
      aoCamera.aspect = camera.aspect;
      aoCamera.updateProjectionMatrix();
    },
    setBloom(threshold, strength) {
      bloom.threshold = threshold;
      bloom.strength = strength;
    },
    setGrade(saturation, gain) {
      grade.uniforms.uSaturation.value = saturation;
      (grade.uniforms.uGain.value as THREE.Vector3).copy(gain);
    },
    update(dt) {
      grade.uniforms.uTime.value += dt;
      // Same eye, shorter sight. Only the transform moves frame to frame; the
      // projection is rebuilt in `setSize`.
      aoCamera.position.copy(camera.position);
      aoCamera.quaternion.copy(camera.quaternion);
      aoCamera.updateMatrixWorld();
    },
  };
}

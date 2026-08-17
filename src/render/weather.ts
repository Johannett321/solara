import * as THREE from 'three';
import { Rng } from '../core/rng';
import type { SkyState } from './sky';

/**
 * Weather.
 *
 * Deliberately *not* a list of weather types. Every condition is a set of
 * continuous scalars that vary independently, so "light rain under broken cloud
 * with a stiff breeze" and "still, thick sea fog under a clear sky" are both
 * just points in the same space. The named fronts below are only sampling
 * regions used to pick plausible new targets — nothing downstream ever asks
 * which one is active.
 *
 * Everything reaches the renderer through two seams: `modify()` bends the sky's
 * time-of-day state (which already owns sun, ambient, fog, exposure and bloom),
 * and the rain mesh draws itself. Nothing else in the project knows weather
 * exists.
 */

export interface WeatherState {
  /** 0 clear, ~0.45 partly cloudy, 1 solid overcast. */
  cover: number;
  /** 0 dry, ~0.25 drizzle, 1 downpour. */
  rain: number;
  /** Extra haze on top of the time-of-day fog. 1 is thick sea fog. */
  haze: number;
  /** 0 still, 1 gale. Drives cloud drift and how far the rain slants. */
  wind: number;
  /** Likelihood and violence of lightning. */
  storm: number;
}

/**
 * Sampling regions for new weather. Each field is a range, so two spells of
 * "showers" are never identical, and the transition between two fronts passes
 * through every intermediate combination on the way.
 */
interface Front {
  name: string;
  weight: number;
  cover: [number, number];
  rain: [number, number];
  haze: [number, number];
  wind: [number, number];
  storm: [number, number];
}

const FRONTS: Front[] = [
  {
    name: 'clear', weight: 3,
    cover: [0.02, 0.18], rain: [0, 0], haze: [0.0, 0.18], wind: [0.08, 0.35], storm: [0, 0],
  },
  {
    name: 'fair', weight: 3,
    cover: [0.25, 0.5], rain: [0, 0], haze: [0.05, 0.28], wind: [0.15, 0.5], storm: [0, 0],
  },
  {
    name: 'broken cloud', weight: 2,
    cover: [0.5, 0.72], rain: [0, 0.12], haze: [0.15, 0.35], wind: [0.25, 0.6], storm: [0, 0.08],
  },
  {
    name: 'showers', weight: 2,
    cover: [0.6, 0.85], rain: [0.18, 0.45], haze: [0.2, 0.45], wind: [0.3, 0.65], storm: [0, 0.25],
  },
  {
    name: 'overcast', weight: 2,
    cover: [0.85, 1], rain: [0, 0.14], haze: [0.3, 0.55], wind: [0.15, 0.5], storm: [0, 0],
  },
  {
    name: 'rain', weight: 2,
    cover: [0.88, 1], rain: [0.45, 0.78], haze: [0.4, 0.7], wind: [0.35, 0.7], storm: [0.05, 0.35],
  },
  {
    name: 'thunderstorm', weight: 1,
    cover: [0.92, 1], rain: [0.7, 1], haze: [0.5, 0.85], wind: [0.55, 1], storm: [0.65, 1],
  },
  {
    name: 'sea fog', weight: 1,
    cover: [0.25, 0.6], rain: [0, 0.1], haze: [0.8, 1], wind: [0.02, 0.18], storm: [0, 0],
  },
];

/* ------------------------------------------------------------------ rain */

const RAIN_MAX = 7000;
/** Half-extent of the box of rain kept around the camera, in metres. */
const RAIN_BOX = 46;
const RAIN_HEIGHT = 34;

const RAIN_VERT = /* glsl */ `
  attribute vec3 iSeed;

  uniform vec3 uCam;
  uniform float uTime, uFall, uBox, uHeight, uLength, uWidth;
  uniform vec2 uDrift;

  varying float vFade;
  varying float vT;

  void main() {
    // Each drop lives at a fixed offset inside a box that is always centred on
    // the camera, so the field follows the player for free and never runs out.
    vec3 p;
    p.x = mod(iSeed.x * uBox + uDrift.x * uTime, uBox) - uBox * 0.5;
    p.z = mod(iSeed.z * uBox + uDrift.y * uTime, uBox) - uBox * 0.5;
    p.y = mod(iSeed.y * uHeight - uFall * uTime, uHeight);

    vec3 world = vec3(uCam.x + p.x, uCam.y - uHeight * 0.32 + p.y, uCam.z + p.z);
    vec4 mv = modelViewMatrix * vec4(world, 1.0);

    // Stretch the quad along the fall direction as it appears on screen. The
    // offsets are added in view space, which is metres, so perspective still
    // makes near drops bigger than far ones.
    vec3 fallW = normalize(vec3(uDrift.x, -uFall, uDrift.y));
    vec3 fallV = (modelViewMatrix * vec4(fallW, 0.0)).xyz;
    vec2 dir = normalize(fallV.xy + vec2(0.0, -1e-4));
    vec2 perp = vec2(-dir.y, dir.x);
    mv.xy += dir * (position.y * uLength) + perp * (position.x * uWidth);

    float d = length(mv.xyz);
    // Fade at both ends: right in the lens, and out at the edge of the box.
    vFade = smoothstep(0.6, 3.0, d) * (1.0 - smoothstep(uBox * 0.30, uBox * 0.5, d));
    vT = position.y + 0.5;

    gl_Position = projectionMatrix * mv;
  }
`;

const RAIN_FRAG = /* glsl */ `
  uniform vec3 uColour;
  uniform float uOpacity;

  varying float vFade;
  varying float vT;

  void main() {
    // Head-heavy streak: bright at the leading end, tailing off behind.
    float a = vFade * uOpacity * (0.25 + 0.75 * vT);
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColour * a, a);
  }
`;

export interface Weather {
  state: WeatherState;
  rain: THREE.Mesh;
  /** Auto-evolution on/off. Manual `set` switches it off. */
  running: boolean;
  /** Human-readable summary for the HUD. */
  describe(): string;
  /** Override any subset of the parameters and stop drifting. */
  set(partial: Partial<WeatherState>): void;
  /** Jump straight to the next named front, for testing. */
  cycle(): string;
  /** Hand control back to the simulation, starting a fresh front now. */
  resume(): void;
  /** Bends the sky's time-of-day state. Wire to `sky.modifier`. */
  modify(s: SkyState): void;
  update(dt: number, cameraPos: THREE.Vector3): void;
  /** Fires when a lightning strike happens, with its distance in metres. */
  onThunder: ((distance: number) => void) | null;
}

const GREY = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);

export function buildWeather(startFront = 'fair'): Weather {
  const rng = new Rng(4711);

  const state: WeatherState = { cover: 0.35, rain: 0, haze: 0.15, wind: 0.3, storm: 0 };
  const target: WeatherState = { ...state };
  const from: WeatherState = { ...state };

  /** Seconds spent in the current transition, and how long it takes. */
  let elapsed = 0;
  let duration = 1;
  /** Seconds to hold once the transition finishes. */
  let hold = 90;

  let frontIndex = Math.max(0, FRONTS.findIndex((f) => f.name === startFront));
  const totalWeight = FRONTS.reduce((a, f) => a + f.weight, 0);

  const pick = (f: Front, out: WeatherState) => {
    out.cover = rng.range(f.cover[0], f.cover[1]);
    out.rain = rng.range(f.rain[0], f.rain[1]);
    out.haze = rng.range(f.haze[0], f.haze[1]);
    out.wind = rng.range(f.wind[0], f.wind[1]);
    out.storm = rng.range(f.storm[0], f.storm[1]);
  };

  pick(FRONTS[frontIndex], state);
  Object.assign(target, state);
  Object.assign(from, state);

  const nextFront = () => {
    // Weighted pick, never the same front twice running.
    let n = rng.range(0, totalWeight);
    let idx = 0;
    for (let i = 0; i < FRONTS.length; i++) {
      n -= FRONTS[i].weight;
      if (n <= 0) {
        idx = i;
        break;
      }
    }
    if (idx === frontIndex) idx = (idx + 1) % FRONTS.length;
    frontIndex = idx;

    Object.assign(from, state);
    pick(FRONTS[idx], target);
    // Weather takes minutes to turn over, not seconds. A front is roughly one
    // in-game day at the default day length, which is what makes the change
    // feel like weather rather than a switch being flipped.
    duration = rng.range(70, 180);
    hold = rng.range(80, 260);
    elapsed = 0;
  };

  /* --------------------------------------------------------------- rain */

  const seeds = new Float32Array(RAIN_MAX * 3);
  for (let i = 0; i < RAIN_MAX * 3; i++) seeds[i] = rng.next();

  const quad = new THREE.PlaneGeometry(1, 1);
  const rainGeo = new THREE.InstancedBufferGeometry();
  rainGeo.index = quad.index;
  rainGeo.attributes.position = quad.attributes.position;
  rainGeo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  rainGeo.instanceCount = 0;

  const rainUniforms = {
    uCam: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uFall: { value: 22 },
    uBox: { value: RAIN_BOX },
    uHeight: { value: RAIN_HEIGHT },
    uLength: { value: 1.1 },
    uWidth: { value: 0.022 },
    uDrift: { value: new THREE.Vector2(2, 1) },
    uColour: { value: new THREE.Color(0xaebfd0) },
    uOpacity: { value: 0.5 },
  };

  const rainMat = new THREE.ShaderMaterial({
    uniforms: rainUniforms,
    vertexShader: RAIN_VERT,
    fragmentShader: RAIN_FRAG,
    transparent: true,
    depthWrite: false,
    // Premultiplied over, same reasoning as the clouds: instances cannot be
    // depth-sorted and this hides the ordering errors on soft shapes.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false,
  });

  const rainMesh = new THREE.Mesh(rainGeo, rainMat);
  rainMesh.frustumCulled = false;
  rainMesh.renderOrder = 900;
  rainMesh.visible = false;

  /* ---------------------------------------------------------- lightning */

  /** Current flash brightness, 0..1. */
  let flash = 0;
  /** Seconds until the next strike. */
  let nextStrike = 6;
  /** Remaining sub-flashes in the current strike, and time to the next. */
  let flickers = 0;
  let flickerIn = 0;

  const sys: Weather = {
    state,
    rain: rainMesh,
    running: true,
    onThunder: null,

    describe() {
      const s = state;
      const cloud =
        s.cover < 0.2 ? 'clear' : s.cover < 0.5 ? 'fair' : s.cover < 0.8 ? 'cloudy' : 'overcast';
      const wet =
        s.rain < 0.05 ? '' : s.rain < 0.3 ? ', drizzle' : s.rain < 0.6 ? ', rain' : ', heavy rain';
      const fog = s.haze > 0.7 ? ', fog' : s.haze > 0.45 ? ', hazy' : '';
      const thunder = s.storm > 0.5 ? ', thunder' : '';
      const gust = s.wind > 0.7 ? ', windy' : '';
      return cloud + wet + fog + thunder + gust;
    },

    set(partial) {
      Object.assign(state, partial);
      Object.assign(target, state);
      Object.assign(from, state);
      sys.running = false;
    },

    resume() {
      sys.running = true;
      // Start a transition immediately rather than serving out the hold left
      // over from before the override — otherwise handing control back looks
      // like nothing happened for a minute and a half.
      nextFront();
    },

    cycle() {
      frontIndex = (frontIndex + 1) % FRONTS.length;
      pick(FRONTS[frontIndex], state);
      Object.assign(target, state);
      Object.assign(from, state);
      sys.running = false;
      return FRONTS[frontIndex].name;
    },

    modify(s) {
      const { cover, rain, haze, storm } = state;

      /* ------------------------------------------------- cloud cover */

      // The overcast grey is derived from the sky it replaces rather than being
      // a fixed colour, so an overcast dawn stays pink-grey and an overcast
      // night stays nearly black.
      const lum = s.mid.r * 0.2126 + s.mid.g * 0.7152 + s.mid.b * 0.0722;
      GREY.setRGB(lum * 0.96, lum * 0.98, lum * 1.06);
      const flat = cover * 0.88;
      s.horizon.lerp(GREY, flat * 0.75);
      s.mid.lerp(GREY, flat);
      s.zenith.lerp(GREY, flat);

      const dim = 1 - cover * 0.42 - rain * 0.2;
      s.intensity *= dim;

      // Cloud hides the sun: no disc, no glow, no horizon band.
      const clear = 1 - cover;
      s.glowStrength *= clear;
      s.bandStrength *= clear;
      s.discStrength *= clear * clear;

      // Direct sun falls away fast; the sky becomes one big soft source, so
      // ambient goes *up* even as the frame gets darker overall.
      s.sunIntensity *= Math.max(0, 1 - cover * 1.15);
      s.sunColour.lerp(GREY, cover * 0.6);
      s.hemiIntensity *= 1 + cover * 0.75 - rain * 0.15;
      s.hemiSky.lerp(GREY, cover * 0.7);
      s.envIntensity *= 1 + cover * 0.35;

      /* ------------------------------------------------------- haze */

      s.fogDensity *= 1 + haze * 9 + rain * 2.2;
      s.fog.lerp(GREY, Math.min(1, haze * 0.8 + cover * 0.4));

      /* ------------------------------------------------- exposure */

      // Open up as the sky closes in, or an overcast noon reads as dusk.
      s.exposure *= 1 + cover * 0.3 + rain * 0.12;
      // Less headroom under cloud, so the threshold has to come down with it or
      // nothing ever blooms again.
      s.bloomThreshold *= 1 - cover * 0.4;

      /* ------------------------------------------------- lightning */

      if (flash > 0.001) {
        const f = flash;
        s.horizon.lerp(WHITE, f * 0.55);
        s.mid.lerp(WHITE, f * 0.7);
        s.zenith.lerp(WHITE, f * 0.6);
        s.intensity *= 1 + f * 5;
        s.hemiIntensity += f * 2.2;
        s.hemiSky.lerp(WHITE, f * 0.8);
        s.envIntensity += f * 0.35;
      }
      // Storms are dark even between the flashes.
      s.intensity *= 1 - storm * 0.12;
    },

    update(dt, cameraPos) {
      /* ------------------------------------------------- evolution */

      if (sys.running) {
        elapsed += dt;
        if (elapsed < duration) {
          const t = elapsed / duration;
          const e = t * t * (3 - 2 * t);
          state.cover = THREE.MathUtils.lerp(from.cover, target.cover, e);
          state.rain = THREE.MathUtils.lerp(from.rain, target.rain, e);
          state.haze = THREE.MathUtils.lerp(from.haze, target.haze, e);
          state.wind = THREE.MathUtils.lerp(from.wind, target.wind, e);
          state.storm = THREE.MathUtils.lerp(from.storm, target.storm, e);
        } else if (elapsed > duration + hold) {
          nextFront();
        }
      }

      /* ------------------------------------------------- lightning */

      if (flickers > 0) {
        flickerIn -= dt;
        if (flickerIn <= 0) {
          flash = rng.range(0.45, 1);
          flickers--;
          flickerIn = rng.range(0.04, 0.12);
        }
      }
      // Flashes decay fast — a long fade reads as a floodlight, not lightning.
      flash = Math.max(0, flash - dt * 7);

      if (state.storm > 0.02) {
        nextStrike -= dt * state.storm;
        if (nextStrike <= 0) {
          flickers = rng.int(1, 3);
          flickerIn = 0;
          // The countdown is scaled by `storm`, so a full storm strikes every
          // few seconds and a distant one every couple of minutes.
          nextStrike = rng.range(2.5, 11);
          const distance = rng.range(220, 3400) * (1.2 - state.storm * 0.6);
          sys.onThunder?.(distance);
        }
      } else {
        nextStrike = rng.range(4, 20);
        flickers = 0;
      }

      /* ------------------------------------------------------ rain */

      rainUniforms.uTime.value += dt;
      rainUniforms.uCam.value.copy(cameraPos);

      const r = state.rain;
      rainMesh.visible = r > 0.01;
      if (rainMesh.visible) {
        // Drop count, fall speed, streak length and opacity all rise together:
        // drizzle is a few short slow streaks, a downpour is a dense fast sheet.
        rainGeo.instanceCount = Math.round(RAIN_MAX * Math.min(1, r * 1.15));
        rainUniforms.uFall.value = 14 + r * 24;
        // Short and faint: long bright streaks read as scratches on the lens,
        // not as rain. Density carries the weight of a downpour, not length.
        rainUniforms.uLength.value = 0.34 + r * 1.0;
        rainUniforms.uWidth.value = 0.011 + r * 0.009;
        rainUniforms.uOpacity.value = 0.1 + r * 0.26;
        const drift = 1.5 + state.wind * 16;
        rainUniforms.uDrift.value.set(drift, drift * 0.45);
      }
    },
  };

  return sys;
}

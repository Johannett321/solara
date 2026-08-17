import * as THREE from 'three';

/**
 * Sky and time of day.
 *
 * This replaces three's `Sky` (Preetham). That model emits physically absolute
 * radiance, which meant everything downstream had to be scaled against it, and
 * it gives you almost no control over the *shape* of a sunset — you get what
 * the atmosphere model gives you. Since the whole point here is art-directed
 * dawns and dusks matching the reference frames, this is a hand-authored dome:
 * a three-band vertical gradient, a sun glow, a horizon band that hugs the
 * sun's azimuth, stars and a moon.
 *
 * It is also a sphere rather than the old flat cloud plane at y = 620, which is
 * what was producing the hard "cut" across the sky.
 *
 * Everything the rest of the renderer needs — light colours, fog, exposure,
 * bloom, and the `night` factor that switches on every artificial light in the
 * city — is interpolated from the keyframe table below.
 */

/* ----------------------------------------------------------- keyframes */

interface SkyKey {
  hour: number;
  /** Vertical gradient: at the horizon, partway up, and at the zenith. */
  horizon: number;
  mid: number;
  zenith: number;
  /** Height at which `mid` sits, as sin(elevation). */
  midHeight: number;
  /** Broad glow around the sun. */
  glow: number;
  glowStrength: number;
  glowPower: number;
  /** The saturated band along the horizon either side of the sun. */
  band: number;
  bandStrength: number;
  /** Overall radiance multiplier for the dome. */
  intensity: number;

  sunColour: number;
  sunIntensity: number;
  /** Colour of the sun disc drawn on the dome. */
  discColour: number;
  discStrength: number;

  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  envIntensity: number;

  fog: number;
  fogDensity: number;

  exposure: number;
  bloomThreshold: number;
  bloomStrength: number;

  stars: number;
  /** 0 by day, 1 at full night. Drives every artificial light in the world. */
  night: number;
}

/**
 * One entry per interesting moment of the day. Hours in between are
 * interpolated, so the table only needs the turning points.
 *
 * The sunset row is the money shot from the reference: a hot orange band on the
 * horizon, magenta above it, and deep violet-blue at the zenith.
 */
const KEYS: SkyKey[] = [
  {
    hour: 0,
    horizon: 0x121a30, mid: 0x0b1024, zenith: 0x04060f, midHeight: 0.16,
    glow: 0x223055, glowStrength: 0.15, glowPower: 30, band: 0x2a3050, bandStrength: 0.1,
    intensity: 0.5,
    sunColour: 0x2a3a6a, sunIntensity: 0.0, discColour: 0x000000, discStrength: 0,
    hemiSky: 0x36466e, hemiGround: 0x201f28, hemiIntensity: 0.28,
    envIntensity: 0.095,
    fog: 0x0b1020, fogDensity: 0.00085,
    exposure: 0.82, bloomThreshold: 1.7, bloomStrength: 0.8,
    stars: 1, night: 1,
  },
  {
    hour: 5.0,
    horizon: 0x2a2c4a, mid: 0x141a34, zenith: 0x070a18, midHeight: 0.16,
    glow: 0x60406a, glowStrength: 0.5, glowPower: 18, band: 0x7a4a70, bandStrength: 0.35,
    intensity: 0.7,
    sunColour: 0x5a4a70, sunIntensity: 0.05, discColour: 0x000000, discStrength: 0,
    hemiSky: 0x38405e, hemiGround: 0x1c1e26, hemiIntensity: 0.22,
    envIntensity: 0.09,
    fog: 0x1a1c30, fogDensity: 0.00095,
    exposure: 0.66, bloomThreshold: 1.6, bloomStrength: 0.75,
    stars: 0.6, night: 0.85,
  },
  {
    // First light. Violet overhead, a cold pink rim on the horizon.
    hour: 6.0,
    horizon: 0xff8f6e, mid: 0x8a5a86, zenith: 0x24306a, midHeight: 0.2,
    glow: 0xff9a5c, glowStrength: 0.75, glowPower: 11, band: 0xff7a4a, bandStrength: 0.85,
    intensity: 1.15,
    sunColour: 0xff9a5a, sunIntensity: 0.7, discColour: 0xff6a30, discStrength: 5,
    hemiSky: 0x6a6a9a, hemiGround: 0x4a3a30, hemiIntensity: 0.32,
    envIntensity: 0.11,
    fog: 0x8a5a72, fogDensity: 0.0011,
    exposure: 0.5, bloomThreshold: 2.6, bloomStrength: 0.7,
    stars: 0.12, night: 0.45,
  },
  {
    hour: 7.0,
    horizon: 0xffc79a, mid: 0xd7a6b0, zenith: 0x3f6dba, midHeight: 0.24,
    glow: 0xffc078, glowStrength: 0.8, glowPower: 9, band: 0xffa060, bandStrength: 0.5,
    intensity: 2.4,
    sunColour: 0xffc188, sunIntensity: 2.6, discColour: 0xffb060, discStrength: 14,
    hemiSky: 0x9ab6e0, hemiGround: 0xc0a080, hemiIntensity: 0.4,
    envIntensity: 0.06,
    fog: 0xd8b8b0, fogDensity: 0.0012,
    exposure: 0.38, bloomThreshold: 4.4, bloomStrength: 0.5,
    stars: 0, night: 0.1,
  },
  {
    hour: 9.0,
    horizon: 0xc8dcef, mid: 0x8fb6e2, zenith: 0x2f68c4, midHeight: 0.26,
    glow: 0xdce6f2, glowStrength: 0.7, glowPower: 8, band: 0xd0dcea, bandStrength: 0.25,
    intensity: 3.4,
    sunColour: 0xfff0d8, sunIntensity: 4.4, discColour: 0xfff2e0, discStrength: 30,
    hemiSky: 0x9ec8f0, hemiGround: 0xe0c49c, hemiIntensity: 0.35,
    envIntensity: 0.19,
    fog: 0xaec9dd, fogDensity: 0.001,
    exposure: 0.34, bloomThreshold: 5.5, bloomStrength: 0.42,
    stars: 0, night: 0,
  },
  {
    hour: 13.0,
    horizon: 0xd2e4f4, mid: 0x8ab4e6, zenith: 0x2360c8, midHeight: 0.3,
    glow: 0xe6eef6, glowStrength: 0.6, glowPower: 9, band: 0xd8e4ee, bandStrength: 0.2,
    intensity: 3.7,
    sunColour: 0xfff6e6, sunIntensity: 4.8, discColour: 0xfff6ea, discStrength: 34,
    hemiSky: 0xa6cef2, hemiGround: 0xe4c8a0, hemiIntensity: 0.35,
    envIntensity: 0.2,
    fog: 0xb4cee0, fogDensity: 0.001,
    exposure: 0.33, bloomThreshold: 5.5, bloomStrength: 0.4,
    stars: 0, night: 0,
  },
  {
    hour: 16.5,
    horizon: 0xe2dcd0, mid: 0x9cbce0, zenith: 0x2a63bc, midHeight: 0.26,
    glow: 0xffe0b0, glowStrength: 1.0, glowPower: 8, band: 0xffcf98, bandStrength: 0.4,
    intensity: 3.2,
    sunColour: 0xffe6bc, sunIntensity: 4.2, discColour: 0xffe2b0, discStrength: 28,
    hemiSky: 0xa2c6ea, hemiGround: 0xe6c8a0, hemiIntensity: 0.36,
    envIntensity: 0.18,
    fog: 0xc4cede, fogDensity: 0.001,
    exposure: 0.34, bloomThreshold: 5.0, bloomStrength: 0.45,
    stars: 0, night: 0,
  },
  {
    // Golden hour. Long raking light, everything turns amber.
    hour: 18.2,
    horizon: 0xffb070, mid: 0xf0906e, zenith: 0x3f63b0, midHeight: 0.24,
    glow: 0xffa050, glowStrength: 0.85, glowPower: 9, band: 0xff9040, bandStrength: 0.55,
    intensity: 2.4,
    sunColour: 0xffa254, sunIntensity: 3.2, discColour: 0xff9040, discStrength: 16,
    hemiSky: 0x93a8d8, hemiGround: 0xffca8a, hemiIntensity: 0.34,
    envIntensity: 0.12,
    fog: 0xc49a90, fogDensity: 0.0011,
    exposure: 0.34, bloomThreshold: 4.8, bloomStrength: 0.5,
    stars: 0, night: 0,
  },
  {
    // Sunset proper — the reference frame.
    hour: 19.1,
    horizon: 0xff5226, mid: 0xb04080, zenith: 0x222a78, midHeight: 0.12,
    glow: 0xff6a2a, glowStrength: 0.95, glowPower: 11, band: 0xff4a20, bandStrength: 1.0,
    intensity: 1.7,
    sunColour: 0xff7038, sunIntensity: 1.7, discColour: 0xff5220, discStrength: 11,
    hemiSky: 0x7a74b8, hemiGround: 0xc07a5a, hemiIntensity: 0.3,
    envIntensity: 0.085,
    fog: 0x8f5a72, fogDensity: 0.0011,
    exposure: 0.36, bloomThreshold: 4.2, bloomStrength: 0.55,
    stars: 0, night: 0.12,
  },
  {
    // Blue hour: the sun is down but the sky is still lit from below.
    hour: 19.9,
    horizon: 0xf05a34, mid: 0x7a3c7e, zenith: 0x141c56, midHeight: 0.1,
    glow: 0xff5a28, glowStrength: 0.6, glowPower: 13, band: 0xff4a24, bandStrength: 0.9,
    intensity: 0.95,
    sunColour: 0xff6040, sunIntensity: 0.25, discColour: 0x000000, discStrength: 0,
    hemiSky: 0x5060a0, hemiGround: 0x6a4a52, hemiIntensity: 0.24,
    envIntensity: 0.08,
    fog: 0x4a3050, fogDensity: 0.0011,
    exposure: 0.5, bloomThreshold: 2.0, bloomStrength: 0.7,
    stars: 0.25, night: 0.62,
  },
  {
    hour: 20.8,
    horizon: 0x4a2c52, mid: 0x241f48, zenith: 0x0a0d22, midHeight: 0.16,
    glow: 0x6a3050, glowStrength: 0.5, glowPower: 16, band: 0x7a3448, bandStrength: 0.6,
    intensity: 0.75,
    sunColour: 0x50406a, sunIntensity: 0.04, discColour: 0x000000, discStrength: 0,
    hemiSky: 0x30365a, hemiGround: 0x22202a, hemiIntensity: 0.18,
    envIntensity: 0.06,
    fog: 0x241a34, fogDensity: 0.001,
    exposure: 0.78, bloomThreshold: 1.7, bloomStrength: 0.8,
    stars: 0.8, night: 0.95,
  },
  {
    hour: 22.0,
    horizon: 0x121a30, mid: 0x0b1024, zenith: 0x04060f, midHeight: 0.16,
    glow: 0x223055, glowStrength: 0.15, glowPower: 30, band: 0x2a3050, bandStrength: 0.1,
    intensity: 0.5,
    sunColour: 0x2a3a6a, sunIntensity: 0.0, discColour: 0x000000, discStrength: 0,
    hemiSky: 0x36466e, hemiGround: 0x201f28, hemiIntensity: 0.28,
    envIntensity: 0.095,
    fog: 0x0b1020, fogDensity: 0.00085,
    exposure: 0.82, bloomThreshold: 1.7, bloomStrength: 0.8,
    stars: 1, night: 1,
  },
];

/** Resolved keyframe, with colours already in linear working space. */
interface SkyState {
  horizon: THREE.Color;
  mid: THREE.Color;
  zenith: THREE.Color;
  glow: THREE.Color;
  band: THREE.Color;
  disc: THREE.Color;
  sunColour: THREE.Color;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  fog: THREE.Color;
  midHeight: number;
  glowStrength: number;
  glowPower: number;
  bandStrength: number;
  intensity: number;
  discStrength: number;
  sunIntensity: number;
  hemiIntensity: number;
  envIntensity: number;
  fogDensity: number;
  exposure: number;
  bloomThreshold: number;
  bloomStrength: number;
  stars: number;
  night: number;
}

function blankState(): SkyState {
  return {
    horizon: new THREE.Color(),
    mid: new THREE.Color(),
    zenith: new THREE.Color(),
    glow: new THREE.Color(),
    band: new THREE.Color(),
    disc: new THREE.Color(),
    sunColour: new THREE.Color(),
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    fog: new THREE.Color(),
    midHeight: 0.2, glowStrength: 1, glowPower: 8, bandStrength: 1, intensity: 3,
    discStrength: 20, sunIntensity: 4, hemiIntensity: 0.35, envIntensity: 0.19,
    fogDensity: 0.001, exposure: 0.34, bloomThreshold: 5.5, bloomStrength: 0.42,
    stars: 0, night: 0,
  };
}

const colourCache = new Map<number, THREE.Color>();
function col(hex: number): THREE.Color {
  let c = colourCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colourCache.set(hex, c);
  }
  return c;
}

/** Interpolate the table at `hour`, wrapping across midnight. */
function sample(hour: number, out: SkyState): SkyState {
  const h = ((hour % 24) + 24) % 24;
  let a = KEYS[KEYS.length - 1];
  let b = KEYS[0];
  for (let i = 0; i < KEYS.length; i++) {
    if (KEYS[i].hour <= h) {
      a = KEYS[i];
      b = KEYS[(i + 1) % KEYS.length];
    }
  }
  // Span, wrapping past midnight for the last segment.
  let span = b.hour - a.hour;
  if (span <= 0) span += 24;
  let into = h - a.hour;
  if (into < 0) into += 24;
  const t = span > 0 ? THREE.MathUtils.clamp(into / span, 0, 1) : 0;
  // Smoothstep: linear ramps between keys make the horizon colour visibly
  // "kink" as it crosses each keyframe.
  const s = t * t * (3 - 2 * t);

  out.horizon.lerpColors(col(a.horizon), col(b.horizon), s);
  out.mid.lerpColors(col(a.mid), col(b.mid), s);
  out.zenith.lerpColors(col(a.zenith), col(b.zenith), s);
  out.glow.lerpColors(col(a.glow), col(b.glow), s);
  out.band.lerpColors(col(a.band), col(b.band), s);
  out.disc.lerpColors(col(a.discColour), col(b.discColour), s);
  out.sunColour.lerpColors(col(a.sunColour), col(b.sunColour), s);
  out.hemiSky.lerpColors(col(a.hemiSky), col(b.hemiSky), s);
  out.hemiGround.lerpColors(col(a.hemiGround), col(b.hemiGround), s);
  out.fog.lerpColors(col(a.fog), col(b.fog), s);

  const m = THREE.MathUtils.lerp;
  out.midHeight = m(a.midHeight, b.midHeight, s);
  out.glowStrength = m(a.glowStrength, b.glowStrength, s);
  out.glowPower = m(a.glowPower, b.glowPower, s);
  out.bandStrength = m(a.bandStrength, b.bandStrength, s);
  out.intensity = m(a.intensity, b.intensity, s);
  out.discStrength = m(a.discStrength, b.discStrength, s);
  out.sunIntensity = m(a.sunIntensity, b.sunIntensity, s);
  out.hemiIntensity = m(a.hemiIntensity, b.hemiIntensity, s);
  out.envIntensity = m(a.envIntensity, b.envIntensity, s);
  out.fogDensity = m(a.fogDensity, b.fogDensity, s);
  out.exposure = m(a.exposure, b.exposure, s);
  out.bloomThreshold = m(a.bloomThreshold, b.bloomThreshold, s);
  out.bloomStrength = m(a.bloomStrength, b.bloomStrength, s);
  out.stars = m(a.stars, b.stars, s);
  out.night = m(a.night, b.night, s);
  return out;
}

/* --------------------------------------------------------------- shader */

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    // The dome is centred on the camera and never rotated, so object space
    // already *is* the world view direction.
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Pin to the far plane. Without this the dome sits at a real depth, the
    // ambient-occlusion pass treats it as ordinary geometry standing 1200 m
    // away, and occludes the entire sky to black. It also means the dome can
    // never be clipped by the far plane whatever its radius.
    gl_Position.z = gl_Position.w;
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;

  uniform vec3 uHorizon, uMid, uZenith, uGlow, uBand, uDisc;
  uniform vec3 uSunDir, uMoonDir;
  uniform float uMidHeight, uGlowStrength, uGlowOct, uBandStrength;
  uniform float uIntensity, uDiscStrength, uStars, uTime, uMoonUp;

  float hash3(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;

    /* ------------------------------------------- vertical gradient */

    vec3 sky;
    if (h < uMidHeight) {
      sky = mix(uHorizon, uMid, smoothstep(0.0, uMidHeight, max(h, 0.0)));
    } else {
      sky = mix(uMid, uZenith, smoothstep(uMidHeight, 0.92, h));
    }
    // Below the horizon the dome darkens rather than ending. Nothing is ever
    // drawn there except over open water, but a hard edge reads as a seam.
    sky = mix(uHorizon * 0.45, sky, smoothstep(-0.25, 0.0, h));

    /* -------------------------------------------------- stars */

    if (uStars > 0.002) {
      vec3 p = d * 220.0;
      vec3 cell = floor(p);
      float r = hash3(cell);
      if (r > 0.9955) {
        float twinkle = 0.55 + 0.45 * sin(uTime * 2.2 + r * 620.0);
        float s = 1.0 - smoothstep(0.0, 0.42, length(fract(p) - 0.5));
        // Fade out toward the horizon, where haze would swallow them anyway.
        sky += vec3(0.85, 0.9, 1.0) * s * twinkle * uStars * 2.6
             * smoothstep(0.0, 0.28, h);
      }
    }

    /* ------------------------------------------------ sun and moon */

    float c = dot(d, uSunDir);

    // Broad glow around the sun.
    //
    // The tightness is blended between two fixed powers rather than fed to
    // pow() as a uniform exponent: pow(x, uSomeUniform) renders the entire
    // dome black on this machine's driver, while the identical pow(x, 9.0)
    // with a literal exponent is fine. Nothing in this file may raise anything
    // to a uniform power.
    // uGlowOct is log2 of the exponent we actually want, so blending between
    // successive squarings reproduces pow() closely across the whole range.
    float g1 = max(c, 0.0);
    float g2 = g1 * g1;
    float g4 = g2 * g2;
    float g8 = g4 * g4;
    float g16 = g8 * g8;
    float g32 = g16 * g16;
    float o = uGlowOct;
    float glow;
    if (o < 1.0) glow = mix(g1, g2, o);
    else if (o < 2.0) glow = mix(g2, g4, o - 1.0);
    else if (o < 3.0) glow = mix(g4, g8, o - 2.0);
    else if (o < 4.0) glow = mix(g8, g16, o - 3.0);
    else glow = mix(g16, g32, min(o - 4.0, 1.0));
    sky += uGlow * glow * uGlowStrength;

    // Horizon band: saturated colour spreading sideways from the sun along the
    // skyline. This is what actually sells a sunset — a radial glow alone just
    // looks like a lamp behind the sky.
    vec2 dh = normalize(d.xz + vec2(1e-5));
    vec2 sh = normalize(uSunDir.xz + vec2(1e-5));
    float az = max(dot(dh, sh), 0.0);
    float band = az * az * sqrt(az) * (1.0 - smoothstep(0.0, 0.16, abs(h)));
    sky += uBand * band * uBandStrength;

    // Sun disc, with a soft edge so it blooms rather than aliasing.
    float ang = acos(clamp(c, -1.0, 1.0));
    sky += uDisc * uDiscStrength * (1.0 - smoothstep(0.008, 0.030, ang));

    // Moon: a small disc and a tight halo, only while it is up.
    if (uMoonUp > 0.001) {
      float mc = acos(clamp(dot(d, uMoonDir), -1.0, 1.0));
      sky += vec3(0.9, 0.93, 1.0) * 5.0 * uMoonUp * (1.0 - smoothstep(0.012, 0.022, mc));
      sky += vec3(0.5, 0.58, 0.8) * 0.5 * uMoonUp * (1.0 - smoothstep(0.02, 0.24, mc));
    }

    gl_FragColor = vec4(max(sky * uIntensity, 0.0), 1.0);
  }
`;

/* --------------------------------------------------------------- system */

export interface SkySystem {
  sun: THREE.DirectionalLight;
  sunDir: THREE.Vector3;
  /** Current time of day, 0..24. */
  hour: number;
  /** 0 by day, 1 at full night. Read by everything that lights up. */
  night: number;
  /**
   * Bends the interpolated state before anything consumes it — this is where
   * weather lives. It runs inside the same pass that sets the dome uniforms and
   * the lights, so cloud cover, haze and lightning reach the sky, the sun, the
   * fog, the exposure and the bloom without any of them knowing about weather.
   */
  modifier: ((s: SkyState) => void) | null;
  /** Fires whenever the resolved state changes enough to matter. */
  onState: ((s: SkyState) => void) | null;
  /** Force the environment probe to rebuild — weather changed the sky's look. */
  invalidateEnv(): void;
  /** Real seconds per in-game day. */
  dayLength: number;
  running: boolean;
  setHour(h: number): void;
  update(dt: number, cameraPos: THREE.Vector3): void;
  followShadow(target: THREE.Vector3): void;
  /**
   * The volume the sun's shadow map actually covers, for group-level culling —
   * see `world/culling.ts`. Null when the sun is down and nothing casts.
   *
   * Call after `followShadow`: the shadow camera is parked relative to the
   * target, so it is only correct once the target has moved for this frame.
   */
  shadowVolume(out: THREE.Frustum): THREE.Frustum | null;
}

export type { SkyState };

/** Peak sun elevation at midday, in degrees. Subtropical, so it is high. */
const MAX_ELEVATION = 66;
/** How far below the horizon the sun swings at midnight. */
const MAX_NIGHT_DIP = 55;
/**
 * A long subtropical day. These have to agree with the keyframe table: an
 * 18:00 sunset with a "sunset" keyframe at 19:00 puts the hot orange band in
 * the sky an hour after the sun has actually gone.
 */
const SUNRISE = 6.3;
const SUNSET = 19.4;

/**
 * Sun direction for a given hour.
 *
 * A plain sinusoid: up at 06:00, highest at 12:00, down at 18:00. The azimuth
 * sweeps from +X at sunrise, through +Z at noon, to -X at sunset — so the sun
 * goes down over the ocean, which is the whole reason the beach is on -X.
 */
function sunDirection(hour: number, out: THREE.Vector3): THREE.Vector3 {
  let elev: number;
  let t: number;
  if (hour >= SUNRISE && hour <= SUNSET) {
    t = (hour - SUNRISE) / (SUNSET - SUNRISE);
    elev = THREE.MathUtils.degToRad(MAX_ELEVATION) * Math.sin(Math.PI * t);
  } else {
    // Night arc, mirrored below the horizon. Both branches hit zero elevation
    // at sunrise and sunset, so the path is continuous.
    const nightLen = 24 - (SUNSET - SUNRISE);
    const n = hour > SUNSET ? (hour - SUNSET) / nightLen : (hour + 24 - SUNSET) / nightLen;
    elev = -THREE.MathUtils.degToRad(MAX_NIGHT_DIP) * Math.sin(Math.PI * n);
    t = 1 + n;
  }
  // Azimuth sweeps +X at sunrise, through +Z at midday, to -X at sunset, then
  // carries on round under the world.
  const theta = Math.PI / 2 - Math.PI * t;
  return out.setFromSphericalCoords(1, Math.PI / 2 - elev, theta);
}

export function buildSky(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  startHour = 10,
): SkySystem {
  const state = blankState();

  const uniforms = {
    uHorizon: { value: new THREE.Color() },
    uMid: { value: new THREE.Color() },
    uZenith: { value: new THREE.Color() },
    uGlow: { value: new THREE.Color() },
    uBand: { value: new THREE.Color() },
    uDisc: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
    uMidHeight: { value: 0.2 },
    uGlowStrength: { value: 1 },
    uGlowOct: { value: 3 },
    uBandStrength: { value: 1 },
    uIntensity: { value: 3 },
    uDiscStrength: { value: 20 },
    uStars: { value: 0 },
    uMoonUp: { value: 0 },
    uTime: { value: 0 },
  };

  const skyMat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), skyMat);
  dome.frustumCulled = false;
  dome.renderOrder = -1000;
  dome.scale.setScalar(1200);
  scene.add(dome);

  /* ----------------------------------------------------------- lights */

  const sunDir = new THREE.Vector3();
  // Hoisted: `apply` runs every frame, and a Vector3 per frame is pure garbage.
  const Z_AXIS = new THREE.Vector3(0, 0, 1);
  const shadowM = new THREE.Matrix4();
  const sun = new THREE.DirectionalLight(0xfff0d8, 4.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 340;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.035;
  const sc = sun.shadow.camera;
  // Tight frustum: 2048 over 64 m gives ~3 cm texels, sharper than 4096 over 90.
  sc.left = -32;
  sc.right = 32;
  sc.top = 32;
  sc.bottom = -32;
  sc.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  // The moon is a light, not just a disc: without it the night is pitch black
  // everywhere the city lights do not reach, and the beach goes invisible.
  const moonDir = new THREE.Vector3();
  const moon = new THREE.DirectionalLight(0x9db4e8, 0);
  scene.add(moon);
  scene.add(moon.target);

  const hemi = new THREE.HemisphereLight(0x9ec8f0, 0xe0c49c, 0.35);
  scene.add(hemi);

  scene.fog = new THREE.FogExp2(0xaec9dd, 0.001);
  const fog = scene.fog as THREE.FogExp2;

  /* ------------------------------------------------------ environment */

  // Image-based lighting, regenerated from the dome as the sun moves. PMREM is
  // far too expensive to run every frame, so it is rebuilt only once the sun
  // has actually moved a noticeable amount — a couple of times a second at the
  // default day length, and never while time is paused.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envScene = new THREE.Scene();
  const envDome = new THREE.Mesh(dome.geometry, skyMat);
  envDome.scale.setScalar(60);
  envScene.add(envDome);
  let envRT: THREE.WebGLRenderTarget | null = null;
  let envHour = -99;
  let envDirty = false;

  const refreshEnv = (hour: number) => {
    const old = envRT;
    envRT = pmrem.fromScene(envScene, 0.03, 1, 200);
    scene.environment = envRT.texture;
    old?.dispose();
    envHour = hour;
    envDirty = false;
  };

  /* -------------------------------------------------------------- run */

  const sys: SkySystem = {
    sun,
    sunDir,
    hour: startHour,
    night: 0,
    modifier: null,
    onState: null,
    invalidateEnv() {
      envDirty = true;
    },
    // A full day in twenty minutes: long enough that the light does not visibly
    // slide while you stand still, short enough to see a sunset without waiting.
    dayLength: 20 * 60,
    running: true,

    setHour(h) {
      sys.hour = ((h % 24) + 24) % 24;
      apply(true);
    },

    update(dt, cameraPos) {
      uniforms.uTime.value += dt;
      if (sys.running) sys.hour = (sys.hour + (dt / sys.dayLength) * 24) % 24;
      // Always applied, not only while the clock runs: weather keeps moving
      // when time is frozen, and the sky has to follow it.
      apply(false);
      // The dome rides with the camera, so it can be small enough to stay well
      // inside the far plane while still never being reachable.
      dome.position.copy(cameraPos);
    },

    followShadow(target) {
      sun.target.position.copy(target);
      sun.target.updateMatrixWorld();
      sun.position.copy(target).addScaledVector(sunDir, 120);
      moon.target.position.copy(target);
      moon.target.updateMatrixWorld();
      moon.position.copy(target).addScaledVector(moonDir, 120);
    },

    shadowVolume(out) {
      if (!sun.castShadow) return null;
      // Normally three does this itself at the top of the shadow pass; the
      // culler needs it a step earlier, and doing it twice is two matrix
      // multiplies.
      sun.shadow.updateMatrices(sun);
      const cam = sun.shadow.camera;
      return out.setFromProjectionMatrix(
        shadowM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse),
      );
    },
  };

  function apply(force: boolean): void {
    sample(sys.hour, state);
    sys.modifier?.(state);
    sunDirection(sys.hour, sunDir);
    // The moon rides opposite the sun, tipped so it is not a perfect mirror.
    moonDir.set(-sunDir.x, -sunDir.y, -sunDir.z).applyAxisAngle(Z_AXIS, 0.35);

    uniforms.uHorizon.value.copy(state.horizon);
    uniforms.uMid.value.copy(state.mid);
    uniforms.uZenith.value.copy(state.zenith);
    uniforms.uGlow.value.copy(state.glow);
    uniforms.uBand.value.copy(state.band);
    uniforms.uDisc.value.copy(state.disc);
    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uMoonDir.value.copy(moonDir);
    uniforms.uMidHeight.value = state.midHeight;
    uniforms.uGlowStrength.value = state.glowStrength;
    // Keyframes author a readable exponent; the shader wants its log2.
    uniforms.uGlowOct.value = Math.log2(Math.max(1, state.glowPower));
    uniforms.uBandStrength.value = state.bandStrength;
    uniforms.uIntensity.value = state.intensity;
    uniforms.uDiscStrength.value = state.discStrength;
    uniforms.uStars.value = state.stars;
    uniforms.uMoonUp.value = THREE.MathUtils.clamp(moonDir.y * 3, 0, 1) * state.stars;

    sun.color.copy(state.sunColour);
    sun.intensity = state.sunIntensity;
    // No sun below the horizon means no shadow pass to run — a free win at night.
    sun.castShadow = sunDir.y > 0.02 && state.sunIntensity > 0.05;

    moon.color.set(0x9db4e8);
    moon.intensity = 0.35 * uniforms.uMoonUp.value;

    hemi.color.copy(state.hemiSky);
    hemi.groundColor.copy(state.hemiGround);
    hemi.intensity = state.hemiIntensity;

    scene.environmentIntensity = state.envIntensity;
    fog.color.copy(state.fog);
    fog.density = state.fogDensity;

    sys.night = state.night;

    // The wrap past midnight produces a ~24 h difference, which trips the same
    // test, so no special case is needed for it.
    if (force || envDirty || Math.abs(sys.hour - envHour) > 0.06) refreshEnv(sys.hour);

    sys.onState?.(state);
  }

  apply(true);
  return sys;
}

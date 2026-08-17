import * as THREE from 'three';
import { Rng } from '../core/rng';

/**
 * Everything here is generated at runtime on a 2D canvas — no external image
 * files. Each surface ships a colour map plus a matching normal + roughness map
 * derived from the same height field, which is what keeps asphalt reading as
 * asphalt under a moving sun instead of as flat grey paint.
 */

const SIZE = 512;

type Field = Float32Array;

/** Tileable value-noise lattice, bilinear sampled. */
function lattice(res: number, rng: Rng): Field {
  const f = new Float32Array(res * res);
  for (let i = 0; i < f.length; i++) f[i] = rng.next();
  return f;
}

function sampleWrapped(f: Field, res: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = ((xi % res) + res) % res;
  const y0 = ((yi % res) + res) % res;
  const x1 = (x0 + 1) % res;
  const y1 = (y0 + 1) % res;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = f[y0 * res + x0] * (1 - sx) + f[y0 * res + x1] * sx;
  const b = f[y1 * res + x0] * (1 - sx) + f[y1 * res + x1] * sx;
  return a * (1 - sy) + b * sy;
}

/** Fractal brownian motion over tileable lattices. Returns 0..1 height field. */
export function fbm(
  size: number,
  baseRes: number,
  octaves: number,
  seed: number,
  gain = 0.5,
): Field {
  const rng = new Rng(seed);
  const out = new Float32Array(size * size);
  let amp = 1;
  let total = 0;
  let res = baseRes;

  for (let o = 0; o < octaves; o++) {
    const lat = lattice(res, rng);
    const scale = res / size;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out[y * size + x] += amp * sampleWrapped(lat, res, x * scale, y * scale);
      }
    }
    total += amp;
    amp *= gain;
    res = Math.min(res * 2, size);
  }

  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

/** Sobel-style height -> tangent-space normal map (OpenGL +Y convention). */
function normalFromHeight(h: Field, size: number, strength: number): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const at = (x: number, y: number) =>
    h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const dy = (at(x, y - 1) - at(x, y + 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      d[i] = ((dx / len) * 0.5 + 0.5) * 255;
      d[i + 1] = ((dy / len) * 0.5 + 0.5) * 255;
      d[i + 2] = (1 / len) * 0.5 * 255 + 127.5;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return finish(cv);
}

/** Greyscale field -> single-channel-ish texture, used for roughness/AO. */
function grayFromField(
  f: Field,
  size: number,
  lo: number,
  hi: number,
): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < f.length; i++) {
    const v = Math.round((lo + f[i] * (hi - lo)) * 255);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return finish(cv);
}

function finish(cv: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function canvas(size = SIZE): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  return [cv, cv.getContext('2d')!];
}

export interface SurfaceMaps {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function setRepeat(maps: SurfaceMaps, r: number) {
  for (const t of [maps.map, maps.normalMap, maps.roughnessMap]) t.repeat.set(r, r);
}

/* ------------------------------------------------------------------ asphalt */

export function asphalt(repeat = 1): SurfaceMaps {
  const size = SIZE;
  const grit = fbm(size, 128, 4, 11, 0.55);
  const patches = fbm(size, 8, 3, 12, 0.6);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let i = 0; i < grit.length; i++) {
    // Sun-bleached Solara asphalt: warm grey, blotchy from patch repairs.
    const g = grit[i];
    const p = patches[i];
    const base = 46 + p * 26 + (g - 0.5) * 40;
    d[i * 4] = base * 1.04;
    d[i * 4 + 1] = base * 1.0;
    d[i * 4 + 2] = base * 0.97;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Scatter light aggregate so it sparkles a little in raking light.
  const rng = new Rng(4);
  for (let i = 0; i < 5200; i++) {
    const a = rng.range(0.04, 0.16);
    ctx.fillStyle = `rgba(200,196,188,${a})`;
    ctx.beginPath();
    ctx.arc(rng.range(0, size), rng.range(0, size), rng.range(0.4, 1.5), 0, Math.PI * 2);
    ctx.fill();
  }

  const maps: SurfaceMaps = {
    map: finish(cv),
    normalMap: normalFromHeight(grit, size, 2.2),
    roughnessMap: grayFromField(grit, size, 0.72, 0.96),
  };
  setRepeat(maps, repeat);
  return maps;
}

/* ---------------------------------------------------------------- sidewalk  */

/** The salmon-pink pavement that defines the look of the strip. */
export function sidewalk(repeat = 1): SurfaceMaps {
  const size = SIZE;
  const grain = fbm(size, 96, 4, 21, 0.5);
  const blotch = fbm(size, 6, 3, 22, 0.6);
  const [cv, ctx] = canvas(size);

  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < grain.length; i++) {
    const g = (grain[i] - 0.5) * 26;
    const b = (blotch[i] - 0.5) * 22;
    d[i * 4] = 214 + g + b;
    d[i * 4 + 1] = 154 + g * 0.9 + b * 0.8;
    d[i * 4 + 2] = 141 + g * 0.85 + b * 0.7;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  // Pale terrazzo chips.
  const rng = new Rng(7);
  for (let i = 0; i < 2600; i++) {
    ctx.fillStyle = rng.chance(0.65)
      ? `rgba(238,214,203,${rng.range(0.18, 0.5)})`
      : `rgba(150,96,88,${rng.range(0.1, 0.3)})`;
    ctx.beginPath();
    ctx.arc(rng.range(0, size), rng.range(0, size), rng.range(0.6, 2.4), 0, Math.PI * 2);
    ctx.fill();
  }

  // Expansion joints: two seams per tile so slabs read at walking scale.
  const heights = Float32Array.from(grain);
  ctx.strokeStyle = 'rgba(120,74,70,0.55)';
  ctx.lineWidth = 2.5;
  for (const p of [0.5, 1.0]) {
    const c = p * size - 1;
    ctx.beginPath();
    ctx.moveTo(c, 0);
    ctx.lineTo(c, size);
    ctx.moveTo(0, c);
    ctx.lineTo(size, c);
    ctx.stroke();
    for (let k = -2; k <= 2; k++) {
      const x = Math.round(c + k);
      for (let j = 0; j < size; j++) {
        heights[j * size + ((x % size) + size) % size] *= 0.25;
        heights[(((x % size) + size) % size) * size + j] *= 0.25;
      }
    }
  }

  const maps: SurfaceMaps = {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 3.0),
    roughnessMap: grayFromField(grain, size, 0.62, 0.88),
  };
  setRepeat(maps, repeat);
  return maps;
}

/* ------------------------------------------------------- tactile paving pad */

/** Yellow truncated-dome ADA pad at the crossing, straight out of the ref shot. */
export function tactilePaving(): SurfaceMaps {
  const size = SIZE;
  const [cv, ctx] = canvas(size);
  ctx.fillStyle = '#d8a53a';
  ctx.fillRect(0, 0, size, size);

  const cols = 8;
  const step = size / cols;
  const heights = new Float32Array(size * size);

  for (let gy = 0; gy < cols; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const cx = (gx + 0.5) * step;
      const cy = (gy + 0.5) * step;
      const r = step * 0.31;
      const grad = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
      grad.addColorStop(0, '#f5cd6d');
      grad.addColorStop(0.7, '#dCA83f');
      grad.addColorStop(1, '#a97c26');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();

      for (let y = Math.floor(cy - r); y <= cy + r; y++) {
        for (let x = Math.floor(cx - r); x <= cx + r; x++) {
          const dd = Math.hypot(x - cx, y - cy) / r;
          if (dd < 1) {
            const yy = ((y % size) + size) % size;
            const xx = ((x % size) + size) % size;
            heights[yy * size + xx] = Math.cos(dd * Math.PI * 0.5);
          }
        }
      }
    }
  }

  const rng = new Rng(9);
  for (let i = 0; i < 900; i++) {
    ctx.fillStyle = `rgba(90,66,20,${rng.range(0.03, 0.12)})`;
    ctx.fillRect(rng.range(0, size), rng.range(0, size), rng.range(1, 3), rng.range(1, 3));
  }

  return {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 8),
    roughnessMap: grayFromField(heights, size, 0.55, 0.8),
  };
}

/* ------------------------------------------------------------------ stucco  */

/**
 * Art Deco facade plaster, generated neutral. Callers tint with
 * `material.color` so every pastel on the strip shares one texture instead of
 * baking a fresh 512² canvas per building.
 */
export function stucco(repeat = 1): SurfaceMaps {
  const size = SIZE;
  const fine = fbm(size, 160, 4, 31, 0.5);
  const wide = fbm(size, 5, 3, 32, 0.65);
  const [cv, ctx] = canvas(size);

  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < fine.length; i++) {
    const v = 1 + (fine[i] - 0.5) * 0.16 + (wide[i] - 0.5) * 0.13;
    const g = Math.min(255, 255 * v);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const maps: SurfaceMaps = {
    map: finish(cv),
    normalMap: normalFromHeight(fine, size, 1.6),
    roughnessMap: grayFromField(fine, size, 0.78, 0.95),
  };
  setRepeat(maps, repeat);
  return maps;
}

/* ------------------------------------------------------------------- fabric */

/** Canvas awning weave — subtle warp/weft so the canopies aren't flat plastic. */
export function awningFabric(repeat = 1): SurfaceMaps {
  const size = 256;
  const heights = new Float32Array(size * size);
  const [cv, ctx] = canvas(size);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const weave = Math.sin(x * 1.1) * 0.5 + Math.sin(y * 1.1) * 0.5;
      const v = 1 + weave * 0.06;
      const i = (y * size + x) * 4;
      d[i] *= v;
      d[i + 1] *= v;
      d[i + 2] *= v;
      heights[y * size + x] = weave * 0.5 + 0.5;
    }
  }
  ctx.putImageData(img, 0, 0);

  const maps: SurfaceMaps = {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 1.1),
    roughnessMap: grayFromField(heights, size, 0.7, 0.88),
  };
  setRepeat(maps, repeat);
  return maps;
}

/* -------------------------------------------------------------------- sand  */

export function sand(repeat = 1): SurfaceMaps {
  const size = SIZE;
  const g = fbm(size, 140, 4, 51, 0.5);
  const dunes = fbm(size, 7, 3, 52, 0.6);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < g.length; i++) {
    const v = 1 + (g[i] - 0.5) * 0.1 + (dunes[i] - 0.5) * 0.12;
    d[i * 4] = 226 * v;
    d[i * 4 + 1] = 205 * v;
    d[i * 4 + 2] = 172 * v;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const maps: SurfaceMaps = {
    map: finish(cv),
    normalMap: normalFromHeight(g, size, 2.4),
    roughnessMap: grayFromField(g, size, 0.86, 0.99),
  };
  setRepeat(maps, repeat);
  return maps;
}

/* ------------------------------------------------------------ palm textures */

/** One palm frond, alpha-cut from a canvas — cheaper and softer than geometry. */
export function frondAlpha(): { map: THREE.Texture; alphaMap: THREE.Texture } {
  const w = 256;
  const h = 512;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);

  const rng = new Rng(77);
  const midX = w / 2;

  // Leaflets are drawn as filled tapered blades, not strokes. Thin strokes get
  // eaten by mipmapping and the alpha test and leave the palm looking bald.
  for (let i = 0; i < 46; i++) {
    const t = i / 45;
    const y = h - 14 - t * (h - 34);
    const len = (1 - Math.pow(t, 2.1)) * w * 0.49 * rng.range(0.9, 1.05);
    const halfW = (10 - t * 4) * rng.range(0.85, 1.15);
    const droop = 30 + t * 46;

    for (const s of [-1, 1]) {
      const tipX = midX + s * len;
      const tipY = y + droop;
      const grad = ctx.createLinearGradient(midX, y, tipX, tipY);
      grad.addColorStop(0, '#4d6a22');
      grad.addColorStop(0.45, '#78983a');
      grad.addColorStop(1, '#a3c256');
      ctx.fillStyle = grad;

      // Blade: wide at the rachis, tapering to a point, bowed downward.
      ctx.beginPath();
      ctx.moveTo(midX, y - halfW * 0.55);
      ctx.quadraticCurveTo(midX + s * len * 0.5, y - halfW * 0.2, tipX, tipY);
      ctx.quadraticCurveTo(midX + s * len * 0.45, y + halfW * 1.5, midX, y + halfW * 0.75);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Rachis over the top so the leaflets read as attached to a spine.
  const rg = ctx.createLinearGradient(midX, h, midX, 0);
  rg.addColorStop(0, '#6d8232');
  rg.addColorStop(1, '#9cb457');
  ctx.strokeStyle = rg;
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(midX, h - 4);
  ctx.lineTo(midX, 10);
  ctx.stroke();

  const map = new THREE.CanvasTexture(cv);
  map.colorSpace = THREE.SRGBColorSpace;

  // Alpha from the drawn coverage.
  const acv = document.createElement('canvas');
  acv.width = w;
  acv.height = h;
  const actx = acv.getContext('2d')!;
  const src = ctx.getImageData(0, 0, w, h);
  const dst = actx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const a = src.data[i * 4 + 3];
    dst.data[i * 4] = dst.data[i * 4 + 1] = dst.data[i * 4 + 2] = a;
    dst.data[i * 4 + 3] = 255;
  }
  actx.putImageData(dst, 0, 0);
  const alphaMap = new THREE.CanvasTexture(acv);

  return { map, alphaMap };
}

/** Fibrous palm trunk. */
export function palmBark(): SurfaceMaps {
  const size = 256;
  const n = fbm(size, 40, 3, 61, 0.55);
  const heights = new Float32Array(size * size);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Diamond-shaped leaf scars ringing the trunk.
      const rings = Math.abs(((y * 0.28 + x * 0.14) % 2) - 1);
      const v = 0.72 + n[i] * 0.3 + rings * 0.24;
      heights[i] = rings * 0.6 + n[i] * 0.4;
      d[i * 4] = 138 * v;
      d[i * 4 + 1] = 122 * v;
      d[i * 4 + 2] = 100 * v;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  return {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 3.5),
    roughnessMap: grayFromField(n, size, 0.8, 0.98),
  };
}

/* ------------------------------------------------------------------- skin   */

/**
 * Skin with pore-level break-up; flat skin is the fastest way to look cheap.
 * Neutral, so one texture serves every skin tone in the crowd via material tint.
 */
export function skin(): SurfaceMaps {
  const size = 256;
  const pores = fbm(size, 128, 3, 71, 0.5);
  const mottle = fbm(size, 10, 3, 72, 0.6);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let i = 0; i < pores.length; i++) {
    const v = 1 + (pores[i] - 0.5) * 0.07 + (mottle[i] - 0.5) * 0.1;
    // Blotches lean red rather than grey — blood under the surface.
    d[i * 4] = Math.min(255, 255 * v * (1 + (mottle[i] - 0.5) * 0.05));
    d[i * 4 + 1] = Math.min(255, 255 * v);
    d[i * 4 + 2] = Math.min(255, 255 * v * (1 - (mottle[i] - 0.5) * 0.04));
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  return {
    map: finish(cv),
    normalMap: normalFromHeight(pores, size, 0.9),
    roughnessMap: grayFromField(pores, size, 0.42, 0.62),
  };
}

/** Ribbed knit for tops. Neutral; tint via material colour. */
export function knit(): SurfaceMaps {
  const size = 256;
  const n = fbm(size, 96, 3, 81, 0.5);
  const heights = new Float32Array(size * size);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const rib = Math.sin(x * 0.55) * 0.5 + 0.5;
      const v = 0.9 + rib * 0.16 + (n[i] - 0.5) * 0.12;
      heights[i] = rib * 0.7 + n[i] * 0.3;
      const g = Math.min(255, 255 * v);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  return {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 2.0),
    roughnessMap: grayFromField(n, size, 0.68, 0.9),
  };
}

/** Twill denim for shorts and trousers. Neutral; tint via material colour. */
export function denim(): SurfaceMaps {
  const size = 256;
  const n = fbm(size, 120, 3, 91, 0.5);
  const heights = new Float32Array(size * size);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  const d = img.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const twill = Math.sin((x + y) * 0.8) * 0.5 + 0.5;
      const v = 0.88 + twill * 0.2 + (n[i] - 0.5) * 0.18;
      heights[i] = twill * 0.6 + n[i] * 0.4;
      const g = Math.min(255, 255 * v);
      d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = g;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  return {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 1.8),
    roughnessMap: grayFromField(n, size, 0.72, 0.92),
  };
}

/** Mark every colour map as sRGB. Call once after building a maps bundle. */
export function asColor(m: SurfaceMaps): SurfaceMaps {
  m.map.colorSpace = THREE.SRGBColorSpace;
  return m;
}

/* ------------------------------------------------------------- facades  */

/**
 * A tileable block of windows, for the inland city.
 *
 * The beachfront hotels build every window as geometry, which is right for the
 * dozen buildings you walk past. A hundred more inland can't afford that, so
 * they get a box with this texture repeated per bay and per floor instead. The
 * result is neutral, so the wall colour comes from vertex colours and the whole
 * city merges into a single draw call per chunk.
 */
export function facade(opts: {
  /** Fraction of the bay taken by glass. */
  glass: number;
  /** Darkness of the glazing, 0..1. */
  tint: number;
  /** Horizontal band between floors. */
  spandrel: boolean;
  seed: number;
}): SurfaceMaps {
  const size = 256;
  const [cv, ctx] = canvas(size);
  const rng = new Rng(opts.seed);

  // Wall: neutral, so material/vertex colour decides the actual hue.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const grain = fbm(size, 64, 3, opts.seed + 1, 0.5);
  const img = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < grain.length; i++) {
    const v = 1 + (grain[i] - 0.5) * 0.1;
    img.data[i * 4] *= v;
    img.data[i * 4 + 1] *= v;
    img.data[i * 4 + 2] *= v;
  }
  ctx.putImageData(img, 0, 0);

  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = 0.62;

  // One bay per tile, one floor per tile.
  const margin = (1 - opts.glass) * 0.5 * size;
  const wx = margin;
  const ww = size - margin * 2;
  const wy = size * 0.16;
  const wh = size * (opts.spandrel ? 0.56 : 0.68);

  // Reveal: the window sits back in the wall, so it reads with depth.
  ctx.fillStyle = 'rgba(140,140,140,0.5)';
  ctx.fillRect(wx - 3, wy - 3, ww + 6, wh + 6);

  // Glazing, with a sky gradient so it doesn't read as a flat hole.
  const g = ctx.createLinearGradient(0, wy, 0, wy + wh);
  const dark = Math.round(24 + (1 - opts.tint) * 70);
  g.addColorStop(0, `rgb(${dark + 46},${dark + 58},${dark + 66})`);
  g.addColorStop(0.45, `rgb(${dark + 10},${dark + 18},${dark + 24})`);
  g.addColorStop(1, `rgb(${dark},${dark + 6},${dark + 8})`);
  ctx.fillStyle = g;
  ctx.fillRect(wx, wy, ww, wh);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x >= wx && x < wx + ww && y >= wy && y < wy + wh) {
        heights[y * size + x] = 0.1;
      }
    }
  }

  // Mullions.
  ctx.fillStyle = 'rgba(210,210,206,0.85)';
  const cols = 2;
  for (let i = 1; i < cols; i++) {
    ctx.fillRect(wx + (ww / cols) * i - 1.5, wy, 3, wh);
  }
  ctx.fillRect(wx, wy + wh * 0.52, ww, 3);

  // A few blinds and lit rooms, so the grid isn't perfectly uniform.
  if (rng.chance(0.45)) {
    ctx.fillStyle = `rgba(228,222,206,${rng.range(0.35, 0.8)})`;
    ctx.fillRect(wx, wy, ww, wh * rng.range(0.2, 0.6));
  }

  if (opts.spandrel) {
    ctx.fillStyle = 'rgba(232,229,222,0.9)';
    ctx.fillRect(0, size * 0.84, size, size * 0.16);
    for (let y = Math.floor(size * 0.84); y < size; y++) {
      for (let x = 0; x < size; x++) heights[y * size + x] = 0.85;
    }
  }

  const maps: SurfaceMaps = {
    map: finish(cv),
    normalMap: normalFromHeight(heights, size, 2.6),
    roughnessMap: grayFromField(heights, size, 0.25, 0.85),
  };
  return maps;
}

/**
 * The same facade, as an emissive map of lit windows for after dark.
 *
 * Laid out as a `cells` x `cells` block rather than a single bay, because the
 * colour map tiles once per bay and once per floor — reusing that frequency
 * would switch every window in the city on and off in unison. Set this as
 * `emissiveMap` with `repeat = 1 / cells` and the pattern spans several bays
 * before it repeats, which is enough to read as random from the street.
 *
 * Window rectangles are positioned with exactly the same fractions as
 * `facade()`, so the glow lands on the glass and not on the wall.
 */
export function facadeLit(opts: {
  glass: number;
  spandrel: boolean;
  seed: number;
  cells: number;
}): THREE.Texture {
  const cell = 128;
  const n = opts.cells;
  const size = cell * n;
  const [cv, ctx] = canvas(size);
  const rng = new Rng(opts.seed);

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, size, size);

  const margin = (1 - opts.glass) * 0.5 * cell;
  const ww = cell - margin * 2;
  const wy = cell * 0.16;
  const wh = cell * (opts.spandrel ? 0.56 : 0.68);

  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      // Most windows are dark. A city where every window is lit looks like a
      // grid of LEDs, not a building.
      if (!rng.chance(0.42)) continue;
      const ox = cx * cell + margin;
      const oy = cy * cell + wy;

      const warm = rng.chance(0.78);
      const bright = rng.range(0.45, 1.0);
      const r = Math.round((warm ? 255 : 198) * bright);
      const g = Math.round((warm ? 214 : 216) * bright);
      const b = Math.round((warm ? 150 : 244) * bright);
      ctx.fillStyle = `rgb(${r},${g},${b})`;

      // Some rooms are only half lit — a blind down, or one room of a flat.
      const h = rng.chance(0.3) ? wh * rng.range(0.35, 0.7) : wh;
      ctx.fillRect(ox, oy + (wh - h), ww, h);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / n, 1 / n);
  return tex;
}

/** A soft radial pool of light, for lamps to cast on the pavement. */
export function lightPool(): THREE.Texture {
  const size = 128;
  const [cv, ctx] = canvas(size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,236,196,1)');
  g.addColorStop(0.35, 'rgba(255,224,170,0.55)');
  g.addColorStop(0.7, 'rgba(240,200,150,0.16)');
  g.addColorStop(1, 'rgba(220,180,130,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Flat roof gravel and plant, so towers aren't capped with a blank lid. */
export function roofDeck(): SurfaceMaps {
  const size = 256;
  const n = fbm(size, 96, 4, 313, 0.55);
  const [cv, ctx] = canvas(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < n.length; i++) {
    const v = 150 + n[i] * 70;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v * 0.98;
    img.data[i * 4 + 2] = v * 0.94;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: finish(cv),
    normalMap: normalFromHeight(n, size, 2),
    roughnessMap: grayFromField(n, size, 0.8, 0.98),
  };
}

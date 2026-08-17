import * as THREE from 'three';
import { Rng } from '../core/rng';
import * as T from '../render/textures';

/**
 * Street-level detail kit for the inland city.
 *
 * The city's problem was never its massing — it was that every building met the
 * pavement as a blank plaster wall. This module supplies the things you actually
 * look at from head height: recessed shopfronts, fascia signs, awnings, neon,
 * blade signs, fire escapes and rooftop clutter.
 *
 * Everything here obeys one rule: **materials are shared and cached**. A hundred
 * buildings' worth of shopfronts must collapse into a handful of draw calls in
 * `bakeStatic`, which buckets by material identity. Anything that news up a
 * material per building silently multiplies the draw count by a hundred.
 *
 * Signage is the awkward case, since text needs a canvas. Rather than a canvas
 * per sign, every shop name in the city is drawn once into a single atlas and
 * each sign is a quad with UVs into its cell — so all of them share one
 * material and merge together too.
 */

/* ----------------------------------------------------------- materials */

const matCache = new Map<string, THREE.MeshStandardMaterial>();

function mat(
  key: string,
  make: () => THREE.MeshStandardMaterialParameters,
): THREE.MeshStandardMaterial {
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial(make());
    matCache.set(key, m);
  }
  return m;
}

/**
 * Shop glazing.
 *
 * Nearly a mirror, on purpose. A dark diffuse pane reads as a black hole in the
 * wall in daylight, which is what a row of shops must never look like; a
 * metallic, near-smooth pane picks up the sky and the buildings opposite from
 * the environment map and reads as glass with the street in it.
 */
const shopGlass = () =>
  mat('shopGlass', () => ({
    color: 0x74909c,
    // Metalness stays low on purpose. A fully metallic pane has no diffuse
    // term, so all of its colour has to come from the environment — and
    // `environmentIntensity` is deliberately tiny here (see CLAUDE.md), which
    // turned every shopfront into a black rectangle.
    roughness: 0.14,
    metalness: 0.3,
    envMapIntensity: 3.0,
  }));

const mullion = () => mat('mullion', () => ({ color: 0x2b2f33, roughness: 0.4, metalness: 0.7 }));
const darkMetal = () => mat('darkMetal', () => ({ color: 0x33383c, roughness: 0.5, metalness: 0.75 }));
const paleMetal = () => mat('paleMetal', () => ({ color: 0x9aa0a6, roughness: 0.42, metalness: 0.8 }));
const stone = () => mat('kitStone', () => ({ color: 0xd8d2c6, roughness: 0.85 }));
const darkStone = () => mat('kitDarkStone', () => ({ color: 0x4c4a46, roughness: 0.8 }));
const timber = () => mat('kitTimber', () => ({ color: 0x8a6440, roughness: 0.85 }));

/**
 * Painted fascia / bulkhead colours — the band a shop sign sits on. Mixed dark
 * and light: an unbroken run of dark fascias turns the whole street into a
 * black stripe at eye level, which is its own kind of dull.
 */
const FASCIA_COLOURS = [
  0x1d2b3a, 0x2c1f3d, 0x123a33, 0x4a1725, 0x0f2740, 0x3a2413,
  0xe8dcc4, 0xd9c3a8, 0xc8dad6, 0xe6c9b8, 0xf0e6d2, 0xb8ccd4,
];

function fasciaMat(colour: number) {
  return mat(`fascia${colour}`, () => ({ color: colour, roughness: 0.62 }));
}

/**
 * Awning canvas colours, straight off Ocean Drive. Weighted towards the
 * saturated end — the pale ones read as grey wedges from across the street,
 * and the coral/teal ones are what makes the reference frame look like Miami.
 */
export const AWNING_COLOURS = [
  0xc9403f, 0xd0625f, 0xd0625f, 0xe07a4a, 0x1f7f70, 0x2f7f74,
  0x2a5f9c, 0xd9a23c, 0xc9557f, 0xc9557f, 0x4d8f4a, 0xdedad0,
];

function awningMat(colour: number) {
  return mat(`kitAwning${colour}`, () => ({
    color: colour,
    roughness: 0.88,
    side: THREE.DoubleSide,
  }));
}

/* --------------------------------------------------------------- neon */

/**
 * Neon colours. `emissiveIntensity` is set well above 1 because everything in
 * this renderer is scaled against absolute sky radiance, not against 1.0 — but
 * deliberately below the 5.5 bloom threshold in `render/post.ts`, so signs read
 * as saturated and lit in daylight without smearing the whole frame.
 */
export const NEON_COLOURS = [
  0xff2f6d, 0x28e0ff, 0xff8a1e, 0x9d4bff, 0x35ff9e, 0xffe23a, 0xff4fd1, 0x4d7bff,
];

export function neonMat(colour: number): THREE.MeshStandardMaterial {
  return mat(`neon${colour}`, () => ({
    color: 0x0a0a0c,
    emissive: colour,
    emissiveIntensity: 3.4,
    roughness: 0.4,
    metalness: 0,
  }));
}

/** Warm interior glow behind shop glazing, so shops read as occupied. */
function interiorMat() {
  return mat('shopInterior', () => ({
    color: 0x120e0a,
    emissive: 0xffcf8a,
    emissiveIntensity: 1.5,
    roughness: 0.9,
  }));
}

/* ------------------------------------------------- street lighting */

/**
 * Lamp head, and the pool of light it throws on the ground.
 *
 * Hundreds of real point lights are out of the question, so a lit street is an
 * emissive head plus an additive disc on the pavement. Both are shared
 * materials, so every lamp in the world merges into two draw calls and switches
 * on with two writes.
 */
export function lampHeadMat(): THREE.MeshStandardMaterial {
  return mat('streetLampHead', () => ({
    color: 0xe8e4d8,
    emissive: 0xffd79a,
    emissiveIntensity: 0,
    roughness: 0.4,
  }));
}

let poolMaterial: THREE.MeshBasicMaterial | null = null;

export function lightPoolMat(): THREE.MeshBasicMaterial {
  if (!poolMaterial) {
    poolMaterial = new THREE.MeshBasicMaterial({
      map: T.lightPool(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    });
  }
  return poolMaterial;
}

/** A flat additive disc of lamplight, `size` metres across, laid at y = 0. */
export function lightPool(size: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), lightPoolMat());
  m.rotation.x = -Math.PI / 2;
  return m;
}

/**
 * Deco promenade lamp: a fluted column with a frosted globe on top, of the kind
 * that lines Ocean Drive. Local origin at the pavement.
 */
export function promenadeLamp(): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.15, 4.2, 10), darkMetal());
  post.position.y = 2.1;
  post.castShadow = true;
  g.add(post);
  g.add(box(0.42, 0.16, 0.42, 0, 0.08, 0, darkMetal()));
  g.add(box(0.34, 0.12, 0.34, 0, 4.24, 0, darkMetal()));

  const globe = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10), lampHeadMat());
  globe.position.y = 4.6;
  g.add(globe);

  const pool = lightPool(13);
  pool.position.y = 0.03;
  g.add(pool);
  return g;
}

/* ------------------------------------------------------------- night */

/**
 * Day/night response for everything in this kit.
 *
 * All of it works by scaling `emissiveIntensity` on the shared cached
 * materials, so one call re-lights every shopfront, sign and neon tube in the
 * city without touching a single mesh. Daytime values are deliberately modest —
 * neon in full sun reads as saturated paint, not as light — and night values
 * are pushed above the bloom threshold so they actually glow.
 */
export function setNight(f: number): void {
  const t = Math.min(1, Math.max(0, f));
  for (const [key, m] of matCache) {
    if (key.startsWith('neon')) {
      m.emissiveIntensity = 3.4 + t * 1.4;
    } else if (key === 'shopInterior') {
      m.emissiveIntensity = 1.5 + t * 1.5;
    } else if (key === 'shopGlass') {
      // Glass has nothing to reflect once the sky goes out, so let a little of
      // the shop interior bleed through it instead of going pure black.
      m.emissive.setHex(0x2a2016);
      m.emissiveIntensity = t * 0.9;
    }
  }
  if (signMaterial) signMaterial.emissiveIntensity = 1.35 + t * 1.8;
  if (bladeMaterial) bladeMaterial.emissiveIntensity = 2.0 + t * 1.6;

  // Lamps come on over the last part of dusk rather than tracking the sun
  // linearly: street lighting switches on when it gets dark, not at sunset.
  const lit = Math.pow(t, 0.7);
  lampHeadMat().emissiveIntensity = lit * 6.5;
  lightPoolMat().opacity = lit * 0.5;
}

/* --------------------------------------------------------- box helper */

function box(
  w: number,
  h: number,
  d: number,
  x: number,
  y: number,
  z: number,
  m: THREE.Material,
): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/* --------------------------------------------------------- sign atlas */

/**
 * Every shop name in the city, drawn once into one texture.
 *
 * 4 columns x 8 rows of 512x128 cells. `signBoard` hands back a quad whose UVs
 * address one cell, so a thousand signs cost one material and one draw call.
 */
const SIGN_NAMES = [
  'EL PELICANO', 'PALMERA BARBERS', 'CAFE SOLARA', 'SURF SHACK',
  'GOLD & GEMS', 'TAQUERIA', '24H DINER', 'LAUNDROMAT',
  'PAWN', 'SUNSET DELI', 'PIZZA NAPOLI', 'INK & NEEDLE',
  'BODEGA', 'CUBAN COFFEE', 'PHARMACY', 'ARCADE',
  'VINYL RECORDS', 'BOXING GYM', 'SUSHI BAR', 'KEY LIME',
  'NAILS', 'LIQUOR', 'FLAMINGO SPA', 'PALM LAUNDRY',
  'CHECK CASHING', 'DRY CLEANING', 'HAVANA GRILL', 'THE BLUE ROOM',
  'MOTOR PARTS', 'FRESH MARKET', 'ESPRESSO', 'DOLLAR STORE',
];

const SIGN_COLS = 4;
const SIGN_ROWS = 8;

const SIGN_STYLES: Array<[string, string, string]> = [
  // [background, text, accent rule]
  ['#101018', '#ff3d74', '#ff3d74'],
  ['#0d1f2a', '#2ee6ff', '#2ee6ff'],
  ['#f2ead8', '#1c2b3a', '#b5342a'],
  ['#1b1030', '#ffb43a', '#ffb43a'],
  ['#0f2b20', '#5dffb0', '#5dffb0'],
  ['#3a0f1c', '#ffe0b8', '#ff8a3a'],
  ['#141416', '#f4f0e6', '#9d4bff'],
  ['#123048', '#ffe23a', '#ffe23a'],
];

const SIGN_FONTS = [
  '"Impact", "Haettenschweiler", sans-serif',
  '"Futura", "Century Gothic", sans-serif',
  '"Copperplate", Georgia, serif',
  '"Gill Sans", "Trebuchet MS", sans-serif',
];

let signMaterial: THREE.MeshStandardMaterial | null = null;

function buildSignAtlas(): THREE.MeshStandardMaterial {
  if (signMaterial) return signMaterial;

  const cw = 512;
  const ch = 128;
  const cv = document.createElement('canvas');
  cv.width = cw * SIGN_COLS;
  cv.height = ch * SIGN_ROWS;
  const ctx = cv.getContext('2d')!;

  for (let i = 0; i < SIGN_NAMES.length; i++) {
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    const ox = col * cw;
    const oy = row * ch;
    const [bg, fg, accent] = SIGN_STYLES[i % SIGN_STYLES.length];

    ctx.fillStyle = bg;
    ctx.fillRect(ox, oy, cw, ch);

    // Accent rules top and bottom — reads as a lit sign box from the street.
    ctx.fillStyle = accent;
    ctx.fillRect(ox + 8, oy + 7, cw - 16, 5);
    ctx.fillRect(ox + 8, oy + ch - 12, cw - 16, 5);

    const name = SIGN_NAMES[i];
    ctx.font = `700 ${ch * 0.46}px ${SIGN_FONTS[i % SIGN_FONTS.length]}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Squeeze long names rather than letting them overrun the cell.
    const target = cw - 44;
    const w = ctx.measureText(name).width;
    ctx.save();
    ctx.translate(ox + cw / 2, oy + ch / 2 + 1);
    if (w > target) ctx.scale(target / w, 1);
    ctx.shadowColor = accent;
    ctx.shadowBlur = 18;
    ctx.fillStyle = fg;
    ctx.fillText(name, 0, 0);
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  signMaterial = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    // Only the bright letters carry any emission; the dark board stays dark.
    emissiveIntensity: 1.35,
    roughness: 0.55,
    metalness: 0,
  });
  return signMaterial;
}

/** A quad showing sign `index` from the shared atlas. Aspect is 4:1. */
export function signBoard(index: number, widthM: number, heightM: number): THREE.Mesh {
  const m = buildSignAtlas();
  const geo = new THREE.PlaneGeometry(widthM, heightM);
  const col = index % SIGN_COLS;
  const row = Math.floor(index / SIGN_COLS) % SIGN_ROWS;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (col + uv.getX(i)) / SIGN_COLS,
      (SIGN_ROWS - 1 - row + uv.getY(i)) / SIGN_ROWS,
    );
  }
  uv.needsUpdate = true;
  return new THREE.Mesh(geo, m);
}

export const SIGN_COUNT = SIGN_NAMES.length;

/* -------------------------------------------------------- blade signs */

/**
 * The vertical projecting sign — the single most recognisable thing on the
 * Ocean Drive skyline after the awnings. Same atlas trick, letters stacked.
 */
const BLADE_NAMES = ['HOTEL', 'BAR', 'CAFE', 'MOTEL', 'ROOMS', 'CLUB', 'DELI', 'CINEMA'];
const BLADE_COLS = 4;
const BLADE_ROWS = 2;

let bladeMaterial: THREE.MeshStandardMaterial | null = null;

function buildBladeAtlas(): THREE.MeshStandardMaterial {
  if (bladeMaterial) return bladeMaterial;

  const cw = 256;
  const ch = 1024;
  const cv = document.createElement('canvas');
  cv.width = cw * BLADE_COLS;
  cv.height = ch * BLADE_ROWS;
  const ctx = cv.getContext('2d')!;

  for (let i = 0; i < BLADE_NAMES.length; i++) {
    const col = i % BLADE_COLS;
    const row = Math.floor(i / BLADE_COLS);
    const ox = col * cw;
    const oy = row * ch;
    const neon = `#${NEON_COLOURS[i % NEON_COLOURS.length].toString(16).padStart(6, '0')}`;

    ctx.fillStyle = '#141418';
    ctx.fillRect(ox, oy, cw, ch);
    ctx.strokeStyle = neon;
    ctx.lineWidth = 8;
    ctx.strokeRect(ox + 14, oy + 14, cw - 28, ch - 28);

    const name = BLADE_NAMES[i];
    const step = (ch - 90) / name.length;
    ctx.font = `700 ${Math.min(step * 0.82, cw * 0.62)}px "Impact", "Haettenschweiler", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = neon;
    ctx.shadowBlur = 26;
    ctx.fillStyle = '#fdf6e8';
    for (let k = 0; k < name.length; k++) {
      const y = oy + 46 + step * (k + 0.5);
      ctx.fillText(name[k], ox + cw / 2, y);
      ctx.fillText(name[k], ox + cw / 2, y);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  bladeMaterial = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 2.0,
    roughness: 0.5,
    side: THREE.DoubleSide,
  });
  return bladeMaterial;
}

/**
 * A blade sign projecting from a wall. Local frame: wall at z = 0, sign hangs
 * out along +Z, `height` metres of it, top at y = 0.
 */
export function bladeSign(rng: Rng, height: number): THREE.Group {
  const g = new THREE.Group();
  const idx = rng.int(0, BLADE_NAMES.length - 1);
  const w = height / 4;

  const geo = new THREE.PlaneGeometry(w, height);
  const col = idx % BLADE_COLS;
  const row = Math.floor(idx / BLADE_COLS) % BLADE_ROWS;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(
      i,
      (col + uv.getX(i)) / BLADE_COLS,
      (BLADE_ROWS - 1 - row + uv.getY(i)) / BLADE_ROWS,
    );
  }
  uv.needsUpdate = true;

  const face = new THREE.Mesh(geo, buildBladeAtlas());
  // The blade stands edge-on to the wall, so it is read from up and down the
  // street rather than from straight in front of the building.
  face.rotation.y = Math.PI / 2;
  face.position.set(0, -height / 2, w / 2 + 0.4);
  g.add(face);

  // Box body behind the faces, and the brackets tying it to the wall.
  g.add(box(0.16, height, w, 0, -height / 2, w / 2 + 0.4, darkMetal()));
  for (const y of [-0.35, -height + 0.35]) {
    g.add(box(0.08, 0.08, w * 0.9, 0, y, w * 0.5, paleMetal()));
  }
  return g;
}

/* ------------------------------------------------------------- awning */

/**
 * Straight canvas awning. The beachfront hotels get the expensive scalloped
 * version in `buildings.ts`; a hundred inland shops get this, which is four
 * boxes and merges away to nothing.
 *
 * Local frame: wall at z = 0, canopy reaches out to +Z, hung from y = 0.
 */
export function awning(span: number, reach: number, colour: number): THREE.Group {
  const g = new THREE.Group();
  const m = awningMat(colour);
  const drop = 0.55;
  const slope = Math.hypot(reach, drop);

  const canopy = box(span, 0.05, slope, 0, -drop / 2, reach / 2, m);
  canopy.rotation.x = -Math.atan2(drop, reach);
  g.add(canopy);

  // Valance hanging off the front edge, where the shop name usually repeats.
  g.add(box(span, 0.3, 0.05, 0, -drop - 0.15, reach, m));

  // End cheeks close the triangle, otherwise you see straight up under it.
  // Explicit triangle rather than a Shape: the material is DoubleSide, so the
  // winding does not matter and this is three vertices instead of a extrusion.
  for (const s of [-1, 1]) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0, 0, 0, -drop, reach, 0, 0, reach], 3),
    );
    geo.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1], 2));
    const cheek = new THREE.Mesh(geo, m);
    cheek.position.x = (s * span) / 2;
    g.add(cheek);
  }

  return g;
}

/* -------------------------------------------------------- shopfronts */

export interface FrontageOpts {
  /** Width of the frontage along local X. */
  span: number;
  /** Height of the ground-floor storey. */
  height: number;
  /** How far the columns and fascia project forward, to meet the wall above. */
  project: number;
  /** Chance this frontage gets an awning over each bay. */
  awningChance?: number;
  /** Chance of a projecting blade sign. */
  bladeChance?: number;
}

/**
 * A row of shops.
 *
 * Local frame: the recessed glazing plane sits at z = 0 and faces +Z; the
 * columns and fascia project to z = `project`, meeting the wall of the floors
 * above. That overhang is what gives the shopfront its shadow — a shopfront
 * flush with the wall above reads as a painted stripe, which is exactly what
 * the city looked like before.
 */
export function retailFrontage(o: FrontageOpts, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const bays = Math.max(1, Math.round(o.span / rng.range(4.4, 6.4)));
  const bayW = o.span / bays;
  const colW = 0.5;
  const fasciaH = 0.95;
  const glazeTop = o.height - fasciaH - 0.12;
  const riser = 0.42;

  const fasciaColour = rng.pick(FASCIA_COLOURS);
  const doorBay = rng.int(0, bays - 1);
  const awnColour = rng.pick(AWNING_COLOURS);

  for (let b = 0; b < bays; b++) {
    const cx = -o.span / 2 + (b + 0.5) * bayW;
    const inner = bayW - colW;

    // Strip light along the head of the glazing. The glass itself is opaque,
    // so a lit slab *behind* it would simply be buried in the wall — this sits
    // just proud instead and gives every shop a lit interior line.
    g.add(box(inner - 0.2, 0.16, 0.1, cx, glazeTop - 0.22, 0.06, interiorMat()));

    if (b === doorBay) {
      // Doorway: recessed, with a transom over it.
      g.add(box(1.15, o.height * 0.62, 0.08, cx, (o.height * 0.62) / 2, -0.1, darkStone()));
      g.add(box(0.08, o.height * 0.62, 0.1, cx - 0.6, (o.height * 0.62) / 2, 0, mullion()));
      g.add(box(0.08, o.height * 0.62, 0.1, cx + 0.6, (o.height * 0.62) / 2, 0, mullion()));
      const side = (inner - 1.3) / 2;
      if (side > 0.4) {
        for (const s of [-1, 1]) {
          g.add(
            box(side, glazeTop - riser, 0.05, cx + s * (0.65 + side / 2), (glazeTop + riser) / 2, 0, shopGlass()),
          );
          g.add(box(side, riser, 0.14, cx + s * (0.65 + side / 2), riser / 2, 0.04, stone()));
        }
      }
    } else {
      // Plate glass over a stall riser, split by one or two mullions.
      g.add(box(inner, glazeTop - riser, 0.05, cx, (glazeTop + riser) / 2, 0, shopGlass()));
      g.add(box(inner + 0.1, riser, 0.16, cx, riser / 2, 0.05, stone()));
      const mullions = inner > 3.4 ? 2 : 1;
      for (let k = 1; k <= mullions; k++) {
        const mx = cx - inner / 2 + (inner / (mullions + 1)) * k;
        g.add(box(0.09, glazeTop - riser, 0.09, mx, (glazeTop + riser) / 2, 0.03, mullion()));
      }
    }

    // Bay pier, projecting forward to the wall line above.
    g.add(box(colW, o.height, o.project, cx - bayW / 2, o.height / 2, o.project / 2, stone()));
  }
  g.add(box(colW, o.height, o.project, o.span / 2, o.height / 2, o.project / 2, stone()));

  /* ----------------------------------------------------------- fascia */

  const fy = o.height - fasciaH / 2;
  g.add(box(o.span + colW, fasciaH, o.project + 0.12, 0, fy, o.project / 2, fasciaMat(fasciaColour)));

  // A sign per shop, not one per building. Each bay is a separate business, and
  // a single small plaque in the middle of a 20 m fascia is what an empty
  // shopping precinct looks like, not a high street.
  for (let b = 0; b < bays; b++) {
    const cx = -o.span / 2 + (b + 0.5) * bayW;
    const sw = Math.min(bayW * 0.88, fasciaH * 0.7 * 4);
    const sign = signBoard(rng.int(0, SIGN_COUNT - 1), sw, sw / 4);
    sign.position.set(cx, fy, o.project + 0.075);
    g.add(sign);
  }

  // Neon rule under the fascia — the horizontal glow line that defines the
  // strip at dusk, and still reads as trim in full sun.
  const neon = rng.pick(NEON_COLOURS);
  g.add(box(o.span, 0.09, 0.09, 0, o.height - fasciaH - 0.1, o.project + 0.02, neonMat(neon)));

  /* ---------------------------------------------------------- awnings */

  if (rng.chance(o.awningChance ?? 0.55)) {
    const reach = rng.range(1.5, 2.3);
    for (let b = 0; b < bays; b++) {
      if (rng.chance(0.15)) continue;
      const cx = -o.span / 2 + (b + 0.5) * bayW;
      const a = awning(bayW - colW - 0.1, reach, awnColour);
      a.position.set(cx, o.height - fasciaH - 0.28, o.project);
      g.add(a);
    }
  }

  if (rng.chance(o.bladeChance ?? 0.22)) {
    const b = bladeSign(rng, rng.range(3.4, 5.2));
    b.position.set(rng.range(-o.span / 2 + 1, o.span / 2 - 1), o.height + 4.2, o.project);
    g.add(b);
  }

  return g;
}

/**
 * Everything that hangs on a wall above the shopfronts: downpipes, condenser
 * units, wall lamps and a fire escape.
 *
 * Local frame matches the frontages — wall at z = 0, outward is +Z — but it
 * attaches to the *upper* wall plane, which stands proud of the recessed
 * ground floor. `baseY` is the top of the shopfronts.
 */
export function upperWallKit(
  span: number,
  height: number,
  baseY: number,
  rng: Rng,
): THREE.Group {
  const g = new THREE.Group();

  // Downpipes, run the full height of the upper wall.
  for (const s of [-1, 1]) {
    if (rng.chance(0.45)) continue;
    const len = height - baseY;
    const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, len, 6), darkMetal());
    pipe.position.set(s * (span / 2 - rng.range(0.5, 1.6)), baseY + len / 2, 0.12);
    pipe.castShadow = true;
    g.add(pipe);
  }

  // Wall-mounted condensers, one per few windows.
  for (let i = 0; i < rng.int(1, 5); i++) {
    g.add(
      box(
        rng.range(0.5, 0.9),
        rng.range(0.4, 0.7),
        0.5,
        rng.range(-span / 2 + 1, span / 2 - 1),
        rng.range(baseY + 1.4, Math.max(baseY + 2, height - 2)),
        0.26,
        paleMetal(),
      ),
    );
  }

  /* ------------------------------------------------------- fire escape */

  // Zigzag fire escape, the Miami back-lot staple.
  //
  // The flights climb along the wall in X, not out from it in Z — a flight
  // rotated about the wall normal juts into the street and reads as debris.
  if (height - baseY > 7 && span > 8 && rng.chance(0.55)) {
    const run = 2.8;
    const rise = 3.4;
    const x0 = rng.range(-span / 2 + run + 0.5, span / 2 - run * 2 - 0.5);
    const flight = Math.hypot(run, rise);
    const angle = Math.atan2(rise, run);
    let y = baseY + 1.2;
    let dir = 1;

    while (y + rise < height - 1.5) {
      const lx = dir > 0 ? x0 : x0 + run;
      // Landing, with a rail on its outer edge.
      g.add(box(run * 1.35, 0.1, 1.35, lx, y, 0.75, darkMetal()));
      g.add(box(run * 1.35, 0.05, 0.06, lx, y + 0.95, 1.36, paleMetal()));
      for (const s of [-1, 1]) {
        g.add(box(0.06, 0.95, 0.06, lx + (s * run * 1.35) / 2, y + 0.5, 1.36, paleMetal()));
      }
      // Flight up to the next landing.
      const stair = box(flight, 0.07, 0.85, x0 + run / 2, y + rise / 2, 0.72, darkMetal());
      stair.rotation.z = dir * angle;
      g.add(stair);
      // Stringer rail alongside it.
      const rail = box(flight, 0.05, 0.05, x0 + run / 2, y + rise / 2 + 0.9, 1.1, paleMetal());
      rail.rotation.z = dir * angle;
      g.add(rail);

      y += rise;
      dir *= -1;
    }
  }

  return g;
}

/* ---------------------------------------------------------- balconies */

/**
 * Continuous balcony slabs with a railing, on every floor of one face. This is
 * most of what makes a Miami mid-rise read as residential rather than as an
 * office box with the windows painted on.
 */
export function balconyRow(
  span: number,
  floors: number,
  floorH: number,
  baseY: number,
  glassRail: boolean,
): THREE.Group {
  const g = new THREE.Group();
  const railMat = glassRail
    ? mat('railGlass', () => ({
        color: 0x9fc4cf,
        roughness: 0.12,
        metalness: 0.2,
        transparent: true,
        opacity: 0.42,
      }))
    : paleMetal();

  for (let f = 0; f < floors; f++) {
    const y = baseY + f * floorH;
    g.add(box(span, 0.16, 1.5, 0, y, 0.75, stone()));
    if (glassRail) {
      g.add(box(span, 1.0, 0.06, 0, y + 0.58, 1.47, railMat));
      g.add(box(span, 0.07, 0.12, 0, y + 1.1, 1.47, paleMetal()));
    } else {
      g.add(box(span, 0.06, 0.08, 0, y + 1.02, 1.46, railMat));
      g.add(box(span, 0.06, 0.08, 0, y + 0.55, 1.46, railMat));
      for (const s of [-1, 1]) {
        g.add(box(0.08, 1.05, 0.08, (s * span) / 2, y + 0.52, 1.46, railMat));
      }
    }
  }
  return g;
}

/* ----------------------------------------------------------- rooftops */

const AD_PALETTES = [
  ['#e5382f', '#f7e9c8', '#1c2b4a'],
  ['#00a6a6', '#fef6e4', '#ef8354'],
  ['#f5b301', '#20242c', '#f2f0e6'],
  ['#c2185b', '#fdf3f7', '#2b1b3a'],
];

const adCache: THREE.MeshStandardMaterial[] = [];

/** Abstract billboard art — enough to read as an advert at street distance. */
function adMaterial(rng: Rng): THREE.MeshStandardMaterial {
  if (adCache.length >= 4) return rng.pick(adCache);

  const w = 512;
  const h = 256;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const pal = AD_PALETTES[adCache.length % AD_PALETTES.length];

  ctx.fillStyle = pal[1];
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = pal[0];
  ctx.beginPath();
  ctx.arc(w * 0.72, h * 0.5, h * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(0, h * 0.72, w, h * 0.28);

  ctx.fillStyle = pal[2];
  ctx.font = `700 ${h * 0.26}px "Futura", "Century Gothic", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillText('SOLARA', w * 0.05, h * 0.28);
  ctx.font = `600 ${h * 0.13}px "Futura", "Century Gothic", sans-serif`;
  ctx.fillText('THE SUNSET COAST', w * 0.05, h * 0.5);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  // FrontSide, not DoubleSide: a double-sided quad shows the artwork mirrored
  // from behind, and a billboard with the lettering reversed is the first thing
  // the eye lands on. Callers add a second, back-to-back quad instead.
  const m = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
  adCache.push(m);
  return m;
}

/**
 * Water tanks, plant, stair huts, aerials and the odd billboard.
 *
 * Rooflines are what you see across the whole city from any high camera, and a
 * flat lid on every block is the fastest way to make a skyline look unfinished.
 */
export function rooftopKit(w: number, d: number, y: number, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const inx = Math.max(1, w / 2 - 2);
  const inz = Math.max(1, d / 2 - 2);

  // Stair penthouse — every real flat roof has one.
  const sw = Math.min(4.5, w * 0.3);
  const sd = Math.min(4.0, d * 0.3);
  g.add(box(sw, 2.8, sd, rng.range(-inx, inx) * 0.5, y + 1.4, rng.range(-inz, inz) * 0.5, stone()));

  // Timber-legged water tank.
  if (rng.chance(0.55)) {
    const r = rng.range(1.0, 1.6);
    const legH = rng.range(1.6, 2.6);
    const tx = rng.range(-inx, inx);
    const tz = rng.range(-inz, inz);
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(r, r, r * 1.7, 12), timber());
    tank.position.set(tx, y + legH + r * 0.85, tz);
    tank.castShadow = true;
    g.add(tank);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(r * 1.05, r * 0.5, 12), darkMetal());
    cone.position.set(tx, y + legH + r * 1.95, tz);
    g.add(cone);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        g.add(box(0.16, legH, 0.16, tx + sx * r * 0.7, y + legH / 2, tz + sz * r * 0.7, timber()));
      }
    }
  }

  // Condenser units on a plinth.
  for (let i = 0; i < rng.int(2, 5); i++) {
    const bw = rng.range(1.1, 2.2);
    const bx = rng.range(-inx, inx);
    const bz = rng.range(-inz, inz);
    g.add(box(bw, rng.range(0.7, 1.3), bw * rng.range(0.7, 1.1), bx, y + 0.6, bz, paleMetal()));
  }

  // Ducting runs.
  if (rng.chance(0.6)) {
    const duct = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, Math.max(2, w * 0.5), 8),
      paleMetal(),
    );
    duct.rotation.z = Math.PI / 2;
    duct.position.set(0, y + 0.5, rng.range(-inz, inz));
    g.add(duct);
  }

  // Aerial mast with a couple of dishes.
  if (rng.chance(0.5)) {
    const mx = rng.range(-inx, inx);
    const mz = rng.range(-inz, inz);
    const hh = rng.range(3, 8);
    g.add(box(0.14, hh, 0.14, mx, y + hh / 2, mz, paleMetal()));
    for (let k = 0; k < rng.int(1, 3); k++) {
      const dish = new THREE.Mesh(new THREE.SphereGeometry(0.42, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), stone());
      dish.rotation.set(rng.range(0.6, 1.2), rng.range(0, 6.2), 0);
      dish.position.set(mx + 0.3, y + rng.range(1, hh), mz);
      g.add(dish);
    }
  }

  // Rooftop billboard, on a lattice frame.
  if (rng.chance(0.3) && Math.min(w, d) > 12) {
    const bw = Math.min(w * 0.8, 16);
    const bh = bw / 2.2;
    const ad = adMaterial(rng);
    const yaw = rng.chance(0.5) ? 0 : Math.PI / 2;
    // Two quads back to back, so the artwork reads the right way round from
    // both sides of the block.
    for (const s of [0, Math.PI]) {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(bw, bh), ad);
      face.position.set(0, y + 1.6 + bh / 2, 0);
      face.rotation.y = yaw + s;
      g.add(face);
    }
    for (const s of [-1, 1]) {
      const leg = box(0.18, bh + 1.6, 0.18, 0, y + (bh + 1.6) / 2, 0, darkMetal());
      leg.position.x = Math.cos(yaw) * s * bw * 0.4;
      leg.position.z = -Math.sin(yaw) * s * bw * 0.4;
      g.add(leg);
    }
  }

  return g;
}

/* -------------------------------------------------------------- kerbs */

/** Painted zebra crossing, laid flat. `span` runs across the carriageway. */
export function zebra(span: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const paint = mat('zebraPaint', () => ({
    color: 0xe6e2d8,
    roughness: 0.72,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  }));
  const stripes = Math.max(2, Math.floor(width / 1.2));
  const sw = width / (stripes * 2 - 1);
  for (let i = 0; i < stripes; i++) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(span, sw), paint);
    p.rotation.x = -Math.PI / 2;
    p.position.set(0, 0, -width / 2 + i * sw * 2 + sw / 2);
    p.receiveShadow = true;
    g.add(p);
  }
  return g;
}

/** Bus shelter: glass box, bench, and a lit advert panel on the end. */
export function busShelter(rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const glass = mat('shelterGlass', () => ({
    color: 0xa9c6cf,
    roughness: 0.1,
    metalness: 0.1,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  }));

  g.add(box(4.2, 0.12, 1.7, 0, 2.5, 0, darkMetal()));
  g.add(box(4.2, 2.0, 0.06, 0, 1.3, -0.8, glass));
  for (const s of [-1, 1]) {
    g.add(box(0.1, 2.5, 1.7, (s * 4.2) / 2, 1.25, 0, darkMetal()));
  }
  g.add(box(3.4, 0.08, 0.42, 0, 0.5, -0.5, timber()));
  for (const s of [-1, 1]) {
    g.add(box(0.08, 0.5, 0.4, s * 1.5, 0.25, -0.5, darkMetal()));
  }
  // Backlit advert panel.
  const panel = box(1.2, 1.8, 0.12, 1.4, 1.25, 0.75, adMaterial(rng));
  g.add(panel);
  return g;
}

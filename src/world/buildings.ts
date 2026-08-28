import * as THREE from 'three';
import * as T from '../render/textures';
import { Rng } from '../core/rng';
import { Colliders } from './collision';
import { CURB_H, HOTEL_X, ROAD_HALF, STRIP_MIN_Z, STRIP_MAX_Z } from './layout';
import { neonMat, NEON_COLOURS, promenadeLamp } from './facades';

/* -------------------------------------------------------------- materials */

const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x35474f,
  roughness: 0.07,
  metalness: 0.0,
  reflectivity: 0.9,
  envMapIntensity: 2.2,
  clearcoat: 0.8,
  clearcoatRoughness: 0.05,
});

const frameMat = new THREE.MeshStandardMaterial({
  color: 0xf2ece2,
  roughness: 0.62,
  metalness: 0,
});

// Both of these were built per awning and per block. Shared, so the bake can
// merge them; a material per instance is a draw call per instance.
const rodMat = new THREE.MeshStandardMaterial({
  color: 0x6c6a66,
  roughness: 0.45,
  metalness: 0.85,
});
const acMat = new THREE.MeshStandardMaterial({
  color: 0xd8d4cc,
  roughness: 0.55,
  metalness: 0.35,
});
const trimMat = new THREE.MeshStandardMaterial({
  color: 0xfbf6ec,
  roughness: 0.7,
  metalness: 0,
});

// One neutral plaster texture serves the whole strip; the pastels come from
// material.color, so a dozen facades cost one 512² canvas instead of a dozen.
let stuccoMaps: T.SurfaceMaps | null = null;
const stuccoCache = new Map<number, THREE.MeshStandardMaterial>();

function stuccoMat(color: number): THREE.MeshStandardMaterial {
  let m = stuccoCache.get(color);
  if (!m) {
    if (!stuccoMaps) {
      stuccoMaps = T.asColor(T.stucco(6));
    }
    m = new THREE.MeshStandardMaterial({
      ...stuccoMaps,
      color,
      normalScale: new THREE.Vector2(0.7, 0.7),
      roughness: 1,
      metalness: 0,
    });
    stuccoCache.set(color, m);
  }
  return m;
}

/**
 * The beachfront hotels build their windows as real geometry rather than as a
 * texture, so they need their own night switch: the shared glass gets an
 * interior glow, and the brass sign letters pick up their own uplighting.
 */
export function setStripNight(f: number): void {
  const t = Math.min(1, Math.max(0, f));
  glassMat.emissive.setHex(0xffce8a);
  glassMat.emissiveIntensity = t * 0.9;
  for (const m of signCache) m.emissiveIntensity = t * 1.4;
}

const signCache: THREE.MeshStandardMaterial[] = [];

/* ------------------------------------------------------------ sign canvas */

/**
 * Brass channel letters, faked with a canvas: a dark offset copy underneath the
 * gold gives the letters apparent depth without needing a font loader.
 */
function signPlane(text: string, widthM: number, heightM: number): THREE.Mesh {
  const px = 2048;
  const py = Math.round((px * heightM) / widthM);
  const cv = document.createElement('canvas');
  cv.width = px;
  cv.height = py;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, px, py);

  const fontSize = py * 0.74;
  ctx.font = `600 ${fontSize}px "Copperplate", "Trajan Pro", "Optima", Georgia, serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const cx = px / 2;
  const cy = py * 0.54;
  const spaced = text.split('').join(' ');

  // Cast shadow onto the wall, down-right from the high sun.
  ctx.fillStyle = 'rgba(60,36,26,0.42)';
  ctx.fillText(spaced, cx + fontSize * 0.055, cy + fontSize * 0.075);

  // Letter side walls.
  for (let i = 6; i >= 1; i--) {
    ctx.fillStyle = `rgba(96,68,26,${0.55 + i * 0.03})`;
    ctx.fillText(spaced, cx + i * 1.6, cy + i * 1.6);
  }

  // Polished brass face.
  const grad = ctx.createLinearGradient(0, cy - fontSize / 2, 0, cy + fontSize / 2);
  grad.addColorStop(0, '#f7e2ab');
  grad.addColorStop(0.35, '#c9a03f');
  grad.addColorStop(0.52, '#8d6a1f');
  grad.addColorStop(0.68, '#e6c877');
  grad.addColorStop(1, '#a9812b');
  ctx.fillStyle = grad;
  ctx.fillText(spaced, cx, cy);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mat = new THREE.MeshStandardMaterial({
    map: tex,
    emissiveMap: tex,
    emissive: 0xffffff,
    emissiveIntensity: 0,
    transparent: true,
    alphaTest: 0.04,
    roughness: 0.32,
    metalness: 0.85,
    side: THREE.FrontSide,
  });
  signCache.push(mat);

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(widthM, heightM), mat);
  mesh.castShadow = false;
  return mesh;
}

/* ---------------------------------------------------------------- awnings */

// One canvas-weave texture shared by every awning on the strip.
let awningMaps: T.SurfaceMaps | null = null;
const awningCache = new Map<number, THREE.MeshStandardMaterial>();

function awningMat(color: number): THREE.MeshStandardMaterial {
  let m = awningCache.get(color);
  if (!m) {
    if (!awningMaps) {
      awningMaps = T.asColor(T.awningFabric(1));
      // Coarse repeat: a tight weave moirés badly at grazing angles.
      for (const t of [awningMaps.map, awningMaps.normalMap, awningMaps.roughnessMap]) {
        t.repeat.set(6, 2);
      }
    }
    m = new THREE.MeshStandardMaterial({
      ...awningMaps,
      color,
      roughness: 0.85,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    awningCache.set(color, m);
  }
  return m;
}

/**
 * Scalloped canvas canopy. `bays` semicircular scallops along the front edge,
 * exactly like the coral awnings fronting the hotel in the reference.
 */
function scallopedAwning(span: number, reach: number, color: number): THREE.Group {
  const grp = new THREE.Group();

  const mat = awningMat(color);

  // Sloping canopy: high at the wall, low at the street edge.
  const drop = 0.62;
  const canopy = new THREE.Mesh(new THREE.PlaneGeometry(span, Math.hypot(reach, drop)), mat);
  canopy.rotation.x = -Math.PI / 2 + Math.atan2(drop, reach);
  canopy.position.set(0, -drop / 2, reach / 2);
  canopy.castShadow = true;
  canopy.receiveShadow = true;
  grp.add(canopy);

  // Scalloped valance hanging off the front edge.
  //
  // The scallops must bulge DOWNWARD and stay small relative to the valance —
  // arcs sweeping up through the top edge self-intersect, and a self-
  // intersecting shape triangulates into a garbage sheet several metres wide.
  const scallopR = 0.21;
  const n = Math.max(2, Math.round(span / (scallopR * 2)));
  const bayW = span / n;
  const r = bayW / 2;
  const valanceH = 0.3;

  const shape = new THREE.Shape();
  shape.moveTo(-span / 2, 0);
  shape.lineTo(span / 2, 0);
  shape.lineTo(span / 2, -valanceH);
  // Walk right to left; each arc runs clockwise beneath the hem line.
  for (let i = n - 1; i >= 0; i--) {
    const cx = -span / 2 + (i + 0.5) * bayW;
    shape.absarc(cx, -valanceH, r, 0, Math.PI, true);
  }
  shape.lineTo(-span / 2, 0);
  shape.closePath();

  const valance = new THREE.Mesh(new THREE.ShapeGeometry(shape), mat);
  valance.position.set(0, -drop, reach);
  valance.castShadow = true;
  valance.receiveShadow = true;
  grp.add(valance);

  // Support rods back to the wall.
  const rodGeo = new THREE.CylinderGeometry(0.028, 0.028, Math.hypot(reach, drop), 6);
  const rodStep = Math.max(1.8, span / Math.max(1, Math.round(span / 2.4)));
  for (let x = -span / 2; x <= span / 2 + 1e-6; x += rodStep) {
    const rod = new THREE.Mesh(rodGeo, rodMat);
    rod.position.set(x, -drop / 2, reach / 2);
    rod.rotation.x = Math.PI / 2 - Math.atan2(drop, reach);
    rod.castShadow = true;
    grp.add(rod);
  }

  return grp;
}

/* --------------------------------------------------------------- building */

export interface BlockOpts {
  /** Extent along the street (Z). */
  span: number;
  /** Extent away from the street (X). */
  depth: number;
  floors: number;
  floorH: number;
  color: number;
  /** Facade colour of the ground-floor band. */
  baseColor?: number;
  bays: number;
  awning?: { color: number; reach: number } | null;
  sign?: string | null;
  /** Raised Art Deco crown over the entrance bay. */
  crown?: boolean;
}

/**
 * Builds one Art Deco block in local space: facade plane at x = 0 facing -X,
 * mass extending toward +X, centred on z = 0.
 */
function artDecoBlock(o: BlockOpts, rng: Rng): THREE.Group {
  const g = new THREE.Group();
  const h = o.floors * o.floorH;
  const groundH = o.floorH * 1.32;
  const wall = stuccoMat(o.color);

  // Main mass.
  const mass = new THREE.Mesh(new THREE.BoxGeometry(o.depth, h, o.span), wall);
  mass.position.set(o.depth / 2, h / 2, 0);
  mass.castShadow = true;
  mass.receiveShadow = true;
  g.add(mass);

  // Ground-floor band, slightly proud of the wall above.
  const band = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, groundH, o.span + 0.24),
    stuccoMat(o.baseColor ?? 0xf6efe3),
  );
  band.position.set(-0.12, groundH / 2, 0);
  band.castShadow = true;
  band.receiveShadow = true;
  g.add(band);

  // Horizontal string course over the ground floor — the Deco "eyebrow".
  const sill = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, o.span + 0.4), trimMat);
  sill.position.set(-0.2, groundH + 0.08, 0);
  sill.castShadow = true;
  sill.receiveShadow = true;
  g.add(sill);

  /* ---------------------------------------------------------- windows */

  const bayW = o.span / o.bays;
  const winW = bayW * 0.52;
  const winH = o.floorH * 0.56;
  const upperFloors = o.floors - 1;
  const count = upperFloors * o.bays;

  if (count > 0) {
    // Recessed reveal box behind each window.
    const reveal = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.26, winH + 0.16, winW + 0.16),
      frameMat,
      count,
    );
    const glass = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(winW, winH),
      glassMat,
      count,
    );
    // Eyebrow ledge over every window — the signature Ocean Drive shadow line.
    const brow = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.36, 0.1, winW + 0.5),
      trimMat,
      count,
    );

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const qGlass = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0));
    const one = new THREE.Vector3(1, 1, 1);
    let i = 0;

    for (let f = 0; f < upperFloors; f++) {
      const y = groundH + 0.16 + f * o.floorH + o.floorH * 0.5;
      for (let b = 0; b < o.bays; b++) {
        const z = -o.span / 2 + (b + 0.5) * bayW;
        reveal.setMatrixAt(i, m.compose(new THREE.Vector3(0.02, y, z), q, one));
        glass.setMatrixAt(i, m.compose(new THREE.Vector3(-0.09, y, z), qGlass, one));
        brow.setMatrixAt(
          i,
          m.compose(new THREE.Vector3(-0.16, y + winH / 2 + 0.18, z), q, one),
        );
        i++;
      }
    }

    for (const im of [reveal, glass, brow]) {
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = true;
      im.receiveShadow = true;
      g.add(im);
    }
  }

  /* --------------------------------------------------------- pilasters */

  const pil = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.22, h - groundH - 0.2, 0.34),
    trimMat,
    o.bays + 1,
  );
  {
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const one = new THREE.Vector3(1, 1, 1);
    for (let b = 0; b <= o.bays; b++) {
      const z = -o.span / 2 + b * bayW;
      pil.setMatrixAt(
        b,
        m.compose(
          new THREE.Vector3(-0.06, groundH + 0.16 + (h - groundH - 0.2) / 2, z),
          q,
          one,
        ),
      );
    }
    pil.instanceMatrix.needsUpdate = true;
    pil.castShadow = true;
    pil.receiveShadow = true;
    g.add(pil);
  }

  /* ----------------------------------------------------------- cornice */

  const cornice = new THREE.Mesh(
    new THREE.BoxGeometry(o.depth + 0.5, 0.42, o.span + 0.5),
    trimMat,
  );
  cornice.position.set(o.depth / 2 - 0.1, h + 0.21, 0);
  cornice.castShadow = true;
  cornice.receiveShadow = true;
  g.add(cornice);

  const parapet = new THREE.Mesh(
    new THREE.BoxGeometry(o.depth * 0.9, 0.5, o.span - 0.6),
    wall,
  );
  parapet.position.set(o.depth / 2, h + 0.67, 0);
  parapet.castShadow = true;
  g.add(parapet);

  if (o.crown) {
    // Stepped ziggurat over the entrance — pure Miami Deco.
    for (let s = 0; s < 3; s++) {
      const w = 6.5 - s * 1.9;
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.72, w), trimMat);
      step.position.set(0.4, h + 0.92 + s * 0.62, 0);
      step.castShadow = true;
      step.receiveShadow = true;
      g.add(step);
    }
    // Three vertical fins, the classic Deco flourish.
    for (let k = -1; k <= 1; k++) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.5, 0.3), trimMat);
      fin.position.set(0.1, h + 2.7, k * 1.0);
      fin.castShadow = true;
      g.add(fin);
    }
  }

  /* -------------------------------------------------------------- neon */

  // Neon tubing tracing the string course and the cornice, and up the crown
  // fins. This is the single most recognisable thing about Ocean Drive after
  // dark, and without it the strip was the darkest place on the map at night —
  // it had no light sources of its own at all.
  {
    const tube = neonMat(NEON_COLOURS[o.bays % NEON_COLOURS.length]);
    // Along the eyebrow over the shopfronts.
    const eyebrow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, o.span + 0.3), tube);
    eyebrow.position.set(-0.46, groundH + 0.02, 0);
    g.add(eyebrow);
    // Under the cornice.
    const under = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, o.span + 0.4), tube);
    under.position.set(-0.32, h - 0.12, 0);
    g.add(under);
    // Vertical runs up the pilasters, every other bay.
    const bayW2 = o.span / o.bays;
    const runGeo = new THREE.BoxGeometry(0.08, h - groundH - 0.4, 0.08);
    for (let b = 0; b <= o.bays; b += 2) {
      const strip = new THREE.Mesh(runGeo, tube);
      strip.position.set(-0.24, groundH + 0.2 + (h - groundH - 0.4) / 2, -o.span / 2 + b * bayW2);
      g.add(strip);
    }
    if (o.crown) {
      for (let k = -1; k <= 1; k++) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.5, 0.08), tube);
        fin.position.set(-0.1, h + 2.7, k * 1.0);
        g.add(fin);
      }
    }
  }

  /* ------------------------------------------------------- ground floor */

  // Shopfront glazing between columns. Capped at real shopfront dimensions —
  // scaling it off the bay alone gives wide bays absurd 4 m panes.
  const colGeo = new THREE.BoxGeometry(0.42, groundH, 0.42);
  const glassW = Math.min(bayW * 0.72, 3.0);
  const glassH = Math.min(groundH * 0.66, 2.9);
  const shopGlass = new THREE.PlaneGeometry(glassW, glassH);
  const transom = new THREE.BoxGeometry(0.3, 0.14, glassW + 0.3);
  for (let b = 0; b < o.bays; b++) {
    const z = -o.span / 2 + (b + 0.5) * bayW;
    const gl = new THREE.Mesh(shopGlass, glassMat);
    gl.rotation.y = -Math.PI / 2;
    gl.position.set(-0.28, glassH / 2 + 0.35, z);
    g.add(gl);

    // Header above the glazing so the shopfront isn't a floating pane.
    const tr = new THREE.Mesh(transom, trimMat);
    tr.position.set(-0.3, glassH + 0.42, z);
    tr.castShadow = true;
    tr.receiveShadow = true;
    g.add(tr);
  }
  for (let b = 0; b <= o.bays; b++) {
    const col = new THREE.Mesh(colGeo, trimMat);
    col.position.set(-0.25, groundH / 2, -o.span / 2 + b * bayW);
    col.castShadow = true;
    col.receiveShadow = true;
    g.add(col);
  }

  /* ------------------------------------------------------------ awning */

  if (o.awning) {
    const awn = scallopedAwning(o.span - 0.4, o.awning.reach, o.awning.color);
    awn.position.set(-0.2, groundH + 0.1, 0);
    // -PI/2 so the canopy's local +Z (its reach) points out over the pavement.
    // +PI/2 buries the whole awning inside the building.
    awn.rotation.y = -Math.PI / 2;
    g.add(awn);
  }

  /* -------------------------------------------------------------- sign */

  if (o.sign) {
    const sw = Math.min(o.span * 0.82, o.sign.length * 1.12);
    const sign = signPlane(o.sign, sw, sw / (o.sign.length * 0.62));
    sign.rotation.y = -Math.PI / 2;
    sign.position.set(-0.34, groundH + 1.35, 0);
    g.add(sign);
  }

  // A few closed shutters and AC units for lived-in break-up.
  for (let f = 0; f < upperFloors; f++) {
    for (let b = 0; b < o.bays; b++) {
      if (!rng.chance(0.16)) continue;
      const ac = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.34, 0.5), acMat);
      ac.position.set(
        -0.16,
        groundH + 0.16 + f * o.floorH + o.floorH * 0.5 - winH / 2 - 0.14,
        -o.span / 2 + (b + 0.5) * bayW,
      );
      ac.castShadow = true;
      g.add(ac);
    }
  }

  return g;
}

/* ------------------------------------------------------------------ strip */

/** A building footprint, handed to the map overlay. */
export interface Footprint {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Storey count, used to shade taller blocks darker on the map. */
  floors: number;
  label: string | null;
}

/** Places a block with its facade on `facadeX`, facing the street. */
function place(
  parent: THREE.Group,
  colliders: Colliders,
  footprints: Footprint[],
  block: THREE.Group,
  opts: BlockOpts,
  facadeX: number,
  z: number,
  east: boolean,
) {
  block.position.set(facadeX, CURB_H, z);
  block.rotation.y = east ? 0 : Math.PI;
  parent.add(block);

  const minX = east ? facadeX : facadeX - opts.depth;
  const maxX = east ? facadeX + opts.depth : facadeX;
  colliders.addBox(minX, maxX, z - opts.span / 2, z + opts.span / 2);
  footprints.push({
    minX,
    maxX,
    minZ: z - opts.span / 2,
    maxZ: z + opts.span / 2,
    floors: opts.floors,
    label: opts.sign ?? null,
  });
}

export interface BuildingsResult {
  group: THREE.Group;
  footprints: Footprint[];
  /** World positions of the lamp globes, for `render/lights.ts`. */
  lamps: THREE.Vector3[];
}

export function buildBuildings(colliders: Colliders): BuildingsResult {
  const g = new THREE.Group();
  g.name = 'buildings';
  const rng = new Rng(918);
  const footprints: Footprint[] = [];
  const lamps: THREE.Vector3[] = [];

  /* ------------------------------------------- the Dominion, hotel side */

  const dominion: BlockOpts = {
    span: 34,
    depth: 26,
    floors: 4,
    floorH: 3.5,
    color: 0xf3e6da,
    baseColor: 0xf7ded2,
    bays: 7,
    awning: { color: 0xd9736f, reach: 4.2 },
    sign: 'DOMINION HOTEL',
    crown: true,
  };
  place(g, colliders, footprints, artDecoBlock(dominion, rng), dominion, HOTEL_X, 0, true);

  // Neighbours on the hotel side. Spans are chosen to butt up against each
  // other — any gap exposes the ground plane and reads as a missing lot.
  const eastNeighbours: Array<[BlockOpts, number]> = [
    [
      {
        span: 11,
        depth: 20,
        floors: 2,
        floorH: 3.6,
        color: 0xe6d9c4,
        baseColor: 0xf5ece0,
        bays: 2,
        awning: { color: 0x5f8f86, reach: 2.8 },
        sign: null,
        crown: false,
      },
      22.5,
    ],
    [
      {
        span: 32,
        depth: 24,
        floors: 3,
        floorH: 3.4,
        color: 0xeae3d2,
        baseColor: 0xf6f1e6,
        bays: 6,
        awning: { color: 0x5f8f86, reach: 3.4 },
        sign: 'CORAL',
        crown: false,
      },
      -33,
    ],
    [
      {
        span: 34,
        depth: 22,
        floors: 5,
        floorH: 3.3,
        color: 0xe6ddc9,
        baseColor: 0xf2ece0,
        bays: 7,
        awning: { color: 0xc9843f, reach: 3.2 },
        sign: null,
        crown: true,
      },
      -66,
    ],
    [
      {
        span: 34,
        depth: 22,
        floors: 4,
        floorH: 3.4,
        color: 0xdfe8e0,
        baseColor: 0xeef4ee,
        bays: 7,
        awning: { color: 0x7fa08c, reach: 3.0 },
        sign: null,
        crown: false,
      },
      -100,
    ],
    [
      {
        span: 34,
        depth: 24,
        floors: 4,
        floorH: 3.5,
        color: 0xf0e2d0,
        baseColor: 0xfaf3e8,
        bays: 7,
        awning: { color: 0xcf6f8a, reach: 3.6 },
        sign: 'MIRADOR',
        crown: false,
      },
      57,
    ],
    [
      {
        span: 34,
        depth: 26,
        floors: 6,
        floorH: 3.2,
        color: 0xe9e6dc,
        baseColor: 0xf5f2ea,
        bays: 7,
        awning: null,
        sign: null,
        crown: true,
      },
      91,
    ],
  ];
  for (const [o, z] of eastNeighbours)
    place(g, colliders, footprints, artDecoBlock(o, rng), o, HOTEL_X, z, true);

  /* ------------------------------------------------------- ocean side */

  // Nothing here any more: west of the promenade is Lummus-style park, dune,
  // beach and open ocean. See world/terrain.ts and world/beach.ts.

  /* ------------------------------------------------- promenade lighting */

  // Ocean Drive had no lighting geometry whatsoever — at night it was the
  // darkest place on the map, with the lit city visible behind it.
  for (const side of [-1, 1]) {
    for (let z = STRIP_MIN_Z + 8; z < STRIP_MAX_Z; z += 22) {
      const lamp = promenadeLamp();
      lamp.position.set(side * (ROAD_HALF + 2.2), CURB_H, z);
      g.add(lamp);
      // The globe sits 4.6 m up the post — see `promenadeLamp`.
      lamps.push(new THREE.Vector3(side * (ROAD_HALF + 2.2), CURB_H + 4.6, z));
      colliders.addCircle(side * (ROAD_HALF + 2.2), z, 0.2, 2.2);
    }
  }

  /* --------------------------------------- distant skyline through haze */

  // Gone. These were 22 untextured boxes standing in for a skyline back when
  // Ocean Drive was the whole map — and they were placed by x-range, so once
  // the city was built inland they were sitting *inside* it as blank blue-grey
  // slabs, and the ones flipped negative were standing in the sea. The city
  // itself is the skyline now.

  return { group: g, footprints, lamps };
}

import * as THREE from 'three';
import { loft, limb, Section } from '../util/loft';
import * as T from '../render/textures';
import { bakeStatic } from '../util/bake';

/**
 * Mara, built as an articulated bone hierarchy of lofted body parts rather
 * than a skinned mesh — every joint below is a real THREE.Group the animator
 * rotates, so the walk cycle is authored in joint space like a normal rig.
 *
 * Proportions target a 1.68 m woman. Origin sits on the ground between her feet.
 */

/**
 * Segment lengths follow standard anthropometry for a 1.68 m woman, expressed
 * as joint heights: hip 0.874, knee 0.479, ankle 0.075, shoulder 1.354.
 * These MUST stay self-consistent — `hipY + hipJointY - thigh - shin` has to
 * equal `ankleY`, or the pelvis-IK pass fights the rest pose every frame.
 */
export const P = {
  ankleY: 0.075,
  shin: 0.404,
  thigh: 0.395,
  hipY: 0.934,
  /** Hip joint offset below the pelvis group origin. */
  hipJointY: -0.06,
  spineY: 0.11,
  chestH: 0.31,
  neckH: 0.088,
  shoulderX: 0.148,
  upperArm: 0.3,
  foreArm: 0.245,
  hipX: 0.082,
} as const;

export interface LegChain {
  hip: THREE.Group;
  knee: THREE.Group;
  ankle: THREE.Group;
}

export interface ArmChain {
  shoulder: THREE.Group;
  elbow: THREE.Group;
  wrist: THREE.Group;
}

export interface MaraRig {
  root: THREE.Group;
  hips: THREE.Group;
  spine: THREE.Group;
  chest: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  legL: LegChain;
  legR: LegChain;
  armL: ArmChain;
  armR: ArmChain;
  /** Ponytail links, root-first, driven by the secondary-motion solver. */
  ponytail: THREE.Group[];
}

/* -------------------------------------------------------------- materials */

/**
 * All character textures are generated once, neutral, and shared. Variation
 * between Mara and every pedestrian comes from `material.color` alone — a
 * crowd of thirty otherwise means thirty 256² canvases per fabric type.
 */
interface SharedMaps {
  skin: T.SurfaceMaps;
  knit: T.SurfaceMaps;
  denim: T.SurfaceMaps;
}

let shared: SharedMaps | null = null;

function sharedMaps(): SharedMaps {
  if (!shared) {
    const skin = T.asColor(T.skin());
    const knit = T.asColor(T.knit());
    for (const t of [knit.map, knit.normalMap, knit.roughnessMap]) t.repeat.set(3, 3);
    const denim = T.asColor(T.denim());
    for (const t of [denim.map, denim.normalMap, denim.roughnessMap]) t.repeat.set(3, 2);
    shared = { skin, knit, denim };
  }
  return shared;
}

export interface Look {
  /** Skin tone. */
  skin: number;
  /** Upper garment colour. */
  top: number;
  /** Lower garment colour. */
  bottom: number;
  hair: number;
  shoe: number;
}

export const MARA_LOOK: Look = {
  skin: 0xc9926a,
  top: 0xe8735a,
  bottom: 0x54657d,
  hair: 0x2e1c12,
  shoe: 0xf3f0e8,
};

// Materials are cached by colour so repeated looks across the crowd cost nothing.
const cache = new Map<string, THREE.Material>();

function cached<M extends THREE.Material>(key: string, make: () => M): M {
  let m = cache.get(key) as M | undefined;
  if (!m) {
    m = make();
    cache.set(key, m);
  }
  return m;
}

function materials(look: Look) {
  const maps = sharedMaps();

  return {
    skin: cached(`skin${look.skin}`, () =>
      new THREE.MeshPhysicalMaterial({
        ...maps.skin,
        color: look.skin,
        normalScale: new THREE.Vector2(0.5, 0.5),
        roughness: 1,
        metalness: 0,
        clearcoat: 0.28,
        clearcoatRoughness: 0.52,
        sheen: 0.35,
        sheenColor: new THREE.Color(0xffd9c0),
        sheenRoughness: 0.7,
      }),
    ),
    top: cached(`top${look.top}`, () =>
      new THREE.MeshPhysicalMaterial({
        ...maps.knit,
        color: look.top,
        normalScale: new THREE.Vector2(0.8, 0.8),
        roughness: 1,
        metalness: 0,
        sheen: 0.6,
        sheenColor: new THREE.Color(0xffb9a4),
        sheenRoughness: 0.85,
        side: THREE.DoubleSide,
      }),
    ),
    denim: cached(`btm${look.bottom}`, () =>
      new THREE.MeshStandardMaterial({
        ...maps.denim,
        color: look.bottom,
        normalScale: new THREE.Vector2(0.9, 0.9),
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    ),
    hair: cached(`hair${look.hair}`, () =>
      new THREE.MeshPhysicalMaterial({
        color: look.hair,
        roughness: 0.34,
        metalness: 0,
        sheen: 1.0,
        sheenColor: new THREE.Color(0x9a6a3c),
        sheenRoughness: 0.28,
        clearcoat: 0.4,
        clearcoatRoughness: 0.3,
      }),
    ),
    shoe: cached(`shoe${look.shoe}`, () =>
      new THREE.MeshStandardMaterial({ color: look.shoe, roughness: 0.62, metalness: 0 }),
    ),
    sole: cached('sole', () =>
      new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.85 }),
    ),
    lens: cached('lens', () =>
      new THREE.MeshPhysicalMaterial({
        color: 0x14161c,
        roughness: 0.04,
        metalness: 0.1,
        clearcoat: 1,
        clearcoatRoughness: 0.02,
        envMapIntensity: 2.4,
        side: THREE.DoubleSide,
      }),
    ),
    gold: cached('gold', () =>
      new THREE.MeshStandardMaterial({
        color: 0xd8b551,
        roughness: 0.18,
        metalness: 1,
        envMapIntensity: 1.6,
      }),
    ),
    eyeWhite: cached('eyeWhite', () =>
      new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.22 }),
    ),
    iris: cached('iris', () =>
      new THREE.MeshStandardMaterial({ color: 0x4a2c17, roughness: 0.14, metalness: 0 }),
    ),
    pupil: cached('pupil', () => new THREE.MeshBasicMaterial({ color: 0x0a0705 })),
    brow: cached(`brow${look.hair}`, () =>
      new THREE.MeshStandardMaterial({ color: look.hair, roughness: 0.6 }),
    ),
    lip: cached('lip', () =>
      new THREE.MeshPhysicalMaterial({
        color: 0xb0685c,
        roughness: 0.34,
        clearcoat: 0.6,
        clearcoatRoughness: 0.25,
      }),
    ),
  };
}

export type MaraMaterials = ReturnType<typeof materials>;

/* ------------------------------------------------------------------ parts */

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Shoe pointing along +Z from the ankle joint at the origin. */
function shoe(mats: MaraMaterials, hero: boolean): THREE.Group {
  const g = new THREE.Group();

  // Sections run heel -> toe; z-offset controls the vertical centre so the
  // sole ends up flat on the ground once the geometry is rotated forward.
  const raw: Array<[number, number, number]> = [
    [0.0, 0.031, 0.030],
    [0.045, 0.041, 0.040],
    [0.1, 0.046, 0.036],
    [0.16, 0.045, 0.028],
    [0.215, 0.036, 0.019],
    [0.25, 0.022, 0.012],
  ];
  const sections: Section[] = raw.map(([y, w, d]) => ({
    y,
    w,
    d,
    z: P.ankleY - d,
  }));

  const geo = loft(sections, { rings: hero ? 18 : 10, radial: hero ? 16 : 9, capScale: 0.7 });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, 0, -0.052);
  g.add(mesh(geo, mats.shoe));

  // Outsole slab.
  const soleGeo = loft(
    raw.map(([y, w]) => ({ y, w: w * 1.03, d: 0.013, z: P.ankleY - 0.013 })),
    { rings: hero ? 14 : 8, radial: hero ? 12 : 7, capScale: 0.5 },
  );
  soleGeo.rotateX(Math.PI / 2);
  soleGeo.translate(0, 0.004, -0.052);
  g.add(mesh(soleGeo, mats.sole));

  return g;
}

function hand(mats: MaraMaterials, res: number): THREE.Group {
  const g = new THREE.Group();

  const palm = limb(
    0.175,
    [
      [0, 0.023],
      [0.3, 0.028],
      [0.68, 0.026],
      [1, 0.014],
    ],
    0.52,
    res,
  );
  g.add(mesh(palm, mats.skin));

  const thumb = limb(
    0.055,
    [
      [0, 0.012],
      [1, 0.008],
    ],
    1,
    res,
  );
  const tm = mesh(thumb, mats.skin);
  tm.position.set(0.02, -0.032, 0.008);
  tm.rotation.z = 0.8;
  tm.rotation.x = -0.3;
  g.add(tm);

  return g;
}

function buildHead(mats: MaraMaterials, opts: Required<RigOptions>): THREE.Group {
  const g = new THREE.Group();
  const hero = opts.detail === 'hero';

  // Skull: chin at y = 0, crown near y = 0.235.
  const skull = loft(
    [
      { y: 0.0, w: 0.043, d: 0.049, z: 0.006 },
      { y: 0.035, w: 0.06, d: 0.068, z: 0.003 },
      { y: 0.075, w: 0.073, d: 0.082, z: 0.0 },
      { y: 0.12, w: 0.081, d: 0.091, z: -0.004 },
      { y: 0.165, w: 0.081, d: 0.09, z: -0.006 },
      { y: 0.205, w: 0.07, d: 0.079, z: -0.008 },
      { y: 0.232, w: 0.05, d: 0.056, z: -0.01 },
    ],
    { rings: hero ? 26 : 14, radial: hero ? 24 : 12, capScale: 0.6 },
  );
  g.add(mesh(skull, mats.skin));

  /* -------------------------------------------------------------- face */

  // Eyes set into the sockets.
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(s * 0.033, 0.137, 0.068);

    const ball = mesh(new THREE.SphereGeometry(0.0135, hero ? 14 : 8, hero ? 12 : 6), mats.eyeWhite);
    eye.add(ball);

    const iris = mesh(new THREE.SphereGeometry(0.0072, hero ? 12 : 8, hero ? 10 : 6), mats.iris);
    iris.position.set(0, 0, 0.0088);
    iris.scale.z = 0.55;
    eye.add(iris);

    if (hero) {
      const pupil = mesh(new THREE.SphereGeometry(0.0032, 8, 8), mats.pupil);
      pupil.position.set(0, 0, 0.0125);
      eye.add(pupil);

      // Upper lid, which also gives the eye a lash line.
      const lid = mesh(
        new THREE.SphereGeometry(0.0148, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.42),
        mats.skin,
      );
      lid.position.set(0, 0.0012, 0);
      lid.rotation.x = -0.34;
      eye.add(lid);
    }

    g.add(eye);

    const brow = mesh(new THREE.BoxGeometry(0.038, 0.006, 0.011), mats.brow);
    brow.position.set(s * 0.034, 0.163, 0.077);
    brow.rotation.z = -s * 0.16;
    brow.rotation.x = -0.24;
    g.add(brow);

    // Ear.
    const ear = mesh(new THREE.SphereGeometry(0.019, hero ? 10 : 6, hero ? 10 : 6), mats.skin);
    ear.position.set(s * 0.079, 0.122, -0.006);
    ear.scale.set(0.42, 1.05, 0.72);
    g.add(ear);

    if (opts.earrings) {
      const hoop = mesh(new THREE.TorusGeometry(0.026, 0.0032, 6, 20), mats.gold);
      hoop.position.set(s * 0.079, 0.09, -0.006);
      hoop.rotation.y = Math.PI / 2;
      g.add(hoop);
    }
  }

  // Nose.
  const nose = loft(
    [
      { y: 0.0, w: 0.016, d: 0.013 },
      { y: 0.026, w: 0.012, d: 0.014 },
      { y: 0.05, w: 0.009, d: 0.011 },
    ],
    { rings: hero ? 8 : 5, radial: hero ? 12 : 8, capScale: 0.5 },
  );
  const noseM = mesh(nose, mats.skin);
  noseM.position.set(0, 0.098, 0.079);
  noseM.rotation.x = -0.22;
  g.add(noseM);

  // Lips.
  const lips = mesh(new THREE.SphereGeometry(0.019, hero ? 14 : 8, hero ? 10 : 6), mats.lip);
  lips.position.set(0, 0.062, 0.075);
  lips.scale.set(1.35, 0.44, 0.4);
  g.add(lips);

  /* -------------------------------------------------------------- hair */

  // Slicked-back crown cap, then the back-and-sides mass.
  const cap = mesh(
    new THREE.SphereGeometry(1, 26, 16, 0, Math.PI * 2, 0, 1.02),
    mats.hair,
  );
  cap.scale.set(0.087, 0.128, 0.098);
  cap.position.set(0, 0.108, -0.008);
  g.add(cap);

  // Leave the face open: gap centred on +Z (phi = PI/2).
  const gap = 1.45;
  const back = mesh(
    new THREE.SphereGeometry(1, 26, 20, Math.PI / 2 + gap / 2, Math.PI * 2 - gap, 0.98, 1.15),
    mats.hair,
  );
  back.scale.set(0.087, 0.128, 0.098);
  back.position.set(0, 0.108, -0.008);
  g.add(back);

  // Bun of gathered hair where the ponytail is tied off.
  if (opts.ponytail) {
    const tie = mesh(new THREE.SphereGeometry(0.032, 14, 12), mats.hair);
    tie.position.set(0, 0.196, -0.06);
    tie.scale.set(0.9, 0.8, 0.9);
    g.add(tie);
  } else {
    // Loose hair falling to the shoulders instead.
    const fall = mesh(
      new THREE.SphereGeometry(1, 20, 16, Math.PI / 2 + 0.7, Math.PI * 2 - 1.4, 0.9, 1.5),
      mats.hair,
    );
    fall.scale.set(0.094, 0.24, 0.108);
    fall.position.set(0, 0.1, -0.012);
    g.add(fall);
  }

  if (!opts.shades) return g;

  /* -------------------------------------------------- aviators on head */

  const shades = new THREE.Group();
  shades.position.set(0, 0.196, 0.028);
  shades.rotation.x = -1.06;

  const lensShape = new THREE.Shape();
  lensShape.ellipse(0, 0, 0.028, 0.023, 0, Math.PI * 2, false, 0);
  const lensGeo = new THREE.ExtrudeGeometry(lensShape, {
    depth: 0.003,
    bevelEnabled: true,
    bevelSize: 0.0018,
    bevelThickness: 0.0015,
    bevelSegments: 2,
    curveSegments: 16,
  });

  for (const s of [-1, 1]) {
    const l = mesh(lensGeo, mats.lens);
    l.position.set(s * 0.032, 0, 0);
    shades.add(l);

    const rim = mesh(new THREE.TorusGeometry(0.028, 0.0022, 6, 22), mats.gold);
    rim.position.set(s * 0.032, 0, 0.002);
    rim.scale.y = 0.82;
    shades.add(rim);

    // Temple arm sweeping back over the ear.
    const arm = mesh(new THREE.CylinderGeometry(0.0018, 0.0018, 0.1, 6), mats.gold);
    arm.position.set(s * 0.058, 0.0, -0.048);
    arm.rotation.set(Math.PI / 2, 0, -s * 0.32);
    shades.add(arm);
  }

  const bridge = mesh(new THREE.CylinderGeometry(0.0022, 0.0022, 0.03, 6), mats.gold);
  bridge.rotation.z = Math.PI / 2;
  bridge.position.set(0, 0.008, 0.002);
  shades.add(bridge);

  g.add(shades);

  return g;
}

/* ------------------------------------------------------------------ build */

export interface RigOptions {
  /** 'crowd' drops face micro-detail and halves loft resolution. */
  detail?: 'hero' | 'crowd';
  look?: Look;
  ponytail?: boolean;
  shades?: boolean;
  earrings?: boolean;
  necklace?: boolean;
  /** Overall height multiplier; 1.0 is Mara's 1.68 m. */
  scale?: number;
  /** Broader shoulders, narrower hips. */
  build?: 'fem' | 'masc';
}

const DEFAULTS: Required<RigOptions> = {
  detail: 'hero',
  look: MARA_LOOK,
  ponytail: true,
  shades: true,
  earrings: true,
  necklace: true,
  scale: 1,
  build: 'fem',
};

export function buildMara(options: RigOptions = {}): {
  rig: MaraRig;
  mats: MaraMaterials;
} {
  const opts: Required<RigOptions> = { ...DEFAULTS, ...options };
  const mats = materials(opts.look);
  const hero = opts.detail === 'hero';
  // Loft resolution: halved for the crowd, where nobody counts the polygons.
  const R = (n: number) => (hero ? n : Math.max(6, Math.round(n * 0.55)));
  // Masc builds get wider shoulders and a narrower pelvis.
  const shoulderW = opts.build === 'masc' ? 1.12 : 1;
  const hipW = opts.build === 'masc' ? 0.88 : 1;

  const root = new THREE.Group();
  root.name = 'mara';
  root.scale.setScalar(opts.scale);

  /* -------------------------------------------------------------- torso */

  const hips = new THREE.Group();
  hips.position.y = P.hipY;
  root.add(hips);

  const pelvis = loft(
    [
      { y: -0.17, w: 0.128, d: 0.098 },
      { y: -0.09, w: 0.156, d: 0.111 },
      { y: -0.02, w: 0.162, d: 0.116 },
      { y: 0.05, w: 0.143, d: 0.105 },
      { y: 0.11, w: 0.124, d: 0.093 },
    ],
    { rings: R(20), radial: R(22), capScale: 0.5 },
  );
  hips.add(mesh(pelvis, mats.skin));

  const spine = new THREE.Group();
  spine.position.y = P.spineY;
  hips.add(spine);

  const torso = loft(
    [
      { y: -0.05, w: 0.122, d: 0.091 },
      { y: 0.04, w: 0.12, d: 0.09 },
      { y: 0.12, w: 0.134, d: 0.1, z: 0.004 },
      { y: 0.2, w: 0.15, d: 0.111, z: 0.007 },
      { y: 0.27, w: 0.161, d: 0.107, z: 0.003 },
      { y: 0.34, w: 0.152, d: 0.096, z: 0 },
    ],
    { rings: R(22), radial: R(22), capScale: 0.45 },
  );
  spine.add(mesh(torso, mats.skin));

  const chest = new THREE.Group();
  chest.position.y = P.chestH;
  spine.add(chest);

  /* ---------------------------------------------------------- clothing */

  // Tank top: open-ended shell riding just outside the torso.
  const tank = loft(
    [
      { y: -0.07, w: 0.128, d: 0.097 },
      { y: 0.02, w: 0.127, d: 0.096 },
      { y: 0.11, w: 0.141, d: 0.106, z: 0.004 },
      { y: 0.2, w: 0.157, d: 0.118, z: 0.007 },
      { y: 0.28, w: 0.168, d: 0.114, z: 0.003 },
    ],
    { rings: R(22), radial: R(22), capTop: false, capBottom: false },
  );
  spine.add(mesh(tank, mats.top));

  // Spaghetti straps over each shoulder.
  for (const s of [-1, 1]) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(s * 0.062, 0.275, 0.1),
      new THREE.Vector3(s * 0.116, 0.328, 0.052),
      new THREE.Vector3(s * 0.13, 0.338, -0.01),
      new THREE.Vector3(s * 0.088, 0.292, -0.08),
    ]);
    spine.add(mesh(new THREE.TubeGeometry(curve, 20, 0.008, 6, false), mats.top));
  }

  // Denim shorts. The waist shell stops at the crotch; each thigh carries its
  // own flared cuff below, so the hem follows the leg instead of gapping open.
  // The waist shell stops above where the legs separate; below that the per-leg
  // cuffs are the visible hem, overlapping the shell from OUTSIDE so no gap can
  // open onto the shell's hollow interior.
  const shorts = loft(
    [
      { y: -0.055, w: 0.186, d: 0.137 },
      { y: 0.0, w: 0.173, d: 0.127 },
      { y: 0.06, w: 0.15, d: 0.111 },
      { y: 0.095, w: 0.133, d: 0.101 },
    ],
    { rings: R(14), radial: R(22), capTop: false, capBottom: false },
  );
  hips.add(mesh(shorts, mats.denim));

  // Fills the gap between the thighs so the shorts' hollow interior is never
  // visible through the leg openings.
  const gusset = mesh(new THREE.SphereGeometry(0.085, R(14), R(12)), mats.denim);
  gusset.position.set(0, -0.115, 0.004);
  gusset.scale.set(1.25, 0.72, 1.2);
  hips.add(gusset);

  if (opts.necklace) {
    const chain = mesh(new THREE.TorusGeometry(0.048, 0.0022, 6, 26), mats.gold);
    chain.position.set(0, 0.276, 0.012);
    chain.rotation.x = Math.PI / 2 - 0.24;
    chain.scale.set(1, 0.86, 1);
    spine.add(chain);
  }

  /* --------------------------------------------------------- neck/head */

  const neck = new THREE.Group();
  neck.position.y = 0.012;
  chest.add(neck);

  // Starts below the shoulder line so it emerges from the torso rather than
  // butting against it — a hidden neck is what makes a head look shrunken.
  const neckGeo = loft(
    [
      { y: -0.045, w: 0.052, d: 0.05, z: -0.004 },
      { y: 0.01, w: 0.042, d: 0.041, z: -0.002 },
      { y: 0.05, w: 0.039, d: 0.038 },
      { y: P.neckH, w: 0.041, d: 0.04, z: 0.004 },
    ],
    { rings: R(10), radial: R(16), capTop: false, capBottom: false },
  );
  neck.add(mesh(neckGeo, mats.skin));

  const head = new THREE.Group();
  head.position.y = P.neckH;
  neck.add(head);
  // Crowd heads collapse to one mesh per material — a head is ~14 objects and
  // nothing inside it moves relative to the head bone.
  const headParts = buildHead(mats, opts);
  head.add(hero ? headParts : bakeStatic(headParts));

  /* -------------------------------------------------------- ponytail */

  const ponytail: THREE.Group[] = [];
  {
    const links = 5;
    let parent: THREE.Group = head;
    for (let i = 0; i < links; i++) {
      const link = new THREE.Group();
      link.position.set(0, i === 0 ? 0.196 : -0.062, i === 0 ? -0.072 : 0);
      const t = i / links;
      const seg = limb(
        0.068,
        [
          [0, 0.03 * (1 - t * 0.55)],
          [0.5, 0.028 * (1 - t * 0.6)],
          [1, 0.024 * (1 - t * 0.75)],
        ],
        0.85,
        hero ? 1 : 0.5,
      );
      link.add(mesh(seg, mats.hair));
      parent.add(link);
      ponytail.push(link);
      parent = link;
    }
    // Rest pose: swept back and down off the crown.
    ponytail[0].rotation.x = 0.55;
    for (let i = 1; i < ponytail.length; i++) ponytail[i].rotation.x = 0.16;
  }

  /* ------------------------------------------------------------- legs */

  const makeLeg = (side: number): LegChain => {
    const hip = new THREE.Group();
    hip.position.set(side * P.hipX * hipW, P.hipJointY, 0);
    hips.add(hip);

    hip.add(
      mesh(
        limb(P.thigh, [
          [0, 0.1],
          [0.2, 0.096],
          [0.55, 0.082],
          [0.85, 0.068],
          [1, 0.061],
        ], 1, hero ? 1 : 0.5),
        mats.skin,
      ),
    );

    // Denim cuff: flares wider than the waist shell's hem so it swallows the
    // seam, and follows the thigh when the leg swings.
    // Runs up past the hip joint so its top is swallowed by the waist shell,
    // and flares wider than the shell so the seam is hidden from every angle.
    const cuff = loft(
      [
        { y: -0.185, w: 0.092, d: 0.087 },
        { y: -0.13, w: 0.1, d: 0.094 },
        { y: -0.07, w: 0.112, d: 0.105 },
        { y: 0.02, w: 0.128, d: 0.118 },
      ],
      { rings: R(12), radial: R(18), capTop: false, capBottom: false },
    );
    hip.add(mesh(cuff, mats.denim));

    const knee = new THREE.Group();
    knee.position.y = -P.thigh;
    hip.add(knee);

    knee.add(
      mesh(
        limb(P.shin, [
          [0, 0.062],
          [0.22, 0.069],
          [0.55, 0.049],
          [0.85, 0.035],
          [1, 0.031],
        ], 1, hero ? 1 : 0.5),
        mats.skin,
      ),
    );

    const ankle = new THREE.Group();
    ankle.position.y = -P.shin;
    knee.add(ankle);
    const sh = shoe(mats, hero);
    ankle.add(hero ? sh : bakeStatic(sh));

    return { hip, knee, ankle };
  };

  const legL = makeLeg(1);
  const legR = makeLeg(-1);

  /* ------------------------------------------------------------- arms */

  const makeArm = (side: number): ArmChain => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * P.shoulderX * shoulderW, 0.005, 0);
    chest.add(shoulder);

    // Deltoid cap so the shoulder joint doesn't pinch.
    const delt = mesh(new THREE.SphereGeometry(0.055, R(14), R(12)), mats.skin);
    delt.scale.set(1, 0.92, 0.95);
    shoulder.add(delt);

    shoulder.add(
      mesh(
        limb(P.upperArm, [
          [0, 0.05],
          [0.3, 0.047],
          [0.75, 0.039],
          [1, 0.034],
        ], 1, hero ? 1 : 0.5),
        mats.skin,
      ),
    );

    const elbow = new THREE.Group();
    elbow.position.y = -P.upperArm;
    shoulder.add(elbow);

    elbow.add(
      mesh(
        limb(P.foreArm, [
          [0, 0.038],
          [0.22, 0.041],
          [0.7, 0.03],
          [1, 0.024],
        ], 1, hero ? 1 : 0.5),
        mats.skin,
      ),
    );

    const wrist = new THREE.Group();
    wrist.position.y = -P.foreArm;
    elbow.add(wrist);
    wrist.add(hand(mats, hero ? 1 : 0.5));

    return { shoulder, elbow, wrist };
  };

  const armL = makeArm(1);
  const armR = makeArm(-1);

  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });

  return {
    rig: { root, hips, spine, chest, neck, head, legL, legR, armL, armR, ponytail },
    mats,
  };
}

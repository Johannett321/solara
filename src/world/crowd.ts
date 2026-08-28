import * as THREE from 'three';
import { Rng } from '../core/rng';
import { buildMara, Look, RigOptions, MaraRig, P } from '../player/rig';
import { MaraAnimator, LocomotionState } from '../player/animator';
import { Colliders } from './collision';
import { bakeChunked } from '../util/bake';
import type { Cullable } from './culling';
import {
  ROAD_HALF,
  STRIP_MIN_Z,
  STRIP_MAX_Z,
  SHORELINE_X,
  AVENUES,
  CROSS_STREETS,
  CITY_MIN_Z,
  CITY_MAX_X,
  CITY_MAX_Z,
  groundHeight,
  riverInfluence,
} from './layout';
import type { BeachResult } from './beach';
import type { HitZone, PersonTarget } from '../weapons/ballistics';

/* ------------------------------------------------------------------ looks */

const SKIN = [0xf0c9a8, 0xe0b088, 0xd8a582, 0xb87e50, 0x8d5a34, 0x633d22, 0x4a2c19];
const HAIR = [0x14100c, 0x2e1c12, 0x4a3220, 0x6d4a24, 0x9b6f34, 0xc9a05a, 0x2a2a2c];

/** Saturated beachwear — the reference strip is anything but muted. */
const TOPS = [
  0xe8735a, 0xf2f0ea, 0x3fb0c8, 0xe8c93f, 0xd94f7c, 0x6dc16a, 0xf28f3b, 0x5a6ed0,
  0x1f2328, 0xf4a7c0, 0x2f8f6e, 0xe2e5ea,
];
const BOTTOMS = [
  0x54657d, 0x2f3a4a, 0xf0ece2, 0x8a6a4a, 0x1f2328, 0xc9d0d8, 0x7a4a52, 0x35506b,
];
const SHOES = [0xf3f0e8, 0x1f2328, 0xd8b551, 0xe0e4ea, 0x8a5a3a];

/** Swimwear: brighter and more saturated than the street palette. */
const SWIM_TOPS = [
  0x2fd0c8, 0xe2467a, 0xe8c22c, 0xf2f1ea, 0xf07a35, 0x46c07a, 0x2f7fc4, 0x9b5ad0,
  0xff5f7a, 0x1f2328, 0xc9f04a,
];
const SWIM_BOTTOMS = [
  0x2fd0c8, 0xe2467a, 0xe8c22c, 0xf2f1ea, 0xf07a35, 0x46c07a, 0x2f7fc4, 0x1f2328,
  0xff5f7a, 0x5a6ed0,
];

function randomLook(rng: Rng): Look {
  return {
    skin: rng.pick(SKIN),
    top: rng.pick(TOPS),
    bottom: rng.pick(BOTTOMS),
    hair: rng.pick(HAIR),
    shoe: rng.pick(SHOES),
  };
}

function beachLook(rng: Rng): Look {
  return {
    skin: rng.pick(SKIN),
    top: rng.pick(SWIM_TOPS),
    bottom: rng.pick(SWIM_BOTTOMS),
    hair: rng.pick(HAIR),
    // Barefoot on the sand: shoes take the skin tone so they disappear.
    shoe: 0,
  };
}

function randomOptions(rng: Rng, beach = false): RigOptions {
  const masc = rng.chance(0.45);
  const look = beach ? beachLook(rng) : randomLook(rng);
  if (beach) look.shoe = look.skin;
  return {
    detail: 'crowd',
    look,
    build: masc ? 'masc' : 'fem',
    ponytail: !masc && rng.chance(0.55),
    shades: rng.chance(beach ? 0.7 : 0.45),
    earrings: !masc && rng.chance(0.5),
    necklace: rng.chance(0.35),
    // Adult height spread, roughly 1.55 m to 1.87 m.
    scale: (masc ? rng.range(1.02, 1.11) : rng.range(0.93, 1.03)) * rng.range(0.99, 1.01),
  };
}

/**
 * Static seated pose: hips dropped to chair height, thighs forward, knees
 * folded, one arm resting on the table. Posed once at build time — the gait
 * solver would overwrite it every frame, so seated agents never run it.
 */
function poseSeated(rig: MaraRig, rng: Rng): void {
  // Chair seat is 0.44 m; the pelvis sits just above it.
  rig.root.position.y += 0.44 + 0.05 - P.hipY + 0.06;

  const lean = rng.range(-0.1, 0.16);
  rig.spine.rotation.x = -0.1 + lean;
  rig.chest.rotation.x = -0.04;
  rig.head.rotation.x = 0.1 - lean * 0.6;
  rig.head.rotation.y = rng.range(-0.5, 0.5);

  for (const [leg, s] of [
    [rig.legL, 1],
    [rig.legR, -1],
  ] as const) {
    leg.hip.rotation.x = -(Math.PI / 2) + rng.range(-0.12, 0.1);
    leg.hip.rotation.z = s * rng.range(0.06, 0.2);
    leg.knee.rotation.x = Math.PI / 2 + rng.range(-0.15, 0.3);
    leg.ankle.rotation.x = rng.range(-0.15, 0.15);
  }

  // Arms: one forward onto the table, the other hanging or in the lap.
  const onTable = rng.chance(0.6);
  for (const [arm, s] of [
    [rig.armL, 1],
    [rig.armR, -1],
  ] as const) {
    const up = onTable && (s > 0 ? rng.chance(0.7) : rng.chance(0.4));
    arm.shoulder.rotation.x = up ? -0.85 : -0.3;
    arm.shoulder.rotation.z = s * (up ? 0.22 : 0.12);
    arm.elbow.rotation.x = up ? -1.5 : -1.05;
    arm.wrist.rotation.x = up ? -0.25 : -0.1;
  }
}

/**
 * Flat out on a towel. The root is dropped to ground level and the whole rig
 * is tipped onto its back, then the limbs are splayed the way people actually
 * lie — one knee up, arms out or behind the head.
 */
function poseLying(rig: MaraRig, rng: Rng): void {
  const faceUp = rng.chance(0.65);
  // Tip the body flat. The rig is authored standing, so this is a 90 deg pitch.
  rig.root.rotation.x = faceUp ? -Math.PI / 2 : Math.PI / 2;
  // Once flat, the pelvis sits a few centimetres off the sand, not a metre up.
  rig.root.position.y += 0.13 - P.hipY;

  rig.spine.rotation.x = faceUp ? -0.12 : 0.1;
  rig.head.rotation.x = faceUp ? 0.2 : -0.15;
  rig.head.rotation.y = rng.range(-0.6, 0.6);

  const kneeUp = faceUp && rng.chance(0.45);
  for (const [leg, s] of [
    [rig.legL, 1],
    [rig.legR, -1],
  ] as const) {
    const up = kneeUp && s > 0;
    leg.hip.rotation.x = up ? -0.95 : rng.range(-0.06, 0.06);
    leg.hip.rotation.z = s * rng.range(0.04, 0.16);
    leg.knee.rotation.x = up ? 1.7 : rng.range(0.02, 0.14);
    leg.ankle.rotation.x = rng.range(-0.2, 0.35);
  }

  const behindHead = faceUp && rng.chance(0.4);
  for (const [arm, s] of [
    [rig.armL, 1],
    [rig.armR, -1],
  ] as const) {
    arm.shoulder.rotation.x = behindHead ? -2.1 : rng.range(-0.15, 0.15);
    arm.shoulder.rotation.z = s * (behindHead ? 0.5 : rng.range(0.18, 0.42));
    arm.elbow.rotation.x = behindHead ? -1.9 : -rng.range(0.05, 0.3);
  }
}

/** Reclined on a sun lounger, propped up on the backrest. */
function poseLounging(rig: MaraRig, rng: Rng): void {
  const recline = rng.range(0.55, 0.95);
  rig.root.rotation.x = -Math.PI / 2 + recline;
  rig.root.position.y += 0.42 - P.hipY * Math.cos(recline);

  rig.spine.rotation.x = -0.1;
  rig.head.rotation.x = 0.32;
  rig.head.rotation.y = rng.range(-0.5, 0.5);

  for (const [leg, s] of [
    [rig.legL, 1],
    [rig.legR, -1],
  ] as const) {
    leg.hip.rotation.x = rng.range(-0.12, 0.06);
    leg.hip.rotation.z = s * rng.range(0.05, 0.18);
    leg.knee.rotation.x = rng.chance(0.3) ? rng.range(0.5, 1.1) : rng.range(0.03, 0.2);
    leg.ankle.rotation.x = rng.range(-0.1, 0.3);
  }
  for (const [arm, s] of [
    [rig.armL, 1],
    [rig.armR, -1],
  ] as const) {
    arm.shoulder.rotation.x = rng.range(-0.25, 0.1);
    arm.shoulder.rotation.z = s * rng.range(0.22, 0.45);
    arm.elbow.rotation.x = -rng.range(0.1, 0.7);
  }
}

/**
 * Fold a shot pedestrian to the ground over `t` in 0..1.
 *
 * Not a ragdoll — there is no physics here to hang one on, and a scripted
 * collapse is both cheaper and more legible at the distance these are seen
 * from. The order is what sells it: the knees go first and the body follows,
 * because a figure that pitches over rigid reads as a falling plank.
 *
 * `back` is which way they go, taken from the shot direction, so a round from
 * behind puts them on their face.
 */
function poseCollapse(rig: MaraRig, t: number, back: number, side: number, groundY: number): void {
  const k = Math.min(1, t);
  // Ease out: fast at the start, settling into the ground.
  const e = 1 - (1 - k) * (1 - k);

  // The legs give way first, and then straighten out again as the body
  // settles. Held bent, the knees end up pointing at the sky and the body reads
  // as a chair rather than a corpse — so the buckle is a transient that peaks
  // early and decays, with only a little sprawl left at rest.
  const buckle = Math.sin(Math.min(1, k * 1.5) * Math.PI);
  for (const [leg, s] of [
    [rig.legL, 1],
    [rig.legR, -1],
  ] as const) {
    leg.hip.rotation.x = -0.5 * buckle - 0.05 * e;
    leg.knee.rotation.x = 1.5 * buckle + 0.12 * e;
    leg.hip.rotation.z = s * (0.12 * buckle + 0.15 * e);
    leg.ankle.rotation.x = 0.3 * buckle + 0.1 * e;
  }

  // Then the whole body tips over, pivoting about the feet where the root sits.
  //
  // The pelvis must NOT be pulled down `hips.position.y` to do this. That axis
  // is the body's own up, and a quarter turn later it is pointing along the
  // ground — dropping the pelvis 'down' it telescopes the character into
  // itself. The rotation does the work; the root only has to rise by half a
  // body's thickness so the finished pose rests on the pavement rather than
  // half inside it.
  rig.root.rotation.x = back * (Math.PI / 2) * e;
  rig.root.rotation.z = side * 0.14 * e;
  rig.root.position.y = groundY + LYING_HEIGHT * e;
  rig.hips.position.y = P.hipY;

  // Arms fly out and then flop, ending spread on the ground rather than raised.
  const fling = Math.sin(Math.min(1, k * 1.6) * Math.PI);
  for (const [arm, sgn] of [
    [rig.armL, 1],
    [rig.armR, -1],
  ] as const) {
    arm.shoulder.rotation.x = -0.3 * fling + 0.12 * e;
    arm.shoulder.rotation.z = sgn * (0.3 * fling + 0.6 * e);
    arm.elbow.rotation.x = -0.6 * fling - 0.22 * e;
  }

  rig.spine.rotation.x = 0.12 * e - 0.35 * fling;
  rig.chest.rotation.x = 0.06 * e;
  rig.head.rotation.x = -0.25 * e;
  rig.head.rotation.y = 0;
  rig.head.rotation.z = 0;
}

/* ------------------------------------------------------------------ agent */

/**
 * How a survivor carries a body hit.
 *
 * Picked from where the round landed relative to the body, and then permanent:
 * a pedestrian who has been shot keeps walking wrong for the rest of the
 * session, which is the whole point of the state existing.
 */
export type Injury = 'none' | 'leg' | 'arm' | 'gut';

/** Body shots a pedestrian survives. A head shot is always fatal. */
const BODY_HITS_TO_KILL = 3;
/** Seconds the flinch takes to play out. */
const FLINCH_TIME = 0.42;
/** Seconds the collapse takes. */
const DEATH_TIME = 0.95;
/**
 * How high the rig root sits once a body is flat, in metres.
 *
 * With the root pitched a quarter turn the body extends horizontally from it,
 * so this is simply half the thickness of a person lying down.
 */
const LYING_HEIGHT = 0.16;

interface Agent {
  rig: MaraRig;
  anim: MaraAnimator;
  pos: THREE.Vector3;
  yaw: number;
  /** Preferred walking lane, in x. */
  lane: number;
  /** +1 walks toward +z, -1 toward -z. 0 means stationary. */
  heading: number;
  speed: number;
  /** Lateral offset used to sidestep the player. */
  dodge: number;
  /** Standing agents drift their gaze rather than their feet. */
  idle: boolean;
  /** Posed once at build time; never runs the gait solver. */
  seated: boolean;
  /** Beach agents roam the sand instead of the promenade lanes. */
  beach: boolean;
  /** City agents walk an inland avenue and are not clamped to the promenade. */
  city: boolean;
  bob: number;
  /** This agent's entry in the culler; `near` is the range rule below. */
  cull: Cullable;

  /* ------------------------------------------------------------ damage */

  /** Body shots absorbed so far. */
  wounds: number;
  /** 0 until shot, then counts up through `DEATH_TIME` and stops at 1. */
  dying: number;
  dead: boolean;
  /** 1 the instant a round lands, decaying over `FLINCH_TIME`. */
  flinch: number;
  /** Lateral component of the shot in the agent's own frame, -1..1. */
  flinchSide: number;
  /** Set on the frame a head shot lands, so the flinch reads differently. */
  flinchHead: boolean;
  injury: Injury;
  /** Which side the limp or the held arm is on. */
  injurySide: number;
  /** Which way they fold, set from the shot that killed them. */
  deathBack: number;
  deathSide: number;
  /** This agent's row in the shootable list. */
  target: PersonTarget;
}

export interface Crowd {
  group: THREE.Group;
  /** One entry per live pedestrian, for group-level culling. */
  cullable: Cullable[];
  /**
   * Shootable pedestrians, as head and body spheres. Built once and held by
   * reference, so `weapons/ballistics.ts` can walk it without allocating.
   */
  people: PersonTarget[];
  /**
   * Put a round into person `index`. The index comes back from the trace.
   *
   * @param dirX,dirZ The shot direction, for which way they fold.
   */
  shoot(index: number, zone: HitZone, dirX: number, dirZ: number, hitY: number): void;
  /**
   * Agent state, for `window.SOLARA`. Reaction poses are hard to tell apart by
   * eye at pedestrian distance — a raised arm can be a flinch, a cradled wound
   * or the ordinary walk swing — so the state has to be readable directly.
   */
  debug(index: number): Record<string, unknown> | null;
  /** The posed sunbathers and diners, baked. Chunked, so it culls per chunk. */
  posed: THREE.Group;
  /** Live pedestrian positions, for the map overlay. */
  positions(): THREE.Vector3[];
  update(dt: number, playerPos: THREE.Vector3): void;
}

/** Pedestrians past this range are hidden and stop animating. */
const CULL_DIST = 62;

const LANES_EAST = [8.6, 9.8, 11.2, 13.4, 14.6];
const LANES_WEST = [-8.6, -9.9, -11.4, -12.6];

export function buildCrowd(colliders: Colliders, beach: BeachResult): Crowd {
  const group = new THREE.Group();
  group.name = 'crowd';
  const rng = new Rng(24601);
  const agents: Agent[] = [];
  const cullable: Cullable[] = [];
  // Parallel to `agents`: one row per live pedestrian, in the same order, so
  // the index a trace returns indexes both.
  const people: PersonTarget[] = [];

  /**
   * Sunbathers, diners and anyone else posed once and left alone never move a
   * joint again, so they are geometry, not agents: they go in here and get
   * merged by the bake pass. Left as live rigs they were 8000+ draw calls on
   * their own — more than the rest of the world combined.
   */
  const statics = new THREE.Group();
  statics.name = 'crowd:static';
  const staticPositions: THREE.Vector3[] = [];

  type Static = 'sit' | 'lie' | 'lounge';

  /** Returns the live agent, or null when the pose made it static geometry. */
  const spawn = (
    x: number,
    z: number,
    yaw: number,
    idle: boolean,
    pose: Static | null = null,
    beach = false,
  ): Agent => {
    // Live agents collapse to one SkinnedMesh — 40 draw calls down to about a
    // dozen, and the same again saved in the shadow pass. The posed ones must
    // keep their loose hierarchy: `poseSeated` and friends run *after* this
    // call, and a skeleton captured at the rest pose would have to be rebound
    // to pick the pose up. They never animate, so the bake below is a better
    // answer for them anyway.
    const { rig } = buildMara({ ...randomOptions(rng, beach), skinned: pose === null });
    const pos = new THREE.Vector3(x, groundHeight(x, z), z);
    rig.root.position.copy(pos);
    rig.root.rotation.y = yaw;
    group.add(rig.root);

    if (pose === 'sit') poseSeated(rig, rng);
    else if (pose === 'lie') poseLying(rig, rng);
    else if (pose === 'lounge') poseLounging(rig, rng);

    if (pose !== null) {
      // Static: move it out of the live group and record it for the map.
      group.remove(rig.root);
      statics.add(rig.root);
      staticPositions.push(pos.clone());
      return null as unknown as Agent;
    }

    const seated = false;

    // A standing figure is under two metres; the sphere sits on her feet, so
    // this clears the top of the tallest of them with room to spare.
    const cull: Cullable = { object: rig.root, radius: 2.2, near: true };
    cullable.push(cull);

    // Hit spheres, scaled with the figure. The crowd varies height by ±10%, and
    // a fixed head sphere sits in the neck of the tall ones and over the hair of
    // the short ones. Heights are joint heights from `player/rig.ts` plus the
    // skull's own centre.
    const scale = rig.root.scale.y;
    const target: PersonTarget = {
      position: pos,
      headY: (P.hipY + P.spineY + P.chestH + P.neckH + 0.12) * scale,
      headR: 0.15 * scale,
      bodyY: (P.hipY + 0.16) * scale,
      bodyR: 0.36 * scale,
      dead: false,
    };
    people.push(target);

    const a: Agent = {
      cull,
      target,
      wounds: 0,
      dying: 0,
      dead: false,
      flinch: 0,
      flinchSide: 0,
      flinchHead: false,
      injury: 'none',
      injurySide: 1,
      deathBack: 1,
      deathSide: 1,
      rig,
      anim: new MaraAnimator(rig),
      pos,
      yaw,
      lane: x,
      heading: idle ? 0 : rng.chance(0.5) ? 1 : -1,
      speed: idle ? 0 : rng.range(1.05, 1.75),
      dodge: 0,
      idle: idle || seated,
      seated,
      beach,
      city: false,
      bob: rng.range(0, Math.PI * 2),
    };
    agents.push(a);
    return a;
  };

  /* --------------------------------------------------------- pedestrians */

  // Walkers spread down both promenades, densest near the hotel frontage.
  for (let i = 0; i < 22; i++) {
    const east = rng.chance(0.62);
    const lane = east ? rng.pick(LANES_EAST) : rng.pick(LANES_WEST);
    // Bias toward the blocks around the player's spawn.
    const z = rng.chance(0.6) ? rng.range(-30, 45) : rng.range(STRIP_MIN_Z + 20, STRIP_MAX_Z - 20);
    const a = spawn(lane + rng.range(-0.4, 0.4), z, 0, false);
    a.yaw = a.heading > 0 ? 0 : Math.PI;
    a.rig.root.rotation.y = a.yaw;
  }

  /* ------------------------------------------------- knots of standing people */

  // Clusters facing inward, like the group posing in the reference shot.
  const clusters: Array<[number, number, number]> = [
    [11.4, 6.5, 4],
    [12.6, -8, 3],
    [9.4, 26, 3],
    [-10.4, -4, 3],
    [13.2, -20, 2],
    [-9.8, 30, 2],
  ];
  for (const [cx, cz, n] of clusters) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = rng.range(0.55, 0.95);
      const x = cx + Math.cos(a0) * r;
      const z = cz + Math.sin(a0) * r;
      // Face the centre of the group.
      spawn(x, z, Math.atan2(cx - x, cz - z), true);
    }
  }

  /* ------------------------------------------------- diners at the tables */

  // Terrace runs matching the café rows in props.ts.
  const terraces: Array<[number, number]> = [
    [-16, 16],
    [-48, -19],
    [42, 71],
  ];
  for (const [z0, z1] of terraces) {
    for (let z = z0 + 1; z <= z1; z += 3.3) {
      if (!rng.chance(0.5)) continue;
      // Seated either side of the table, facing across it.
      const side = rng.chance(0.5) ? 1 : -1;
      const x = 13.3 + side * 0.78 + rng.range(-0.15, 0.15);
      spawn(x, z + rng.range(-0.3, 0.3), side > 0 ? -Math.PI / 2 : Math.PI / 2, false, 'sit');
    }
  }

  /* ------------------------------------------------------------- the city */

  // Walkers on the inland avenue pavements. They use the same lane-following
  // logic as the promenade crowd, just with a different lane x.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (let i = 0; i < 16; i++) {
      const side = rng.chance(0.5) ? 1 : -1;
      const lane = a.x + side * (a.halfWidth + rng.range(1.4, 3.4));
      const z = rng.range(CITY_MIN_Z + 20, CITY_MAX_Z - 20);
      if (riverInfluence(lane, z) > 0.05) continue;
      const ag = spawn(lane, z, 0, false);
      ag.yaw = ag.heading > 0 ? 0 : Math.PI;
      ag.rig.root.rotation.y = ag.yaw;
      ag.city = true;
    }
  }

  // Groups standing on the cross-street pavements too — the avenues alone left
  // half the grid with nobody on it.
  for (const c of CROSS_STREETS) {
    for (let i = 0; i < 5; i++) {
      const side = rng.chance(0.5) ? 1 : -1;
      const lane = c.z + side * (c.halfWidth + rng.range(1.4, 3.4));
      const x = rng.range(AVENUES[1].x, CITY_MAX_X - 20);
      if (riverInfluence(x, lane) > 0.05) continue;
      spawn(x, lane, rng.range(0, Math.PI * 2), true);
    }
  }

  // A few clusters waiting at junctions.
  for (const a of AVENUES) {
    if (a.x === 0) continue;
    for (const c of CROSS_STREETS) {
      if (!rng.chance(0.45)) continue;
      const n = rng.int(2, 4);
      for (let i = 0; i < n; i++) {
        spawn(
          a.x + (rng.chance(0.5) ? 1 : -1) * (a.halfWidth + rng.range(1.5, 3)),
          c.z + (rng.chance(0.5) ? 1 : -1) * (c.halfWidth + rng.range(1.5, 3)),
          rng.range(0, Math.PI * 2),
          true,
        );
      }
    }
  }

  /* ------------------------------------------------------------ the beach */

  // Sunbathers on the towels and loungers laid out by world/beach.ts.
  for (const seat of beach.seats) {
    if (!rng.chance(0.72)) continue;
    spawn(
      seat.x + rng.range(-0.15, 0.15),
      seat.z + rng.range(-0.15, 0.15),
      seat.yaw + rng.range(-0.25, 0.25),
      false,
      seat.kind === 'lounger' ? 'lounge' : 'lie',
      true,
    );
  }

  // Walkers on the sand, mostly along the water's edge.
  for (let i = 0; i < 26; i++) {
    const x = rng.chance(0.5)
      ? rng.range(SHORELINE_X + 1, SHORELINE_X + 9)
      : rng.range(-52, -38);
    const z = rng.chance(0.65) ? rng.range(-60, 70) : rng.range(STRIP_MIN_Z, STRIP_MAX_Z);
    const a = spawn(x, z, 0, false, null, true);
    a.yaw = a.heading > 0 ? 0 : Math.PI;
    a.rig.root.rotation.y = a.yaw;
    a.speed = rng.range(0.8, 1.5);
  }

  // Standing about on the sand, and wading in the shallows. Waders need no
  // special handling: their feet sit on the seabed and the water plane cuts
  // them off at whatever depth they are standing in.
  for (let i = 0; i < 30; i++) {
    const wading = rng.chance(0.45);
    const x = wading
      ? rng.range(SHORELINE_X - 11, SHORELINE_X - 1)
      : rng.range(-53, -37);
    const z = rng.chance(0.7) ? rng.range(-70, 80) : rng.range(STRIP_MIN_Z, STRIP_MAX_Z);
    spawn(x, z, rng.range(0, Math.PI * 2), true, null, true);
  }

  // Knots of people talking on the sand.
  for (let k = 0; k < 8; k++) {
    const cx = rng.range(-52, -40);
    const cz = rng.range(-90, 110);
    const n = rng.int(2, 4);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
      const r = rng.range(0.6, 1.0);
      const x = cx + Math.cos(a0) * r;
      const z = cz + Math.sin(a0) * r;
      spawn(x, z, Math.atan2(cx - x, cz - z), true, null, true);
    }
  }

  // Standing figures are permanent obstacles; walkers are not.
  for (const a of agents) {
    if (a.idle) colliders.addCircle(a.pos.x, a.pos.z, 0.3, 1.6);
  }

  const posed = bakeChunked(statics, (o) => Math.floor(o.position.z / 40));
  group.add(posed);

  /* ----------------------------------------------------------- update */

  const state: LocomotionState = {
    speed: 0,
    distance: 0,
    turnRate: 0,
    groundY: 0,
    grounded: true,
    vy: 0,
    justLanded: false,
  };

  /** Local frame of an agent, for turning a world shot into a body-space one. */
  const shotSide = (a: Agent, dirX: number, dirZ: number): { back: number; side: number } => {
    // Forward is (sin yaw, cos yaw); right is the perpendicular.
    const fx = Math.sin(a.yaw);
    const fz = Math.cos(a.yaw);
    return { back: dirX * fx + dirZ * fz, side: dirX * fz - dirZ * fx };
  };

  return {
    group,
    cullable,
    posed,
    people,
    shoot(index, zone, dirX, dirZ, hitY) {
      const a = agents[index];
      if (!a || a.dead) return;

      const { back, side } = shotSide(a, dirX, dirZ);
      a.flinch = 1;
      a.flinchSide = THREE.MathUtils.clamp(side, -1, 1);
      a.flinchHead = zone === 'head';

      // A head shot is always fatal, whatever they have absorbed so far.
      if (zone === 'head') {
        a.wounds = BODY_HITS_TO_KILL;
      } else {
        a.wounds++;
        if (a.wounds < BODY_HITS_TO_KILL) {
          // Survivors keep the wound, chosen from **where the round actually
          // landed** rather than from which way it was travelling: the player
          // watched it hit, and a low shot that produces a clutched shoulder
          // reads as a bug. The body sphere spans roughly hip to collarbone, so
          // the height within it maps straight onto hip, gut and shoulder.
          if (a.injury === 'none') {
            const local = hitY - a.pos.y;
            const t = (local - a.target.bodyY) / a.target.bodyR;
            a.injury = t < -0.35 ? 'leg' : t > 0.35 ? 'arm' : 'gut';
            // Side comes from the shot: which hip or shoulder took it.
            a.injurySide = side >= 0 ? 1 : -1;
          }
          // Wounded people do not stroll.
          a.speed *= a.injury === 'leg' ? 0.55 : 0.75;
          return;
        }
      }

      a.dead = true;
      a.target.dead = true;
      a.dying = 0;
      // Away from the shooter, so a round in the back drops them on their face.
      a.deathBack = back >= 0 ? -1 : 1;
      a.deathSide = side >= 0 ? 1 : -1;
      a.speed = 0;
      a.idle = true;
    },
    debug(index) {
      const a = agents[index];
      if (!a) return null;
      return {
        injury: a.injury,
        injurySide: a.injurySide,
        flinch: +a.flinch.toFixed(3),
        flinchHead: a.flinchHead,
        wounds: a.wounds,
        dead: a.dead,
        dying: +a.dying.toFixed(3),
        idle: a.idle,
        speed: +a.speed.toFixed(2),
      };
    },
    positions: () => [...agents.map((a) => a.pos), ...staticPositions],
    update(dt, playerPos) {
      for (const a of agents) {
        let moved = 0;

        // A body on the pavement is scenery: it holds its final pose and stops
        // costing an animator update entirely once it has finished falling.
        if (a.dead) {
          const far = a.pos.distanceToSquared(playerPos) > CULL_DIST * CULL_DIST;
          a.cull.near = !far;
          if (a.dying >= 1) continue;
          a.dying = Math.min(1, a.dying + dt / DEATH_TIME);
          a.pos.y = groundHeight(a.pos.x, a.pos.z);
          a.rig.root.position.set(a.pos.x, a.pos.y, a.pos.z);
          a.rig.root.rotation.y = a.yaw;
          poseCollapse(a.rig, a.dying, a.deathBack, a.deathSide, a.pos.y);
          continue;
        }

        a.flinch = Math.max(0, a.flinch - dt / FLINCH_TIME);

        if (!a.idle) {
          const step = a.speed * dt;
          a.pos.z += a.heading * step;
          moved = step;

          // Wrap around the ends of the strip rather than pooling at the edges.
          const zHi = a.city ? CITY_MAX_Z - 12 : STRIP_MAX_Z - 12;
          const zLo = a.city ? CITY_MIN_Z + 12 : STRIP_MIN_Z + 12;
          if (a.pos.z > zHi) a.pos.z = zLo;
          if (a.pos.z < zLo) a.pos.z = zHi;

          // Sidestep the player instead of walking through her.
          const dx = a.pos.x - playerPos.x;
          const dz = a.pos.z - playerPos.z;
          const d = Math.hypot(dx, dz);
          const want = d < 1.6 && d > 1e-3 ? Math.sign(dx || 1) * (1.6 - d) * 0.9 : 0;
          a.dodge += (want - a.dodge) * Math.min(1, dt * 3.5);

          const targetX = a.lane + a.dodge;
          const prevX = a.pos.x;
          a.pos.x += (targetX - a.pos.x) * Math.min(1, dt * 2.2);
          moved = Math.hypot(moved, a.pos.x - prevX);

          // Keep them where they belong: promenade walkers out of the road,
          // beach walkers between the dune and waist-deep water.
          if (a.city) {
            // City walkers keep to their own pavement, a metre either way.
            a.pos.x = THREE.MathUtils.clamp(a.pos.x, a.lane - 1.2, a.lane + 1.2);
          } else {
            const limit = a.beach
              ? [SHORELINE_X - 11, -36]
              : a.lane > 0
                ? [ROAD_HALF + 1.1, 15.2]
                : [-15.2, -(ROAD_HALF + 1.1)];
            a.pos.x = THREE.MathUtils.clamp(a.pos.x, limit[0], limit[1]);
          }

          const targetYaw = Math.atan2(a.dodge * 0.6, a.heading);
          a.yaw += Math.atan2(Math.sin(targetYaw - a.yaw), Math.cos(targetYaw - a.yaw)) * Math.min(1, dt * 4);
        }

        if (!a.seated) {
          a.pos.y = groundHeight(a.pos.x, a.pos.z);
          a.rig.root.position.copy(a.pos);
          a.rig.root.rotation.y = a.yaw;
        }

        // Beyond the fog they are a handful of unreadable pixels but still cost
        // ~30 draw calls each, twice over with the shadow pass. The culler ANDs
        // this with the view and shadow frusta — it is the one writer of
        // `visible`, so the range rule is handed to it rather than applied here.
        const far = a.pos.distanceToSquared(playerPos) > CULL_DIST * CULL_DIST;
        a.cull.near = !far;
        if (far) continue;

        // Seated agents hold the pose set at build time; running the gait
        // solver on them would stand them straight back up.
        if (a.seated) continue;

        state.speed = a.idle ? 0 : a.speed;
        state.distance = moved;
        state.groundY = a.pos.y;
        state.flinch = a.flinch;
        state.flinchSide = a.flinchSide;
        state.flinchHead = a.flinchHead;
        state.injury = a.injury;
        state.injurySide = a.injurySide;
        a.anim.update(dt, state);
      }
    },
  };
}

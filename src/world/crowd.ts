import * as THREE from 'three';
import { Rng } from '../core/rng';
import { buildMara, Look, RigOptions, MaraRig, P } from '../player/rig';
import { MaraAnimator } from '../player/animator';
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

/* ------------------------------------------------------------------ agent */

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
}

export interface Crowd {
  group: THREE.Group;
  /** One entry per live pedestrian, for group-level culling. */
  cullable: Cullable[];
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

    const a: Agent = {
      cull,
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

  const state = {
    speed: 0,
    distance: 0,
    turnRate: 0,
    groundY: 0,
    grounded: true,
    vy: 0,
    justLanded: false,
  };

  return {
    group,
    cullable,
    posed,
    positions: () => [...agents.map((a) => a.pos), ...staticPositions],
    update(dt, playerPos) {
      for (const a of agents) {
        let moved = 0;

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
        a.anim.update(dt, state);
      }
    },
  };
}

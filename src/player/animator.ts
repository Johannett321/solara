import * as THREE from 'three';
import { MaraRig, P } from './rig';

/**
 * Procedural locomotion. There is no animation clip anywhere in this project —
 * every joint angle below is evaluated from the gait phase, and the gait phase
 * advances with distance actually travelled, so the feet never skate no matter
 * how the speed ramps.
 */

/** Shortest signed angular difference. */
function angDiff(a: number, b: number): number {
  let d = (a - b) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Gaussian bump on the gait circle — the building block for joint curves. */
function bump(phase: number, centre: number, width: number): number {
  const d = angDiff(phase, centre);
  return Math.exp(-(d * d) / (2 * width * width));
}

const PI = Math.PI;

/**
 * Aim pose, in joint angles.
 *
 * Split out and mutable so it can be tuned against a screenshot rather than by
 * arithmetic: the weapon hangs off the wrist through two Euler chains, and
 * working out by hand which sign puts the barrel on the crosshair is a good way
 * to spend an afternoon. `window.SOLARA.aimPose` is this object.
 */
export const AIM_POSE = {
  /** Gun arm. `pitch` terms track the camera up and down. */
  /**
   * Solved for where the *hand* ends up, not for where the barrel points.
   *
   * Optimising the arm angles directly against the aim line finds poses that
   * are numerically perfect and anatomically absurd — the first solve put the
   * barrel within a degree of the crosshair with her fist tucked against her
   * ear. The arm is placed to look like someone holding a gun, and
   * `GRIP_ROTATION` in `weapons/index.ts` takes up the remaining few degrees.
   */
  gunShoulderX: -1.22,
  /**
   * Share of the camera pitch the shoulder carries. Positive because
   * `chase.pitch` is positive looking *down* — the sign here was wrong first
   * time and made the gun swing away from the crosshair rather than with it.
   * Residual is under a degree level, ~5 aiming steeply down.
   */
  gunShoulderXPitch: 0.95,
  gunShoulderY: 0.3,
  gunShoulderZ: 0.25,
  gunElbowX: -0.5,
  gunWristX: -0.06,
  /**
   * Support arm, two-handed. Solved for the gap between the left hand and the
   * SMG's `SUPPORT_GRIP`, which is the magazine well rather than the foregrip:
   * with the gun arm extended, the foregrip sits about 0.72 m from the left
   * shoulder and the whole arm is 0.545 m, so no pose reaches it. Gripping the
   * magazine is both a real technique and one she can actually get to. Residual
   * gap is ~8 cm, which is inside the width of a hand.
   */
  supShoulderX: -1.43,
  supShoulderXPitch: 0.95,
  supShoulderY: -0.75,
  supShoulderZ: -0.03,
  supElbowX: -0.25,
  /** Support arm, one-handed: tucked in rather than left hanging. */
  freeShoulderX: -0.42,
  freeShoulderY: -0.2,
  freeShoulderZ: 0.16,
  freeElbowX: -1.15,
  /** Torso squared up behind the gun. */
  spineY: -0.12,
  spineX: -0.06,
  spineXPitch: -0.12,
  chestY: -0.16,
  chestX: -0.04,
  headXPitch: -0.42,
  headX: 0.05,
  headY: 0.1,
};

/**
 * Per-layer weights for the reaction poses, as a debugging seam.
 *
 * These layers stack on top of the gait and on each other, and at pedestrian
 * distance an odd-looking arm could be coming from any of them. Multiplying a
 * layer out at runtime — `window.SOLARA.reactions.injury = 0` — is the quickest
 * way to find which one owns a pose. Left at 1 in normal play.
 */
export const REACTIONS = { flinch: 1, injury: 1, reload: 1 };

export const GAIT = {
  walkSpeed: 1.65,
  runSpeed: 5.1,
  /** Ground covered by one full two-step cycle, per gait. */
  walkCycle: 1.55,
  runCycle: 3.1,
  /** Matches Controller's JUMP_SPEED; used to normalise vertical velocity. */
  jumpSpeed: 5.1,
} as const;

export interface LocomotionState {
  /** Horizontal speed, m/s. */
  speed: number;
  /** Ground distance covered this frame, m. */
  distance: number;
  /** Yaw change, rad/s. */
  turnRate: number;
  /** Surface height under her feet. */
  groundY: number;
  grounded: boolean;
  /** Vertical velocity, m/s. */
  vy: number;
  /** True for the single frame she touches down. */
  justLanded: boolean;
  /** Out of her depth: front crawl instead of a walk cycle. */
  swimming?: boolean;
  /** Water depth underfoot, for the wading blend. */
  depth?: number;
  /**
   * 0 carrying, 1 aiming down sights. The gun hangs from the wrist joint, so
   * the aim pose is what points it — there is no separate weapon animation.
   */
  aim?: number;
  /** Camera pitch, so she actually looks where the crosshair is. */
  aimPitch?: number;
  /** Support hand comes across for an SMG, stays clear for a pistol. */
  twoHanded?: boolean;
  /** Reload progress, 0..1. Overrides the aim pose while it runs. */
  reload?: number;

  /* ------------------------------------------------- taking a round */

  /** 1 the instant a round lands, decaying to 0. */
  flinch?: number;
  /** Lateral component of the shot in body space, -1..1. */
  flinchSide?: number;
  /** A head shot snaps rather than folds. */
  flinchHead?: boolean;
  /** A wound they are still carrying, which changes how they walk. */
  injury?: 'none' | 'leg' | 'arm' | 'gut';
  injurySide?: number;
}

interface Link {
  vx: number;
  vz: number;
  restX: number;
  restZ: number;
}

export class MaraAnimator {
  private phase = 0;
  private gait = 0;
  private run01 = 0;
  private breath = 0;
  private idleT = 0;
  private lookYaw = 0;
  private lookPitch = 0;
  private lookTimer = 0;

  private air = 0;
  private land = 0;
  private swim = 0;
  private stroke = 0;
  private aim = 0;
  private reload = 0;

  /**
   * Fired the moment a foot plants. Only the player's animator sets this — the
   * whole crowd shares this class, and a hundred pairs of footsteps would be
   * both deafening and pointless.
   */
  onFootPlant?: (side: -1 | 1) => void;
  /** Half-cycle accumulator; one step per PI of gait phase. */
  private stepAccum = 0;
  private stepSide: -1 | 1 = 1;

  private links: Link[];
  private prevHead = new THREE.Vector3();
  private headVel = new THREE.Vector3();
  private headAcc = new THREE.Vector3();
  private hasPrev = false;

  private tmp = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(private rig: MaraRig) {
    this.links = rig.ponytail.map((l) => ({
      vx: 0,
      vz: 0,
      restX: l.rotation.x,
      restZ: l.rotation.z,
    }));
  }

  update(dt: number, st: LocomotionState): void {
    const r = this.rig;
    const { speed, distance, turnRate, groundY } = st;

    // Swim weight, eased so entering and leaving the water isn't a snap.
    this.swim += ((st.swimming ? 1 : 0) - this.swim) * Math.min(1, dt * 4);
    this.stroke += dt * (1.4 + Math.min(1, speed / 2.2) * 2.4);

    // Airborne weight, eased so takeoff and touchdown aren't instant pops.
    this.air += ((st.grounded ? 0 : 1) - this.air) * Math.min(1, dt * 16);
    if (st.justLanded) this.land = 1;
    this.land = Math.max(0, this.land - dt / 0.34);

    /* -------------------------------------------------------- blending */

    const targetGait = THREE.MathUtils.smoothstep(speed, 0.12, 0.9);
    // Ease in/out of the gait so a tap of W doesn't snap the legs open.
    this.gait += (targetGait - this.gait) * Math.min(1, dt * 11);

    const targetRun = THREE.MathUtils.clamp(
      (speed - GAIT.walkSpeed) / (GAIT.runSpeed - GAIT.walkSpeed),
      0,
      1,
    );
    this.run01 += (targetRun - this.run01) * Math.min(1, dt * 7);
    const run = this.run01;

    const cycle = THREE.MathUtils.lerp(GAIT.walkCycle, GAIT.runCycle, run);
    const advance = (distance / cycle) * PI * 2;
    this.phase = (this.phase + advance) % (PI * 2);

    // Steps are driven off the same distance-based advance as the pose, so the
    // sound lands on the frame the foot actually touches down.
    if (this.onFootPlant) {
      this.stepAccum += advance;
      while (this.stepAccum >= PI) {
        this.stepAccum -= PI;
        if (this.gait > 0.3 && st.grounded && !st.swimming) this.onFootPlant(this.stepSide);
        this.stepSide = this.stepSide === 1 ? -1 : 1;
      }
    }
    // Keep a slow idle-side cadence so the blend out of walking stays smooth.
    const ph = this.phase;
    const g = this.gait;

    this.breath += dt * (1.1 + run * 2.2);
    this.idleT += dt;

    /* ------------------------------------------------------------ legs */

    const thighAmp = THREE.MathUtils.lerp(0.52, 0.92, run) * g;
    const kneeSwing = THREE.MathUtils.lerp(1.12, 1.55, run);
    const kneeStance = THREE.MathUtils.lerp(0.2, 0.34, run);

    const poseLeg = (leg: typeof r.legL, phase: number, side: number) => {
      // Thigh: negative rotation.x swings the leg toward +Z (forward).
      leg.hip.rotation.x = -thighAmp * Math.cos(phase);
      // Slight outward splay, plus hip drop compensation.
      leg.hip.rotation.z = side * (0.035 + 0.02 * g);
      leg.hip.rotation.y = side * 0.02;

      const flex =
        kneeStance * bump(phase, 0.26 * PI, 0.34) +
        kneeSwing * bump(phase, 1.3 * PI, 0.56) +
        0.05;
      leg.knee.rotation.x = flex * g + (1 - g) * 0.045;

      const ankle =
        -0.2 * bump(phase, 0.02 * PI, 0.3) +
        0.52 * bump(phase, 0.96 * PI, 0.32) -
        0.22 * bump(phase, 1.45 * PI, 0.42);
      leg.ankle.rotation.x = ankle * g;
    };

    poseLeg(r.legL, ph, 1);
    poseLeg(r.legR, ph + PI, -1);

    /* ------------------------------------------------------------ arms */

    const armAmp = THREE.MathUtils.lerp(0.44, 0.86, run) * g;
    const baseBend = 0.22 + run * 0.62;

    const poseArm = (arm: typeof r.armL, phase: number, side: number) => {
      arm.shoulder.rotation.x = -armAmp * Math.cos(phase) + (1 - g) * 0.04;
      // Held just clear of the hips, opening slightly at a run.
      arm.shoulder.rotation.z = side * (0.075 + 0.035 * g + 0.04 * run);
      arm.shoulder.rotation.y = side * (-0.04 - 0.1 * run * g);

      const swingBend = Math.max(0, Math.cos(phase)) * (0.22 + run * 0.5);
      arm.elbow.rotation.x = -(baseBend + swingBend * g);
      arm.elbow.rotation.y = side * 0.04;

      arm.wrist.rotation.x = -0.08 - 0.12 * run * g;
      arm.wrist.rotation.z = side * 0.05;
    };

    // Arms counter-swing against the legs.
    poseArm(r.armL, ph + PI, 1);
    poseArm(r.armR, ph, -1);

    /* ---------------------------------------------------------- pelvis */

    const bobAmp = THREE.MathUtils.lerp(0.028, 0.085, run) * g;
    // Two rises per cycle: highest at each mid-stance.
    const bob = (1 - Math.cos(ph * 2)) * 0.5 * bobAmp;

    const idleSway = (1 - g) * Math.sin(this.idleT * 0.85) * 0.018;
    const idleBreath = (1 - g) * Math.sin(this.breath) * 0.006;

    r.hips.position.y = P.hipY + bob + idleBreath;
    r.hips.position.x = idleSway;

    // Pelvis drops toward the swing side, and counter-rotates against the chest.
    const yawAmp = THREE.MathUtils.lerp(0.09, 0.17, run) * g;
    r.hips.rotation.y = -yawAmp * Math.cos(ph);
    r.hips.rotation.z = Math.sin(ph) * 0.055 * g + idleSway * 1.4;

    // Bank into turns.
    const bank = THREE.MathUtils.clamp(-turnRate * 0.11, -0.16, 0.16) * (0.3 + g);
    r.hips.rotation.z += bank;

    /* ----------------------------------------------------- spine/chest */

    const lean = 0.045 * g + 0.24 * run * g;
    r.spine.rotation.x = -lean + Math.sin(this.breath) * 0.012 * (1 - g);
    r.spine.rotation.y = yawAmp * 1.25 * Math.cos(ph);
    r.spine.rotation.z = -bank * 0.5;

    r.chest.rotation.y = yawAmp * 0.5 * Math.cos(ph);
    r.chest.rotation.x = Math.sin(this.breath) * 0.016;
    // Every channel the layers below write has to be written here too, even
    // when the base pose has nothing to say about it. The reaction poses add
    // into these, and a channel that is only ever added to accumulates: the
    // flinch's `chest.rotation.z` reached a couple of radians over a single
    // reaction and rolled the whole torso over, which read as the arms being
    // wrong because the arms are what you notice.
    r.chest.rotation.z = -bank * 0.25;

    /* ------------------------------------------------------------ head */

    // Idle glances: she looks around when standing still.
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 2.2 + Math.random() * 3.4;
      this.lookYaw = (Math.random() - 0.5) * 1.0;
      this.lookPitch = (Math.random() - 0.5) * 0.22;
    }
    const lookW = (1 - g) * 0.85;

    // Gaze stabilisation: cancel the torso lean so she keeps her eyes level.
    r.head.rotation.x = lean * 0.72 - this.lookPitch * lookW - Math.sin(ph * 2) * 0.014 * g;
    r.head.rotation.y =
      -(r.spine.rotation.y + r.chest.rotation.y) * 0.55 + this.lookYaw * lookW;
    r.head.rotation.z = -r.hips.rotation.z * 0.3;

    /* -------------------------------------------------- jump / landing */

    if (this.air > 0.001) this.poseAir(st.vy, this.air);
    if (this.land > 0.001) this.poseLanding(this.land);
    if (this.swim > 0.001) this.poseSwim(this.swim, speed);

    // A wound is carried into the walk itself, so it goes on before the aim
    // layer and after the gait it is modifying.
    if (st.injury && st.injury !== 'none' && REACTIONS.injury > 0) {
      this.poseInjury(st.injury, st.injurySide ?? 1, g, ph);
    }

    // Aiming last of the upper-body layers and before the foot IK: it has to
    // win over the arm swing, and it must not touch the legs, which keep
    // walking underneath it.
    this.aim += ((st.aim ?? 0) - this.aim) * Math.min(1, dt * 12);
    if (this.aim > 0.002) {
      this.poseAim(this.aim * (1 - this.swim) * (1 - this.air), st.aimPitch ?? 0, st.twoHanded ?? false);
    }

    // Reloading overrides the aim pose — both hands are busy with the magazine,
    // so there is nothing left to hold the gun on target with.
    this.reload = (st.reload ?? 0) * REACTIONS.reload;
    if (this.reload > 0) this.poseReload(this.reload, st.twoHanded ?? false);

    // The flinch is last and wins over everything: a round arriving interrupts
    // whatever the body was doing, which is what makes it read as an impact
    // rather than as a gesture.
    const flinch = (st.flinch ?? 0) * REACTIONS.flinch;
    if (flinch > 0.001) {
      this.poseFlinch(flinch, st.flinchSide ?? 0, st.flinchHead ?? false);
    }

    /* -------------------------------------------- foot planting (IK) */

    // Meaningless while airborne or afloat — the feet are supposed to be off
    // the ground in both cases.
    const ikWeight = (1 - this.air) * (1 - this.swim);
    if (ikWeight > 0.01) {
      r.root.updateMatrixWorld(true);
      const targetY = groundY + P.ankleY;
      let lowest = Infinity;
      for (const leg of [r.legL, r.legR]) {
        leg.ankle.getWorldPosition(this.tmp);
        lowest = Math.min(lowest, this.tmp.y);
      }
      if (Number.isFinite(lowest)) {
        // Drop the pelvis until the trailing foot reaches the pavement.
        const delta = THREE.MathUtils.clamp(lowest - targetY, -0.14, 0.14);
        r.hips.position.y -= delta * ikWeight;
      }
    }

    /* ------------------------------------------------- ponytail spring */

    this.updatePonytail(dt, g, run);
  }

  /**
   * Airborne pose, blended over whatever the gait produced. Rising tucks the
   * legs and throws the arms up; falling extends the lead leg to reach for the
   * ground. The two legs are deliberately asymmetric — a perfectly mirrored
   * jump reads as a mannequin.
   */
  /**
   * Weapon carry and aim.
   *
   * `w` runs from carrying (arm down, gun by the hip) at 0 to aiming down the
   * sights at 1, because there is no third state worth authoring: the moment
   * she has a gun out the arm stops swinging like an empty one, and pulling it
   * up to eye line is the same motion carried further.
   *
   * `pitch` is the camera's, so the barrel tracks the crosshair up and down a
   * building rather than staying level. The shoulder carries most of it and the
   * head a little, which is what stops her looking like she is aiming at her
   * own feet when the player looks down.
   */
  private poseAim(w: number, pitch: number, twoHanded: boolean): void {
    const r = this.rig;
    const L = THREE.MathUtils.lerp;

    const A = AIM_POSE;

    // The gun hand. The weapon is parented down the forearm, so where this
    // points is where the barrel points.
    r.armR.shoulder.rotation.x = L(r.armR.shoulder.rotation.x, A.gunShoulderX + pitch * A.gunShoulderXPitch, w);
    r.armR.shoulder.rotation.y = L(r.armR.shoulder.rotation.y, A.gunShoulderY, w);
    r.armR.shoulder.rotation.z = L(r.armR.shoulder.rotation.z, A.gunShoulderZ, w);
    r.armR.elbow.rotation.x = L(r.armR.elbow.rotation.x, A.gunElbowX, w);
    r.armR.elbow.rotation.y = L(r.armR.elbow.rotation.y, 0, w);
    r.armR.wrist.rotation.x = L(r.armR.wrist.rotation.x, A.gunWristX, w);
    r.armR.wrist.rotation.z = L(r.armR.wrist.rotation.z, 0, w);

    // The support hand. On a two-handed weapon it comes across to meet the
    // foregrip; on a pistol it tucks in rather than hanging, which reads as
    // braced instead of forgotten.
    r.armL.shoulder.rotation.x = L(
      r.armL.shoulder.rotation.x,
      twoHanded ? A.supShoulderX + pitch * A.supShoulderXPitch : A.freeShoulderX,
      w,
    );
    r.armL.shoulder.rotation.y = L(r.armL.shoulder.rotation.y, twoHanded ? A.supShoulderY : A.freeShoulderY, w);
    r.armL.shoulder.rotation.z = L(r.armL.shoulder.rotation.z, twoHanded ? A.supShoulderZ : A.freeShoulderZ, w);
    r.armL.elbow.rotation.x = L(r.armL.elbow.rotation.x, twoHanded ? A.supElbowX : A.freeElbowX, w);

    // Square the torso up behind the gun and kill the walk sway, which reads as
    // wobble the moment there is a barrel to notice it on.
    r.spine.rotation.y = L(r.spine.rotation.y, A.spineY, w);
    r.spine.rotation.x = L(r.spine.rotation.x, A.spineX + pitch * A.spineXPitch, w);
    r.chest.rotation.y = L(r.chest.rotation.y, A.chestY, w);
    r.chest.rotation.x = L(r.chest.rotation.x, A.chestX, w);

    // Head down the sights, not off on an idle glance.
    r.head.rotation.x = L(r.head.rotation.x, pitch * A.headXPitch + A.headX, w);
    r.head.rotation.y = L(r.head.rotation.y, A.headY, w);
    r.head.rotation.z = L(r.head.rotation.z, 0, w);
  }

  /**
   * Taking a round.
   *
   * A short, violent impulse that decays — `w` arrives at 1 and is driven to 0
   * by the caller. The shape is a whip: the part nearest the impact moves first
   * and hardest, everything else follows and overshoots. Made symmetric it just
   * looks like a bow.
   *
   * @param side Lateral component of the shot in body space, -1..1.
   * @param head A head shot snaps the neck rather than folding the body, which
   *   is the difference between a hit that hurts and a hit that kills.
   */
  private poseFlinch(w: number, side: number, head: boolean): void {
    const r = this.rig;
    // Sharp attack, slower release: `w` is linear, this is not.
    const k = Math.sin(Math.min(1, w) * Math.PI * 0.85) * (0.35 + 0.65 * w);

    if (head) {
      // The head snaps back and the body follows a beat later — the arms drop
      // out of the swing entirely, because nothing is driving them any more.
      const L0 = THREE.MathUtils.lerp;
      r.head.rotation.x -= 0.85 * k;
      r.head.rotation.z += side * 0.6 * k;
      r.head.rotation.y += side * 0.4 * k;
      r.chest.rotation.x -= 0.22 * k;
      r.spine.rotation.x -= 0.14 * k;
      r.hips.position.y -= 0.05 * k;
      for (const [arm, sgn] of [
        [r.armL, 1],
        [r.armR, -1],
      ] as const) {
        arm.shoulder.rotation.x = L0(arm.shoulder.rotation.x, 0.1, k);
        arm.shoulder.rotation.z = L0(arm.shoulder.rotation.z, sgn * 0.22, k);
        arm.elbow.rotation.x = L0(arm.elbow.rotation.x, -0.25, k);
      }
      return;
    }

    // A body shot folds them around it. Positive `rotation.x` on the spine and
    // chest is *forward*: these joints carry their children along +Y, so they
    // tip the opposite way to the hips and shoulders, which hang along -Y.
    r.spine.rotation.x += 0.34 * k;
    r.spine.rotation.z += side * 0.3 * k;
    r.chest.rotation.x += 0.22 * k;
    r.chest.rotation.z += side * 0.22 * k;
    r.head.rotation.x += 0.3 * k;
    r.hips.position.y -= 0.075 * k;
    r.hips.rotation.z += side * 0.1 * k;

    // The arms are *replaced*, not nudged. Adding a flinch to the walk's arm
    // swing leaves whichever arm happened to be trailing pointing at the sky
    // once the torso folds over it — the swing has to stop, which is what
    // happens to a person who has just been shot.
    // Hands to the wound: the upper arm stays hanging and the *elbow* does the
    // work. Swinging the shoulder forward instead raises the whole arm — a
    // negative `rotation.x` here carries the hand up as well as forward, and
    // with the torso folded over it the elbows finish above the shoulders,
    // which reads as reaching rather than as clutching.
    const L = THREE.MathUtils.lerp;
    for (const [arm, sgn] of [
      [r.armL, 1],
      [r.armR, -1],
    ] as const) {
      arm.shoulder.rotation.x = L(arm.shoulder.rotation.x, 0.06, k);
      arm.shoulder.rotation.z = L(arm.shoulder.rotation.z, sgn * 0.26, k);
      arm.shoulder.rotation.y = L(arm.shoulder.rotation.y, sgn * -0.3, k);
      arm.elbow.rotation.x = L(arm.elbow.rotation.x, -1.5, k);
    }
  }

  /**
   * A wound they are still walking on.
   *
   * Permanent once set, and applied on top of the ordinary gait rather than
   * replacing it, so an injured pedestrian still walks — badly. All three read
   * at a distance, which is the only place these are ever seen from.
   */
  private poseInjury(
    injury: 'leg' | 'arm' | 'gut',
    side: number,
    gait: number,
    phase: number,
  ): void {
    const r = this.rig;
    const s = side >= 0 ? 1 : -1;
    const bad = s > 0 ? r.legL : r.legR;
    const good = s > 0 ? r.legR : r.legL;
    const badArm = s > 0 ? r.armL : r.armR;

    if (injury === 'leg') {
      // A limp is an asymmetry in time, not in pose: the bad leg takes a short
      // stride and gets off the ground quickly, and the body dips onto it.
      const onBad = Math.max(0, Math.cos(phase + (s > 0 ? 0 : PI)));
      bad.hip.rotation.x *= 0.45;
      bad.knee.rotation.x = bad.knee.rotation.x * 0.6 + 0.34 * gait;
      bad.ankle.rotation.x += 0.2 * gait;
      good.hip.rotation.x *= 1.15;
      // The dip, and the lurch away from the bad side that comes with it.
      r.hips.position.y -= onBad * 0.055 * gait;
      r.hips.rotation.z += s * onBad * 0.14 * gait;
      r.spine.rotation.z -= s * onBad * 0.1 * gait;
      r.spine.rotation.x -= 0.06;
      return;
    }

    if (injury === 'arm') {
      // Cradled against the chest and kept still — the swing is the first thing
      // to go when an arm hurts. The upper arm stays *hanging*: rotating the
      // shoulder forward to bring the hand in lifts the whole arm with it, and
      // the result reads as pointing rather than as nursing.
      badArm.shoulder.rotation.x = 0.04;
      badArm.shoulder.rotation.z = s * 0.22;
      badArm.shoulder.rotation.y = -s * 0.55;
      badArm.elbow.rotation.x = -1.95;
      badArm.wrist.rotation.x = -0.2;
      r.spine.rotation.z += s * 0.07;
      r.chest.rotation.y += s * 0.12;
      return;
    }

    // Gut: hunched around it, both forearms drawn across, head down. Same rule
    // as above — the elbows do the work and the shoulders stay down.
    r.spine.rotation.x += 0.3;
    r.chest.rotation.x += 0.16;
    r.head.rotation.x += 0.12;
    r.hips.position.y -= 0.045;
    for (const [arm, sgn] of [
      [r.armL, 1],
      [r.armR, -1],
    ] as const) {
      arm.shoulder.rotation.x = 0.05;
      arm.shoulder.rotation.z = sgn * 0.2;
      arm.shoulder.rotation.y = -sgn * 0.28;
      arm.elbow.rotation.x = -1.55;
    }
  }

  /**
   * Reloading.
   *
   * Three beats, matched to the three clacks `audio/weapons.ts` schedules
   * across the same duration — magazine out, magazine in, slide released. The
   * sound is doing half the work here, so the poses have to land on it: the
   * support hand is at the magazine well when the first clack plays and back on
   * the gun by the third.
   */
  private poseReload(t: number, twoHanded: boolean): void {
    const r = this.rig;
    const L = THREE.MathUtils.lerp;
    // Ease the whole layer in and out so it does not snap out of the aim pose.
    const w = Math.min(1, Math.min(t, 1 - t) * 6);

    // The gun comes down and rolls inward to where the hands can work on it.
    r.armR.shoulder.rotation.x = L(r.armR.shoulder.rotation.x, -0.72, w);
    r.armR.shoulder.rotation.y = L(r.armR.shoulder.rotation.y, 0.42, w);
    r.armR.shoulder.rotation.z = L(r.armR.shoulder.rotation.z, -0.1, w);
    r.armR.elbow.rotation.x = L(r.armR.elbow.rotation.x, -1.35, w);
    r.armR.wrist.rotation.z = L(r.armR.wrist.rotation.z, -0.5, w);

    // The support hand does the work: down to the magazine, back up, then a
    // short sharp pull for the slide.
    const drop = t < 0.42 ? t / 0.42 : t < 0.72 ? 1 - (t - 0.42) / 0.3 : 0;
    const slide = t > 0.72 ? Math.sin(((t - 0.72) / 0.28) * PI) : 0;

    r.armL.shoulder.rotation.x = L(r.armL.shoulder.rotation.x, -0.5 - 0.35 * drop + 0.2 * slide, w);
    r.armL.shoulder.rotation.y = L(r.armL.shoulder.rotation.y, -0.55 - 0.2 * slide, w);
    r.armL.shoulder.rotation.z = L(r.armL.shoulder.rotation.z, 0.12 + 0.3 * drop, w);
    r.armL.elbow.rotation.x = L(r.armL.elbow.rotation.x, -1.5 - 0.5 * drop - 0.35 * slide, w);
    r.armL.wrist.rotation.x = L(r.armL.wrist.rotation.x, -0.3 * drop, w);

    // She looks at what her hands are doing, and squares back up at the end.
    r.head.rotation.x = L(r.head.rotation.x, 0.34 * (1 - slide), w);
    r.head.rotation.y = L(r.head.rotation.y, 0.24, w);
    r.chest.rotation.y = L(r.chest.rotation.y, -0.1, w);
    if (!twoHanded) r.spine.rotation.y = L(r.spine.rotation.y, -0.06, w);
  }

  private poseAir(vy: number, w: number): void {
    const r = this.rig;
    // +1 rising hard, -1 falling hard.
    const v = THREE.MathUtils.clamp(vy / GAIT.jumpSpeed, -1, 1);
    const rise = Math.max(0, v);
    const fall = Math.max(0, -v);
    const mix = (o: THREE.Object3D, x: number, z = o.rotation.z) => {
      o.rotation.x = THREE.MathUtils.lerp(o.rotation.x, x, w);
      o.rotation.z = THREE.MathUtils.lerp(o.rotation.z, z, w);
    };

    // Lead leg tucks hard on the way up, reaches out on the way down.
    mix(r.legL.hip, -(0.5 + rise * 0.5 - fall * 0.24), 0.05);
    mix(r.legL.knee, 0.85 + rise * 0.75 - fall * 0.55);
    mix(r.legL.ankle, -0.1 - fall * 0.22);

    // Trailing leg stays straighter and swings behind.
    mix(r.legR.hip, 0.12 + rise * 0.3 - fall * 0.3, -0.05);
    mix(r.legR.knee, 0.42 + rise * 0.55 - fall * 0.28);
    mix(r.legR.ankle, 0.16 + rise * 0.2 - fall * 0.3);

    mix(r.armL.shoulder, -(0.85 + rise * 0.75), 0.34 + fall * 0.28);
    mix(r.armL.elbow, -(0.7 + rise * 0.3));
    mix(r.armR.shoulder, 0.3 - rise * 0.25, -(0.3 + fall * 0.3));
    mix(r.armR.elbow, -(0.55 + rise * 0.25));

    r.spine.rotation.x = THREE.MathUtils.lerp(
      r.spine.rotation.x,
      -0.14 - rise * 0.1 + fall * 0.06,
      w,
    );
    r.hips.rotation.y = THREE.MathUtils.lerp(r.hips.rotation.y, -0.1, w);
    r.spine.rotation.y = THREE.MathUtils.lerp(r.spine.rotation.y, 0.14, w);
    // Chin comes up as she leaves the ground.
    r.head.rotation.x = THREE.MathUtils.lerp(r.head.rotation.x, -0.08 + fall * 0.16, w);
  }

  /** Absorb the impact: knees fold, pelvis drops, torso pitches forward. */
  private poseLanding(t: number): void {
    const r = this.rig;
    // Sharp at touchdown, easing out — a linear recovery looks robotic.
    const k = Math.pow(t, 1.6);
    r.hips.position.y -= k * 0.16;
    for (const leg of [r.legL, r.legR]) {
      leg.hip.rotation.x -= k * 0.34;
      leg.knee.rotation.x += k * 0.78;
      leg.ankle.rotation.x -= k * 0.3;
    }
    r.spine.rotation.x -= k * 0.24;
    for (const arm of [r.armL, r.armR]) {
      arm.shoulder.rotation.x -= k * 0.3;
      arm.elbow.rotation.x -= k * 0.35;
    }
  }

  /**
   * Front crawl. The body pitches forward to lie prone at the surface, the arms
   * windmill a half-cycle out of phase, and the legs flutter from the hip with
   * almost straight knees.
   */
  private poseSwim(w: number, speed: number): void {
    const r = this.rig;
    const p = this.stroke;
    // Barely moving is a lazy tread rather than a full stroke.
    const effort = 0.35 + Math.min(1, speed / 2.2) * 0.65;

    const mix = (o: THREE.Object3D, x: number, y = o.rotation.y, z = o.rotation.z) => {
      o.rotation.x = THREE.MathUtils.lerp(o.rotation.x, x, w);
      o.rotation.y = THREE.MathUtils.lerp(o.rotation.y, y, w);
      o.rotation.z = THREE.MathUtils.lerp(o.rotation.z, z, w);
    };

    // Prone: pitch the whole body down so she lies along the surface.
    r.hips.rotation.x = THREE.MathUtils.lerp(r.hips.rotation.x, -1.32, w);
    r.hips.rotation.y = THREE.MathUtils.lerp(r.hips.rotation.y, 0, w);
    r.hips.rotation.z = THREE.MathUtils.lerp(
      r.hips.rotation.z,
      Math.sin(p) * 0.22 * effort,
      w,
    );
    r.hips.position.y = THREE.MathUtils.lerp(r.hips.position.y, P.hipY * 0.72, w);

    r.spine.rotation.x = THREE.MathUtils.lerp(r.spine.rotation.x, 0.16, w);
    r.spine.rotation.y = THREE.MathUtils.lerp(r.spine.rotation.y, 0, w);
    // Head lifts to breathe on alternate strokes.
    r.head.rotation.x = THREE.MathUtils.lerp(r.head.rotation.x, 0.95, w);
    r.head.rotation.y = THREE.MathUtils.lerp(
      r.head.rotation.y,
      Math.sin(p * 0.5) * 0.5,
      w,
    );

    // Arms: full windmill, half a cycle apart.
    for (const [arm, phase, s] of [
      [r.armL, p, 1],
      [r.armR, p + PI, -1],
    ] as const) {
      const a = Math.cos(phase);
      mix(arm.shoulder, -1.6 - a * 1.5 * effort, s * 0.12, s * (0.22 + 0.1 * effort));
      // Elbow bends on the recovery, straightens through the pull.
      mix(arm.elbow, -(0.25 + Math.max(0, a) * 0.9) * effort);
      mix(arm.wrist, -0.1);
    }

    // Legs: shallow flutter kick, knees nearly locked.
    for (const [leg, phase, s] of [
      [r.legL, p * 2, 1],
      [r.legR, p * 2 + PI, -1],
    ] as const) {
      const k = Math.sin(phase);
      mix(leg.hip, -k * 0.34 * effort, 0, s * 0.05);
      mix(leg.knee, 0.18 + Math.max(0, k) * 0.5 * effort);
      mix(leg.ankle, 0.42 - k * 0.2);
    }
  }

  /** Damped angular springs driven by the head's own acceleration. */
  private updatePonytail(dt: number, gait: number, run: number): void {
    const r = this.rig;
    r.head.getWorldPosition(this.tmp);

    if (!this.hasPrev) {
      this.prevHead.copy(this.tmp);
      this.hasPrev = true;
      return;
    }

    const inv = dt > 1e-5 ? 1 / dt : 0;
    const vel = this.tmp.clone().sub(this.prevHead).multiplyScalar(inv);
    const acc = vel.clone().sub(this.headVel).multiplyScalar(inv);
    this.headVel.copy(vel);
    this.prevHead.copy(this.tmp);
    // Heavy smoothing — raw frame-to-frame acceleration is far too spiky.
    this.headAcc.lerp(acc, Math.min(1, dt * 12));

    // Express the acceleration in the head's own frame.
    r.head.getWorldQuaternion(this.tmpQ).invert();
    const local = this.headAcc.clone().applyQuaternion(this.tmpQ);

    const stiffness = 62;
    const damping = 9.5;

    for (let i = 0; i < this.links.length; i++) {
      const link = r.ponytail[i];
      const s = this.links[i];
      // Links further down the tail respond more.
      const w = 0.28 + (i / this.links.length) * 0.72;

      const targetX =
        s.restX -
        THREE.MathUtils.clamp(local.z, -26, 26) * 0.0075 * w +
        gait * (0.05 + run * 0.14) * w;
      const targetZ = s.restZ + THREE.MathUtils.clamp(local.x, -26, 26) * 0.009 * w;

      s.vx += ((targetX - link.rotation.x) * stiffness - s.vx * damping) * dt;
      s.vz += ((targetZ - link.rotation.z) * stiffness - s.vz * damping) * dt;

      link.rotation.x = THREE.MathUtils.clamp(link.rotation.x + s.vx * dt, -0.9, 1.5);
      link.rotation.z = THREE.MathUtils.clamp(link.rotation.z + s.vz * dt, -0.7, 0.7);
    }
  }
}

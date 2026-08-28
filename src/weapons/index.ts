import * as THREE from 'three';
import { Colliders } from '../world/collision';
import { MaraRig } from '../player/rig';
import { buildWeapon, MUZZLE } from './models';
import { WEAPONS, WeaponId, WeaponSpec } from './specs';
import { Hit, HitKind, Targets, spreadDir, traceShot } from './ballistics';
import { WeaponFx } from './fx';

/**
 * What Mara is carrying, and what happens when she pulls the trigger.
 *
 * The inventory is deliberately separate from the wheel and the HUD: both read
 * `owned` and `ammoOf`, neither writes them. When the gun shops arrive they
 * call `give` and `addAmmo` and nothing else has to change — the wheel will
 * show a weapon the moment it is owned.
 *
 * A round goes where the *crosshair* points, not where the barrel points: the
 * trace starts at the camera and the tracer is drawn from the muzzle to
 * wherever that trace ended. Firing from the muzzle instead looks correct in a
 * screenshot and feels broken in the hand, because the gun sits half a metre
 * right of the eye and everything inside about five metres misses low and left.
 */

/** Where the weapon sits in the wrist joint's space. */
const GRIP_OFFSET = new THREE.Vector3(0.012, -0.075, 0.012);
/**
 * How the weapon sits in the hand.
 *
 * Not a round number, and not guessed: with the aim pose in `player/animator.ts`
 * fixed to put the *hand* in a plausible place, this is the rotation that then
 * lands the barrel on the shot line, solved by measuring the wrist's world
 * matrix in the running game and asking for the quaternion taking the model's
 * -Z to `camera.getWorldDirection()`. Roughly a quarter turn, because the arm
 * is lofted along -Y and weapons are modelled along -Z; the couple of degrees
 * either side of that are the part no one would arrive at by inspection.
 *
 * Re-solve it if the aim pose moves. `window.SOLARA.aimPose` is live for
 * exactly that.
 */
const GRIP_ROTATION = new THREE.Euler(-1.188, 0.019, 0.013, 'XYZ');

export interface ShotContext {
  aiming: boolean;
  /** Left mouse held — automatics only. */
  firing: boolean;
  /** Left mouse pressed this frame — semi-autos only. */
  fireEdge: boolean;
  reload: boolean;
  /** Eye position and look direction: the shot's true origin and aim. */
  eye: THREE.Vector3;
  look: THREE.Vector3;
  /** Ground speed, for the movement penalty on accuracy. */
  speed: number;
  targets: Targets;
}

export interface ArsenalHooks {
  /** Camera kick, in radians. */
  onRecoil(pitch: number, yaw: number): void;
  onShot(spec: WeaponSpec, muzzle: THREE.Vector3): void;
  onHit(kind: HitKind, point: THREE.Vector3): void;
  onDryFire(): void;
  onReload(spec: WeaponSpec): void;
}

export class Arsenal {
  /** Effects layer. Add to the scene, not to the world group. */
  readonly fx = new WeaponFx();

  /** Weapons Mara actually has. The shop will add to this. */
  private owned = new Set<WeaponId>();
  private mag = new Map<WeaponId, number>();
  private reserve = new Map<WeaponId, number>();
  private models = new Map<WeaponId, THREE.Group>();

  private equipped: WeaponId | null = null;
  private cooldown = 0;
  private reloading = 0;
  /** Accumulated bloom from firing, in radians, on top of the base spread. */
  private bloom = 0;

  private hit: Hit = {
    kind: 'sky',
    point: new THREE.Vector3(),
    distance: 0,
    normal: new THREE.Vector3(),
  };
  private dir = new THREE.Vector3();
  private muzzleWorld = new THREE.Vector3();

  constructor(
    private rig: MaraRig,
    private colliders: Colliders,
    private hooks: ArsenalHooks,
  ) {}

  /* ----------------------------------------------------------- inventory */

  /** Grant a weapon with a full magazine. This is what a gun shop will call. */
  give(id: WeaponId, withAmmo = true): void {
    const spec = WEAPONS[id];
    if (!this.owned.has(id)) {
      this.owned.add(id);
      this.mag.set(id, spec.magazine);
      this.reserve.set(id, withAmmo ? spec.reserve : 0);
    }
    if (!this.models.has(id)) {
      const model = buildWeapon(id);
      model.position.copy(GRIP_OFFSET);
      model.rotation.copy(GRIP_ROTATION);
      model.visible = false;
      // Parented to the wrist, so every joint the animator moves carries it.
      this.rig.armR.wrist.add(model);
      this.models.set(id, model);
    }
  }

  /** Ammo pickups and shop purchases land here. Returns what was taken. */
  addAmmo(id: WeaponId, rounds: number): number {
    if (!this.owned.has(id)) return 0;
    const spec = WEAPONS[id];
    const have = this.reserve.get(id) ?? 0;
    const take = Math.min(rounds, spec.reserveMax - have);
    this.reserve.set(id, have + take);
    return take;
  }

  has(id: WeaponId): boolean {
    return this.owned.has(id);
  }

  ammoOf(id: WeaponId): { mag: number; reserve: number } {
    return { mag: this.mag.get(id) ?? 0, reserve: this.reserve.get(id) ?? 0 };
  }

  get current(): WeaponId | null {
    return this.equipped;
  }

  get spec(): WeaponSpec | null {
    return this.equipped ? WEAPONS[this.equipped] : null;
  }

  get isReloading(): boolean {
    return this.reloading > 0;
  }

  /** True while a weapon is drawn — the camera and the animator both ask. */
  get armed(): boolean {
    return this.equipped !== null;
  }

  equip(id: WeaponId | null): void {
    if (id !== null && !this.owned.has(id)) return;
    if (id === this.equipped) return;
    for (const [key, model] of this.models) model.visible = key === id;
    this.equipped = id;
    this.reloading = 0;
    this.cooldown = 0.15;
    this.bloom = 0;
  }

  /** Hide the gun without forgetting it — used getting into a car. */
  holster(): void {
    for (const model of this.models.values()) model.visible = false;
    this.equipped = null;
  }

  /* ------------------------------------------------------------- firing */

  /**
   * Current cone half-angle, and the same value normalised for the crosshair.
   *
   * The crosshair is the player's only readout of this, so the two must come
   * from one place — a reticle that lies about the cone is worse than none.
   */
  spreadNow(aiming: boolean, speed: number): number {
    const spec = this.spec;
    if (!spec) return 0;
    const base = aiming ? spec.adsSpread : spec.hipSpread;
    // Walking costs a little accuracy, sprinting a lot.
    const move = Math.min(1, speed / 5.1) * (aiming ? 0.5 : 1) * 0.045;
    return base + move + this.bloom;
  }

  /** 0 at the tightest this weapon ever gets, 1 at the widest. */
  spread01(aiming: boolean, speed: number): number {
    const spec = this.spec;
    if (!spec) return 0;
    const now = this.spreadNow(aiming, speed);
    const widest = spec.hipSpread + 0.045 + spec.spreadPerShot * 5;
    return THREE.MathUtils.clamp((now - spec.adsSpread) / (widest - spec.adsSpread), 0, 1);
  }

  update(dt: number, ctx: ShotContext): void {
    this.fx.update(dt);
    const spec = this.spec;
    if (!spec || !this.equipped) return;

    this.cooldown = Math.max(0, this.cooldown - dt);
    this.bloom = Math.max(0, this.bloom - spec.spreadRecover * dt);

    if (this.reloading > 0) {
      this.reloading -= dt;
      if (this.reloading <= 0) this.finishReload(this.equipped, spec);
      return;
    }

    const mag = this.mag.get(this.equipped) ?? 0;
    const reserve = this.reserve.get(this.equipped) ?? 0;

    if (ctx.reload && mag < spec.magazine && reserve > 0) {
      this.reloading = spec.reloadTime;
      this.hooks.onReload(spec);
      return;
    }

    const wantsShot = spec.fire === 'auto' ? ctx.firing : ctx.fireEdge;
    if (!wantsShot || this.cooldown > 0) return;

    if (mag <= 0) {
      // Click. Auto-reload rather than making the player find the key.
      this.cooldown = 0.25;
      this.hooks.onDryFire();
      if (reserve > 0) {
        this.reloading = spec.reloadTime;
        this.hooks.onReload(spec);
      }
      return;
    }

    this.shoot(spec, ctx, mag);
  }

  private shoot(spec: WeaponSpec, ctx: ShotContext, mag: number): void {
    const id = this.equipped as WeaponId;
    this.mag.set(id, mag - 1);
    this.cooldown = 60 / spec.rpm;

    const spread = this.spreadNow(ctx.aiming, ctx.speed);
    spreadDir(ctx.look, spread, this.dir);
    traceShot(ctx.eye, this.dir, spec.range, this.colliders, ctx.targets, this.hit);

    const model = this.models.get(id);
    if (model) {
      model.updateMatrixWorld();
      this.muzzleWorld.copy(MUZZLE[id]).applyMatrix4(model.matrixWorld);
    } else {
      this.muzzleWorld.copy(ctx.eye);
    }

    this.fx.shot(this.muzzleWorld, this.hit.point, this.hit.kind, spec.twoHanded ? 1 : 0.8);
    this.hooks.onShot(spec, this.muzzleWorld);
    if (this.hit.kind !== 'sky') this.hooks.onHit(this.hit.kind, this.hit.point);

    // Kick up and slightly to one side, so a held burst walks off target.
    this.hooks.onRecoil(spec.recoil, (Math.random() - 0.5) * spec.recoil * 0.9);
    this.bloom = Math.min(spec.spreadPerShot * 5, this.bloom + spec.spreadPerShot);
  }

  private finishReload(id: WeaponId, spec: WeaponSpec): void {
    const mag = this.mag.get(id) ?? 0;
    const reserve = this.reserve.get(id) ?? 0;
    const take = Math.min(spec.magazine - mag, reserve);
    this.mag.set(id, mag + take);
    this.reserve.set(id, reserve - take);
    this.bloom = 0;
  }
}

export { WEAPONS, WHEEL_ORDER } from './specs';
export type { WeaponId, WeaponSpec } from './specs';

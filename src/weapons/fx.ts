import * as THREE from 'three';
import type { HitKind } from './ballistics';

/**
 * Muzzle flashes, tracers and impact puffs.
 *
 * All three are fixed-size pools allocated once: a full-auto weapon fires
 * twelve times a second, and allocating geometry per shot would hand the
 * garbage collector a steady drip for as long as the trigger is held.
 *
 * Emissive intensities here are picked to sit *above* the bloom threshold in
 * `render/post.ts` — 5.5 at midday, ~1.7 at night — because unlike the neon in
 * `world/facades.ts`, a muzzle flash is supposed to smear. It is the one thing
 * in the world that should blow out the frame for a frame and a half.
 */

const TRACERS = 24;
const FLASH_LIFE = 0.035;
const TRACER_LIFE = 0.055;
const IMPACTS = 20;
const IMPACT_LIFE = 0.22;

interface Live {
  mesh: THREE.Object3D;
  t: number;
  life: number;
}

/** Impact tint by what was hit — dust off the road, sparks off metal. */
const IMPACT_TINT: Record<HitKind, number> = {
  ground: 0xbfae90,
  wall: 0xc8c4bc,
  person: 0xb4383a,
  vehicle: 0xffd9a0,
  sky: 0xffffff,
};

export class WeaponFx {
  readonly group = new THREE.Group();

  private flash: THREE.Mesh;
  private flashT = 0;
  private tracers: Live[] = [];
  private impacts: Live[] = [];
  private nextTracer = 0;
  private nextImpact = 0;

  private tracerMat: THREE.MeshBasicMaterial;
  private impactMats = new Map<number, THREE.MeshBasicMaterial>();

  constructor() {
    this.group.name = 'weaponfx';
    // Effects are a handful of tiny meshes that follow the player, so the
    // per-mesh frustum test is worth more than it costs; but they must stay out
    // of the world bake and out of the culler, which owns whole subtrees.
    this.group.matrixAutoUpdate = true;

    // Muzzle flash: two crossed quads, so it has some presence from the side
    // as well as from behind the shooter.
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: true,
    });
    // Small: at 34 cm the flash was wider than the gun and read as a flare
    // rather than a muzzle blast.
    const a = new THREE.PlaneGeometry(0.16, 0.16);
    const b = new THREE.PlaneGeometry(0.16, 0.16).rotateZ(Math.PI / 2).rotateY(Math.PI / 2);
    this.flash = new THREE.Mesh(a, flashMat);
    this.flash.add(new THREE.Mesh(b, flashMat));
    this.flash.visible = false;
    this.group.add(this.flash);

    this.tracerMat = new THREE.MeshBasicMaterial({
      color: 0xffe6b0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: true,
    });
    // A unit-length box along **+Z**, because `Object3D.lookAt` is not the
    // camera's. `Matrix4.lookAt(eye, target, up)` puts +Z on target→eye, and
    // `Object3D.lookAt` passes those arguments *reversed* for anything that is
    // not a camera or a light — so a plain mesh ends up with its +Z pointing at
    // the target where a camera would point its -Z. Built along -Z, every
    // tracer drew from the muzzle backwards past the player.
    const beam = new THREE.BoxGeometry(0.028, 0.028, 1).translate(0, 0, 0.5);
    for (let i = 0; i < TRACERS; i++) {
      const m = new THREE.Mesh(beam, this.tracerMat);
      m.visible = false;
      m.frustumCulled = false;
      this.group.add(m);
      this.tracers.push({ mesh: m, t: 0, life: TRACER_LIFE });
    }

    const puff = new THREE.SphereGeometry(0.06, 6, 5);
    for (let i = 0; i < IMPACTS; i++) {
      const m = new THREE.Mesh(puff, this.impactMaterial(0xbfae90));
      m.visible = false;
      this.group.add(m);
      this.impacts.push({ mesh: m, t: 0, life: IMPACT_LIFE });
    }
  }

  private impactMaterial(tint: number): THREE.MeshBasicMaterial {
    let m = this.impactMats.get(tint);
    if (!m) {
      m = new THREE.MeshBasicMaterial({
        color: tint,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      this.impactMats.set(tint, m);
    }
    return m;
  }

  /** Fire everything for one round: flash at the muzzle, streak, impact. */
  shot(muzzle: THREE.Vector3, hit: THREE.Vector3, kind: HitKind, scale: number): void {
    this.flash.position.copy(muzzle);
    this.flash.rotation.z = Math.random() * Math.PI;
    this.flash.scale.setScalar(scale * (0.85 + Math.random() * 0.4));
    this.flash.visible = true;
    this.flashT = 0;

    const tr = this.tracers[this.nextTracer++ % TRACERS];
    const len = muzzle.distanceTo(hit);
    tr.mesh.position.copy(muzzle);
    tr.mesh.lookAt(hit);
    tr.mesh.scale.set(1, 1, Math.max(0.5, len));
    tr.mesh.visible = true;
    tr.t = 0;

    if (kind === 'sky') return;
    const im = this.impacts[this.nextImpact++ % IMPACTS];
    (im.mesh as THREE.Mesh).material = this.impactMaterial(IMPACT_TINT[kind]);
    im.mesh.position.copy(hit);
    im.mesh.scale.setScalar(0.7 + Math.random() * 0.5);
    im.mesh.visible = true;
    im.t = 0;
  }

  update(dt: number): void {
    if (this.flash.visible) {
      this.flashT += dt;
      const k = 1 - this.flashT / FLASH_LIFE;
      if (k <= 0) this.flash.visible = false;
      else {
        // Well above the daytime bloom threshold: a muzzle flash is the one
        // thing here that is meant to smear.
        (this.flash.material as THREE.MeshBasicMaterial).opacity = k;
        (this.flash.material as THREE.MeshBasicMaterial).color.setRGB(9 * k, 7.2 * k, 3.6 * k);
      }
    }

    // One shared material per pool, so the fade is driven off the newest live
    // entry rather than per mesh. Tracers all last the same 55 ms, so the
    // youngest one is the brightest and the rest are within a frame of it.
    let brightest = 0;
    for (const tr of this.tracers) {
      if (!tr.mesh.visible) continue;
      tr.t += dt;
      const k = 1 - tr.t / tr.life;
      if (k <= 0) tr.mesh.visible = false;
      else brightest = Math.max(brightest, k);
    }
    this.tracerMat.opacity = brightest * 0.9;
    this.tracerMat.color.setRGB(4.5 * brightest, 3.6 * brightest, 1.8 * brightest);

    const peak = new Map<THREE.Material, number>();
    for (const im of this.impacts) {
      if (!im.mesh.visible) continue;
      im.t += dt;
      const k = 1 - im.t / im.life;
      if (k <= 0) {
        im.mesh.visible = false;
        continue;
      }
      // Puffs expand as they fade.
      const s = (0.7 + (1 - k) * 1.9) * 1;
      im.mesh.scale.setScalar(s);
      const mat = (im.mesh as THREE.Mesh).material as THREE.Material;
      peak.set(mat, Math.max(peak.get(mat) ?? 0, k));
    }
    for (const [mat, k] of peak) {
      (mat as THREE.MeshBasicMaterial).opacity = k * 0.75;
    }
    for (const mat of this.impactMats.values()) {
      if (!peak.has(mat)) mat.opacity = 0;
    }
  }
}

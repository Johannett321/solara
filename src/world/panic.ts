import * as THREE from 'three';

/**
 * The street's reaction to a drawn weapon.
 *
 * Raising the sights sets this off; everyone and everything inside the radius
 * behaves differently until it runs down. It is deliberately a *local* effect —
 * the city is 800 m across and a panic that reached all of it would cost the
 * whole crowd and every traffic car an update every frame, for a spectacle
 * nobody can see. Outside the radius the world carries on as normal.
 *
 * The timer is only ever refreshed, never counted up: aiming re-arms it to the
 * full duration, so the panic outlives the aim by `PANIC_TIME` however long the
 * player held it.
 */

/** How long the street stays frightened after the last frame of aiming. */
export const PANIC_TIME = 26;

/**
 * How far it reaches, in metres.
 *
 * Sized to a couple of blocks of Ocean Drive. Much wider and pedestrians start
 * bolting out of the fog for no visible reason; much tighter and the street
 * behind you is unnervingly calm.
 */
export const PANIC_RADIUS = 38;

/** Panic fades over the last few seconds rather than switching off. */
const FADE = 4;

export class Panic {
  /** Where the trouble is — the player, at the moment they last aimed. */
  readonly centre = new THREE.Vector3();
  private timer = 0;

  /** Called every frame the player is aiming a drawn weapon. */
  alarm(at: THREE.Vector3): void {
    this.centre.copy(at);
    this.timer = PANIC_TIME;
  }

  update(dt: number): void {
    this.timer = Math.max(0, this.timer - dt);
  }

  get active(): boolean {
    return this.timer > 0;
  }

  /** Seconds remaining, for the HUD. */
  get remaining(): number {
    return this.timer;
  }

  /**
   * How frightened something at `x,z` should be, 0..1.
   *
   * Falls off with distance as well as with time, so the edge of the radius is
   * a fringe of people walking briskly rather than a circle inside which
   * everyone is sprinting.
   */
  at(x: number, z: number): number {
    if (this.timer <= 0) return 0;
    const dx = x - this.centre.x;
    const dz = z - this.centre.z;
    const d = Math.hypot(dx, dz);
    if (d > PANIC_RADIUS) return 0;
    const near = 1 - (d / PANIC_RADIUS) ** 2;
    const late = Math.min(1, this.timer / FADE);
    return near * late;
  }
}

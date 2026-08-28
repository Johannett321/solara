import * as THREE from 'three';

/**
 * The handful of real lights this world can afford.
 *
 * Night here is a materials problem — see the note in CLAUDE.md — and it stays
 * one: the emissive lamp heads, neon, lit windows and the additive ground pools
 * do almost all of the work, and none of that changes. What they cannot do is
 * put light *on* anything. A street lit entirely by emissive surfaces leaves
 * the player a black silhouette standing on black tarmac, which is exactly what
 * the city looked like at midnight.
 *
 * So: a small, **fixed** pool of real lights that follows the player around.
 * The nearest few street lamps get one each, and the car gets headlamps.
 *
 * Two rules, both non-negotiable:
 *
 * - **The counts never change.** three bakes the number of lights of each type
 *   into every material's shader, so adding or removing one recompiles every
 *   program in the scene — hundreds of them, mid-frame. Lights that are not in
 *   use are moved out of the way and set to zero intensity; they are never
 *   removed.
 * - **Nothing here casts a shadow.** The sun's shadow map is already ~6 ms; a
 *   second shadow-casting light would be another full scene render.
 *
 * The per-fragment cost is affordable for a reason specific to this project:
 * it is bound by draw submission, not fill. Quartering the framebuffer moves
 * the frame under 5%, so the extra work these add per pixel is close to free —
 * the thing to watch is the uniform upload per draw call, which is why the pool
 * is small.
 */

/** Street lamps lit at once. Beyond about this many the uniform block hurts. */
const LAMP_LIGHTS = 6;
/** How far a lamp light reaches. Past this it is doing nothing visible. */
const LAMP_RANGE = 26;
/** Only lamps within this of the camera are candidates. */
const LAMP_SEARCH = 42;
/**
 * A lamp must be this much closer than the one it evicts before they swap.
 *
 * Without it two lamps at nearly equal distance trade the same light back and
 * forth as the player walks, and the street flickers.
 */
const SWAP_MARGIN = 4;
/** Headlamp spots. Two reads as a car; one reads as a torch. */
const HEADLAMPS = 2;

export interface Lights {
  /** Call once a frame with the camera position and the night factor, 0..1. */
  update(cameraPos: THREE.Vector3, night: number): void;
  /**
   * Point the headlamps. `on` false parks them at zero intensity rather than
   * detaching anything, so the light count never changes.
   */
  setHeadlights(on: boolean, position: THREE.Vector3, yaw: number, night: number): void;
}

export function buildLights(scene: THREE.Scene, lamps: THREE.Vector3[]): Lights {
  /* --------------------------------------------------------- street lamps */

  const lampLights: THREE.PointLight[] = [];
  /** Index into `lamps` each pool light is currently serving, or -1. */
  const assigned: number[] = [];
  for (let i = 0; i < LAMP_LIGHTS; i++) {
    const l = new THREE.PointLight(0xffd9a0, 0, LAMP_RANGE, 1.6);
    l.castShadow = false;
    // Parked far below the world until it is given a lamp.
    l.position.set(0, -1000, 0);
    scene.add(l);
    lampLights.push(l);
    assigned.push(-1);
  }

  /* ----------------------------------------------------------- headlamps */

  // Two spots rather than one wide one: a single beam reads as a torch, and
  // the pair is what makes the road ahead look like it is lit by a car.
  const headlamps: THREE.SpotLight[] = [];
  const targets: THREE.Object3D[] = [];
  for (let i = 0; i < HEADLAMPS; i++) {
    const s = new THREE.SpotLight(0xfff2d4, 0, 70, THREE.MathUtils.degToRad(34), 0.55, 1.1);
    s.castShadow = false;
    s.position.set(0, -1000, 0);
    const t = new THREE.Object3D();
    t.position.set(0, -1000, 1);
    scene.add(s);
    scene.add(t);
    s.target = t;
    headlamps.push(s);
    targets.push(t);
  }

  const candidates: Array<{ i: number; d: number }> = [];
  const forward = new THREE.Vector3();
  const right = new THREE.Vector3();

  return {
    update(cameraPos, night) {
      const lit = Math.pow(THREE.MathUtils.clamp(night, 0, 1), 0.7);
      if (lit <= 0.01) {
        for (const l of lampLights) l.intensity = 0;
        return;
      }

      // Nearest lamps first. The list is a few hundred entries and this runs
      // once a frame, so a plain scan is cheaper than maintaining a grid.
      candidates.length = 0;
      for (let i = 0; i < lamps.length; i++) {
        const p = lamps[i];
        const dx = p.x - cameraPos.x;
        const dz = p.z - cameraPos.z;
        const d = dx * dx + dz * dz;
        if (d > LAMP_SEARCH * LAMP_SEARCH) continue;
        candidates.push({ i, d });
      }
      candidates.sort((a, b) => a.d - b.d);

      // Keep whatever is still in range where it is, so a light does not hop
      // between two lamps every few frames as the player walks between them.
      const wanted = candidates.slice(0, LAMP_LIGHTS);
      const taken = new Set<number>();
      for (let s = 0; s < LAMP_LIGHTS; s++) {
        const held = assigned[s];
        if (held < 0) continue;
        const still = wanted.find((c) => c.i === held);
        if (still) {
          taken.add(held);
          continue;
        }
        // Only give it up for something meaningfully closer.
        const p = lamps[held];
        const dx = p.x - cameraPos.x;
        const dz = p.z - cameraPos.z;
        const mine = Math.sqrt(dx * dx + dz * dz);
        const best = wanted.find((c) => !taken.has(c.i));
        if (best && mine - Math.sqrt(best.d) > SWAP_MARGIN) {
          assigned[s] = -1;
        } else {
          taken.add(held);
        }
      }
      for (let s = 0; s < LAMP_LIGHTS; s++) {
        if (assigned[s] >= 0) continue;
        const next = wanted.find((c) => !taken.has(c.i));
        if (!next) break;
        assigned[s] = next.i;
        taken.add(next.i);
      }

      for (let s = 0; s < LAMP_LIGHTS; s++) {
        const l = lampLights[s];
        const idx = assigned[s];
        if (idx < 0) {
          l.intensity = 0;
          continue;
        }
        l.position.copy(lamps[idx]);
        // Fade the far ones out rather than snapping them off at the edge of
        // the search radius.
        const d = l.position.distanceTo(cameraPos);
        const fade = THREE.MathUtils.clamp((LAMP_SEARCH - d) / 10, 0, 1);
        l.intensity = 26 * lit * fade;
      }
    },

    setHeadlights(on, position, yaw, night) {
      // Lit a little before full dark, like the street lamps.
      const lit = on ? Math.pow(THREE.MathUtils.clamp(night, 0, 1), 0.7) : 0;
      if (lit <= 0.01) {
        for (const s of headlamps) s.intensity = 0;
        return;
      }
      forward.set(Math.sin(yaw), 0, Math.cos(yaw));
      right.set(forward.z, 0, -forward.x);
      for (let i = 0; i < headlamps.length; i++) {
        const side = i === 0 ? -1 : 1;
        const s = headlamps[i];
        s.intensity = 55 * lit;
        s.position
          .copy(position)
          .addScaledVector(right, side * 0.62)
          .addScaledVector(forward, 1.9);
        s.position.y = position.y + 0.62;
        // Aimed well down the road and slightly down, so the beam lands on the
        // tarmac rather than on the buildings on the far side of it.
        targets[i].position
          .copy(s.position)
          .addScaledVector(forward, 18)
          .addScaledVector(right, side * 1.6);
        targets[i].position.y = position.y - 1.4;
        targets[i].updateMatrixWorld();
      }
    },
  };
}

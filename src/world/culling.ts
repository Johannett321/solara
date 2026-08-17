import * as THREE from 'three';

/**
 * Group-level visibility.
 *
 * three culls per *mesh*, which is the right answer at the wrong granularity
 * here. Reaching that decision means walking every node in the scene — 68000 of
 * them — and then walking them again for the shadow pass and again for GTAO's
 * normal pass. Testing a parked car, a pedestrian or a baked street chunk
 * *once* and switching the whole subtree off with `visible = false` lets three
 * skip the lot in a single comparison.
 *
 * Two rules keep this from changing a single pixel:
 *
 * - The sphere must *enclose* the subtree. Nothing that would have been drawn
 *   may ever be switched off, so the radii here are deliberately generous —
 *   three still does the exact per-mesh test on whatever survives.
 * - A caster behind the camera still throws a shadow into shot, so the sun's
 *   shadow volume is tested alongside the view frustum. Culling on the camera
 *   alone deletes the shadows of everything just out of frame.
 *
 * Switching a subtree off has to take it out of `updateMatrixWorld` as well,
 * which is worth as much again — the render list is only one of the two full
 * walks a frame costs. `matrixWorldAutoUpdate = false` looks like the flag for
 * that and is not: three skips the matrix multiply but still recurses into
 * every child regardless, so a frozen city was still costing a walk of 64000
 * nodes twice a frame (~27 ms, 40% of the budget). `prune` below is what
 * actually stops the walk.
 */

const walkMatrices = THREE.Object3D.prototype.updateMatrixWorld;

/**
 * Skip the matrix walk for a subtree while it is switched off.
 *
 * Its `position` keeps being written while it is hidden; the first walk after
 * it comes back on picks all of that up, because `matrixAutoUpdate` is still
 * doing its job whenever the walk does reach it.
 */
function prune(object: THREE.Object3D): void {
  object.updateMatrixWorld = function (this: THREE.Object3D, force?: boolean) {
    if (this.visible) walkMatrices.call(this, force);
  };
}

/**
 * Take a subtree out of the matrix walk permanently.
 *
 * For the baked world only: its matrices are correct the moment it is built and
 * can never change again, so there is nothing for the walk to discover.
 * Requires one forced update first.
 */
export function freezeMatrices(object: THREE.Object3D): void {
  object.updateMatrixWorld = () => {};
}

export interface Cullable {
  /** The subtree to switch. Its `position` is the centre of the test sphere. */
  object: THREE.Object3D;
  /** Radius about that position enclosing the whole subtree, in metres. */
  radius: number;
  /**
   * The owner's own say. Crowd and traffic already drop agents past their own
   * range; they write that decision here instead of to `visible`, so there is
   * only ever one writer.
   */
  near: boolean;
}

export class Culler {
  private readonly items: Cullable[] = [];
  private readonly view = new THREE.Frustum();
  private readonly m = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  /** Fixed centres for things whose `position` is not where their geometry is. */
  private readonly statics: Array<{ object: THREE.Object3D; centre: THREE.Vector3; radius: number }> = [];

  /**
   * Register a mover. Its `position` is read fresh every frame, and its owner
   * keeps writing `near`.
   */
  track(c: Cullable): void {
    this.items.push(c);
    prune(c.object);
  }

  /**
   * Register something that never moves. Baked chunks sit at the origin with
   * their geometry spread across a whole block, so they carry explicit bounds.
   */
  addStatic(object: THREE.Object3D, bounds: THREE.Box3): void {
    if (bounds.isEmpty()) return;
    const centre = bounds.getCenter(new THREE.Vector3());
    const radius = bounds.getSize(new THREE.Vector3()).length() * 0.5;
    this.statics.push({ object, centre, radius });
  }

  /**
   * @param camera Positioned for *this* frame — call after the chase camera has
   *   settled, or everything lags a frame behind the view.
   * @param shadow The sun's shadow volume, or null when the sun is down.
   */
  update(camera: THREE.Camera, shadow: THREE.Frustum | null): void {
    this.view.setFromProjectionMatrix(
      this.m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const sphere = this.sphere;

    for (const it of this.statics) {
      sphere.center.copy(it.centre);
      sphere.radius = it.radius;
      it.object.visible =
        this.view.intersectsSphere(sphere) || (shadow !== null && shadow.intersectsSphere(sphere));
    }

    for (const it of this.items) {
      let on = it.near;
      if (on) {
        sphere.center.copy(it.object.position);
        sphere.radius = it.radius;
        on =
          this.view.intersectsSphere(sphere) ||
          (shadow !== null && shadow.intersectsSphere(sphere));
      }
      // `prune` reads this too, so one write drops the subtree out of both the
      // render list and the matrix walk.
      it.object.visible = on;
    }
  }
}

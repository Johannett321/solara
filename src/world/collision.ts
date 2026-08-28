import * as THREE from 'three';

interface Box {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Obstacles shorter than this are stepped over rather than blocked by. */
  top: number;
  on: boolean;
}

interface Circle {
  x: number;
  z: number;
  r: number;
  top: number;
  on: boolean;
}

/**
 * Handle to a single obstacle so it can be switched off later — a parked car
 * must stop blocking the world the moment you climb into it.
 */
export interface ColliderHandle {
  enable(): void;
  disable(): void;
  /** Re-place the footprint, keeping its original dimensions. */
  move(cx: number, cz: number, yaw: number): void;
}

/**
 * 2D swept-circle resolution against axis-aligned boxes and cylinders. Enough
 * for a pedestrian on a flat street, and it never tunnels at sprint speed
 * because we resolve along the minimum-penetration axis every frame.
 */
export class Colliders {
  private boxes: Box[] = [];
  private circles: Circle[] = [];

  addBox(minX: number, maxX: number, minZ: number, maxZ: number, top = 50): this {
    this.boxes.push({ minX, maxX, minZ, maxZ, top, on: true });
    return this;
  }

  /** Convenience for a centred footprint. */
  addBoxAt(cx: number, cz: number, sx: number, sz: number, top = 50): this {
    return this.addBox(cx - sx / 2, cx + sx / 2, cz - sz / 2, cz + sz / 2, top);
  }

  addCircle(x: number, z: number, r: number, top = 50): this {
    this.circles.push({ x, z, r, top, on: true });
    return this;
  }

  /**
   * Footprint of something facing `yaw`, given its own length and width.
   *
   * **Use this for anything with a heading.** `addRotatedBox` below takes
   * *world-axis* extents — at yaw 0 its `sx` is the X extent — while a heading
   * of 0 in this project means facing **+Z**, so a car's length runs along Z
   * and its width along X. Passing `(length, width)` to `addRotatedBox`
   * therefore lays the footprint across the road instead of along it, which is
   * exactly the bug that had parked cars blocking a lane of Ocean Drive while
   * you could walk through their doors.
   */
  addHeadingBox(
    cx: number,
    cz: number,
    length: number,
    width: number,
    yaw: number,
    top = 50,
  ): this {
    return this.addRotatedBox(cx, cz, width, length, yaw, top);
  }

  /** Footprint of an arbitrarily rotated box, approximated by its AABB. */
  addRotatedBox(
    cx: number,
    cz: number,
    sx: number,
    sz: number,
    yaw: number,
    top = 50,
  ): this {
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    return this.addBoxAt(cx, cz, sx * c + sz * s, sx * s + sz * c, top);
  }

  /**
   * Same as `addHeadingBox`, but hands back a handle that can switch the
   * obstacle off or re-place it as the object it represents moves. Takes
   * `length` along the heading and `width` across it.
   */
  addSwitchableBox(
    cx: number,
    cz: number,
    length: number,
    width: number,
    yaw: number,
    top = 50,
  ): ColliderHandle {
    const sx = width;
    const sz = length;
    this.addRotatedBox(cx, cz, sx, sz, yaw, top);
    const box = this.boxes[this.boxes.length - 1];
    return {
      enable: () => {
        box.on = true;
      },
      disable: () => {
        box.on = false;
      },
      move: (nx, nz, nyaw) => {
        const c = Math.abs(Math.cos(nyaw));
        const s = Math.abs(Math.sin(nyaw));
        const w = sx * c + sz * s;
        const d = sx * s + sz * c;
        box.minX = nx - w / 2;
        box.maxX = nx + w / 2;
        box.minZ = nz - d / 2;
        box.maxZ = nz + d / 2;
      },
    };
  }

  /**
   * Pushes a circle of `radius` at `pos` out of every overlapping obstacle.
   * `feetY` lets low obstacles (kerbs, planter lips) be ignored once stepped on.
   */
  resolve(pos: THREE.Vector3, radius: number, feetY: number): void {
    for (const b of this.boxes) {
      if (!b.on || feetY >= b.top - 0.02) continue;
      const cx = THREE.MathUtils.clamp(pos.x, b.minX, b.maxX);
      const cz = THREE.MathUtils.clamp(pos.z, b.minZ, b.maxZ);
      const dx = pos.x - cx;
      const dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;

      if (d2 > radius * radius) continue;

      if (d2 > 1e-8) {
        // Outside the box, overlapping a face or corner: push straight out.
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * radius;
        pos.z = cz + (dz / d) * radius;
      } else {
        // Centre is inside the box: escape via the nearest face.
        const toL = pos.x - b.minX;
        const toR = b.maxX - pos.x;
        const toB = pos.z - b.minZ;
        const toT = b.maxZ - pos.z;
        const m = Math.min(toL, toR, toB, toT);
        if (m === toL) pos.x = b.minX - radius;
        else if (m === toR) pos.x = b.maxX + radius;
        else if (m === toB) pos.z = b.minZ - radius;
        else pos.z = b.maxZ + radius;
      }
    }

    for (const c of this.circles) {
      if (!c.on || feetY >= c.top - 0.02) continue;
      const dx = pos.x - c.x;
      const dz = pos.z - c.z;
      const rr = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-8) continue;
      const d = Math.sqrt(d2);
      pos.x = c.x + (dx / d) * rr;
      pos.z = c.z + (dz / d) * rr;
    }
  }

  /**
   * Shortest unobstructed distance from `from` toward `to`, used to pull the
   * camera in when a wall gets between it and Mara.
   */
  raycastXZ(from: THREE.Vector3, to: THREE.Vector3, y: number, pad: number): number {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-5) return len;

    const steps = Math.max(4, Math.ceil(len / 0.25));
    const probe = new THREE.Vector3();

    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * len;
      probe.set(from.x + (dx / len) * t, y, from.z + (dz / len) * t);
      if (this.blocked(probe.x, probe.z, y, pad)) return Math.max(0, t - pad);
    }
    return len;
  }

  /**
   * Is this point inside anything solid?
   *
   * `raycastXZ` above walks at a fixed 25 cm and is O(colliders) per step,
   * which is right for one camera arm per frame and far too expensive for a
   * bullet: a 160 m shot would be 640 steps over a few thousand colliders, a
   * dozen times a second. Ballistics marches at its own adaptive step instead
   * and asks this directly — see `weapons/ballistics.ts`.
   */
  hits(x: number, z: number, y: number): boolean {
    return this.blocked(x, z, y, 0);
  }

  private blocked(x: number, z: number, y: number, pad: number): boolean {
    for (const b of this.boxes) {
      if (!b.on || y >= b.top) continue;
      if (
        x > b.minX - pad &&
        x < b.maxX + pad &&
        z > b.minZ - pad &&
        z < b.maxZ + pad
      )
        return true;
    }
    for (const c of this.circles) {
      if (!c.on || y >= c.top) continue;
      if (Math.hypot(x - c.x, z - c.z) < c.r + pad) return true;
    }
    return false;
  }
}

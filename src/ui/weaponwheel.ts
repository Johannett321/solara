import { WEAPONS, WHEEL_ORDER, WeaponId } from '../weapons/specs';

/**
 * The hold-Tab weapon wheel.
 *
 * Drawn to a 2D canvas for the same reason the map is: it is flat UI over the
 * frame, and a canvas costs one textured quad where a DOM tree of arcs would
 * cost a layout pass every frame.
 *
 * The pointer is locked while playing, so there is no cursor to read. The wheel
 * integrates the raw mouse delta into its own cursor instead, which is why it
 * has to be handed the frame's mouse movement rather than listening for it —
 * `main.ts` routes the delta here *instead of* to the camera while the wheel is
 * up, so the view does not swing around behind it.
 */

/** How far the cursor must be from the centre before a slot is picked. */
const DEAD_ZONE = 42;
const RADIUS = 132;
const THICKNESS = 74;

export interface WheelSources {
  /** Which weapons are owned — the shop will change this over time. */
  has(id: WeaponId): boolean;
  ammoOf(id: WeaponId): { mag: number; reserve: number };
  current(): WeaponId | null;
}

export class WeaponWheel {
  private ctx: CanvasRenderingContext2D;
  private cx = 0;
  private cy = 0;
  private open = false;
  /** Eased 0..1, so the wheel grows in rather than snapping. */
  private show = 0;
  private slots: Array<WeaponId | null> = [];
  private hover = -1;

  constructor(
    private root: HTMLElement,
    private canvas: HTMLCanvasElement,
    private sources: WheelSources,
  ) {
    this.ctx = canvas.getContext('2d')!;
    this.resize();
  }

  resize(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    this.canvas.width = Math.floor(innerWidth * dpr);
    this.canvas.height = Math.floor(innerHeight * dpr);
    this.canvas.style.width = `${innerWidth}px`;
    this.canvas.style.height = `${innerHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** The slot the cursor is over, or the current weapon if it is centred. */
  get selection(): WeaponId | null {
    if (this.hover < 0 || this.hover >= this.slots.length) return this.sources.current();
    return this.slots[this.hover];
  }

  private rebuild(): void {
    // Empty hands is always available; weapons appear as they are acquired.
    this.slots = WHEEL_ORDER.filter((id) => id === null || this.sources.has(id));
  }

  openWheel(): void {
    if (this.open) return;
    this.open = true;
    this.cx = 0;
    this.cy = 0;
    this.hover = -1;
    this.rebuild();
    this.root.classList.add('show');
  }

  closeWheel(): void {
    if (!this.open) return;
    this.open = false;
    this.root.classList.remove('show');
  }

  /** Feed the frame's raw pointer delta. Returns nothing; read `selection`. */
  moveCursor(dx: number, dy: number): void {
    if (!this.open) return;
    this.cx += dx * 0.55;
    this.cy += dy * 0.55;
    const r = Math.hypot(this.cx, this.cy);
    // Clamp to the ring rather than letting the cursor run off into the corner,
    // so a big flick still lands on the slot it was pointed at.
    const max = RADIUS + THICKNESS * 0.5;
    if (r > max) {
      this.cx = (this.cx / r) * max;
      this.cy = (this.cy / r) * max;
    }
    this.hover = r < DEAD_ZONE ? -1 : this.slotAt(Math.atan2(this.cx, -this.cy));
  }

  /** Slot index for an angle measured clockwise from straight up. */
  private slotAt(angle: number): number {
    const n = this.slots.length;
    if (!n) return -1;
    const step = (Math.PI * 2) / n;
    let a = angle % (Math.PI * 2);
    if (a < 0) a += Math.PI * 2;
    return Math.floor((a + step / 2) / step) % n;
  }

  update(dt: number): void {
    const target = this.open ? 1 : 0;
    this.show += (target - this.show) * Math.min(1, dt * 18);
    if (this.show > 0.002) this.draw();
  }

  private draw(): void {
    const c = this.ctx;
    const w = innerWidth;
    const h = innerHeight;
    c.clearRect(0, 0, w, h);

    const ox = w / 2;
    const oy = h / 2;
    const k = this.show;
    const n = this.slots.length;
    if (!n) return;

    c.save();
    c.translate(ox, oy);
    c.scale(0.82 + k * 0.18, 0.82 + k * 0.18);
    c.globalAlpha = k;

    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const id = this.slots[i];
      const spec = id ? WEAPONS[id] : null;
      const active = i === this.hover;
      // Canvas angles run clockwise from +X; the wheel runs from straight up.
      const mid = i * step - Math.PI / 2;
      const a0 = mid - step / 2 + 0.028;
      const a1 = mid + step / 2 - 0.028;

      const inner = RADIUS - THICKNESS / 2;
      const outer = RADIUS + THICKNESS / 2 + (active ? 9 : 0);

      c.beginPath();
      c.arc(0, 0, outer, a0, a1);
      c.arc(0, 0, inner, a1, a0, true);
      c.closePath();
      c.fillStyle = active ? 'rgba(255,255,255,.20)' : 'rgba(12,15,20,.62)';
      c.fill();
      c.lineWidth = active ? 2 : 1;
      c.strokeStyle = active
        ? `#${(spec?.tint ?? 0xffffff).toString(16).padStart(6, '0')}`
        : 'rgba(255,255,255,.14)';
      c.stroke();

      // Label, laid out flat rather than following the arc: rotated type in a
      // ring is unreadable at a glance, and a glance is all this gets.
      const lx = Math.cos(mid) * RADIUS;
      const ly = Math.sin(mid) * RADIUS;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = active ? '#fff' : 'rgba(255,255,255,.66)';
      c.font = '700 13px ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif';
      c.fillText(spec ? spec.name : 'Unarmed', lx, ly - 9);

      c.font = '500 10px ui-monospace, Menlo, monospace';
      c.fillStyle = active ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.4)';
      if (spec) {
        const { mag, reserve } = this.sources.ammoOf(spec.id);
        c.fillText(`${mag} / ${reserve}`, lx, ly + 9);
      } else {
        c.fillText('fists', lx, ly + 9);
      }
    }

    // Hub, and the cursor the mouse is pushing around.
    c.beginPath();
    c.arc(0, 0, DEAD_ZONE - 6, 0, Math.PI * 2);
    c.fillStyle = 'rgba(12,15,20,.72)';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,.16)';
    c.lineWidth = 1;
    c.stroke();

    const sel = this.selection;
    c.fillStyle = 'rgba(255,255,255,.82)';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = '600 10px ui-sans-serif, -apple-system, sans-serif';
    c.fillText(sel ? WEAPONS[sel].name.toUpperCase() : 'UNARMED', 0, 0);

    c.beginPath();
    c.arc(this.cx, this.cy, 4.5, 0, Math.PI * 2);
    c.fillStyle = '#ffd24a';
    c.fill();

    c.restore();
  }
}

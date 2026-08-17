import * as THREE from 'three';
import { Footprint } from '../world/buildings';
import { Drivable } from '../world/cars';
import { Boat } from '../world/boats';
import {
  AVENUES,
  CROSS_STREETS,
  CITY_MAX_X,
  CITY_MIN_Z,
  CITY_MAX_Z,
  HOTEL_X,
  beachEdgeAt,
  riverCentreZ,
  riverHalfWidth,
  BRIDGES,
  RIVER_END_X,
  ROAD_HALF,
  WALK_R_OUTER,
  WALK_L_OUTER,
  PARK_EDGE,
  SHORELINE_X,
  OCEAN_EDGE,
  STRIP_MIN_Z,
  STRIP_MAX_Z,
} from '../world/layout';

/**
 * The pause map. World coordinates are metres with +Z running north up the
 * strip, so the projection is a straight affine map: screen x from world x,
 * screen y from *negated* world z, both scaled by `zoom`.
 */

export interface MapSources {
  footprints: Footprint[];
  drivables: Drivable[];
  boats: Boat[];
  /** Live pedestrian positions. */
  crowd: () => THREE.Vector3[];
  player: () => { pos: THREE.Vector3; yaw: number; driving: boolean };
}

const COL = {
  bg: '#0d1117',
  shallow: '#1d6d6b',
  water: '#0d3e4f',
  deep: '#0a2b3a',
  sand: '#7a6a4a',
  park: '#2c3d28',
  boat: '#8fe6d2',
  bank: '#3a3a33',
  block: '#20272f',
  blockTall: '#2a323c',
  road: '#3b424b',
  walk: '#4a3a3c',
  walkGrey: '#2a2e33',
  walkLine: '#5d494b',
  label: '#8f9aa8',
  player: '#ffd24a',
  car: '#5fd1e8',
  ped: '#6f7a88',
  grid: 'rgba(255,255,255,0.04)',
};

export class MapOverlay {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private root: HTMLElement;

  private zoom = 6.5;
  private centre = new THREE.Vector2(0, 0);
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  /** Recentre on the player until the user pans away. */
  private followPlayer = true;

  open = false;

  constructor(
    root: HTMLElement,
    canvas: HTMLCanvasElement,
    private src: MapSources,
  ) {
    this.root = root;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;

    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', (e) => {
      this.dragging = false;
      canvas.releasePointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.followPlayer = false;
      this.centre.x -= (e.clientX - this.lastX) / this.zoom;
      this.centre.y += (e.clientY - this.lastY) / this.zoom;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      this.draw();
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom = THREE.MathUtils.clamp(this.zoom * (e.deltaY < 0 ? 1.12 : 0.89), 1.4, 26);
        this.draw();
      },
      { passive: false },
    );
  }

  show(): void {
    this.open = true;
    this.followPlayer = true;
    this.root.classList.add('show');
    this.resize();
  }

  hide(): void {
    this.open = false;
    this.root.classList.remove('show');
  }

  resize(): void {
    const dpr = Math.min(devicePixelRatio, 2);
    const r = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.open) this.draw();
  }

  draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.width / Math.min(devicePixelRatio, 2);
    const h = this.canvas.height / Math.min(devicePixelRatio, 2);
    const player = this.src.player();

    if (this.followPlayer) {
      this.centre.set(player.pos.x, player.pos.z);
    }

    ctx.fillStyle = COL.bg;
    ctx.fillRect(0, 0, w, h);

    // World -> screen. North (+Z) is up, so the z axis is flipped.
    const sx = (x: number) => (x - this.centre.x) * this.zoom + w / 2;
    const sy = (z: number) => -(z - this.centre.y) * this.zoom + h / 2;
    const rect = (x0: number, x1: number, z0: number, z1: number) =>
      ctx.fillRect(sx(x0), sy(z1), (x1 - x0) * this.zoom, (z1 - z0) * this.zoom);

    /* -------------------------------------------------------------- grid */

    ctx.strokeStyle = COL.grid;
    ctx.lineWidth = 1;
    const step = 20;
    ctx.beginPath();
    for (let x = -200; x <= 200; x += step) {
      ctx.moveTo(sx(x), 0);
      ctx.lineTo(sx(x), h);
    }
    for (let z = STRIP_MIN_Z - 60; z <= STRIP_MAX_Z + 60; z += step) {
      ctx.moveTo(0, sy(z));
      ctx.lineTo(w, sy(z));
    }
    ctx.stroke();

    /* ------------------------------------------------------------- sea */

    // Depth bands, seaward of the waterline.
    ctx.fillStyle = COL.deep;
    rect(OCEAN_EDGE, SHORELINE_X, STRIP_MIN_Z - 400, STRIP_MAX_Z + 400);
    ctx.fillStyle = COL.water;
    rect(SHORELINE_X - 120, SHORELINE_X, STRIP_MIN_Z - 400, STRIP_MAX_Z + 400);
    ctx.fillStyle = COL.shallow;
    rect(SHORELINE_X - 26, SHORELINE_X, STRIP_MIN_Z - 400, STRIP_MAX_Z + 400);

    // Beach, then the park with its wandering seaward edge.
    ctx.fillStyle = COL.sand;
    rect(SHORELINE_X, PARK_EDGE, STRIP_MIN_Z - 400, STRIP_MAX_Z + 400);

    ctx.fillStyle = COL.park;
    ctx.beginPath();
    ctx.moveTo(sx(PARK_EDGE), sy(STRIP_MIN_Z - 400));
    for (let z = STRIP_MIN_Z - 400; z <= STRIP_MAX_Z + 400; z += 8) {
      ctx.lineTo(sx(beachEdgeAt(z)), sy(z));
    }
    ctx.lineTo(sx(PARK_EDGE), sy(STRIP_MAX_Z + 400));
    ctx.closePath();
    ctx.fill();

    // Waterline.
    ctx.strokeStyle = '#bfe9e0';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sx(SHORELINE_X), 0);
    ctx.lineTo(sx(SHORELINE_X), h);
    ctx.stroke();

    /* ------------------------------------------------------------ ground */

    // Promenades either side of the carriageway.
    ctx.fillStyle = COL.walk;
    rect(ROAD_HALF, WALK_R_OUTER, STRIP_MIN_Z, STRIP_MAX_Z);
    rect(WALK_L_OUTER, -ROAD_HALF, STRIP_MIN_Z, STRIP_MAX_Z);

    /* ------------------------------------------------------------- city */

    // Block pavement under the whole inland grid, then the streets over it.
    ctx.fillStyle = COL.walkGrey;
    rect(HOTEL_X - 3, CITY_MAX_X, CITY_MIN_Z, CITY_MAX_Z);

    ctx.fillStyle = COL.road;
    for (const a of AVENUES) {
      const zA = a.x === 0 ? STRIP_MIN_Z : CITY_MIN_Z;
      const zB = a.x === 0 ? STRIP_MAX_Z : CITY_MAX_Z;
      rect(a.x - a.halfWidth, a.x + a.halfWidth, zA, zB);
    }
    for (const c of CROSS_STREETS) {
      rect(-ROAD_HALF - 6.5, CITY_MAX_X, c.z - c.halfWidth, c.z + c.halfWidth);
    }

    // Centre lines down every avenue.
    ctx.strokeStyle = '#6a6250';
    ctx.lineWidth = Math.max(1, this.zoom * 0.09);
    ctx.setLineDash([this.zoom * 1.6, this.zoom * 1.4]);
    ctx.beginPath();
    for (const a of AVENUES) {
      const zA = a.x === 0 ? STRIP_MIN_Z : CITY_MIN_Z;
      const zB = a.x === 0 ? STRIP_MAX_Z : CITY_MAX_Z;
      ctx.moveTo(sx(a.x), sy(zA));
      ctx.lineTo(sx(a.x), sy(zB));
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Avenue names, once zoomed in enough to read them.
    if (this.zoom > 2.2) {
      ctx.fillStyle = COL.label;
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const a of AVENUES) {
        ctx.save();
        ctx.translate(sx(a.x), h - 60);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(a.name, 0, 0);
        ctx.restore();
      }
    }

    /* ------------------------------------------------------------ river */

    // Channel drawn as a filled ribbon down the meander, banks then water.
    const ribbon = (pad: number, fill: string) => {
      ctx.fillStyle = fill;
      ctx.beginPath();
      for (let x = -90; x <= RIVER_END_X; x += 12) {
        ctx.lineTo(sx(x), sy(riverCentreZ(x) - riverHalfWidth(x) - pad));
      }
      for (let x = RIVER_END_X; x >= -90; x -= 12) {
        ctx.lineTo(sx(x), sy(riverCentreZ(x) + riverHalfWidth(x) + pad));
      }
      ctx.closePath();
      ctx.fill();
    };
    ribbon(14, COL.bank);
    ribbon(0, COL.water);

    // Bridges over it.
    ctx.fillStyle = COL.road;
    for (const b of BRIDGES) {
      rect(
        b.x - b.halfWidth,
        b.x + b.halfWidth,
        b.centreZ - b.spanHalf,
        b.centreZ + b.spanHalf,
      );
    }

    /* --------------------------------------------------------- buildings */

    for (const f of this.src.footprints) {
      ctx.fillStyle = f.floors >= 5 ? COL.blockTall : COL.block;
      rect(f.minX, f.maxX, f.minZ, f.maxZ);
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        sx(f.minX),
        sy(f.maxZ),
        (f.maxX - f.minX) * this.zoom,
        (f.maxZ - f.minZ) * this.zoom,
      );
    }

    // Labels last so buildings never paint over them.
    if (this.zoom > 3.4) {
      ctx.fillStyle = COL.label;
      ctx.font = '600 10px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const f of this.src.footprints) {
        if (!f.label) continue;
        ctx.save();
        // Names read along the street, which runs vertically on screen.
        ctx.translate(sx((f.minX + f.maxX) / 2), sy((f.minZ + f.maxZ) / 2));
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(f.label, 0, 0);
        ctx.restore();
      }
    }

    /* ------------------------------------------------------------- blips */

    // Pedestrians.
    ctx.fillStyle = COL.ped;
    for (const p of this.src.crowd()) {
      ctx.beginPath();
      ctx.arc(sx(p.x), sy(p.z), Math.max(1.2, this.zoom * 0.13), 0, Math.PI * 2);
      ctx.fill();
    }

    // Parked cars.
    for (const d of this.src.drivables) {
      if (d.occupied) continue;
      ctx.save();
      ctx.translate(sx(d.position.x), sy(d.position.z));
      ctx.rotate(-d.yaw);
      ctx.fillStyle = COL.car;
      const l = Math.max(3, this.zoom * 0.62);
      const wd = Math.max(2, this.zoom * 0.28);
      ctx.fillRect(-wd / 2, -l / 2, wd, l);
      ctx.restore();
    }

    // Boats.
    for (const b of this.src.boats) {
      if (b.occupied) continue;
      ctx.save();
      ctx.translate(sx(b.position.x), sy(b.position.z));
      ctx.rotate(-b.yaw);
      ctx.fillStyle = COL.boat;
      const l = Math.max(4, b.build.halfLength * 2 * this.zoom * 0.5);
      const wd = Math.max(2, b.build.halfBeam * 2 * this.zoom * 0.5);
      // A blunt arrow, so moored boats read as pointing somewhere.
      ctx.beginPath();
      ctx.moveTo(0, -l / 2);
      ctx.lineTo(wd / 2, l / 4);
      ctx.lineTo(-wd / 2, l / 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    /* ------------------------------------------------------------ player */

    ctx.save();
    ctx.translate(sx(player.pos.x), sy(player.pos.z));
    // Screen y is inverted, so a world yaw becomes a negative screen rotation.
    ctx.rotate(-player.yaw);
    ctx.fillStyle = COL.player;
    ctx.strokeStyle = '#1b1b1b';
    ctx.lineWidth = 1.5;
    const r = player.driving ? 11 : 9;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.62, r * 0.66);
    ctx.lineTo(0, r * 0.3);
    ctx.lineTo(-r * 0.62, r * 0.66);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    /* ------------------------------------------------------------- scale */

    const barMetres = this.zoom > 9 ? 10 : this.zoom > 4 ? 25 : 50;
    const barPx = barMetres * this.zoom;
    ctx.strokeStyle = '#7d8794';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(20, h - 26);
    ctx.lineTo(20 + barPx, h - 26);
    ctx.moveTo(20, h - 30);
    ctx.lineTo(20, h - 22);
    ctx.moveTo(20 + barPx, h - 30);
    ctx.lineTo(20 + barPx, h - 22);
    ctx.stroke();
    ctx.fillStyle = '#7d8794';
    ctx.font = '500 11px ui-monospace, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(`${barMetres} m`, 20, h - 34);

    // Compass.
    ctx.fillStyle = '#7d8794';
    ctx.font = '700 13px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', w - 30, 30);
    ctx.beginPath();
    ctx.moveTo(w - 30, 36);
    ctx.lineTo(w - 30, 54);
    ctx.strokeStyle = '#7d8794';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

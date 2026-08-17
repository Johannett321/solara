export class Input {
  private keys = new Set<string>();
  /** Accumulated pointer delta, consumed once per frame. */
  private mx = 0;
  private my = 0;
  private jumpQueued = false;
  private interactQueued = false;
  locked = false;

  constructor(private canvas: HTMLElement) {
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Queue on the keydown edge only, so auto-repeat can't bunny-hop.
    if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
    if (e.code === 'KeyF' && !e.repeat) this.interactQueued = true;
    this.keys.add(e.code);
    // Stop the page scrolling out from under the game.
    if (
      ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)
    )
      e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onBlur = () => {
    this.keys.clear();
    this.clearBuffers();
  };

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) this.keys.clear();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mx += e.movementX;
    this.my += e.movementY;
  };

  requestLock(): void {
    this.canvas.requestPointerLock();
  }

  down(...codes: string[]): boolean {
    return codes.some((c) => this.keys.has(c));
  }

  /** Returns and clears the pointer delta for this frame. */
  takeMouse(): { x: number; y: number } {
    const d = { x: this.mx, y: this.my };
    this.mx = 0;
    this.my = 0;
    return d;
  }

  /** Movement intent in screen space: x = right, y = forward. */
  moveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.down('KeyW', 'ArrowUp')) y += 1;
    if (this.down('KeyS', 'ArrowDown')) y -= 1;
    if (this.down('KeyD', 'ArrowRight')) x += 1;
    if (this.down('KeyA', 'ArrowLeft')) x -= 1;
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  /**
   * Edge-triggered jump. Consumed on read so holding Space gives one jump, and
   * a press landing between frames is never dropped.
   */
  takeJump(): boolean {
    if (!this.jumpQueued) return false;
    this.jumpQueued = false;
    return true;
  }

  /**
   * Movement intent without diagonal normalisation — driving wants full
   * throttle while steering, not 0.707 of it.
   */
  driveAxis(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    if (this.down('KeyW', 'ArrowUp')) y += 1;
    if (this.down('KeyS', 'ArrowDown')) y -= 1;
    if (this.down('KeyD', 'ArrowRight')) x += 1;
    if (this.down('KeyA', 'ArrowLeft')) x -= 1;
    return { x, y };
  }

  /** Space doubles as jump on foot and handbrake behind the wheel. */
  get handbrake(): boolean {
    return this.down('Space');
  }

  /** Edge-triggered F, for getting in and out of cars. */
  takeInteract(): boolean {
    if (!this.interactQueued) return false;
    this.interactQueued = false;
    return true;
  }

  /** Drops any buffered edge-triggered input — used when switching modes. */
  clearBuffers(): void {
    this.jumpQueued = false;
    this.interactQueued = false;
  }

  get sprint(): boolean {
    return this.down('ShiftLeft', 'ShiftRight');
  }

  get creep(): boolean {
    return this.down('AltLeft', 'AltRight');
  }
}

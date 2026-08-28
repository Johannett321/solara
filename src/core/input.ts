export class Input {
  private keys = new Set<string>();
  /** Accumulated pointer delta, consumed once per frame. */
  private mx = 0;
  private my = 0;
  private jumpQueued = false;
  private interactQueued = false;
  private reloadQueued = false;
  /** Mouse buttons currently held, by `MouseEvent.button`. */
  private buttons = new Set<number>();
  private fireQueued = false;
  locked = false;

  constructor(private canvas: HTMLElement) {
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    // Up on the window, not the canvas: releasing outside the page would
    // otherwise leave the button stuck down and the gun firing forever.
    addEventListener('mouseup', this.onMouseUp);
    // Right-drag is aim-down-sights, so the browser menu has to go.
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Queue on the keydown edge only, so auto-repeat can't bunny-hop.
    if (e.code === 'Space' && !e.repeat) this.jumpQueued = true;
    if (e.code === 'KeyF' && !e.repeat) this.interactQueued = true;
    if (e.code === 'KeyR' && !e.repeat) this.reloadQueued = true;
    this.keys.add(e.code);
    // Stop the page scrolling out from under the game — and stop Tab walking
    // the focus ring through the HUD while the weapon wheel is open.
    if (
      ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)
    )
      e.preventDefault();
  };

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onBlur = () => {
    this.keys.clear();
    this.buttons.clear();
    this.clearBuffers();
  };

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    if (!this.locked) {
      this.keys.clear();
      this.buttons.clear();
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.mx += e.movementX;
    this.my += e.movementY;
  };

  private onMouseDown = (e: MouseEvent) => {
    // Only once the pointer is captured; the first click is what asks for the
    // lock in the first place and must not also fire a round.
    if (!this.locked) return;
    this.buttons.add(e.button);
    if (e.button === 0) this.fireQueued = true;
  };

  private onMouseUp = (e: MouseEvent) => {
    this.buttons.delete(e.button);
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
    this.reloadQueued = false;
    this.fireQueued = false;
  }

  /* ------------------------------------------------------------- weapons */

  /** Left mouse held. Automatics read this; semi-autos read `takeFire`. */
  get firing(): boolean {
    return this.buttons.has(0);
  }

  /**
   * Edge-triggered left mouse, so a pistol fires once per click however long
   * the button is held. Consumed on read.
   */
  takeFire(): boolean {
    if (!this.fireQueued) return false;
    this.fireQueued = false;
    return true;
  }

  /** Right mouse held: aim down sights. */
  get aiming(): boolean {
    return this.buttons.has(2);
  }

  /** Tab held: the weapon wheel is up. */
  get wheel(): boolean {
    return this.down('Tab');
  }

  /** Edge-triggered R. */
  takeReload(): boolean {
    if (!this.reloadQueued) return false;
    this.reloadQueued = false;
    return true;
  }

  get sprint(): boolean {
    return this.down('ShiftLeft', 'ShiftRight');
  }

  get creep(): boolean {
    return this.down('AltLeft', 'AltRight');
  }
}

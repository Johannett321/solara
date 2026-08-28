/**
 * Weapon data.
 *
 * Everything that distinguishes one gun from another lives here as numbers, so
 * adding a weapon is a row in `WEAPONS` plus a builder in `models.ts` — the
 * firing code, the wheel, the HUD and the aim pose all read this table and
 * none of them know what a pistol is.
 *
 * Spreads are half-angles in radians, at the muzzle. For scale: 0.02 rad is
 * about 20 cm of scatter at 10 m, which reads as "accurate but not a laser".
 */

export type WeaponId = 'pistol' | 'smg';

export interface WeaponSpec {
  id: WeaponId;
  name: string;
  /** Shown under the name on the wheel. */
  blurb: string;
  /** Semi fires once per click; auto keeps firing while the button is held. */
  fire: 'semi' | 'auto';
  /** Rounds per minute — the floor on time between shots either way. */
  rpm: number;
  magazine: number;
  /** Rounds carried outside the magazine. The shop will top this up. */
  reserve: number;
  /** Cap on reserve, so ammo pickups can't overfill. */
  reserveMax: number;
  reloadTime: number;
  /** Cone half-angle standing and firing from the hip. */
  hipSpread: number;
  /** Cone half-angle aiming down sights. Never zero: a dot is not a gun. */
  adsSpread: number;
  /** Added to the spread per shot, and bled off at `spreadRecover` per second. */
  spreadPerShot: number;
  spreadRecover: number;
  /** Camera kick per shot, radians. */
  recoil: number;
  /** How far a round carries before it stops mattering, in metres. */
  range: number;
  /** Field of view while aiming. The hip FOV comes from the camera rig. */
  adsFov: number;
  /** Both hands on it — the animator brings the support arm across. */
  twoHanded: boolean;
  /** Wheel and HUD accent. */
  tint: number;
}

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    blurb: 'Semi-auto · 12 rounds',
    fire: 'semi',
    rpm: 320,
    magazine: 12,
    reserve: 48,
    reserveMax: 96,
    reloadTime: 1.1,
    hipSpread: 0.05,
    adsSpread: 0.008,
    // A pistol's cone should jump on every shot and settle between them, so
    // per-shot bloom is large and recovery is fast. Semi-auto means the player
    // sets the rhythm, and this is what rewards them for slowing down.
    spreadPerShot: 0.03,
    spreadRecover: 0.12,
    recoil: 0.022,
    range: 120,
    adsFov: 40,
    twoHanded: false,
    tint: 0xffd24a,
  },
  smg: {
    id: 'smg',
    name: 'Compact SMG',
    blurb: 'Full auto · 30 rounds',
    fire: 'auto',
    rpm: 750,
    magazine: 30,
    reserve: 120,
    reserveMax: 240,
    reloadTime: 1.6,
    hipSpread: 0.075,
    adsSpread: 0.017,
    /**
     * Recovery has to be well under `spreadPerShot × rounds per second`, or a
     * held burst never opens the cone at all. At 750 rpm this adds 0.1125/s;
     * the first pass recovered 0.11/s and the two cancelled almost exactly, so
     * the reticle sat still through a full magazine.
     */
    spreadPerShot: 0.009,
    spreadRecover: 0.045,
    recoil: 0.011,
    range: 160,
    adsFov: 44,
    twoHanded: true,
    tint: 0x7ad4ff,
  },
};

/** Wheel order, clockwise from the top. `null` is the empty hands slot. */
export const WHEEL_ORDER: Array<WeaponId | null> = [null, 'pistol', 'smg'];

/** Single source of truth for the Ocean Drive block, in metres. */

/** Carriageway runs along Z; x = 0 is the centre line. */
export const ROAD_HALF = 7;

/** Kerb height — Mara steps up onto the promenade. */
export const CURB_H = 0.16;

/** Hotel-side promenade: the wide salmon pavement from the reference. */
export const WALK_R_OUTER = 16;

/** Ocean-side walk is narrower. */
export const WALK_L_OUTER = -13.5;

/** Dominion Hotel facade plane and block depth. */
export const HOTEL_X = 16;
export const HOTEL_DEPTH = 30;

/** Facade plane of the buildings across the street. */
export const WEST_X = -13.5;

/** Cross street that forms the corner Mara spawns beside. */
export const CROSS_Z = 34;
export const CROSS_HALF = 6;

/** Extent of the original beachfront strip (Ocean Drive's own blocks). */
export const STRIP_MIN_Z = -150;
export const STRIP_MAX_Z = 150;

/* ------------------------------------------------------------ city grid */

/**
 * The street grid, inland of Ocean Drive.
 *
 * This is data, not geometry: the road surfaces, the block filler, the kerbs,
 * the traffic lanes, `isRoadway` and the map overlay all read these same
 * arrays, so a street can never exist visually without existing physically.
 */

/** An avenue runs along Z, at a fixed x. */
export interface Avenue {
  name: string;
  x: number;
  halfWidth: number;
  /** Lanes each way; 2 gets a central median. */
  lanes: 1 | 2;
}

/** A cross street runs along X, at a fixed z. */
export interface CrossStreet {
  z: number;
  halfWidth: number;
}

/** Ocean Drive is avenue 0; everything else marches inland. */
export const AVENUES: Avenue[] = [
  { name: 'Ocean Drive', x: 0, halfWidth: ROAD_HALF, lanes: 1 },
  { name: 'Collins Avenue', x: 66, halfWidth: 8, lanes: 1 },
  { name: 'Washington Avenue', x: 128, halfWidth: 8, lanes: 1 },
  { name: 'Alton Boulevard', x: 202, halfWidth: 11, lanes: 2 },
  { name: 'Bayshore Drive', x: 292, halfWidth: 9, lanes: 1 },
  { name: 'Flagler Street', x: 372, halfWidth: 8, lanes: 1 },
  { name: 'Biscayne Boulevard', x: 452, halfWidth: 11, lanes: 2 },
  { name: 'Carib Avenue', x: 536, halfWidth: 8, lanes: 1 },
];

/** Cross streets, spaced a city block apart. CROSS_Z is one of them. */
export const CROSS_STREETS: CrossStreet[] = (() => {
  const out: CrossStreet[] = [];
  // A block every 80 m, keyed to the original junction so CROSS_Z stays put.
  for (let k = -7; k <= 6; k++) {
    const z = CROSS_Z + k * 80;
    out.push({ z, halfWidth: z === CROSS_Z ? CROSS_HALF : 6 });
  }
  return out;
})();

/** How far inland the city extends, and how far along the shore. */
export const CITY_MAX_X = 580;
export const CITY_MIN_Z = -540;
export const CITY_MAX_Z = 520;

/** Hard limits of the walkable world, enforced once in world/index.ts. */
export const WORLD_MAX_X = CITY_MAX_X + 30;
export const WORLD_MIN_Z = CITY_MIN_Z - 40;
export const WORLD_MAX_Z = CITY_MAX_Z + 40;

/** Cross streets stop at the promenade; they never run onto the sand. */
export const CROSS_MIN_X = -ROAD_HALF - 6.5;

/** Width of the pavement flanking every city street. */
export const WALK_W = 4.2;

/** Where Mara starts, and which way she faces. */
export const SPAWN = { x: 10.6, z: 20, yaw: Math.PI };

/* --------------------------------------------------------------- seaside */

/** Sea level. Everything below this is swimmable. */
export const WATER_Y = 0;

/** Where the paved promenade gives way to the park strip. */
export const PARK_EDGE = -13.5;

/** Seaward limit of the modelled ocean. */
export const OCEAN_EDGE = -720;

/**
 * Cross-shore profile, west of the park edge. Purely a function of x — the
 * shore runs dead straight along Z, which is what lets the water shader work
 * out its own depth analytically instead of needing a depth prepass.
 *
 * Park edge (-13.5) --- dune crest (~-39, +1.2) --- waterline (~-55) ---
 * shelf, levelling off around -4.5 m by -250.
 *
 * MUST stay in sync with `PROFILE_GLSL` below.
 */
export function shoreHeight(x: number): number {
  const u = -(x + 30);
  // Behind the dune the ground just runs back up to promenade level.
  if (u < 0) return CURB_H + 0.28 * smooth01((x + 13.5) / -16.5);
  const dune = 1.05 * Math.exp(-Math.pow((u - 9) / 7, 2));
  const slope = 1.25 * smoothstep(14, 62, u);
  // Extra drop that only bites past the waterline, so you reach swimming depth
  // a dozen metres out instead of wading for fifty. The waterline itself does
  // not move, which keeps the whole beach layout where it was placed.
  const drop = 1.6 * smoothstep(24, 44, u);
  const shelf = 3.4 * smoothstep(62, 170, u);
  return CURB_H + dune - slope - drop - shelf;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function smooth01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

/**
 * Gentle cross-shore undulation on the dry sand, so the beach isn't a pure
 * extrusion of the profile. Anything placed on the sand MUST add this too —
 * it is why `groundHeight` applies it rather than the terrain mesh alone.
 * Fades to nothing below the waterline, so the ocean shader can ignore it.
 */
export function sandRipple(x: number, z: number): number {
  const base = shoreHeight(x);
  if (base <= 0.05) return 0;
  return Math.sin(z * 0.06 + x * 0.02) * 0.05 + Math.sin(z * 0.017 - x * 0.05) * 0.09;
}

/** The exact same profile, for injection into the ocean shader. */
export const PROFILE_GLSL = /* glsl */ `
  float shoreHeight(float x) {
    float u = -(x + 30.0);
    if (u < 0.0) {
      float t = clamp((x + 13.5) / -16.5, 0.0, 1.0);
      return ${CURB_H.toFixed(3)} + 0.28 * (t * t * (3.0 - 2.0 * t));
    }
    float dune  = 1.05 * exp(-pow((u - 9.0) / 7.0, 2.0));
    float slope = 1.25 * smoothstep(14.0, 62.0, u);
    float drop  = 1.6  * smoothstep(24.0, 44.0, u);
    float shelf = 3.4  * smoothstep(62.0, 170.0, u);
    return ${CURB_H.toFixed(3)} + dune - slope - drop - shelf;
  }
`;

/** Approximate x of the waterline, found once by bisection. */
export const SHORELINE_X = (() => {
  let lo = -30;
  let hi = -120;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (shoreHeight(mid) > WATER_Y) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
})();

/* ------------------------------------------------------------- queries */

/**
 * The seaward edge of the grass park, as a function of z.
 *
 * Curving *this* line — rather than the waterline — is what gives the wandering
 * sand-to-city boundary from the reference. The waterline has to stay straight:
 * the ocean shader derives its own depth from world x alone, and a curved
 * waterline would break that outright.
 */
export function beachEdgeAt(z: number): number {
  return (
    -33 +
    6.5 * Math.sin(z * 0.0105) +
    3.2 * Math.sin(z * 0.0271 + 1.3) +
    1.6 * Math.sin(z * 0.061 + 0.4)
  );
}

/* ----------------------------------------------------------------- river */

/**
 * The river runs inland from the sea along X, meandering in Z, and widens into
 * a harbour basin partway up. It cuts clean through the street grid, so every
 * avenue that meets it carries a bridge (see `BRIDGES`).
 */
export const RIVER_BED = -6.5;
const RIVER_MOUTH_X = -90;
export const RIVER_END_X = WORLD_MAX_X;

/** Centreline of the channel. */
export function riverCentreZ(x: number): number {
  return -232 + 54 * Math.sin((x + 120) * 0.0042) + 16 * Math.sin((x + 40) * 0.011);
}

/** Half-width of the channel, wider through the harbour basin. */
export function riverHalfWidth(x: number): number {
  const basin = 46 * Math.exp(-Math.pow((x - 150) / 130, 2));
  return 30 + basin;
}

/**
 * How much the river carves the ground here: 1 in open water, easing to 0 up
 * the banks. Everything that shapes or places ground reads this.
 */
export function riverInfluence(x: number, z: number): number {
  if (x < RIVER_MOUTH_X || x > RIVER_END_X) return 0;
  const half = riverHalfWidth(x);
  const d = Math.abs(z - riverCentreZ(x));
  // 14 m of sloped bank either side of the open channel.
  if (d > half + 14) return 0;
  if (d < half) return 1;
  const t = 1 - (d - half) / 14;
  return t * t * (3 - 2 * t);
}

export function isRiver(x: number, z: number): boolean {
  return riverInfluence(x, z) > 0.5;
}

/* --------------------------------------------------------------- bridges */

/**
 * A bridge carries one avenue over the river. The deck is flat across the
 * channel with ramps at each end, and `bridgeHeightAt` is what makes it
 * genuinely drivable rather than scenery — the ground height function returns
 * the deck, not the riverbed, when you are on one.
 */
export interface Bridge {
  /** Avenue x this bridge carries. */
  x: number;
  halfWidth: number;
  /** Deck centre and clear span. */
  centreZ: number;
  spanHalf: number;
  /** Length of the approach ramp at each end. */
  ramp: number;
  deckY: number;
}

export const BRIDGES: Bridge[] = AVENUES.filter(
  (a) => riverInfluence(a.x, riverCentreZ(a.x)) > 0.5,
).map((a) => {
  const half = riverHalfWidth(a.x);
  return {
    x: a.x,
    halfWidth: a.halfWidth + 1.6,
    centreZ: riverCentreZ(a.x),
    spanHalf: half + 18,
    ramp: 34,
    deckY: 8.5,
  };
});

/** Deck height at a point, or null when not on a bridge. */
export function bridgeHeightAt(x: number, z: number): number | null {
  for (const b of BRIDGES) {
    if (Math.abs(x - b.x) > b.halfWidth) continue;
    const d = Math.abs(z - b.centreZ);
    if (d > b.spanHalf + b.ramp) continue;
    if (d <= b.spanHalf) return b.deckY;
    // Smooth ramp down to street level at the far end.
    const t = 1 - (d - b.spanHalf) / b.ramp;
    return CURB_H + (b.deckY - CURB_H) * (t * t * (3 - 2 * t));
  }
  return null;
}

/** True where the surface is road level rather than pavement level. */
export function isRoadway(x: number, z: number): boolean {
  if (x < CROSS_MIN_X) return false;

  for (const a of AVENUES) {
    if (Math.abs(x - a.x) <= a.halfWidth) return true;
  }
  if (x > CITY_MAX_X || z < CITY_MIN_Z || z > CITY_MAX_Z) return false;
  for (const c of CROSS_STREETS) {
    if (Math.abs(z - c.z) <= c.halfWidth) return true;
  }
  return false;
}

/**
 * The actual ground: shore, street or riverbed, ignoring bridges entirely.
 *
 * Anything that *builds* the ground — the riverbed mesh, quay walls, things
 * standing on the bank — must use this. Using `groundHeight` there instead
 * lifts the terrain to the bridge deck wherever a bridge passes overhead,
 * which roofs the river over with a plateau of riverbed.
 */
export function terrainHeight(x: number, z: number): number {
  const base =
    x < PARK_EDGE ? shoreHeight(x) + sandRipple(x, z) : isRoadway(x, z) ? 0 : CURB_H;

  const r = riverInfluence(x, z);
  if (r <= 0) return base;
  return base * (1 - r) + RIVER_BED * r;
}

/**
 * Walkable surface height: the terrain, or a bridge deck when one is overhead.
 * This is what the player, vehicles and pedestrians stand on.
 */
export function groundHeight(x: number, z: number): number {
  // A bridge wins outright — it is the only place the world is two-storey.
  const deck = bridgeHeightAt(x, z);
  if (deck !== null) return deck;
  return terrainHeight(x, z);
}

/** Water depth at a point; zero or less on dry land. */
export function waterDepth(x: number, z: number): number {
  return WATER_Y - groundHeight(x, z);
}

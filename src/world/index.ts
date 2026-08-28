import * as THREE from 'three';
import { Colliders } from './collision';
import { buildStreet } from './street';
import { buildBuildings, BuildingsResult, Footprint, setStripNight } from './buildings';
import { buildProps, PropsResult } from './props';
import { buildCars, CarsResult, Drivable, setCarNight } from './cars';
import { buildCrowd, Crowd } from './crowd';
import { buildTraffic, Traffic } from './traffic';
import { buildTerrain } from './terrain';
import { buildBeach, BeachResult } from './beach';
import { buildBoats, BoatsResult, Boat } from './boats';
import { buildCity, CityResult, setCityNight, setCityWet } from './city';
import { buildCityDress } from './citydress';
import { setNight as setFacadeNight } from './facades';
import { buildPark } from './park';
import { buildHarbour, HarbourResult } from './harbour';
import { buildOcean, Ocean } from '../render/water';
import { bakeChunked } from '../util/bake';
import { Culler, freezeMatrices } from './culling';
import { Panic } from './panic';
import { WORLD_MAX_X, WORLD_MIN_Z, WORLD_MAX_Z, OCEAN_EDGE } from './layout';
import type { HitZone, PersonTarget } from '../weapons/ballistics';

export interface World {
  group: THREE.Group;
  colliders: Colliders;
  /** Parked cars the player can enter. */
  drivables: Drivable[];
  /** Moored boats the player can board. */
  boats: Boat[];
  /** Building footprints, for the map overlay. */
  footprints: Footprint[];
  /** Live pedestrian positions, for the map overlay. */
  crowdPositions(): THREE.Vector3[];
  /** Shootable pedestrians — see `weapons/ballistics.ts`. Held by reference. */
  people: PersonTarget[];
  /** Put a round into person `index`, from a shot travelling `dirX,dirZ`. */
  shootPerson(index: number, zone: HitZone, dirX: number, dirZ: number, hitY: number): void;
  /** Agent state for `window.SOLARA` — see `Crowd.debug`. */
  personDebug(index: number): Record<string, unknown> | null;
  /** Drop a fleeing pedestrian on the street — the driver of a stolen car. */
  ejectDriver(x: number, z: number, yaw: number): void;
  /**
   * The street's reaction to a drawn weapon. Call `alarm` every frame the
   * player is aiming; everything else reads it.
   */
  panic: Panic;
  /**
   * Everything a bullet can hit that is not the ground or a collider: parked
   * cars, moving traffic and moored boats.
   *
   * Built once and held by reference — every `position` here is the live vector
   * its owner is already writing each frame, so the array never needs
   * rebuilding and `weapons/ballistics.ts` can walk it allocation-free.
   */
  targets: Array<{ position: THREE.Vector3; radius: number }>;
  /** Wave-displaced sea surface height, for swimmers and boats. */
  waterHeight(x: number, z: number): number;
  /** 0 by day, 1 at full night. Switches on every artificial light. */
  setNight(f: number): void;
  /** 0 dry, 1 soaked. Darkens and glosses the road surfaces. */
  setWet(f: number): void;
  update(t: number, dt: number, playerPos: THREE.Vector3): void;
  /**
   * Switch whole subtrees off before they reach three's per-mesh culling — see
   * `world/culling.ts`. Call once a frame, *after* the camera has settled and
   * after `update`, so both the view and the agents are current.
   */
  cull(camera: THREE.Camera, shadow: THREE.Frustum | null): void;
}

/** Chunk size for baking, in metres along the street. */
const CHUNK = 40;

/**
 * Draw ranges for the chunk groups whose *contents* are small, in metres.
 *
 * Measured looking down Ocean Drive, 58% of the draw calls in frame were more
 * than 200 m away, and most of that is clutter: café chairs, bins, planters and
 * kerbside cars, each a couple of pixels at that range. Cutting them is worth
 * roughly a third of the beauty pass.
 *
 * What is deliberately *not* here is anything containing a building —
 * `city`, `buildings`, `harbour`, `props` (the palms) and the ground surfaces.
 * A city chunk is 60 m across and holds towers; dropping one takes a piece out
 * of the skyline and is obvious from a kilometre away. The rule of thumb is the
 * size of the things inside the chunk, never the size of the chunk.
 */
const RANGE = {
  /** Bins, benches, café tables, bikes, planters, litter. */
  citydress: 150,
  /** Kerbside scenery cars, merged into the street. */
  cityparking: 190,
  /** Sunbathers and diners, posed and baked. */
  posedCrowd: 150,
} as const;

/**
 * Parked cars the player can enter. Longer than the scenery cars they sit
 * beside, because a drivable one is the thing you walk toward on purpose.
 */
const PARKED_CAR_RANGE = 230;

const chunkByZ = (o: THREE.Object3D) => Math.floor(o.position.z / CHUNK);

/**
 * 2D bucketing, for the city. Chunking by z alone would put a whole 340 m-deep
 * row of blocks in one bucket, so nothing inland could ever be culled.
 */
const chunkByCell = (o: THREE.Object3D) =>
  `${Math.floor(o.position.x / 70)},${Math.floor(o.position.z / 70)}`;

export function buildWorld(): World {
  const group = new THREE.Group();
  const colliders = new Colliders();
  const culler = new Culler();
  const panic = new Panic();

  // Groups of baked chunks. Collected as they are built and then, once the
  // whole world has been placed, frozen: their matrices never change again, and
  // each chunk gets a bounding sphere so the culler can drop the whole block in
  // one test instead of three visiting every mesh inside it.
  const chunked: Array<{ group: THREE.Group; range?: number }> = [];
  const chunks = (g: THREE.Group, range?: number): THREE.Group => {
    chunked.push({ group: g, range });
    return g;
  };

  // The one and only world boundary. Everything inside is walkable — the old
  // per-module fences are what produced the invisible wall across the city.
  colliders.addBox(WORLD_MAX_X, WORLD_MAX_X + 40, WORLD_MIN_Z - 60, WORLD_MAX_Z + 60);
  colliders.addBox(OCEAN_EDGE - 40, WORLD_MAX_X + 40, WORLD_MIN_Z - 40, WORLD_MIN_Z);
  colliders.addBox(OCEAN_EDGE - 40, WORLD_MAX_X + 40, WORLD_MAX_Z, WORLD_MAX_Z + 40);

  // Everything below is authored as many small meshes for readability, then
  // baked down to a few dozen draw calls per chunk before it ever renders.
  group.add(chunks(bakeChunked(buildStreet(colliders), chunkByZ)));
  const buildings: BuildingsResult = buildBuildings(colliders);
  group.add(chunks(bakeChunked(buildings.group, chunkByZ)));
  // Parked cars stay individual objects — you have to be able to get into one,
  // and a car merged into the street can't be driven away. Each is baked on its
  // own instead, so it still costs only a handful of draw calls.
  const cars: CarsResult = buildCars(colliders);
  group.add(cars.group);
  // The kerbside cars that are scenery only do get merged into the street.
  group.add(chunks(bakeChunked(cars.staticGroup, chunkByCell), RANGE.cityparking));

  // Seaward half of the map: park, dune, beach, seabed, then the ocean itself.
  const terrain = buildTerrain();
  group.add(terrain.group);
  const ocean: Ocean = buildOcean();
  group.add(ocean.mesh);

  // River, port and marina. Built before the city so the ground can be cut
  // around the channel.
  const harbour: HarbourResult = buildHarbour(colliders);
  group.add(chunks(bakeChunked(harbour.group, chunkByCell)));
  group.add(harbour.water.mesh);

  // The inland city: street grid, districts and towers.
  const city: CityResult = buildCity(colliders);
  group.add(chunks(bakeChunked(city.group, chunkByCell)));

  // Street-level dressing: bins, benches, cafés, bikes, planters, litter.
  group.add(chunks(bakeChunked(buildCityDress(colliders), chunkByCell), RANGE.citydress));

  // Green belt between the sand and the promenade.
  group.add(chunks(bakeChunked(buildPark(colliders), chunkByZ)));

  const beach: BeachResult = buildBeach(colliders);
  group.add(chunks(bakeChunked(beach.group, chunkByZ)));

  const props: PropsResult = buildProps(colliders);
  group.add(chunks(bakeChunked(props.group, chunkByZ)));
  group.add(props.fronds.mesh);

  // Runtime-spawned pedestrians — the driver hauled out of a car — have to be
  // handed to the culler, which is built below them.
  const crowd: Crowd = buildCrowd(colliders, beach, (c) => culler.track(c));
  group.add(crowd.group);
  chunks(crowd.posed, RANGE.posedCrowd);

  const traffic: Traffic = buildTraffic(colliders);
  group.add(traffic.group);

  // Boats float, so they stay out of the static bake.
  const boats: BoatsResult = buildBoats();
  group.add(boats.group);

  /* ------------------------------------------------------------- culling */

  // Parked cars carry no range rule of their own — they never move and never
  // run an update — so the draw range is applied here.
  for (const c of cars.cullable) c.maxDistance = PARKED_CAR_RANGE;
  for (const c of [...cars.cullable, ...crowd.cullable, ...traffic.cullable]) {
    culler.track(c);
  }

  // One forced pass fixes every static matrix in the world for good, and then
  // the whole baked half of it comes out of the per-frame matrix walk. Each
  // chunk keeps its bounds so the culler can still switch it in and out of the
  // render list; only the matrices are settled.
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3();
  for (const { group: g, range } of chunked) {
    for (const chunk of g.children) culler.addStatic(chunk, bounds.setFromObject(chunk), range);
    freezeMatrices(g);
  }
  freezeMatrices(terrain.group);

  const targets: Array<{ position: THREE.Vector3; radius: number }> = [];
  // The rendered transform, not the logical one: a car being driven moves its
  // group every frame and only writes `Drivable.position` back on exit.
  for (const d of cars.drivables) targets.push({ position: d.build.group.position, radius: 1.15 });
  for (const c of traffic.cullable) targets.push({ position: c.object.position, radius: 1.15 });
  for (const b of boats.boats) targets.push({ position: b.build.group.position, radius: 1.6 });

  return {
    group,
    colliders,
    // Kerbside and moving traffic in one list: `main.ts` finds the nearest car
    // without caring which it is.
    drivables: [...cars.drivables, ...traffic.drivables],
    boats: boats.boats,
    targets,
    footprints: [...buildings.footprints, ...city.footprints],
    crowdPositions: () => crowd.positions(),
    people: crowd.people,
    panic,
    shootPerson: (i, zone, dirX, dirZ, hitY) => crowd.shoot(i, zone, dirX, dirZ, hitY),
    personDebug: (i) => crowd.debug(i),
    ejectDriver: (x, z, yaw) => crowd.eject(x, z, yaw),
    waterHeight: (x, z) => ocean.heightAt(x, z),
    setNight(f) {
      setFacadeNight(f);
      setCityNight(f);
      setCarNight(f);
      setStripNight(f);
      ocean.setNight(f);
    },
    setWet(f) {
      setCityWet(f);
    },
    cull(camera, shadow) {
      culler.update(camera, shadow);
    },
    update(t, dt, playerPos) {
      // Sea breeze through the palms — the street feels dead without it.
      props.fronds.update(t);
      ocean.update(t);
      harbour.water.update(t);
      panic.update(dt);
      crowd.update(dt, playerPos, panic);
      traffic.update(dt, playerPos, panic);

      // Moored boats ride the same waves the player's boat does.
      for (const b of boats.boats) {
        if (b.occupied) continue;
        const f = new THREE.Vector3(Math.sin(b.yaw), 0, Math.cos(b.yaw));
        const half = b.build.halfLength;
        const bow = ocean.heightAt(b.position.x + f.x * half, b.position.z + f.z * half);
        const stern = ocean.heightAt(b.position.x - f.x * half, b.position.z - f.z * half);
        b.build.group.position.set(
          b.position.x,
          (bow + stern) / 2 - b.build.draft * 0.55,
          b.position.z,
        );
        b.build.group.rotation.set(0, 0, 0);
        b.build.group.rotateY(b.yaw);
        b.build.group.rotateX(Math.atan2(bow - stern, half * 2));
      }
    },
  };
}

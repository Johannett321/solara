import * as THREE from 'three';
import { buildSky } from './render/sky';
import { buildClouds } from './render/clouds';
import { buildWeather } from './render/weather';
import { buildPost } from './render/post';
import { buildWorld } from './world';
import { buildMara } from './player/rig';
import { MaraAnimator, GAIT, AIM_POSE, REACTIONS } from './player/animator';
import { Controller } from './player/controller';
import { VehicleController } from './player/driving';
import { BoatController } from './player/boating';
import { ThirdPersonCamera, ON_FOOT, IN_CAR, inBoat } from './camera/thirdperson';
import { Input } from './core/input';
import { MapOverlay } from './ui/map';
import { WeaponWheel } from './ui/weaponwheel';
import { Arsenal, WeaponId } from './weapons';
import { Audio } from './audio';
import { groundHeight, waterDepth, SPAWN } from './world/layout';
import { insideBody } from './world/traffic';
import type { Drivable } from './world/cars';
import type { Boat } from './world/boats';

/* ------------------------------------------------------------- renderer */

const renderer = new THREE.WebGLRenderer({
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
// The frame renders the scene twice — once for the beauty pass and once for
// GTAO's normal buffer — and three rebuilds the shadow map at the top of each.
// The second one is identical to the first and cost ~9 ms a frame. Driving it
// by hand means it happens once, before the beauty pass consumes the flag.
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Exposure is set against the Sky shader's absolute radiance, not against 1.0.
renderer.toneMappingExposure = 0.34;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// The scene never moves, and recomposing its matrix every frame reports that it
// did, which forces a full matrix recompute all the way down.
scene.matrixAutoUpdate = false;
const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.12, 1400);

/* ----------------------------------------------------------------- build */

const sky = buildSky(renderer, scene);
const clouds = buildClouds();
scene.add(clouds.mesh);
const weather = buildWeather();
scene.add(weather.rain);
const world = buildWorld();
scene.add(world.group);

const { rig } = buildMara();
scene.add(rig.root);

const input = new Input(renderer.domElement);
const controller = new Controller(input, world.colliders, world.waterHeight);
const vehicle = new VehicleController(input, world.colliders);
const boat = new BoatController(input, world.waterHeight);
const animator = new MaraAnimator(rig);
const chase = new ThirdPersonCamera(camera, input, world.colliders);
const audio = new Audio();

// Footsteps come from the animator, so they land on the frame the foot plants.
animator.onFootPlant = () => {
  const effort = THREE.MathUtils.clamp(controller.speed / GAIT.runSpeed, 0, 1);
  audio.step(controller.position, effort);
};

rig.root.position.copy(controller.position);
rig.root.rotation.y = controller.yaw;
chase.setRig(ON_FOOT);
chase.reset(controller.position, SPAWN.yaw);

/* --------------------------------------------------------------- weapons */

// Recoil goes to the camera, not to the arm: kicking the look angles moves the
// crosshair, which is the thing the player is actually aiming with. Kicking
// only the gun would look right and shoot identically, which is worse.
const arsenal = new Arsenal(rig, world.colliders, {
  onRecoil: (pitch, yaw) => chase.kick(pitch, yaw),
  onShot: (spec, muzzle) => audio.shot(muzzle, spec.twoHanded ? 150 : 200, 0.85),
  onHit: (kind, point) => {
    if (kind !== 'sky') audio.bulletImpact(kind, point);
  },
  onPersonHit: (index, zone, dir, point) =>
    world.shootPerson(index, zone, dir.x, dir.z, point.y),
  onDryFire: () => audio.dryFire(),
  onReload: (spec) => audio.reload(spec.reloadTime),
});
scene.add(arsenal.fx.group);

// Both weapons to start with. When the gun shops land, this becomes whatever
// the player has actually bought — `give` is the only way in either way.
arsenal.give('pistol');
arsenal.give('smg');

const wheel = new WeaponWheel(
  document.getElementById('wheel')!,
  document.getElementById('wheelCanvas') as HTMLCanvasElement,
  {
    has: (id) => arsenal.has(id),
    ammoOf: (id) => arsenal.ammoOf(id),
    current: () => arsenal.current,
  },
);

/** Re-drawn on getting out of a car, so the gun survives a drive. */
let stowed: WeaponId | null = null;

// Car-to-car contact. Parked cars are in the shared collider set; moving
// traffic is not, for the reasons in `world/traffic.ts`.
vehicle.traffic = world.trafficBodies;

const post = buildPost(renderer, scene, camera);
post.setSize(innerWidth, innerHeight, Math.min(devicePixelRatio, 1.75));

/* ------------------------------------------------------------ time of day */

// One place where the time of day reaches the rest of the renderer. The sky
// owns the keyframes; everything downstream — exposure, bloom, the grade, the
// clouds and every artificial light in the world — is driven from them here,
// so there is no second copy of the schedule to keep in sync.
const WHITE = new THREE.Color(0xffffff);
const cloudLit = new THREE.Color();
const cloudBase = new THREE.Color();
const gradeGain = new THREE.Vector3();
const DAY_GAIN = new THREE.Vector3(1.045, 1.005, 0.955);
const NIGHT_GAIN = new THREE.Vector3(0.94, 0.985, 1.09);

// Weather bends the time-of-day state before anything reads it, so cloud cover,
// haze and lightning reach the sun, the fog, the exposure and the bloom without
// any of those knowing weather exists.
sky.modifier = (s) => weather.modify(s);

sky.onState = (s) => {
  renderer.toneMappingExposure = s.exposure;
  post.setBloom(s.bloomThreshold, s.bloomStrength);
  // Push saturation up after dark: neon against a near-black street is the
  // whole look, and ACES desaturates bright sources hard.
  post.setGrade(1.12 + s.night * 0.26, gradeGain.copy(DAY_GAIN).lerp(NIGHT_GAIN, s.night));
  world.setNight(s.night);

  // Clouds take the sun's colour where the light hits and the sky's colour in
  // shadow, both scaled into the same radiance range the dome uses.
  cloudLit.copy(s.sunColour).lerp(WHITE, 0.3).multiplyScalar(s.intensity * 1.15 * (1 - 0.6 * s.night));
  cloudBase.copy(s.mid).lerp(s.horizon, 0.35).multiplyScalar(s.intensity * 0.8 * (1 - 0.4 * s.night));
  // Under heavy cover the deck has to sit *darker* than the sky behind it, or
  // it disappears into the grey the weather has already painted the dome.
  const heavy = 1 - weather.state.cover * 0.42 - weather.state.rain * 0.12;
  cloudLit.multiplyScalar(heavy);
  cloudBase.multiplyScalar(heavy * 0.9);
  clouds.setLight(sky.sunDir, cloudLit, cloudBase, 0.9 - s.night * 0.3);
  clouds.setCover(weather.state.cover);
  clouds.setWind(1.2 + weather.state.wind * 14);
  world.setWet(weather.state.rain);
};

weather.onThunder = (distance) => audio.thunder(distance);

addEventListener('keydown', (e) => {
  if (e.repeat) return;
  // Comma and period scrub an hour at a time; T freezes the clock, which is
  // what you want when lining up a shot.
  if (e.code === 'Comma') sky.setHour(sky.hour - 1);
  else if (e.code === 'Period') sky.setHour(sky.hour + 1);
  else if (e.code === 'KeyT') sky.running = !sky.running;
  // K steps through the weather fronts; J hands control back to the simulation.
  else if (e.code === 'KeyK') weather.cycle();
  else if (e.code === 'KeyJ') weather.resume();
});

function clockText(): string {
  const h = Math.floor(sky.hour);
  const m = Math.floor((sky.hour - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ HUD */

const statsEl = document.getElementById('stats')!;
const locationEl = document.getElementById('location')!;
const startEl = document.getElementById('start')!;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const loadingEl = document.getElementById('loading')!;
const promptEl = document.getElementById('prompt')!;
const promptText = document.getElementById('promptText')!;
const speedoEl = document.getElementById('speedo')!;
const speedoKph = speedoEl.querySelector('.kph') as HTMLElement;
const reticleEl = document.getElementById('reticle')!;
const reticle = {
  top: document.getElementById('rT') as HTMLElement,
  bottom: document.getElementById('rB') as HTMLElement,
  left: document.getElementById('rL') as HTMLElement,
  right: document.getElementById('rR') as HTMLElement,
};
const ammoEl = document.getElementById('ammo')!;
const ammoMag = document.getElementById('ammoMag') as HTMLElement;
const ammoReserve = document.getElementById('ammoReserve') as HTMLElement;
const ammoName = document.getElementById('ammoName') as HTMLElement;

/* ------------------------------------------------------------ game state */

type Mode = 'onFoot' | 'driving' | 'boating';
let mode: Mode = 'onFoot';
let started = false;
/** True while the map is up; the simulation is frozen. */
let paused = false;
let mapOpenedAt = 0;

/** How close Mara has to be to a car door to get in. */
const ENTER_RANGE = 3.6;
/** Boats are bigger, so you can board from further out. */
const BOARD_RANGE = 6.5;
/** She won't step out of a car moving faster than this. */
const EXIT_SPEED = 3.5;

const mapUI = new MapOverlay(
  document.getElementById('map')!,
  document.getElementById('mapCanvas') as HTMLCanvasElement,
  {
    footprints: world.footprints,
    drivables: world.drivables,
    boats: world.boats,
    crowd: () => world.crowdPositions(),
    player: () =>
      mode === 'driving'
        ? { pos: vehicle.position, yaw: vehicle.yaw, driving: true }
        : mode === 'boating'
          ? { pos: boat.position, yaw: boat.yaw, driving: true }
          : { pos: controller.position, yaw: controller.yaw, driving: false },
  },
);

/* ----------------------------------------------------------- map control */

function tryLock(): void {
  const result = renderer.domElement.requestPointerLock() as unknown;
  // Chrome rejects for ~1s after a user-initiated Esc; the click handler on the
  // canvas is the fallback, so swallowing the rejection is fine.
  if (result && typeof (result as Promise<void>).catch === 'function') {
    (result as Promise<void>).catch(() => {});
  }
}

function openMap(): void {
  if (!started || paused) return;
  paused = true;
  mapOpenedAt = performance.now();
  mapUI.show();
  if (document.pointerLockElement) document.exitPointerLock();
}

function closeMap(): void {
  if (!paused) return;
  paused = false;
  mapUI.hide();
  // Throw away the time spent paused so nothing jumps on resume.
  clock.getDelta();
  input.clearBuffers();
  tryLock();
}

// Escape while pointer-locked is swallowed by the browser to release the
// cursor, so the lock change — not the keystroke — is what opens the map.
document.addEventListener('pointerlockchange', () => {
  if (started && !document.pointerLockElement && !paused) openMap();
});

addEventListener('keydown', (e) => {
  if (e.code !== 'Escape' && e.code !== 'KeyM') return;
  if (paused) {
    // Ignore the keystroke that opened the map in the first place.
    if (performance.now() - mapOpenedAt < 300) return;
    closeMap();
  } else {
    openMap();
  }
});

document.getElementById('mapClose')!.addEventListener('click', closeMap);

const muteBtn = document.getElementById('mapMute') as HTMLButtonElement;

function refreshMute(): void {
  muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on';
}

function toggleMute(): void {
  audio.toggleMute();
  refreshMute();
}

muteBtn.addEventListener('click', toggleMute);
addEventListener('keydown', (e) => {
  // N, not M: M already opens the map.
  if (e.code === 'KeyN' && !e.repeat) toggleMute();
});

/* --------------------------------------------------------- vehicle entry */

function nearestCar(): Drivable | null {
  let best: Drivable | null = null;
  let bestDist = ENTER_RANGE * ENTER_RANGE;
  for (const d of world.drivables) {
    if (d.occupied) continue;
    const dist = d.position.distanceToSquared(controller.position);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  return best;
}

function nearestBoat(): Boat | null {
  let best: Boat | null = null;
  let bestDist = BOARD_RANGE * BOARD_RANGE;
  for (const b of world.boats) {
    if (b.occupied) continue;
    const dist = b.position.distanceToSquared(controller.position);
    if (dist < bestDist) {
      bestDist = dist;
      best = b;
    }
  }
  return best;
}

/** Put the gun away for a drive, remembering what was drawn. */
function stow(): void {
  stowed = arsenal.current;
  arsenal.holster();
  chase.setAim(false);
  controller.faceYaw = null;
  wheel.closeWheel();
}

/** And draw it again on the pavement. */
function redraw(): void {
  if (stowed) arsenal.equip(stowed);
  stowed = null;
}

function enterBoat(b: Boat): void {
  audio.enterBoat();
  stow();
  boat.enter(b);
  mode = 'boating';
  rig.root.visible = false;
  chase.setRig(inBoat(b.build.halfLength), boat.position);
  chase.reset(boat.position, boat.yaw);
  speedoEl.classList.add('show');
}

function exitBoat(): void {
  audio.exitBoat();
  audio.splash(0.9);
  boat.dismountPoint(dismount);
  const yaw = boat.yaw;
  boat.exit();

  controller.teleport(dismount, yaw);
  mode = 'onFoot';
  rig.root.visible = true;
  rig.root.position.copy(controller.position);
  chase.setRig(ON_FOOT, controller.position);
  chase.setAutoAlign(null);
  speedoEl.classList.remove('show');
  redraw();
  input.clearBuffers();
}

function enterCar(car: Drivable): void {
  audio.enterCar();
  stow();
  // Carjacking: whoever was driving gets hauled out on the driver's side and
  // runs. `onTaken` is how the traffic system learns to stop steering it.
  car.onTaken?.();
  if (car.hasDriver) {
    car.hasDriver = false;
    const right = new THREE.Vector3(Math.cos(car.yaw), 0, -Math.sin(car.yaw));
    world.ejectDriver(
      car.position.x - right.x * 1.7,
      car.position.z - right.z * 1.7,
      car.yaw,
    );
  }
  vehicle.enter(car);
  mode = 'driving';
  rig.root.visible = false;
  chase.setRig(IN_CAR, vehicle.position);
  chase.reset(vehicle.position, vehicle.yaw);
  speedoEl.classList.add('show');
}

const dismount = new THREE.Vector3();

function exitCar(): void {
  audio.exitCar();
  vehicle.dismountPoint(dismount);
  const yaw = vehicle.yaw;
  vehicle.exit();

  controller.teleport(dismount, yaw);
  mode = 'onFoot';
  rig.root.visible = true;
  rig.root.position.copy(controller.position);
  rig.root.rotation.y = controller.yaw;

  chase.setRig(ON_FOOT, controller.position);
  chase.setAutoAlign(null);
  speedoEl.classList.remove('show');
  redraw();
  // Space is the handbrake in a car; don't let a held press become a jump.
  input.clearBuffers();
}

/* ---------------------------------------------------------------- resize */

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  const dpr = Math.min(devicePixelRatio, 1.75);
  renderer.setPixelRatio(dpr);
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(innerWidth, innerHeight, dpr);
  mapUI.resize();
  wheel.resize();
});

renderer.domElement.addEventListener('click', () => {
  if (!input.locked && started && !paused) tryLock();
});

/* ----------------------------------------------------------------- debug */

(globalThis as Record<string, unknown>).SOLARA = {
  THREE,
  renderer,
  scene,
  camera,
  sky,
  clouds,
  weather,
  world,
  rig,
  controller,
  vehicle,
  boat,
  chase,
  post,
  mapUI,
  audio,
  arsenal,
  wheel,
  aimPose: AIM_POSE,
  reactions: REACTIONS,
  // Under automation pointer lock is never really held, so `Input` ignores
  // every mouse event. Driving the weapons from a script means forcing this.
  input,
  insideBody,
  getMode: () => mode,
  enterNearestCar: () => {
    const c = nearestCar();
    if (c) enterCar(c);
    return !!c;
  },
};

/* ------------------------------------------------------------------ loop */

/**
 * How far to tip the rig root over during a knockdown.
 *
 * Pitched flat almost at once, held there, then brought upright over the last
 * quarter as she gets up. Zero whenever she is on her feet, so the ordinary
 * walk is never touched.
 */
function knockPitch(t: number, knocked: number): number {
  if (knocked <= 0) return 0;
  const down = t < 0.18 ? t / 0.18 : t > 0.72 ? Math.max(0, 1 - (t - 0.72) / 0.28) : 1;
  return -(Math.PI / 2) * 0.82 * down;
}

const cameraRight = new THREE.Vector3();
const aimDir = new THREE.Vector3();
/** Scratch footprint for the player's car, reused every frame. */
const runOver = {
  position: new THREE.Vector3(),
  yaw: 0,
  halfLength: 2.4,
  halfWidth: 0.95,
  speed: 0,
  taken: false,
};
const shadowVolume = new THREE.Frustum();

/**
 * Crosshair and ammo.
 *
 * The reticle gap is driven from the same `spreadNow` the bullets are, rather
 * than from an animation: a crosshair that does not match the cone it is
 * standing in front of is worse than no crosshair at all.
 */
function updateWeaponHud(aiming: boolean): void {
  const spec = arsenal.spec;
  if (!spec) {
    reticleEl.classList.remove('show');
    ammoEl.classList.remove('show');
    return;
  }
  reticleEl.classList.add('show');
  ammoEl.classList.add('show');

  const gap = 4 + arsenal.spread01(aiming, controller.speed) * 24;
  reticle.top.style.top = `${-(gap + 9)}px`;
  reticle.bottom.style.top = `${gap}px`;
  reticle.left.style.left = `${-(gap + 9)}px`;
  reticle.right.style.left = `${gap}px`;

  const { mag, reserve } = arsenal.ammoOf(spec.id);
  ammoMag.textContent = String(mag);
  ammoMag.classList.toggle('empty', mag === 0);
  ammoReserve.textContent = `/ ${reserve}`;
  ammoName.textContent = arsenal.isReloading ? 'Reloading' : spec.name;
  ammoName.classList.toggle('reloading', arsenal.isReloading);
}
const clock = new THREE.Clock();
let fpsAccum = 0;
let fpsFrames = 0;

function frame(): void {
  requestAnimationFrame(frame);

  // Clamped so an alt-tab doesn't teleport her across the block.
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  if (paused) {
    // The world is frozen; just keep the map current and re-present the frame.
    mapUI.draw();
    post.composer.render();
    return;
  }

  const focus =
    mode === 'driving'
      ? vehicle.position
      : mode === 'boating'
        ? boat.position
        : controller.position;

  if (started) {
    if (input.takeInteract()) {
      if (mode === 'driving') {
        if (Math.abs(vehicle.speed) < EXIT_SPEED) exitCar();
      } else if (mode === 'boating') {
        if (Math.abs(boat.speed) < EXIT_SPEED) exitBoat();
      } else {
        // In the water, a boat is the only thing worth reaching for.
        const b = nearestBoat();
        const car = controller.swimming || controller.depth > 0.4 ? null : nearestCar();
        if (b && (!car || b.position.distanceToSquared(controller.position) <
            car.position.distanceToSquared(controller.position))) {
          enterBoat(b);
        } else if (car) {
          enterCar(car);
        }
      }
    }

    // Driving through people. The car's own footprint, tested against the crowd
    // — they are not in the collider set, so nothing here stops the car.
    if (mode === 'driving' && vehicle.car) {
      const spec = vehicle.car.build.spec;
      runOver.position = vehicle.position;
      runOver.yaw = vehicle.yaw;
      runOver.halfLength = spec.length * 0.5;
      runOver.halfWidth = spec.width * 0.5;
      const kph = Math.abs(vehicle.speed);
      if (kph > 1.5) {
        const dirX = Math.sin(vehicle.yaw) * Math.sign(vehicle.speed);
        const dirZ = Math.cos(vehicle.yaw) * Math.sign(vehicle.speed);
        const people = world.people;
        for (let i = 0; i < people.length; i++) {
          const p = people[i];
          if (p.dead) continue;
          if (Math.abs(p.position.x - vehicle.position.x) > 4) continue;
          if (Math.abs(p.position.z - vehicle.position.z) > 4) continue;
          if (!insideBody(runOver, p.position.x, p.position.z, 0.3)) continue;
          if (world.runOverPerson(i, kph, dirX, dirZ)) {
            audio.impact(Math.min(1, kph / 16));
            // A body costs the car a little, but nothing like a wall.
            vehicle.scrubOnImpact(0.93);
          }
        }
      }
    }

    if (mode === 'boating') {
      boat.update(dt);
      chase.setAutoAlign(boat.yaw, Math.min(1.8, Math.abs(boat.speed) * 0.2));
      chase.update(dt, boat.position, Math.abs(boat.speed), boat.topSpeed);
      speedoKph.textContent = String(Math.round(boat.kph));
    } else if (mode === 'driving') {
      vehicle.update(dt);
      // Let the view settle behind the car, but only once actually moving.
      chase.setAutoAlign(vehicle.yaw, Math.min(2.2, Math.abs(vehicle.speed) * 0.22));
      chase.update(dt, vehicle.position, Math.abs(vehicle.speed), 34);
      speedoKph.textContent = String(Math.round(vehicle.kph));
    } else {
      /* -------------------------------------------------------- weapons */

      // The wheel eats the frame's pointer delta before the camera can. Both
      // read the same buffer and `takeMouse` clears it, so draining it here is
      // what stops the view swinging around while a weapon is being picked.
      if (input.wheel && !arsenal.isReloading) {
        if (!wheel.isOpen) wheel.openWheel();
        const m = input.takeMouse();
        wheel.moveCursor(m.x, m.y);
      } else if (wheel.isOpen) {
        // Releasing Tab commits whatever the cursor was pointing at.
        arsenal.equip(wheel.selection);
        wheel.closeWheel();
      }

      const spec = arsenal.spec;
      // No aiming with empty hands, and none while the wheel is up.
      const aiming = !!spec && input.aiming && !wheel.isOpen;
      // Raising the sights sets the street off. Re-armed every frame it is
      // held, so the panic outlives the aim rather than tracking it.
      if (aiming) world.panic.alarm(controller.position);
      chase.setAim(aiming, spec ? spec.adsFov : 40);
      // Hold the camera's heading and strafe around it while aiming.
      controller.faceYaw = aiming ? chase.yaw : null;

      // Run over on foot. Only cars close enough to matter are tested; the
      // player is one point, so this is a handful of rectangle tests a frame.
      if (controller.knocked <= 0) {
        for (const b of world.trafficBodies) {
          if (b.taken || b.speed < 2) continue;
          if (Math.abs(b.position.x - controller.position.x) > 6) continue;
          if (Math.abs(b.position.z - controller.position.z) > 6) continue;
          if (!insideBody(b, controller.position.x, controller.position.z, 0.3)) continue;
          const s = Math.sign(b.speed) || 1;
          controller.knock(Math.sin(b.yaw) * s, Math.cos(b.yaw) * s, Math.abs(b.speed));
          audio.impact(Math.min(1, Math.abs(b.speed) / 14));
          break;
        }
      }

      controller.update(dt, chase.yaw);

      rig.root.position.copy(controller.position);
      rig.root.rotation.y = controller.yaw;
      // The animator owns the joints; which way up she is lying is the caller's
      // job, the same split the crowd's collapse uses.
      rig.root.rotation.x = knockPitch(controller.knockT, controller.knocked);

      animator.update(dt, {
        speed: controller.speed,
        distance: controller.distance,
        turnRate: controller.turnRate,
        groundY: groundHeight(controller.position.x, controller.position.z),
        grounded: controller.grounded,
        vy: controller.vy,
        justLanded: controller.justLanded,
        swimming: controller.swimming,
        depth: controller.depth,
        // Carry the gun as soon as it is drawn; raise it to the eye on aim.
        aim: spec ? 0.34 + chase.aim01 * 0.66 : 0,
        aimPitch: chase.pitch,
        twoHanded: spec ? spec.twoHanded : false,
        reload: arsenal.reloadProgress,
        knocked: controller.knocked > 0 ? controller.knockT : 0,
      });

      chase.update(dt, controller.position, controller.speed, GAIT.runSpeed);

      // After the camera has settled, so the round goes where the crosshair is
      // *this* frame rather than where it was last frame.
      if (spec && !wheel.isOpen) {
        camera.getWorldDirection(aimDir);
        arsenal.update(dt, {
          aiming,
          firing: input.firing,
          fireEdge: input.takeFire(),
          reload: input.takeReload(),
          eye: camera.position,
          look: aimDir,
          speed: controller.speed,
          targets: { people: world.people, vehicles: world.targets },
        });
      } else {
        // Still tick the effects: tracers and puffs have to finish fading even
        // with the gun put away.
        arsenal.fx.update(dt);
        input.takeFire();
        input.takeReload();
      }
      updateWeaponHud(aiming);

      if (controller.justJumped) audio.jump();
      if (controller.justLanded) {
        audio.land(controller.position, THREE.MathUtils.clamp(-controller.vy / 6 + 0.5, 0.3, 1));
      }
    }

    if (mode !== 'onFoot') {
      arsenal.fx.update(dt);
      reticleEl.classList.remove('show');
      ammoEl.classList.remove('show');
    }

    if (mode === 'driving' && vehicle.impact > 0.05) audio.impact(vehicle.impact);
    if (mode === 'boating' && boat.slam > 0.05) audio.hullSlap(boat.slam);

    audio.update(dt, {
      mode,
      listener: camera.position,
      right: cameraRight.setFromMatrixColumn(camera.matrixWorld, 0),
      subject: focus,
      speed:
        mode === 'driving'
          ? Math.abs(vehicle.speed)
          : mode === 'boating'
            ? Math.abs(boat.speed)
            : controller.speed,
      crowd: world.crowdPositions(),
      swimming: controller.swimming && mode === 'onFoot',
      depth: waterDepth(focus.x, focus.z),
      rain: weather.state.rain,
      gust: weather.state.wind,
      throttle: input.driveAxis().y,
      handbrake: vehicle.handbrake,
      slip: vehicle.slip,
      boatTopSpeed: boat.topSpeed,
    });

    updatePrompt();
  }

  wheel.update(dt);
  world.update(t, dt, focus);
  weather.update(dt, camera.position);
  sky.update(dt, camera.position);
  clouds.update(dt);
  sky.followShadow(focus);
  // Last thing before the render: the camera has settled and every agent has
  // moved, so this is the only point at which both frusta are true for the
  // frame about to be drawn.
  world.cull(camera, sky.shadowVolume(shadowVolume));
  post.update(dt);
  renderer.shadowMap.needsUpdate = true;
  post.composer.render();

  fpsAccum += dt;
  fpsFrames++;
  if (fpsAccum >= 0.5) {
    const fps = Math.round(fpsFrames / fpsAccum);
    fpsAccum = 0;
    fpsFrames = 0;
    statsEl.textContent =
      `${fps} fps\n` +
      `${(mode === 'driving'
        ? Math.abs(vehicle.speed)
        : mode === 'boating'
          ? Math.abs(boat.speed)
          : controller.speed
      ).toFixed(1)} m/s\n` +
      `x ${focus.x.toFixed(1)}  z ${focus.z.toFixed(1)}\n` +
      `${clockText()}  ${weather.describe()}`;
  }
}

function updatePrompt(): void {
  let show = false;
  if (mode === 'driving') {
    show = Math.abs(vehicle.speed) < EXIT_SPEED;
    promptText.textContent = 'Exit vehicle';
  } else if (mode === 'boating') {
    show = Math.abs(boat.speed) < EXIT_SPEED;
    promptText.textContent = 'Leave boat';
  } else {
    const b = nearestBoat();
    if (b) {
      show = true;
      promptText.textContent = 'Board boat';
    } else if (!controller.swimming && controller.depth < 0.4 && nearestCar()) {
      show = true;
      promptText.textContent = 'Enter vehicle';
    }
  }
  promptEl.classList.toggle('show', show);
}

/* ---------------------------------------------------------------- start */

// One warm-up render compiles every shader so the first frame of play is smooth.
renderer.compile(scene, camera);
post.composer.render();

playBtn.disabled = false;
loadingEl.textContent = 'Enter Solara';

playBtn.addEventListener('click', () => {
  // Browsers only allow an AudioContext to start from a user gesture.
  audio.unlock();
  refreshMute();
  started = true;
  startEl.classList.add('hide');
  locationEl.classList.add('show');
  setTimeout(() => locationEl.classList.remove('show'), 6000);
  tryLock();
  clock.getDelta();
});

frame();

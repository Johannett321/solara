# Contributing to Solara

Thanks for taking a look. This is a graphics prototype, so the contribution
loop is a little different from a normal web project: there is no test suite to
tell you whether a change is right, and the thing you are changing is usually
something you can only judge by looking at it.

## Setup

```bash
git clone https://github.com/johannett321/solara.git
cd solara
npm install
npm run dev          # http://127.0.0.1:5173
```

Node 20+ and a WebGL2 browser. That is the whole toolchain — no backend, no
database, no environment variables, no accounts.

## The one automated gate

```bash
npx tsc --noEmit
```

There is no test framework and no linter. TypeScript is the only check that runs
by itself, and it is strict: `strict`, `noUnusedLocals` and `noUnusedParameters`
are all on, so an unused import or parameter fails the build. `npm run build`
runs the typecheck first and then bundles, so a green build means both passed.

Please make sure `npx tsc --noEmit` is clean before opening a pull request.

## Verifying a visual change

**Typechecking will not catch the bugs this project actually has.** Almost every
regression here has been visual: an inverted winding order, a material that
stopped being shared, a shader that went black on one driver. So look at the
change in the running game.

`window.SOLARA` is exposed from `main.ts` for exactly this, and gives you
`{ THREE, renderer, scene, camera, sky, clouds, weather, world, rig, controller,
vehicle, boat, chase, post, mapUI, audio, getMode(), enterNearestCar() }`.

**The scene is never in the same state twice** — a day/night cycle and a weather
simulation are both running. Pin them both before comparing two screenshots, or
you will attribute a lighting change to your own edit. Teleport and frame the
shot rather than walking there:

```js
const L = window.SOLARA;
L.sky.running = false;          // freeze the clock (or press T)
L.sky.setHour(13);              // 0..24; 19.15 is sunset, 21.5 is night
L.weather.set({ cover: 0.35, rain: 0, haze: 0.15, wind: 0.3, storm: 0 });
L.controller.teleport(new L.THREE.Vector3(-42, 0, 20), -Math.PI / 2);
L.chase.yaw = -Math.PI / 2; L.chase.pitch = 0.4; L.chase.distance = 20;
```

`weather.set()` also stops the weather drifting; `weather.resume()` hands it
back. Note that `chase.pitch` is **positive looking down** — to frame the sky or
the clouds you want a negative pitch. Leave a couple of seconds after changing
the hour or the weather before you judge the result: cloud cover, lit windows and
the environment probe all ease in rather than snapping.

When something "looks washed out / too dark / wrong colour", **measure pixels
from the screenshot before theorising**. Several long debugging detours here were
caused by guessing at bloom, fog and light balance when the culprit was
elsewhere — and by not noticing the clock had moved.

<details>
<summary>Automating this with a headless browser</summary>

If you drive the game from Playwright or similar, two things will waste your
time first:

- **Wait for `#play` to be enabled before clicking it.** It is disabled while
  the world builds. Clicking early silently does nothing, which leaves the game
  unstarted: the frame loop still renders, so screenshots look plausible, but
  nothing ever updates and nothing moves.
- **Stub out `Element.prototype.requestPointerLock`.** The frame loop re-requests
  pointer lock every frame; losing it fires `pointerlockchange`, which opens the
  map and pauses the game. Under automation the lock is never really held, so the
  game otherwise sits paused forever.

</details>

## Conventions that have caused repeat bugs

These are the ones that have actually broken things more than once. There is a
longer list in [`CLAUDE.md`](CLAUDE.md).

- **Headings** are `forward = (sin yaw, cos yaw)` for Mara, cars and boats.
- **Car meshes** point along local `+X`, so a car's `rotation.y` is always
  `heading - PI/2`. Boat hulls are built pointing `+Z`, so boats use
  `rotation.y = yaw` directly. Getting this wrong has broken parked cars, AI
  traffic and the hotel awnings, once each.
- **Camera `yaw`** is the direction the camera *looks*; the rig sits opposite it.
- **Grid winding**: hand-written grids invert their winding whenever a coordinate
  runs backwards. This bit five times (beach, ocean, park, wet sand, river) with
  wildly different symptoms — blown-out white, invisible, backface-culled. Do not
  reason it out; call `ensureUpward(geo)` from `util/bake.ts` on any generated
  ground or water surface.
- **`terrainHeight` vs `groundHeight`**: `groundHeight` returns a bridge deck
  when one is overhead. Anything that *builds* ground must use `terrainHeight`,
  or the terrain rises to deck height under every bridge.
- **World bounds live only in `world/index.ts`.** Per-module fences once produced
  an invisible wall across the whole city.
- **Never raise anything to a uniform power in a shader.** `pow(x, uSomeUniform)`
  renders black on some drivers while the identical `pow(x, 9.0)` is fine.
- **`smoothstep(edge0, edge1, x)` with `edge0 > edge1` is undefined in GLSL.** A
  reversed pair once returned zero and hid every cloud in the sky. Reverse the
  interpolation, not the edges.

## Performance: share your materials

This is the easiest mistake in the project to make and the hardest to see.
`bakeStatic` buckets by material *identity*, so a `new THREE.MeshStandardMaterial(...)`
inside a per-building or per-prop function silently multiplies the draw count by
the number of instances, and the bake cannot merge any of it. Each site looks
harmless on its own — an audit once found 652 of 1067 materials were accidental
duplicates, including 325 identical browns for palm coconuts.

Every builder must cache and share its materials. `world/facades.ts` and
`world/citydress.ts` both keep a `Map`-backed `mat(key, ...)` helper for this;
follow that pattern. Check your work by grouping every material in the scene by
its parameters and counting distinct objects per group, rather than by reading
the builders.

Related: **anything that moves must stay out of the baked groups** — a wheel
merged into a car body cannot steer.

## Pull requests

- Keep the diff focused; this codebase is read a lot.
- Match the surrounding style. Comments here explain *why* something is the way
  it is, usually because the obvious alternative was tried and failed — that is
  the most valuable thing in the file, so please keep writing them that way.
- Say how you verified a visual change, and attach a screenshot if it changes
  what the game looks like.
- Confirm `npx tsc --noEmit` is clean.

## Reporting bugs

Please include your OS, browser and GPU, and — for anything visual — a
screenshot plus the in-game clock and weather readout from the top-right debug
overlay. Rendering bugs here have repeatedly turned out to be driver-specific.

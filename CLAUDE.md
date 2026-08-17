# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Vite dev server on http://127.0.0.1:5173
npm run build     # tsc --noEmit && vite build
npm run preview   # serve the production build
npx tsc --noEmit  # typecheck alone — the fastest correctness gate
```

There is no test framework and no linter. `tsc --noEmit` is the only automated
check; `strict`, `noUnusedLocals` and `noUnusedParameters` are all on, so unused
imports fail the build.

## Verifying changes

This is a real-time 3D game: most bugs are visual and typechecking will not catch
them. Drive the running game with `playwright-cli` (see the `playwright-cli`
skill) and read the screenshot back.

`window.SOLARA` is exposed in `main.ts` for exactly this — `{ THREE, renderer,
scene, camera, sky, clouds, weather, world, rig, controller, vehicle, boat,
chase, post, mapUI, audio, getMode(), enterNearestCar() }`.

**Two things will silently give you a dead world before any of this works.**
Both look like a working game in a screenshot, which is what makes them
expensive:

- **Wait for `#play` to be enabled before clicking it.** It is disabled
  ("Loading") until the world is built, and clicking it early does nothing, so
  `started` stays false. The frame loop still renders — screenshots look
  correct — but nothing updates: the crowd is frozen, traffic never moves, and
  the car you "drive" sits at 0 km/h.
- **Stub `Element.prototype.requestPointerLock` to a no-op.** `main.ts`
  re-requests pointer lock every frame; losing it fires `pointerlockchange`,
  which calls `openMap()` and sets `paused`. Under automation the lock is never
  really held, so the game sits paused forever — and `if (paused)` in `frame()`
  re-presents the composed frame without updating anything, so again the picture
  looks fine and nothing moves.

Check both by sampling `world.crowdPositions()[0]` twice a second apart: if it
does not change, the world is not running and every conclusion you draw from the
screenshot is about a frozen scene.

**The scene is never in the same state twice: a day/night cycle and a weather
simulation are both running.** Pin them both before comparing two screenshots,
or you will attribute a lighting change to your own edit. Teleport and frame the
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
back. Note `chase.pitch` is **positive looking down** — to frame the sky or the
clouds you want a negative pitch.

Leave a couple of seconds after changing either before screenshotting: cloud
cover, lit windows and the environment probe all ease in rather than snapping.

When something "looks washed out / too dark / wrong colour", **measure pixels
from the screenshot before theorising**. Several long debugging detours here were
caused by guessing at bloom, fog and light balance when the actual culprit was
elsewhere — and by not noticing the clock had moved.

## Architecture

### Everything is generated at runtime

There are no model, texture or audio files anywhere. Geometry is built from
primitives and two custom helpers, and every surface map (colour, normal,
roughness) is drawn to a 2D canvas at startup from fBm noise. Adding an asset
means writing a builder function, not importing a file.

- `util/loft.ts` — surfaces through stacked elliptical cross-sections. This is
  the workhorse: Mara's limbs and torso, boat hulls, shoes, hair.
- `render/textures.ts` — `fbm()` plus sobel-derived normal maps. Texture
  generators are **neutral/greyscale**; colour comes from `material.color` so one
  canvas serves every tint. Materials are cached by colour in each builder.
  Generating a texture per colour variant is the main way to accidentally add
  seconds of load time.

### `world/layout.ts` is the single source of truth

The street grid (`AVENUES`, `CROSS_STREETS`), the beachfront dimensions *and*
the cross-shore terrain profile all live here.

The grid is **data**: road surfaces, kerbs, block filling, `isRoadway`, traffic
lanes, pedestrian lanes and the map overlay all read the same arrays. Adding an
avenue there puts cars and people on it automatically — a street cannot exist
visually without also existing physically. Three
independent consumers read the same functions, which is why the beach mesh, the
player's footing and the surf line can never disagree:

- `shoreHeight(x)` — the cross-shore curve, mirrored **verbatim** as the
  `PROFILE_GLSL` string that gets injected into the ocean shader. Edit one and
  you must edit the other.
- `groundHeight(x, z)` — what anything standing on the ground must use. On sand
  it is `shoreHeight` **plus `sandRipple`**; using `shoreHeight` directly makes
  props sink.
- Because the shore runs dead straight along Z, water depth is a function of
  world `x` alone. That is what lets `render/water.ts` compute its own depth for
  colour and foam with no depth prepass. Curving the coastline breaks that trick.

### `world/facades.ts` is the street-level kit

Everything a building shows the pavement lives here: recessed shopfronts,
fascias, awnings, neon, blade signs, balconies, fire escapes and rooftop
clutter. `world/city.ts` composes them; it does not build them.

Two rules the module exists to enforce:

- **The ground floor must be set back from the wall above.** `retailFrontage`
  assumes the storey it sits on is inset (`inset` in `midRise`/`podium`), so its
  piers and fascia project forward to meet the upper wall line. A shopfront
  flush with the facade renders as a painted stripe — that is exactly why the
  city read as a plaster canyon before.
- **Text goes through an atlas, never a canvas per sign.** `signBoard(index,…)`
  and `bladeSign` draw every shop name in the city into one texture and remap
  each quad's UVs into a cell, so a thousand signs share one material and merge
  into a single draw call.

Emissive intensities here (~2–3.5) are picked to sit *below* the 5.5 bloom
threshold in `render/post.ts`: neon should read as saturated in daylight without
smearing the frame.

### Crowd level of detail

`RigOptions.detail: 'crowd'` halves loft resolution — but only where it is
actually threaded through. `util/loft.ts`'s `limb()` takes a `res` argument for
this, and the head skull and shoes branch on `hero`. Adding a rig part at fixed
resolution costs ~400 pedestrians' worth of geometry across the city: leaving
`limb()` unscaled alone was 7M triangles.

### Conventions that have caused repeat bugs

- **Headings** are `forward = (sin yaw, cos yaw)` for Mara, cars and boats.
- **Car meshes** point along local `+X`, so a car's `rotation.y` is always
  `heading - PI/2`. Boat hulls are built pointing `+Z`, so boats use
  `rotation.y = yaw` directly. Getting this wrong has broken parked cars, AI
  traffic and the hotel awnings, once each.
- **Camera `yaw`** is the direction the camera *looks*; the rig sits opposite it.
- **Grid winding**: hand-written grids invert their winding whenever a
  coordinate runs backwards. This bit five times (beach, ocean, park, wet sand,
  river) with wildly different symptoms. **Call `ensureUpward(geo)` from
  `util/bake.ts`** on any generated ground or water surface instead of
  reasoning about index order.
- **`terrainHeight` vs `groundHeight`**: `groundHeight` returns a bridge deck
  when one is overhead. Anything that *builds* ground must use `terrainHeight`,
  or the terrain rises to deck height under every bridge.
- **World bounds live only in `world/index.ts`.** Per-module fences caused an
  invisible wall across the whole city. Block-filling loops must walk the
  cross-street grid, or buildings land across the side streets and wall it off
  just as effectively.
- **Rig proportions** in `player/rig.ts` (`P`) are joint heights and must stay
  self-consistent: `hipY + hipJointY - thigh - shin === ankleY`. If they drift,
  the pelvis-IK pass in the animator fights the rest pose every frame.

### Time of day

`render/sky.ts` owns a keyframe table (`KEYS`) with one row per interesting
moment of the day. Everything downstream is interpolated from it and pushed out
through the single `sky.onState` callback wired in `main.ts`: sun/moon colour and
intensity, hemisphere light, `environmentIntensity`, fog, `toneMappingExposure`,
bloom threshold and strength, the colour grade, cloud lighting, and the `night`
factor. **There is no second copy of the schedule** — to change how a time of day
looks, edit its row, not the consumers.

- The sky is a hand-authored dome (three-band gradient + sun glow + a horizon
  band that hugs the sun's azimuth + stars + moon), not three's Preetham `Sky`.
- **The dome must write `gl_Position.z = gl_Position.w`.** At a real depth the
  GTAO pass treats it as geometry 1200 m away and occludes the whole sky to
  black.
- **Never raise anything to a uniform power in a shader here.**
  `pow(x, uSomeUniform)` renders black on this machine's driver while the
  identical `pow(x, 9.0)` is fine. The sun glow blends between successive
  squarings (`g2`, `g4`, `g8`…) instead, indexed by log2 of the exponent.
- The sun path (`SUNRISE`/`SUNSET`) has to agree with the keyframe hours. An
  18:00 sunset with a "sunset" row at 19:00 paints the sky orange an hour after
  the sun has gone.
- PMREM is rebuilt from the dome only once the hour has moved by 0.06, not every
  frame. Weather calls `sky.invalidateEnv()` when it needs one sooner.
- `render/clouds.ts` is shared by both systems: the time of day colours the puffs
  (lit side from the sun, shaded side from the sky) and the weather sets how many
  of them exist. They are real clusters of billboards at 190–430 m, not a
  backdrop — the old flat plane at y = 620 is what used to read as a hard "cut"
  across the sky.
- Keys: `,` and `.` scrub an hour, `T` freezes the clock. `SOLARA.sky.setHour()`
  for screenshots.

### Weather

`render/weather.ts` is **not** a list of weather types. Conditions are five
independent continuous scalars — `cover`, `rain`, `haze`, `wind`, `storm` — so
"light rain under broken cloud" and "still sea fog under a clear sky" are just
points in the same space. The named `FRONTS` are only *sampling regions* used to
pick plausible new targets; nothing downstream ever asks which one is active,
and a transition passes through every intermediate combination on the way.

It reaches the renderer through exactly two seams:

- `weather.modify(s)` is wired to `sky.modifier` and bends the interpolated
  `SkyState` — so cover, haze and lightning reach the sun, ambient, fog,
  exposure and bloom without any of those knowing weather exists. Add new
  weather effects here, not by reaching into the consumers.
- The rain mesh draws itself: instanced streaks in a box that follows the
  camera, stretched along the fall direction *in view space* so perspective
  still makes near drops bigger.

Traps hit while building it:

- **`smoothstep(edge0, edge1, x)` with `edge0 > edge1` is undefined in GLSL.**
  A reversed pair in the cloud cover ramp returned zero and hid every cloud in
  the sky. Reverse the interpolation, not the edges.
- Overcast cloud has to be drawn *darker* than the sky, because the same weather
  has already greyed the dome — matched greys make the deck invisible.
- Rain reads as density, not length. Long bright streaks look like scratches on
  the lens.

Keys: `K` steps through the fronts, `J` hands control back to the simulation.

### Night lighting

**Night is a materials problem, not a lights problem.** Hundreds of point lights
are out of the question, so `world.setNight(f)` scales `emissiveIntensity` on
*shared cached materials* — neon, sign atlases, shop interiors, lit-window
emissive maps, lamp heads, car lamps — plus an additive ground disc per street
lamp. The whole city switches with a few dozen scalar writes and no traversal.

Exposure and emissive levels are coupled: raising both at once blows the frame
to white. Night sits at exposure ~0.8 with neon around 4.8, not exposure 0.95
with neon at 12.

### Lighting is a coupled chain — change one, re-check all

Radiance here is authored, not physical, and every value is scaled against the
sky rather than against 1.0. All of these now come from the keyframe table
above rather than being constants:

- `toneMappingExposure` runs ~0.33 at midday and ~0.8 at night.
- `environmentIntensity` is deliberately low. The street is boxed in by buildings
  and tolerates ambient; the open beach sees the whole hemisphere and goes flat.
- Bloom runs **before** tone mapping, so its threshold is in pre-exposure linear
  space: 5.5 at midday, ~1.7 at night. A fixed daytime threshold means neon can
  never bloom after dark; a fixed night threshold smears the whole daytime frame.

### Draw-call baking

The world is authored as thousands of small readable meshes and then merged per
material by `util/bake.ts` before it ever renders (~8300 meshes down to a few
hundred). `bakeChunked` buckets by position so frustum culling still works.

City buildings carry a tiling facade texture with their wall colour in **vertex
colours**, so a whole district shares one material and merges into one draw
call per chunk. Only use the geometry-heavy `artDecoBlock` for buildings the
player walks right past. Static posed crowd members (sunbathers, diners) are
baked too — they never animate, so they are geometry, not agents.

**Every builder must share and cache its materials.** `bakeStatic` buckets by
material *identity*, so a `new THREE.MeshStandardMaterial(...)` inside a
per-building or per-prop function silently multiplies the draw count by the
number of instances. `world/facades.ts` and `world/citydress.ts` both keep a
`Map`-backed `mat(key, ...)` for this; a car's number plate was doing it wrong
and cost one draw call per parked car.

This is the easiest mistake in the project to make and the hardest to see: an
audit found 652 of 1067 materials were accidental duplicates — 325 identical
browns for palm coconuts, three per café table, one per road marking — none of
which the bake could merge. It is invisible by inspection because each site
looks like one harmless material. Check it by grouping every material in the
scene by its parameters and counting distinct objects per group, rather than by
reading the builders.

**The bake keeps geometry indexed.** Merging requires all inputs to agree on
indexed-ness, and agreeing the *other* way — flattening with `toNonIndexed` —
tripled the vertex data for the whole world, because these are nearly all three
primitives and those share vertices heavily (a `SphereGeometry(8, 6)` is 63
vertices for 84 triangles). Non-indexed cost 1.2 GB of buffers; indexed is 736 MB
for the same picture.

**Anything that moves must stay out of the baked groups.** Parked cars and boats
are baked individually via `bakeVehicle` / `bakeStatic` so they stay drivable —
a wheel merged into the body cannot steer. `buildCars` therefore returns *two*
groups: `group` (drivables, baked per vehicle) and `staticGroup` (kerbside
scenery, merged into the street by `world/index.ts`). It owns all kerbside
parking in the city, including the scenery cars — two modules placing cars on
the same kerb would park them inside each other. The bake preserves `position`,
`normal`, `uv` and `color`; dropping `color` renders vertex-coloured materials
(the beach umbrellas) black.

A *parked* car's wheels never turn, so `bakeVehicle(build, true)` gives it a
second, merged set of all four — twelve draws instead of twenty-four — and
`player/driving.ts` swaps the articulated pivots in on `enter` and back out on
`exit`. Only one car is ever being driven. Traffic rolls constantly and is built
without the parked form.

### Culling, and the two walks a frame costs

Rendering this world is **CPU-bound on draw submission and scene traversal**, not
on fill: quartering the framebuffer changes the frame time by under 5%. So the
only things that make it faster are fewer draw calls and fewer visited nodes —
resolution, shader cost and triangle count are nearly free by comparison. Measure
before assuming otherwise; the numbers are very lopsided.

The frame walks the scene graph twice per `renderer.render`, once to update
matrices and once to build the render list, and it renders the scene *twice*
(beauty, then GTAO's normal buffer). With 68000 nodes that was ~40% of the frame
before anything was drawn.

`world/culling.ts` switches whole subtrees off with one sphere test each —
per parked car, per pedestrian, per traffic car, per baked chunk — so three never
visits their contents. Three rules keep it from changing a pixel:

- The sphere must **enclose** the subtree. three still does the exact per-mesh
  test on whatever survives, so generous radii cost nothing.
- It tests the **sun's shadow volume as well as the view frustum**
  (`sky.shadowVolume`). Culling on the camera alone deletes the shadows of
  everything just out of frame.
- Crowd and traffic write their own range rule to `Cullable.near` instead of to
  `visible`, so there is only ever one writer.

**`matrixWorldAutoUpdate = false` does not do what it looks like it does.** three
skips the matrix multiply but still recurses into every child, so a frozen city
still costs the full walk. `prune`/`freezeMatrices` in `world/culling.ts` replace
`updateMatrixWorld` on the subtree root instead — that is what actually stops it,
and it took the walk from 13.3 ms to 0.9 ms. `main.ts` also sets
`scene.matrixAutoUpdate = false`: an object that recomposes its matrix reports
that it moved, which forces every descendant to recompute.

Chunk size is a real trade-off, not a free win. Draw calls per chunked group are
roughly *visible chunks × materials per chunk*, so bigger chunks mean fewer
draws and more off-screen geometry. Measured across 70–320 m it is worth about
3%, which does not pay for the coarser culling everywhere else.

### Audio

No audio files either — `audio/` synthesises everything from oscillators and
noise buffers. `audio/index.ts` is the only seam: `main.ts` calls `update()` once
a frame with world state and fires discrete events; nothing in `audio/` reaches
back into the game.

- The `AudioContext` starts suspended and is resumed from the "Enter Solara"
  button. Voices created before that are simply silent.
- Footsteps are fired from `MaraAnimator.onFootPlant`, which is set **only** on
  the player's animator — the whole crowd shares that class, and a hundred pairs
  of footsteps would be deafening.
- Mute is `N`, not `M`: `M` already opens the map.
- Levels were set against RMS measured from an analyser tap on the master bus,
  not by ear. Re-measure if you retune them.
- Two easy traps: an `AudioBufferSourceNode` that is never `start()`ed is silent,
  and one that is never `stop()`ed leaks a voice per one-shot.
- Weather feeds it too: `AudioFrame` carries `rain` and `gust`, and thunder is a
  one-shot scheduled *`distance / 343` seconds after the flash*. That delay is
  the whole effect — a clap that lands on the flash reads as an explosion.

### Player modes

`main.ts` holds a `Mode` state machine (`'onFoot' | 'driving' | 'boating'`) plus
a `paused` flag for the map. Each mode owns a controller — `player/controller.ts`
(which itself covers walking, wading and swimming), `player/driving.ts`,
`player/boating.ts` — and swaps the camera rig preset. `world/index.ts` exposes
`drivables`, `boats`, `footprints`, `crowdPositions()`, `waterHeight()`,
`setNight()` and `setWet()` as the seams between systems — the last two are how
the time of day and the weather reach the world's materials.

Keys beyond movement: `M`/`Esc` map, `N` mute, `,`/`.` scrub an hour, `T` freeze
the clock, `K` step the weather fronts, `J` hand the weather back to the
simulation.

All locomotion is procedural; there is not a single animation clip in the
project. `player/animator.ts` evaluates every joint angle per frame from a gait
phase that advances with **distance actually travelled**, which is why the feet
never skate.

### Post-processing

The chain is render → GTAO → bloom → grade → output → SMAA. Bloom, grade, output
and SMAA together are a couple of milliseconds; GTAO is the whole cost, because
it re-renders the scene into a normal buffer.

Three things keep that affordable, all in `render/post.ts`:

- **The AO pass gets its own near-sighted camera** (`AO_FAR`, 120 m). The AO
  radius is 0.55 m, so past that an occluder is a fraction of a pixel and three's
  own frustum cull can throw the rest away. Worth ~18% of the frame. The one
  visible consequence is a sub-pixel shading change on the single row of pixels
  where the sea meets the sky, which is where geometry crosses the far plane.
- **`GTAOPass._overrideVisibility` and `_restoreVisibility` are stubbed out.**
  They `scene.traverse` twice a frame purely to hide Points and Lines, of which
  this world has none — ~16 ms to protect nothing. If a Points or Line object is
  ever added, undo this.
- **The shadow map is driven by hand** (`shadowMap.autoUpdate = false`, with
  `needsUpdate` set once a frame in `main.ts`). Otherwise three rebuilds it at
  the top of *both* scene renders, and the second is identical to the first.

### Escape and pointer lock

The browser swallows the Escape keystroke when it uses it to release the cursor,
so the map is opened from the `pointerlockchange` event, not the keypress.
Chrome also blocks `requestPointerLock` for ~1s after a user-initiated Escape,
hence the click-anywhere fallback in `main.ts`.

## Known rough edges

Flat facades above the ground floor; no junction logic (AI traffic drives through
the signals); circle-based vehicle collision; no boat wake or boat-vs-boat
collision; beach NPCs are posed once and do not animate; kerbside cars in the
city are drivable only one in three (`DRIVABLE_EVERY` in `world/cars.ts`), the
rest are scenery merged into the street; rain has no splashes, puddles or
run-off, and only the city road and pavement materials go wet, so the beach and
the promenade stay dry-looking in a downpour; nobody takes shelter from it.

Frame rate is still bounded by draw calls — roughly 5000 in the beauty pass on
Ocean Drive, at ~5 µs each on this driver. The remaining big spenders are the
city chunks, the parked cars and the crowd, and none of them can be cut further
without a visible change: pedestrians are 40 loose meshes because every limb
moves independently (a SkinnedMesh would fix it), and distance culling anything
on the strip pops in plain sight.

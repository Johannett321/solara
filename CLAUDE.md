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

**Baking the textures out to files is not a load-time fix**, which is the first
thing everyone reaches for. Measured on the production build: 8.7 s to a
playable frame, of which `buildWorld` is 7.4 s and *all* texture generation is
0.18 s — 2%. The whole game is a 310 kB gzipped download against 167 MB of
generated texture memory, so shipping those as files trades a fifth of a second
of CPU for tens of megabytes over the wire. The load cost is geometry
construction, and it sits in the same three places as the frame cost: the crowd
(2.2 s), traffic (1.4 s) and cars (1.2 s). Generate less, or build them after
the player can move — don't move them to disk.

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
`limb()` unscaled alone was 7M triangles, and the hair and jewellery sat at
full resolution for a long time for exactly that reason — the hair mass alone
was 2154 of a pedestrian's 17924 triangles, more than the rest of her head.
**Any new rig part must go through `R()`,** in `buildMara` and `buildHead`
alike.

`RigOptions.skinned` then collapses the finished rig into one SkinnedMesh —
`player/skin.ts`. Every mesh in the rig is already rigid inside exactly one
joint, so binding its vertices to that joint with weight 1 is the same
transform chain moved onto the GPU: the pose is identical to the pixel, and 40
draw calls become one per material (about 11), twice over with the shadow pass.
Measured on Ocean Drive that was 33.5 ms to 27.6 ms — 30 fps to 36.

Three things about it are load-bearing:

- **The skeleton is captured at the rest pose**, because `Skeleton` reads each
  joint's inverse bind matrix from its current `matrixWorld`. This is why the
  posed sunbathers and diners are *not* skinned: `poseSeated` and friends run
  after `buildMara` returns, and a skeleton bound before them would hold the
  standing pose. They never animate, so the bake is the better answer anyway.
- **Geometry is baked into root-local space and the SkinnedMesh is parented to
  the root with an identity transform.** three recomputes `bindMatrixInverse`
  from `matrixWorld` every frame, so the root's own motion cancels and the
  agent can still be walked around the world by writing `root.position`.
- **The joints stay ordinary `THREE.Group`s.** `Skeleton` only ever reads
  `matrixWorld` off its bones, so nothing has to become a `THREE.Bone` and the
  animator, `MaraRig` and the crowd's posing code are untouched.

The skinned body sets `frustumCulled = false` on purpose: `world/culling.ts` is
the single writer of a pedestrian's visibility and already tests one enclosing
sphere against the view frustum and the sun's shadow volume. Handing three a
bounding sphere so it can re-test was measured at 5349 draws against 5321, and
slightly slower — and letting `SkinnedMesh.computeBoundingSphere` work it out
walks every vertex on the CPU.

### Conventions that have caused repeat bugs

- **Headings** are `forward = (sin yaw, cos yaw)` for Mara, cars and boats.
- **Car meshes point along local `-X`**, so a car's `rotation.y` is always
  `heading + PI/2`. Boat hulls are built pointing `+Z`, so boats use
  `rotation.y = yaw` directly. Getting this wrong has broken parked cars, AI
  traffic and the hotel awnings, once each.

  This entry said `+X` and `heading - PI/2` for a long time, and every car in
  the world was consequently facing backwards — it only became obvious on
  traffic, because that is the one that moves. The evidence is in the specs:
  every `Spec.profile` runs nose-first and every `profile[0][0]` is negative,
  so `front` is at **-X**, which is where `buildCar` puts the headlamps. If you
  are ever unsure, measure it rather than reading it: compare a moving car's
  world `-X` axis against its velocity, or check which end the white lamps are
  on. Five call sites share the convention — both placements in
  `world/cars.ts`, the spawn in `world/traffic.ts`, the car park in
  `world/city.ts`, and `player/driving.ts`.
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

A *parked* car's wheels never turn, so `bakeVehicle(build, true)` bakes them
*into the body* rather than keeping them as objects — a wheel's chrome, tyre
black and hub gold are all colours the body is already drawing, so four draws
become zero and a parked car is 11 meshes instead of 28. `player/driving.ts`
swaps in the articulated form on `enter` and back on `exit`; the pivots and the
body-only bake are held **detached from the scene graph** while parked, or 236
cars would each carry a spare subtree for `updateMatrixWorld` to walk. Only one
car is ever being driven. Traffic rolls constantly and is built without the
parked form.

`setRolling` must be idempotent — it is called on every `enter` and `exit`, and
a second identical call that re-parented the same meshes would double the car up
or strip it bare.

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
visits their contents. **This is the single biggest optimisation in the
project**: forcing every group back on and measuring took the frame from 26.8 ms
to 97.5 ms, 37 fps to 10. Anyone proposing "only draw what's in front of the
camera" is proposing this, and it is already here.

Three rules keep it from changing a pixel:

- The sphere must **enclose** the subtree. three still does the exact per-mesh
  test on whatever survives, so generous radii cost nothing.
- It tests the **sun's shadow volume as well as the view frustum**
  (`sky.shadowVolume`). Culling on the camera alone deletes the shadows of
  everything just out of frame.
- Crowd and traffic write their own range rule to `Cullable.near` instead of to
  `visible`, so there is only ever one writer.

**Draw ranges are the other half.** The frustum test does nothing about the
things that are dead ahead and 300 m away, and measured down Ocean Drive, 58% of
the draw calls in frame were beyond 200 m — mostly café chairs, bins, planters
and kerbside cars, each a couple of pixels at that range. `Cullable.maxDistance`
and the third argument to `addStatic` cut those; the constants live in one
`RANGE` block in `world/index.ts`.

The rule for setting one is **the size of the things inside the chunk, never the
size of the chunk**. `citydress` is a 44 m-radius chunk full of 1 m objects and
cuts at 150 m; `city` is a 60 m chunk with towers in it and gets no range at all,
because dropping one takes a piece out of the skyline. Ranges are measured from
the chunk's near face (`maxDistance + radius`), or a wide chunk vanishes while
its nearest corner is still well inside the range.

Two things make this safe, and both are worth knowing before touching it:

- **A draw range can never change a shadow.** The sun's shadow box is 64 m
  across, so anything past ~45 m is already outside it and casts nothing.
- Verified by freezing the simulation (`world.update` and `clouds.update` to
  no-ops — traffic moves far enough in 100 ms to swamp the measurement
  otherwise), then diffing the frame with and without the rule, and separately
  diffing against everything in a 14 m band past each boundary switched on —
  what pops the instant the player steps over the line. Both came back at 0.04%
  of pixels differing strongly, which is the same as the noise floor from Mara's
  own idle breathing. Mask the fps readout and the location caption when
  repeating this; they are DOM, and they dominate the diff otherwise.

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
simulation. Hold `Tab` for the weapon wheel, right mouse to aim, left mouse to
fire, `R` to reload.

All locomotion is procedural; there is not a single animation clip in the
project. `player/animator.ts` evaluates every joint angle per frame from a gait
phase that advances with **distance actually travelled**, which is why the feet
never skate.

### Panic

`world/panic.ts` is the street's reaction to a drawn weapon. Aiming calls
`world.panic.alarm(position)` every frame it is held, which *re-arms* a timer
rather than counting one up — so the panic outlives the aim by the full
`PANIC_TIME` however briefly the player raised the sights.

It is deliberately local. `Panic.at(x, z)` falls off with distance as well as
with time, and returns 0 outside `PANIC_RADIUS`, so the edge of the effect is a
fringe of people walking briskly rather than a circle with a stampede inside it.
The city is 800 m across; a panic that reached all of it would cost the whole
crowd and every traffic car an update every frame for a spectacle nobody can
see.

Two consumers, both easing in fast and out slowly:

- Pedestrians run, and **keep their lane structure while doing it**. Running
  directly away from the source instead sends them across the carriageway into
  the traffic and into the buildings — the crowd has no world collision. A
  promenade reads as a stampede perfectly well when everyone runs *along* it.
  They also scatter off the neat walking lanes, because a crowd running is not
  a queue.
- Traffic floors it, tailgates and weaves. Headway compliance scales with fear
  but **never reaches zero**, or a lane telescopes into one pile of cars. The
  swerve is driven off `z` rather than a clock, so a car weaves along the road
  instead of shimmying on the spot when stopped.

### Every car is enterable

`world.drivables` is the kerbside cars and the moving traffic in one list;
`main.ts` finds the nearest without caring which it is. Two things make that
affordable:

- **Traffic colliders are created lazily.** Traffic drives through the player
  rather than colliding, so a moving car needs no footprint — and 616 permanent
  boxes would be paid for on every `Colliders.resolve` and on every 25 cm step
  of the camera arm's `raycastXZ`, which is O(colliders). Only the handful the
  player actually parks ever become real.
- `DRIVABLE_EVERY` in `world/cars.ts` is now **1** — every kerbside car, where
  it used to be one in three with the rest merged into the street. Measured
  down a city avenue that costs 0.4 ms (46.3 → 45.5 fps) and 0.85 s of load,
  which is affordable only because a parked car is 11 meshes rather than 28 and
  because parked cars carry a 230 m draw range. It is the cheapest single knob
  on the frame if the city ever gets denser.

Taking a car with `hasDriver` set hauls the driver out: `crowd.eject` builds a
new rig at run time and drops them on the pavement already running. Building a
rig costs a few milliseconds, which is invisible as a one-off on a carjack and
would not be as a spawner — this is not a general population system. A taken
traffic car never rejoins the flow; `onTaken` tells the traffic system to let go
of it for good.

### Weapons

`weapons/` is the whole system: `specs.ts` is the data, `models.ts` builds the
geometry, `ballistics.ts` decides what a round hits, `fx.ts` draws it, and
`index.ts` (`Arsenal`) owns the inventory and the trigger. `ui/weaponwheel.ts`
is the hold-`Tab` wheel. Adding a weapon is a row in `WEAPONS` plus a builder —
the wheel, the HUD, the aim pose and the firing code all read the table.

**Rounds start at the camera, not at the muzzle.** The trace runs from the eye
along `camera.getWorldDirection()`, and the tracer is then drawn from the muzzle
to wherever that trace ended. Firing from the barrel is the obvious thing to do,
looks correct in a screenshot, and feels broken in the hand: the gun sits half a
metre right of the eye, so everything inside about five metres misses low and
left of the crosshair.

**Nothing raycasts the scene graph.** The world is a few hundred merged meshes
holding 14M triangles with no BVH, so `THREE.Raycaster` against it would cost
more than the whole frame. Bullets test the same things the physics does —
`groundHeight`, the collider set, and the agents' own positions — which is also
why a bullet can never disagree with what the player can walk into. Pedestrians
and vehicles are closed-form ray/sphere tests (stepping the ray and testing 424
pedestrians per step is four orders of magnitude more work); the ground and the
colliders are marched, finely close in and coarsely far out. `Colliders.hits` 
exists for this: `raycastXZ` walks at a fixed 25 cm and is O(colliders) per
step, which is fine for one camera arm per frame and hopeless twelve times a
second.

#### The aim pose is solved, not authored

The weapon hangs off `armR.wrist`, so where the forearm points is where the
barrel points, through two Euler chains. Deriving that by hand is a bad way to
spend an afternoon, so both halves were measured in the running game and the
numbers baked back in — `AIM_POSE` in `player/animator.ts` is exported and
mutable (`window.SOLARA.aimPose`) precisely so it can be re-solved.

The order matters, and getting it backwards is the trap:

1. **Solve the arm for where the *hand* ends up.** Optimising the joint angles
   directly against the aim line finds poses that are numerically perfect and
   anatomically absurd — the first pass put the barrel within a degree of the
   crosshair with her fist tucked against her ear.
2. **Then solve `GRIP_ROTATION` for the barrel**, by asking for the quaternion
   taking the model's -Z to `camera.getWorldDirection()` in wrist space. It
   takes up the few degrees the arm pose leaves over.

Three things that were wrong first time:

- **`chase.pitch` is positive looking *down*.** The shoulder's share of the
  camera pitch has to be positive to follow it; negated, the gun swings away
  from the crosshair as you look down.
- **Aim at the shot direction, not at the character's facing.** Over the
  shoulder the camera looks slightly inward, and a barrel aligned to the body
  sits visibly off the crosshair.
- **The support hand cannot reach a foregrip.** With the gun arm extended the
  SMG's foregrip ends up ~0.72 m from the left shoulder and the whole arm is
  0.545 m. `SUPPORT_GRIP` is the magazine well instead, which is both reachable
  and a real technique.

#### Feel

- The crosshair gap is driven from the same `spreadNow` the bullets are. A
  reticle that lies about the cone it stands in front of is worse than none.
- **Spread recovery has to be well under `spreadPerShot × rounds per second`.**
  The SMG first shipped recovering 0.11/s against 0.1125/s of bloom at 750 rpm;
  the two cancelled and the reticle sat still through a whole magazine.
- Recoil kicks the *camera*, not the arm. Kicking the gun would look right and
  shoot identically, which is worse — the player aims with the crosshair.
- Aiming turns locomotion inside out: `Controller.faceYaw` holds the camera's
  heading and she strafes around it, because a gun that swings to point wherever
  the feet are going cannot be aimed.
- Muzzle flashes are deliberately authored *above* the bloom threshold, unlike
  the neon in `world/facades.ts` which sits below it. A muzzle flash is the one
  thing in the world that is meant to smear.
- **Tracer geometry runs along +Z, not -Z.** `Object3D.lookAt` is not the
  camera's: `Matrix4.lookAt(eye, target, up)` puts +Z on target→eye, and
  `Object3D.lookAt` passes those arguments *reversed* for anything that is not a
  camera or a light. A plain mesh therefore points its **+Z** at the target
  where a camera points its -Z. Built along -Z, every tracer drew from the
  muzzle backwards past the player.
- The reload pose has three beats and `audio/weapons.ts` schedules three clacks
  across the same duration. They have to stay matched — the sound is doing half
  the work, and the support hand has to be at the magazine when the first clack
  lands.
- **Check audio levels on the analyser, not by ear.** The first reload was three
  thin bandpassed clicks that measured 0.023 RMS on the master bus against an
  0.020 ambience floor: they were playing correctly and were completely
  inaudible. Every beat now carries a pitched body under the transient, which is
  what makes a click read as metal. The band that works here is ambience ~0.020,
  reload ~0.085, gunshot ~0.15 — a reload as loud as a gunshot is as wrong as a
  silent one, and the first fix overshot to exactly that.

#### Shooting people

Pedestrians carry two hit spheres — head and body — sized per agent, because the
crowd varies height by ±10% and one fixed head sphere sits in the neck of the
tall ones and above the hair of the short ones. The head is tested *first*: it
is inside the body sphere's vertical span, so testing the body first swallows
every head shot.

A head shot kills outright. The body takes three. A survivor keeps a permanent
`Injury` — leg, arm or gut — chosen from **where the round landed**, not from
which way it was travelling: the player watched it hit, and a low shot that
produces a clutched shoulder reads as a bug. The wound then changes how they
walk for the rest of the session; `crowd.debug(i)` / `world.personDebug(i)` is
on `window.SOLARA` because at pedestrian distance a raised arm could be a
flinch, a nursed wound or the ordinary walk swing, and guessing is hopeless.

Death is a scripted collapse, not a ragdoll — there is no physics to hang one
on, and at these distances the collapse is more legible anyway. Two things it
gets wrong if you are not careful:

- **Do not pull the pelvis down `hips.position.y` to sink the body.** That axis
  is the body's own up, and a quarter turn later it points along the ground, so
  'down' telescopes the character into itself. The root rotation does the work
  and the root only rises by half a body's thickness.
- The knees buckle as a *transient* that decays. Held bent they end up pointing
  at the sky and the body reads as a chair.

#### Animation layers stack, so every channel must be reset

`poseFlinch`, `poseInjury`, `poseReload` and `poseAim` all run on top of the
gait and on each other. **A layer that does `+=` on a channel the base pose
never writes will accumulate.** `poseFlinch` added into `chest.rotation.z`,
which the base pose set no value for; over one reaction it reached a couple of
radians and rolled the whole torso over. It presented as the arms flying out —
the arms are what you notice — and survived three wrong fixes aimed at the arms
before the base pose was the thing at fault. The base pose now writes
`chest.rotation.z` explicitly for that reason.

Two more that cost time here:

- **A negative `shoulder.rotation.x` carries the hand up as well as forward.**
  Swinging the shoulder to bring a hand to a wound lifts the whole arm, and with
  the torso folded over it the elbows finish above the shoulders. Hands come in
  by bending the *elbow* while the upper arm stays hanging.
- **Positive `rotation.x` is forward on the spine and chest and backward on the
  hips and shoulders.** The torso joints carry their children along +Y and the
  limbs hang along -Y, so they tip opposite ways. Measure it rather than
  reasoning about it — set a joint, read the child's world position.

`REACTIONS` in `player/animator.ts` multiplies each layer out at runtime
(`window.SOLARA.reactions.injury = 0`) and is the fastest way to find which
layer owns a pose.

#### Measuring a skinned crowd member

**`Box3.setFromObject` on a SkinnedMesh reads the bind-pose box**, transformed by
the object matrix — it says nothing about the animated pose. A collapse measured
this way looks like it is sinking a quarter of a metre through the pavement when
it is resting on it correctly. Read the skeleton's bone world positions instead;
bone order is the array passed to `skinRig`: hips, spine, chest, neck, head,
five ponytail links, then legL, legR, armL, armR as hip/knee/ankle and
shoulder/elbow/wrist.

#### Ready for the gun shops

`Arsenal` keeps `owned`, magazines and reserves behind `give`, `addAmmo`, `has`
and `ammoOf`. The wheel and the HUD only ever read. A shop calls `give(id)` and
the weapon appears on the wheel; nothing else has to change. `main.ts` currently
grants both at startup — that call is the placeholder.

**Testing any of this needs `window.SOLARA.input.locked = true`.** Pointer lock
is stubbed out under automation (see the top of this file), so `Input` ignores
every mouse event and neither aiming nor firing does anything.

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

Frame rate is still bounded by draw calls, at ~5 µs each on this driver: about
3550 in the beauty pass on Ocean Drive (45 fps) and 5800 looking inland from the
beach (31 fps), which is the worst vantage in the world.

GTAO is 5.8 ms of that and is **not** tunable — dropping its sample count from 8
to 4 made the frame *slower*, and shortening its camera from 120 m to 15 m won
0.8 ms, because the cost is submitting the scene a second time for the normal
buffer rather than the AO shader itself. The shadow map is another ~6 ms; its
2048 map and 64 m box are already tight, and halving the map changed nothing
(fill is nearly free here — quartering the framebuffer moves the frame under
5%). Bloom, the grade and SMAA together are about 1 ms.

**The next real lever is splitting `city:chunked` in two.** It is the largest
group with no draw range, and it cannot have one as it stands, because its
chunks hold towers. But most of its draws are `world/facades.ts` — shopfronts,
awnings, blade signs, balconies, fire escapes, rooftop clutter — none of which
resolves at 200 m. Baking the building shells and the street-level kit into
*separate* chunk groups would let the detail take a 150 m range while the
skyline keeps drawing to the horizon.

After that: traffic is 621 cars at 24 meshes across only 20 distinct materials,
which wants InstancedMesh and would take 1.4 s off the load as well. Note that
merging *across* agents is not the win it looks like — baking parked cars into
street chunks trades per-car culling for chunk culling and measured at 0.5 ms,
a quarter of what collapsing each car individually gets.

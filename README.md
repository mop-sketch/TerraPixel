# TerraPixel

A 2D micro-terrarium simulation inside a sealed glass jar, seen in cross-section. A discrete
substrate grid, one global atmosphere, and hierarchical plant node trees interact through a single
deterministic tick loop.

**[Play it in your browser](https://mop-sketch.github.io/TerraPixel/)** · or download
[the latest release](https://github.com/mop-sketch/TerraPixel/releases/latest) — one HTML file that
runs offline with nothing installed.

```bash
npm install
npm run dev           # play it at localhost:5173
npm test              # 154 tests, including the closed-system water audit
npm run balance       # score every scenario against its stated intent (exits non-zero on drift)
npm run test:balance  # the same matrix as a test suite — minutes, not seconds
npm run harness       # full headless sweep with per-scenario detail
```

Nothing to install to *play* it: `npm run build:single` folds the whole game — code, styles and music
— into one `dist/terrapixel.html` that runs from a double-click with no server and no network.

## The shape of the thing

Rendering ~2,000 coloured rectangles is not the hard part. The hard part is that every subsystem
feeds back into every other one — soil moisture drives humidity drives condensation drives soil
moisture; leaves consume CO2, respiration returns it — so the architecture exists to make those loops
**observable, tunable, and non-oscillating**.

```
src/sim/     PURE. No DOM, no canvas, no Math.exp/pow/sin. Runs headless under Node.
src/render/  Reads sim state and drains SimEvent[]. Never writes.
src/ui/      Pushes commands onto a queue. Never writes state directly.
tools/       Headless balance harness.
```

Two rules make everything else possible:

1. **`src/sim/**` imports nothing from `render/` or `ui/`.** That is what lets the whole simulation
   run under Node for balance sweeps, replay verification, and unit tests.
2. **No transcendentals in `src/sim/**`.** `Math.exp`/`pow`/`sin` are implementation-defined and do
   diverge between engines, which would cost us replay verification — the best bug-reproduction tool
   in the project. `src/sim/detmath.ts` provides deterministic replacements built only from
   `+ - * / sqrt`, which are IEEE-754-exact.

## Time

**10 ticks/sec · 1 tick = 1 sim-minute · 1 sim-day = 144 s real.** Every rate in the config is
per-sim-minute and converted in `compile()`; every probability is stored as expected-events-per-minute
and converted with `1 - exp(-rate·dt)`. Without that discipline, changing the tick rate silently
rebalances the entire game.

## The tick

Phase order is the most load-bearing decision in the codebase. Each step fixes a specific, nameable
bug — see the comments in [src/sim/tick.ts](src/sim/tick.ts) before reordering anything.

```
0   commands        every geometry/tool edit lands here, once
1   settling        granular physics: material falls and slumps
2   drivers         temperature (with inertia) -> light field
3   substrate water landed droplets -> gravity percolation -> capillary diffusion
4   water demand    evaporation and root uptake ARBITRATED against one snapshot
5   atmosphere      single commit point for gas/humidity; condensation; droplets
6   plant internal  transport -> photosynthesis -> maintenance -> health -> growth meter
7   surface ecology mold -> litter decay -> springtails -> charcoal filtering
8   structural      grow / flower / drop / sever, all stamped with spawnTick
9   strikes         debounced failure counters with asymmetric recovery
10  audit           dev-only closed-system water assert
```

The four that matter most:

- **Substrate settles before anything reads the jar's shape.** The light field, each column's exposed
  surface, and the root-anchor check all depend on where the material actually is. Running them
  against last tick's geometry leaves light falling on soil that has already slid away.
- **Water demand is arbitrated, not sequential.** A naive `water -> evaporate -> uptake` lets the air
  skim every cell before the root sees it, producing the worst symptom this sim can have: *"I watered
  it and it still died."* Reordering cannot fix it — whoever runs second is wrong. Both claimants
  state a demand against one frozen snapshot and the cell scales them proportionally.
- **Condensate lands on a later tick.** Crediting soil at the moment of condensation creates a
  same-tick loop (soil wets → humidity drops → soil dries) that oscillates, and makes the
  falling-droplet animation a lie. The queue makes the visual honest and the delay diegetic.
- **Topology only changes in phase 7.** A leaf appended during phase 5's sweep would be visited by
  that same loop and bank a free tick of photosynthesis at age zero.

## Granular physics

Substrate falls into open space and slumps down-diagonally when blocked, one cell per tick, iterated
bottom-up exactly as gravity percolation is. Two per-material numbers give the three materials
distinct characters:

| | `slide` | `cohesion` | behaves like |
| --- | --- | --- | --- |
| Gravel | 0.85 | 0 | runs and self-levels; a poured drainage layer spreads itself flat |
| Charcoal | 0.55 | 0.25 | angular chunks that interlock into steeper piles |
| Soil | 0.40 | 0.90 | crumbles into a slope when dry, holds a near-vertical bank when damp |

`cohesion` is what ties this to the water simulation rather than bolting it on beside it: the chance
of slumping is `slide × (1 − cohesion × wetness)`, so watering a terrace before you plant into it is
a real technique. Two rules keep it honest:

- **Material carries its water** (and nutrients, litter, toxins, mold) with it. Those live in the
  pores, not at a fixed address in the jar — and moving material while leaving its water behind would
  break the conservation audit on the first collapse.
- **Roots bind the substrate.** A cell anchoring a root never moves, which is true of real soil and
  makes an established plant a structural feature of the jar rather than a passenger in it.

Settling runs only while the substrate is dirty — set on any paint, cleared the moment a pass moves
nothing — so a jar at rest pays one flag check per tick.

## Water

Two mechanisms, cleanly separated, and the separation is what makes the drainage layer work:

| | moves | driven by |
| --- | --- | --- |
| Gravity percolation | the surplus **above** field capacity, one cell per tick, bottom-up | `permeability` |
| Capillary diffusion | potential **below** field capacity, all four neighbours, double-buffered | `lateral` |

Every material carries two separate numbers — `maxMl` (total pore space; saturation 1.0 is
waterlogged, the root-rot condition) and `fieldCapacityMl` (what it holds against gravity). Collapsing
those into one means no water is ever mobile, nothing ever reaches the gravel, and every over-watering
simply waterlogs the root zone.

Diffusion equalises **wetness** (`min(1, moisture/fieldCapacity)`), a stand-in for matric potential.
Capping it at 1 is what lets the drainage layer wick its reservoir back up into dry soil while never
pushing soil past field capacity.

**Water is conserved.** A dev-only audit asserts the closed system balances every tick —
substrate + air + glass + droplets + plant tissue + pending. It catches an entire class of bug the
moment it appears. `moisture` and `pool.water` are `Float64Array` specifically so accumulated rounding
stays far below the smallest real leak.

## Atmosphere

The authoritative stored value is `airWaterMl`; **relative humidity is derived** against a
temperature-dependent capacity. That one choice buys exact conservation, makes warming the jar clear
the fog without moving any water, and gives condensation a real negative branch.

Soil↔air exchange is a **signed gradient** between the air's humidity and the humidity the soil can
support. One-way evaporation gives a sealed jar no sink for vapour at all, so humidity climbs until
condensation runs permanently and the gauge pins at the condensation floor. Signed, humidity settles
at roughly the soil's own wetness — a genuine diagnosis of the substrate.

Fogging and condensation are **two latched state machines**, deliberately far apart: the glass mists
at 80% RH (clearing at 74%), and water only runs at 95% (stopping at 89%). They were one latch at
86/80, which forced the jar to rain the moment it became muggy and pinned humidity there forever —
the thing that made it damp was also the thing that immediately dried it. Split, a jar can sit
genuinely humid, growing mold, without water running down the glass. Either way a bare
`if (rh >= 85)` gives a two-tick limit cycle and visibly strobing fog.

Above the condensation latch, a glass reservoir fills and releases **discrete beads** that run down
the pane, cutting a clear track through the fog as they go.

## Plants

One flat node pool. **Nodes are only ever appended, so `parent < child` always holds** — therefore one
forward sweep is root→tip and one reverse sweep is tip→root, with no recursion, sorting, or stack.
That invariant is also why dead nodes are tombstoned and never swap-removed.

Stems are a load-bearing column; leaves are terminal and hang off them. A node's throughput to its
children is `capacity × share × efficiency`, and that product must exceed what the canopy above it
transpires — otherwise the stem is a straw too narrow to feed its own leaves.

Sink priority is **roots → leaves → height**. The middle term matters most: a policy that buys height
first builds a bare stem column, runs out of sugar, and starves with a single leaf. Growth is gated on
having a night's maintenance banked, not merely a node's build cost, which is what stops the
grow-then-starve overshoot cycle.

Health **eases** toward `1 - stress` and never snaps, in both directions. The 10–20 ticks of visible
yellowing are the player's window to act, and recovery uses the same channel so a rescue reads as one.

## Species

Three plants, each a parameter overlay on the same base config, compiled per species so no code path
can silently hand one plant another's habit:

| | wants | the trade |
| --- | --- | --- |
| Fern | shade and damp | reaches full rate in light that starves a Herb — at a lower ceiling in bright light |
| Herb | middling everything | *is* the base config, which is what keeps every balance target meaningful |
| Succulent | bright and dry | holds its size where a Herb booms and fades; rots if kept wet |

The A/Bs are asserted, not asserted-about: at lamp 0.05 the Fern builds 59–135 nodes across five RNG
seeds while the Herb manages 4 or 5 and never establishes.

## The detritus economy

The loop that turns a plant in a box into an ecosystem:

```
leaf senesces -> litter -> springtails eat it -> nutrients + CO2 -> new growth -> leaf senesces
                     \                              ^         ^
                      -> plain microbial decay -----'         |
                         (slower, and also makes toxins)      |
                                                              |
                     moss -> fixes nutrients from the AIR ----'
                       \---> dies back into litter
```

Every arrow above except the moss one just moves existing nutrients around, and loses ~45% each time
it does. Moss is the only thing in the jar that brings new fertility *in*.

Four rules hold it together:

- **Leaves have a lifespan, jittered ±35% per leaf.** Senescence is what gives the jar a litter *flux*
  rather than a one-off pile — without it the decomposers starve and both the carbon and fertility
  loops have a source but no supply. The jitter matters too: a shared lifespan ages the whole canopy
  out on the same tick, and the plant strips itself bare in an otherwise healthy jar.
- **Carbon conserves.** Respiration is charged against the litter actually eaten, not against
  population. A per-head rate lets a large colony exhale carbon it never consumed and the jar invents
  CO2 from nothing. `sugarCostPerNode × co2PpmPerUnit` must equal `leafLitterMass × decay.co2PpmPerUnit`,
  and there's a test asserting exactly that.
- **Nutrients and toxins leach with water.** Litter rots on the surface but roots feed below it, so
  without transport the fertility released up top could never reach the plant — and the charcoal layer,
  sitting at the bottom, would never see a toxin to filter. Over-water and you flush the fertility into
  the drainage layer, which is a second cost for doing it.
- **Starvation is dormancy; drought is death.** Breeding is proportional to population, so letting
  hunger reach zero makes zero an absorbing state and one lean week ends the carbon loop permanently.
  Desiccation and suffocation still kill outright, so those two failure states stay real.
- **Colonies forage, and how they move is load-bearing.** They sniff along each axis out to
  `senseRadius` and step toward the nearest food; with nothing to eat they wander, weighted toward the
  surface. Three details are easy to get wrong and each one silently breaks the whole loop: gating
  movement on `pop >= 1` freezes dormant colonies (the floor is `0.25`) so they starve a few cells from
  a growing pile; wandering off a cell that already *has* food leaves them orbiting their own larder;
  and letting a colony **split** while starving gets both halves floored back to `0.25`, breeding
  springtails out of nothing. So: only colonies with food may split, everyone else migrates whole.

## Moss

The jar's only source of *new* fertility, and a per-cell coverage field like mold rather than a node
tree — it is a mat that creeps, not a structure that branches.

It only grows on a column's exposed surface, needs light, damp and not-too-much heat, and does four
things: **fixes nutrients from the air** (real biology — many mosses host nitrogen-fixing
cyanobacteria), **dies back into litter** so it feeds the springtails, **crowds out mold** by capping
how far it can take a cell it occupies, and **shades the soil** so a mossy jar holds water longer.

Tuned for **break-even**: a well-covered jar holds what it built, a bare one still slowly runs down.
Measured over 50 sim-days, same three plants either way — mossy ends at 178 nodes against a peak of
181, bare ends at 162 against a peak of 179, with 3.6× the soil nutrients and more flowers.

Two mistakes worth not repeating. **Darkness is not stress:** gating die-back on "not currently
photosynthesising" kills every mat within one night, because night is half of every day — only drought
and heat may hurt moss, while darkness merely pauses growth. And **moss is biomass**, so it has to
appear in the carbon audit; growth draws its carbon from the air and die-back returns exactly the same
amount, both derived from one constant (`litterPerCover`) so the two directions cannot drift apart.

**Mold** is gated on the condensation latch rather than a humidity number, because once condensation
engages it holds humidity down near its own release threshold — any figure above the band is
unreachable, and any figure inside it is a magic number one point away from doing nothing. The latch
says the thing that matters, in the same terms the player sees: the glass has been fogging. Mold also
*eats* litter as it grows, so a bloom exhausts its own fuel and crashes, and springtails graze it.

**Flowering** is the win condition, gated on sustained calm rather than a threshold touched once: size,
health, both currencies stocked, and a stretch of low stress that drains three times faster than it
fills. A jar can be nursed through a crisis and survive; it only blooms if it was genuinely left in
good order.

## Pests

The one hazard that arrives from outside, and the only one with a minigame attached.

Sap-suckers ride in dormant on seeds the player plants, sit invisible while a plant is healthy, and
take their chance when it weakens. Four things decide whether they get going:

- **The lid.** An open jar rolls at the full rate; a shut one at 6% of it. Measured over 60 days,
  3 of 10 sealed jars met pests against 10 of 10 vented ones. Venting was already the answer to fog,
  heat and stale air — now it has a price.
- **The host.** A colony grows only as far as its plant will bear: nothing on a healthy young one,
  everything on a plant that is struggling, old, or both. Plants lose resistance from day 40.
- **Luck.** Ignition is a roll, not a threshold — each plant draws its own hardiness, and a dormant
  colony waits a geometric spell before catching, so two identically grown jars differ.
- **Time.** Left alone, a colony *entrenches*: after six days it sustains itself whatever the plant's
  condition, does twice the damage, and spreads three times harder. Neglect compounds rather than
  plateauing.

They spread only where leaves actually touch, so spacing is a defence, and they eat the springtails
in the soil beneath them — never past the dormant floor, so the decomposers recover.

**The cure is a course.** Pruning the speckled growth buys time. Finishing three pesticide sprays at
least a day apart clears the colony for good and that plant is never infested again. The spacing is
the game: a dose inside the minimum gap costs residue and buys no progress (and says so), while three
doses in quick succession poison the plant and kill it.

## Failure states

Every mode uses a debounced strike counter that recovers twice as fast as it accrues, with the warning
driven by the **same** counter at 40% — a separate looser threshold would eventually disagree with the
failure it is meant to precede.

| Mode | Warning | The one fix |
| --- | --- | --- |
| Dehydration | leaves yellow from the tips | water it |
| Root rot | dark waterlogged soil, sump full | stop watering; the gravel layer should have prevented it |
| CO2 stall | growth freezes, leaves desaturate | prune leaves; add springtails |
| Mold | fuzz on litter first, fogged glass | vent the lid; springtails graze it |
| Fauna suffocation | springtail count falling | more leaves; vent the lid |
| Pests | pale specks on the leaves | prune them off, or run a pesticide course |
| Nutrient starvation | growth freezes, "needs feeding" | let litter build; add springtails |

Plants never die of gas. CO2 depletion **stalls** growth — legible and recoverable — and low O2 harms
fauna only.

CO2 stall is deliberately **not** raised as an alert. A jar that has finished growing lives near the
stall threshold and crosses it every night — that is a closed carbon loop at capacity, not an
emergency — so the banner flashed up and vanished repeatedly in exactly the jars that were doing best.
It is reported instead as the calm line "Growth paused — stale air" on the plant card.

## Balance

All tuning lives in [src/sim/config/balance.ts](src/sim/config/balance.ts), injected rather than
imported so two differently-tuned worlds can run side by side. `compile()` derives per-tick rates and
lookup tables, and rejects configs that would misbehave (a diffusion coefficient past the 0.25
stability limit, an inverted hysteresis band, a wilting point above a rootable material's capacity).

`npm run harness` runs fourteen scenarios headless and reports equilibrium, plant size, ecology, mold, and
which failures tripped. Tuning a closed-loop ecological sim by watching it in real time is impractical
— an in-game day is 144 real seconds — so this is how balance becomes a measurement instead of a guess.

### Balance as an assertion, not a feeling

`npm run balance` scores every scenario against a **stated intent** and exits non-zero if any has
drifted out of shape. Each target says what the jar is *for* and bounds only what that role requires:

```
PASS  well-built         the reference jar: it should simply thrive, unattended, and bloom steadily
PASS  wild               one plant left alone seeds the jar and settles, rather than booming or dying
PASS  fern-shade         a dim damp jar: the Fern should thrive in light that would starve a Herb
PASS  succulent-dry      a bright sparse-water jar: the Succulent should hold where a Herb dries out
PASS  mixed              all three together: the jar settles rather than one species crowding the rest
PASS  no-fauna           the same jar without decomposers: litter must visibly pile up
PASS  mossy              a moss-cultivated jar holds what it grew, where the same jar bare runs down
PASS  cold-dry           never watered: dehydration and ONLY dehydration, and no reward for it
PASS  no-drainage        no gravel and drenched: the root zone waterlogs
PASS  swampy             left fogged with litter on the surface: mold takes hold
PASS  well-built         the same jar at 60 days: still thriving, stowaway pest colonies aboard
PASS  overplanted        packed with plants and no recyclers: the air runs thin
PASS  vented             left standing open: the usual way pests get in, and the price of venting
PASS  overplanted-fauna  the same crowd WITH recyclers: more plant, more blooms, far less litter
```

The bounds are deliberately loose — they catch a system that has fallen out of its role, not every
number that moves. The A/B pairs are the real content: over 40 sim-days the crowded jar *with*
decomposers reaches 285 nodes and 172 flowers against 215 and 58 without, and holds 16 units of litter
against 503. That difference is the entire justification for the decomposer milestone, and it is
asserted rather than asserted-about.

### Two conservation audits

Water and carbon are both conserved quantities in a sealed jar, and both have an audit.

The water audit throws per-tick in dev; it caught a leaking transport rule, water lost with pruned
nodes, unaccounted lid exchange, and a leaf's water vanishing on drop. The carbon audit
(`auditCarbonPpm`) is reported rather than thrown, since carbon has legitimate rounding paths — and it
immediately found a **35% leak**: dying roots and stems vanished without leaving litter, and every
flower cost 40 sugar while only ever returning 14 worth. Both are now regression-tested.

## The ending

A jar that fills its space stops being a garden you tend and becomes a thing you keep. When growth
plateaus for long enough — and at least one plant has bloomed, so a jar that merely stalled cannot be
mistaken for one that finished — the **climax** begins: creepers and moss close over the glass, the
air takes on a green cast, and the plants ease. It is not a score screen; the jar goes on running, the
clock keeps its day count, and pruning anything reopens it.

## Teaching

Two layers, because they answer different questions at different times. A one-time intro and a
self-clearing checklist cover *what this is* and the first four actions. Everything after that is
**just-in-time**: the first time fog, mold, filling charcoal, sour soil, pests or the climax actually
appears in your jar, a short card explains that one thing and the single action it calls for. Each
fires once, ever. Explaining mold up front would be a wall of warnings about problems the player has
not met and cannot picture.

## Sound

Four ambient loops chosen by what the jar is doing — title while building, main while tending, alert
when something is wrong, and one for the climax — crossfaded over 2.5 seconds. Trouble outranks the
ending, so a jar that finishes with a failure running does not get the credits played over it.

The music refuses to chase a flickering warning: trouble must hold for 4 seconds before the score
reacts and be gone for 12 before it relaxes. One button, top right, turns it on and off and remembers
the choice. Everything is lazy-loaded, so a jar that never goes wrong never fetches the alert theme.

## Stress vs. distress

Two numbers, because they answer different questions. **Stress** drives health and includes ordinary
ageing — a leaf dying of old age genuinely is losing condition. **Distress** excludes senescence and is
what the player sees, what gates flowering, and what decides whether a plant counts as "dying".

A mature canopy always contains leaves ageing out, so raw stress never returns to zero even in a
flawless jar. Reporting that as the plant's condition shows a permanent ~30% problem with no cause to
find and nothing to fix, and gating flowering on it would punish a jar for doing the one thing it is
supposed to do. In the reference jar the two now read 11% and 2%.

## Licence

The **code** is under the [PolyForm Noncommercial License 1.0.0](LICENSE): read it, run it, modify
it, share it — for any noncommercial purpose. Selling it, or using it commercially, needs
permission. That covers `src/`, `tools/` and `tests/`.

The **music and the jar's visual design are reserved**. They ship with the game and may be
redistributed as part of it, but not lifted out and reused on their own. See [NOTICE](NOTICE),
which also says plainly what is and is not being claimed over the AI-generated tracks.

Noncommercial licences are not "open source" by the OSI's definition, and GitHub will label this
repository's licence as *Other* rather than showing a familiar badge. That is the deliberate
trade for a game that should not be sold by someone else.

Copyright (c) 2026 Robert Audley. For commercial use, ask.

## Status

**Complete and playable.** Substrate painting with granular physics, build and tend phases, the full
water cycle, atmosphere with fogging and condensation, three plant species with light-driven growth,
senescence, decline and recovery, the litter/decomposer/carbon loop, toxins and charcoal filtering,
mold, pests with a pesticide course, six failure states, flowering as a win condition, an overgrown
ending, just-in-time teaching, an ambient score, and a balance matrix of fourteen scenarios.

The reference jar survives **two sim-months unattended on a single watering**, blooming steadily, with
no failure ever tripping and carbon conserved to within 0.1%.

### Known limitations

- **No saving.** Closing the tab loses the jar. A jar takes 40+ sim-days to reach its ending, which is
  a couple of hours at 1x — the speed controls (1x to 128x, keys 1–5) are how you cover that. The
  architecture makes this cheap to add later: a run is a seed plus an ordered command log, which
  reproduces it exactly, and that log already exists for replay verification.
- **The portable build is large.** ~22 MB, nearly all of it the embedded music; the game itself is
  ~140 kB. A file that plays audio with no network has to carry the audio inside it.

Natural next steps, none of them blocking: save/load, water bodies (and the algae that belong with
them), a Tauri desktop wrap, and sprite art in place of the current rectangles and line segments.

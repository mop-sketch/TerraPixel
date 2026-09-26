# Water bodies

The update that lets water exist as *a thing in the jar* rather than only as moisture inside pores,
vapour in the air, beads on the glass, or sap in a plant.

## Why it is not just scenery

Standing water already exists in spirit. The sump readout is "moisture above field capacity in the
gravel" — water with nowhere left to hide — surfaced as a number the player cannot see or touch. Much
of this update is making that real, and then letting the player put one somewhere on purpose.

A pond earns its place by changing the loop the player already has, not by adding one beside it:

- **A reserve.** It wicks into the surrounding soil, so a jar with a pond rides out neglect far
  longer than one without. Watering is the core loop; this changes it.
- **A humidity engine.** Open water evaporates faster than soil, holding humidity up without
  watering — and pushing the jar toward fog, which is what lets mold take hold. A genuine trade,
  built entirely from systems that already exist.

## Decisions taken

| | Decision |
| --- | --- |
| Making one | **Dig, line, fill.** Excavate a basin, line it with mud, pour water in. |
| The liner | **Mud**: impermeable, not rootable, sticky enough to hold a steep wall. |
| What it does | **Reserve and humidity both**, with the fog and mold consequences that follow. |
| When you may dig | **Any time.** Free while building; after sealing it costs the cell's water and hurts nearby roots, exactly as amending already does. |
| Life in the water | **Yes, later.** Plants first, fauna after. Both wait until the water itself is solid. |
| The liner, again | **Watertight.** A pond feeds the jar through the AIR — it evaporates, and the water comes back as condensation and as dry soil drawing on humid air — never by leaking through its walls. Lining stays the skill. |
| Algae | **A recoverable setback**, like mold and pests: it clears once its cause is fixed. |
| Water plants | **Both** a floating plant (duckweed, later replaced by lily pads) and a marginal plant rooted at the water's edge. |
| The grazer | **Ramshorn snails**, grazing algae the way springtails graze mold. |

An unlined basin is not a punishment, it is the lesson: percolation already exists, so water poured
into a hole in soil simply soaks away by morning. Lining it is the skill.

## The model

**Free water is a per-cell quantity in air cells**, not a new substrate type. A cell that is either
full or empty gives blocky ponds that cannot half-fill or find a level; a float can.

**All of its movement is instant**, because a tick is a sim-minute and water finds its level in
about a second. Each tick it settles to the floor of whatever open space it is in, then every row is
levelled whole: a stretch of cells resting on something shares its water equally, takes in whatever
is stacked above it, and refills from the bottom up. Water beside a drop pours over it. That is the
whole of why a pond is flat under a steady pour and why a brimming one spills over its rim instead of
heaping above it. (The first version traded a fraction of the difference between neighbours a few
passes a tick; a pour outran it, and the surface heaped over the pour point.)

**It is in the water audit.** The audit asserts a closed system every tick in dev and has caught four
separate leaks this project, so every mistake in this feature surfaces on the tick it happens.

## Stages

Each is shippable on its own. Stopping after any one of them leaves the game better, not half-built.

**1. Free water exists.** Flow, levelling, the audit term, the art. No new tools — water arrives only
by over-watering, so the payoff is that the drainage layer *visibly fills* instead of reading "0 mL
standing".
*Done when:* the audit holds over a 60-day run; a poured column drains and levels without
oscillating; the gravel reservoir reads as water on the plate.

**2. Ponds on purpose.** The Dig tool, the mud material, and the seepage that makes lining matter.
*Done when:* a lined basin holds its level for 40 days; an unlined one in soil is gone within a day or
two; digging beside roots costs the same as amending.

> **Built.** Mud is a substrate like any other (`maxMl: 0`, not rootable, barely slides) and Dig is
> simply painting `Air`, so excavation reuses the amendment path whole — the spilt water and the cut
> roots come for free rather than being reimplemented. Free water now forms only on a liner, so
> over-watering waterlogs a jar rather than filling it like a bath, which is what makes digging worth
> the trouble. A basin held 396 mL after eight days with plants growing either side.
>
> Lining is **one click**. Mud dropped into a dug hollow lines the whole thing — floor, both banks,
> and the face of every step the slumping left — because the rule it follows is the one the water
> obeys: every cell the pond would touch from below or the side has to be something it cannot get
> into. The clicked row is the level being asked for, so a shallow click lines a shallow pond. Mud on
> solid ground is still just a cell of mud. Measured: dig a hollow a cell at a time, let it slump,
> one click, and the pond holds 226.5 mL with **no loss at all** over 20 sim-days.
>
> **Hovering with Mud previews the click**: a pale wash where the pond will sit and a mud-coloured
> band over every cell that will change, from the same `SubstrateGrid.basinLiner` query the click
> commits with — so the preview cannot promise something the click does not do. Building it turned
> up a real bug: the jar's own rounded corners are genuine walls, so the open air just above an
> *undug* floor read as one enormous basin and a click there lined ~54 columns. One click now lines
> at most `tools.maxBasinSpan` (24) columns.
>
> One trap worth keeping: **air is not a floor.** Both mud and air report `maxMl: 0`, and gating the
> pour on that alone made every open cell impassable — water poured onto a column still slumping into
> place stopped falling and hung in mid-jar. The test is `solid && maxMl <= 0`; see `isFloor` in
> `tick.ts`. It cost two springtail tests to find, because the jar's water budget shifted by 75 mL and
> a marginal colony fell the other way.

**Where stages 1 and 2 leave it.** Measured over 40 days, a lined pond is an *inert tank*: it held
324 mL on day 10 and exactly 324 mL on day 40, and the jar's soil carried ~220 mL less than the
same jar without one. Nothing leaves a pond — it does not evaporate, and the liner is watertight —
so today a pond is a pure cost. Litter is stuck the same way: a leaf that falls on a pond lands on
the mud floor, and decay only runs in soil, so it never breaks down. Stages 3 and 4 are what turn
both of those into the point of having a pond.

**3. It earns its place: evaporation.** Open water evaporates from its surface, and the reserve and
the humidity follow from systems that already exist.

- Each body's top cell evaporates toward **100% humidity**, not toward its own wetness the way soil
  does — open water is always saturated at its surface, which is what makes it out-evaporate damp
  soil cell for cell. Temperature scales it exactly as it scales soil evaporation. It leaves through
  the same atmosphere delta, so the audit needs no new term.
- **The reserve is the loop, not a pipe.** Pond → humid air → condensation onto the surface, and dry
  soil drawing vapour back out of the air. That is how a real sealed jar moves water, and it waters
  the whole jar rather than just the banks — the reason a watertight liner is the right choice.
- **The cost is the same loop.** Higher humidity means fog more often, and fog is what lets mold take
  hold. A pond is a trade, not a free upgrade.
- *Done when:* the same jar with and without a pond, left unwatered, and the pond jar lasts
  measurably longer before the dehydration warning — and it fogs more often, but not permanently.

> **Built.** Open water evaporates from each column's surface toward 100% humidity, at
> `standing.evapFactor` = 0.08 of soil's full-drive rate. At soil's own rate a full pond was gone in
> about four days, because soil has a brake (its surface dries and slows) and open water has none.
>
> Evaporation alone made a pond a slow watering can: in a closed jar, open water always gives its
> water to anything drier, and nothing flowed back, so a pond drained in about a month and did no
> better than pouring the same water into the soil. **Runoff** is what flows back: a surface cell's
> water above field capacity runs along the surface (level or downhill, never over a ridge, up to 8
> columns) into the nearest pond floor lower than where it started. Measured, a 600 mL drench beside
> a pond left its surface at 55% saturation after an hour where the same drench without one sat at
> 1,106%: the pond is the jar's drain. A jar with no lined pond is untouched, which the 14 pond-free
> scenarios confirm.
>
> Over five seeds and 40 days, `ponded` (the reference jar plus a 9-column pond) ran mean humidity
> 65.3% against 58.9%, fogged 2% of the time against never, tripped no failure, and grew within the
> reference jar's range, with slightly fewer plants since seeds cannot land on water.
>
> **Seepage keeps it.** Runoff starts at field capacity, and a normally kept jar's surface sits at
> about 55% of it, so runoff alone never ran and a pond in an ordinary jar still drained in 20-40 days.
> Damp ground in the catchment above 35% of field capacity now seeps slowly along the same route, so a
> pond's level reads how the jar is kept. Over 60 days: charged at 2,400 mL it stayed full; at 1,900
> it settled around two-thirds; at 1,400 it gave everything to the soil by day 20.
>
> Tuning it exposed a bug worth remembering: evaporation took from the first wet cell in a column and
> stopped, so the faintest film above a brim-full pond was all that ever evaporated, and the pond
> beneath looked as if it were holding its level when it had simply stopped losing any. It now draws
> its full amount down through the column.

**Found while building it: a sealed jar left dry loses its rooting-zone nutrients.** Not a pond bug,
but a pond scenario exposed it. Between sealing and the first watering, every tick costs early growth:
10 ticks (one second at 1x) halves it by day 3, and 100 costs 85%, because the first watering then
carries the nutrients in the top cells down out of reach (top cell 0.18 where it should be 1.51, with
the jar's total unchanged). Waiting while still *building* is harmless. The balance harness waters on
the same tick it seals, so every scenario measures a luckier start than a player, who has to reach for
the watering can, can ever get. **Known and accepted, not being fixed** (decided 2026-09-23); the pond
scenario sidesteps it by digging before sealing, which is also where a player would dig.

**4. Algae: a recoverable setback.**

> **Built.** See `src/sim/pond.ts`. Tracked per column rather than per cell: water moves every tick,
> and anything suspended in it would have to be carried by every one of those movements. Each wet
> column holds algae (in litter units, so its carbon needs no new exchange rate), dissolved food, and
> sourness; neighbouring wet columns mix.
>
> - **Food.** Litter on a pond floor now rots in the water (the stuck-litter gap, closed), and a flood
>   running off over-watered soil carries that soil's dissolved food in. A slow seep does not.
> - **Growth.** Light, food and CO2, the scarcest capping it, as the plants use. The lamp is the lever:
>   light is needed at a high level, so a dim pond cannot out-grow its own respiration.
> - **The harm is stale water, not oxygen.** The plan said an overnight oxygen dip; measured, oxygen in
>   this jar barely moves for anything (a 7-point drop would take ~500,000 litter units, a bloom is a
>   few hundred), so it could never have bitten. Instead a dying bloom sours the water, and a pond full
>   to its rim sours the soil of its banks, the first soil past the liner. This is what was actually
>   chosen: "stale water sours the soil around it a little".
> - **Recoverable.** Fed and lit brightly for 20 days then kept clean, a pond went from 40% green with
>   its banks at 0.31 sourness (roots are hurt at 0.30) to 1% green and 0.05 by day 36.
> - Drawn as a pea-green tint per column, steep enough that the 30% warning reads as green water; a
>   lesson card explains it the first time.
>
> **Retuned so algae builds up readily.** At first an ordinary pond peaked at 10% green: algae only
> ever happened to a pond someone had deliberately neglected, and duckweed and snails had nothing to do.
> Now the slow seep of damp ground carries a little dissolved food in, as groundwater does, and algae
> need less light and starve less easily. Measured over 40 days: `ponded`, left alone, is green by
> day 6 and peaks at 52%; `green-water` peaks at 68%; `shaded-pond` stays at 1%. The shade lever
> survived the change, which was the point of checking it.
>
> That retune broke duckweed (37% green under a mat), and the cause was not the shade: its hunger
> counted CO2, which in this jar never gets near duckweed's half-saturation, so a fed mat was always
> treated as a quarter-starved and levelled off at two-thirds cover. Hunger is now food alone; a mat
> closes to about 90% and holds the water at 7% peak, clearing to 0%.

**5. The floating plant: duckweed, then lily pads.**

> **Replaced by water lilies**, at the player's call, keeping everything it does. Same simulation
> (pads cover the surface, take the light and the food before the algae, cut evaporation, spread, die
> back when stranded), renamed throughout: the Lily pads tool, `pond.lilies`, `balance.lilies`, and the
> `lily-pond` scenario. Drawn as broad flattened pads, each with its V notch, overlapping, on long stems
> down to the floor, shading the water beneath; once a bed takes hold, pink flowers with a golden
> centre open on it, and pink buds. What follows records how it was built and tuned as duckweed.

> **Built.** A per-column cover in `src/sim/pond.ts`, planted with the Duckweed tool on water (refused
> on dry ground) and charged to the air as moss is. It floats on top, so it takes the light and the
> dissolved food before the algae beneath it; a full mat lets 15% of the light through, so the water
> under it is dim, not dark. It spreads to neighbouring wet columns, cuts evaporation, and dies back to
> litter when stranded on a dry floor or starved in clear water.
>
> Measured over 40 days on the `green-water` pond: one click on day 1 holds the water to 7% green at
> its peak, clearing to 0%, against 68% without it; the plants do better too, since the banks never
> sour. Drawn as real duckweed is: clusters of small oval fronds, a parent with a daughter or two
> budding off, in three greens with a sheen along the top edge, some trailing a single fine root, and
> the water under a thick mat shaded, fading downward, because the mat is a roof.

**6. Ramshorn snails.** The grazer.

> **Built.** A per-column population on the springtail pattern, added with the Snails tool on water.
> They graze algae, then litter on the pond floor; what they eat is breathed straight back out as CO2
> (so they carry no carbon of their own, as springtails do not), and a share returns to the water as
> droppings. Food sets the colony's ceiling; hunger thins it to a dormant few, not to nothing. A dry
> pond kills every one.
>
> - **Stale water kills them**, graded by how far past 0.6 it is. At first the line was 0.35, and a
>   heavily fed pond was already 0.41 stale by the time it LOOKED green, so snails added to cure it
>   died within a day. The rule is for a pond left to rot, not for a green one.
> - **Paced to read as a colony at work.** Put into a pond 31% green and 0.41 stale, they clear it over
>   three days (31, 24, 6, 0%), booming to about 50 and settling at 25 once the food is gone, with the
>   stale water clearing behind them. The first tuning did it inside a day, which read as a switch.
> - Drawn as small coiled reddish shells on the pond floor, walls and steps.

**6b. A pond worth looking at.** Added after the first ponds read as flat blue shapes: almost nothing
moved in them or stood up out of them.

> - **Living water** (drawing only): pebbles on the floor; slanting light shafts by day, dimmed by green
>   water (a light web drawn along the edge-on floor read as clumps of foam); bubbles rising, more of
>   them where something rots or snails feed; and a leaf landing on a pond floats and drifts before it
>   sinks to the floor it will rot on.
> - **Hornwort**, a submerged plant set with its own tool: whorled needle stems growing up from the
>   floor, soaking up food more efficiently than algae and holding them back besides, giving off oxygen
>   bubbles by day. A duckweed mat shades it as it shades algae, so the cures compete. It is the
>   everyday cure: an ordinary pond peaks at 12% green with it against 52% without, while a pond being
>   overfed under a bright lamp is more than it can hold back alone (41% against 68%).
> - **Hornwort, revised on request:** up to three stems a column reaching nearly to the surface, varied
>   in height, lean and bushiness. Tried in a lighter green with the water it stands in tinted green;
>   settled on dark, cool greens and clear water. Bare patches of floor it
>   could not grow on were tried and taken out again at the player's call; algae grew over the gaps
>   and weakened it as a cure (29% green against 12% without them).
> - **Reeds**, the marginal plant, built as a pond plant rather than a fourth species: tall stems
>   standing up out of the water with arching leaves and, once a bed takes hold, cattail heads. They
>   grow best in the shallows, spread along the pond, and draw its water up into the air (1.6x open
>   water's evaporation at full cover), so a reedbed dries a pond faster and humidifies the jar. They
>   ride out a dry spell for about a fortnight. Not a cure for algae: what they take in food they give
>   back in what they shed, and measured it came out about even.
> - **Reeds grow only at a pond's edges**, at the player's call: its two outermost columns, and the
>   bank one tile out beyond each (fed by the pond water at that edge, drawn standing on the ground).
>   Never in the middle of a pond, never two tiles out. A click in the middle plants BOTH edges of that
>   pond; a click at an edge or its bank plants that side only; two tiles out is refused. They spread
>   only between an edge and its bank, and reeds a pond shrinks away from die back slowly.
> - **Fish** replaced water fleas, at the player's call. Small orange fish swim the pond, eat algae only
>   as much as the water is visibly green and pick litter off the floor, their waste feeding the water.
>   They breed slowly up to a stocking limit set by the pond's volume, go hungry slowly in a spotless
>   pond, and die in stale water or a dry one. They are livestock, not a cure: a gentle check on algae.
> - **Snails were vanishing.** Their shells were drawn per column and rounded down, so a culture spread
>   over the pond drew nothing within the hour; and they starved in a clean pond inside twelve hours.
>   Shells are now shared out by the pond's total, and every pond carries a small colony on the film on
>   its surfaces.
>
> - **Fish were starving in a well-kept pond.** Their meal counted an algae appetite as well as a
>   litter one, so in a pond kept clear of algae a fish with plenty of litter was 57% fed at best, and
>   with no food of their own a new pond starved them from the first minute: three fish were under two
>   in twenty days, well under a minute of play at 128x. One appetite now, filled by algae then litter,
>   plus the film of tiny life every pond carries (about two fish's worth in a 9-column pond). They
>   hold and slowly breed in a kept pond; overstocking, stale water and drying still kill them. And
>   they no longer blink out over the shallows: they turn back at the edge of the deep water.
>
> - **Tested on bigger ponds, at the player's prompting, and three things were broken that the
>   9-column test pond never showed.** (1) Nothing wider than 24 columns could be lined: the cap that
>   kept the liner off the undug jar blocked every real big pond. The grid now records which cells the
>   player dug (`SubstrateGrid.dug`), and a Mud click lines only when it lands inside a dug hollow; any
>   width. (2) Overfilling starved the pond: the can pours 240 mL a second into a pond that holds ~300,
>   the flood over the ground counted as pond, and its plants, food and animals spread across the whole
>   wet surface; lilies were dead in five days. Pond life now lives only in lined columns, and only the
>   water inside the dug hollow counts as the pond's. A 4-second pour now grows lilies to 92%. (3) A jar
>   flooded six cells deep (40 seconds of pouring, ~10 L in a jar meant for 2.4) still starves its
>   pond's plants, because nothing can seep into a pond under a lake; left as physics, not a bug.
>
> Three bugs found on the way, all conservation leaks: pond life spread onto the thin overflow film
> around a brimming pond and died when it dried (spreading is now between real pond columns only); a
> flea's resting eggs grazed away every trace of algae, so a pond with fleas never greened; and fish
> columns under a hundredth of a fish were rounded to zero, deleting the trickles fish spread in every
> tick, so three fish were gone in a day.

**7. The marginal plant.** A new species that lives with its feet in the water.

- A consequence of the watertight liner worth stating plainly: the pond does **not** wet its banks, so
  a bog plant that wanted wet banks would have nowhere to live. It has to root **in** the pond — its
  roots grow into water cells and anchor on the mud floor, the only species allowed to do either.
- Waterlogging does not rot it; ordinary soil is too dry for it.
- Last, because it is the only stage that changes the rooting rules and adds a fourth species, which
  touches every species table, the harness, and the tests.

**Clearing a pond.** *Built.* The **Clear pond** tool (Aquatic tab) kills every plant in the pond you
click: lilies, hornwort and algae across it edge to edge, and its reeds, the bank's included (clicking
a bank reed spot clears the pond it feeds). Fish and snails are spared. Nothing leaves the jar: the
dead plants fall as litter where they grew, so the carbon books need no new term, and that litter rots
back into the water as food, which is what lets algae return. A bloom killed all at once sours the
water exactly as one dying back on its own does (`sourPerDeadUnit`).
> Measured: a pond left to go green is already stale (sour 1.8 against the fish's 0.45) before the tool
> is ever used; clearing it takes that to 2.5. Its fish die, as they were already going to, the snails
> ride it out, and the sourness is gone within about a week.

**Why this order.** Evaporation first, because without it a pond is a cost. Algae next, because it is
the hazard that makes a pond something to manage rather than set and forget. Then its two answers —
duckweed, then snails — and the marginal plant last, as the one stage that changes core rules.

## Traps, known in advance

1. **Conservation will fight this, and that is the point.** Anything that fills a water cell —
   painting soil into a pond, a grain of gravel settling into one — has to put that water somewhere
   first, or the audit throws.
2. **Levelling has to be whole-row, not pairwise.** Pairwise trades either oscillate (moving the
   whole difference) or crawl (moving less), and a steady pour outruns a crawl. Solved in stage 2 —
   keep it that way when anything new starts moving water.
3. **Roots drown for free.** Saturation already drives root rot, so a plant with roots in a pond
   suffers with no new code. Worth knowing before tuning anything.
4. **Evaporation rate is the dangerous number.** Too high and every jar fogs permanently, which turns
   mold from a hazard into a certainty across all fourteen balance scenarios.
5. **The jar's water budget probably has to grow.** A pond is a large standing volume, and the
   reference jar is charged once with ~2,400 mL. That interacts with root rot, which triggers on
   saturation.
6. **Algae touches the light field**, which is on the hot path: every tick, every cell. Shading has to
   be a cheap attenuation through water cells, not a second pass.
7. **Algae's oxygen swing could make faunaO2 fire in jars that never had a pond** if any of it leaks
   into the shared gas books when there is no water. Gate it on water existing, and keep the matrix's
   pond-free scenarios as the proof.
8. **A fourth species** (stage 7) breaks every place that assumes three — species tables, the harness,
   the species tests, the panel's picker.

## Balance targets to add

- `ponded` — **added**: more humid, occasionally fogged, no worse off; fog capped at a quarter of the run.
- `leaky-basin` — dug but unlined: the water is gone, and the jar is no better off for it.
- `green-water` — **added**: a bright pond fed leaves daily passes 30% green.
- `shaded-pond` — **added**: the same fed pond under a dim lamp stays under 10%.
- `lily-pond` (first `duckweed-pond`) — **added**: the green-water pond with lilies stays under 10% green.
- `snail-pond` — **added**: the green-water pond with snails stays under 10%, and the colony lasts.
- The A/B that justifies the feature: the same jar with and without a pond, left unwatered until
  something fails.

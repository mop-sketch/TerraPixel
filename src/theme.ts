// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Presentation values only. Nothing here may affect simulation outcomes — that is why it lives
 * outside src/sim entirely, and why a balance pass never has to read this file.
 */

export const THEME = {
  cellPx: 12,
  /** The page the jar is drawn on. Yellowed, never white. */
  bg: '#efe7d8',
  /**
   * Fog on the inside of the glass. See `Renderer.drawFog`.
   *
   * Fog still LIGHTENS, which reads on cream as a soft bloom over the plate. Three tints rather than
   * one because a single flat wash reads as the renderer dimming, not as a jar misting up: the veil
   * gathers under the lid, the banks cling to the glass at the edges, and the blobs drift.
   */
  fog: {
    /*
     * COOL grey-blue, not white, and that is the whole trick.
     *
     * White fog was invisible by day and obvious at night, because the daytime jar is already warm
     * cream at rgb(234,226,203): there are barely twenty levels of headroom left before pure white, so
     * adding white to it does almost nothing however hard it is pushed. Measured, the same fog moved the
     * night air 62% further than the day air. Opacity could not fix that — at full strength white caps
     * out around a 63-unit shift, and by then it is an opaque rectangle with the jar hidden behind it.
     *
     * Cooling the mist instead trades brightness for hue. Grey-blue over warm cream reads instantly
     * because it changes the colour's character rather than its level, and it still lifts the darker
     * night jar, so both times of day gain.
     */
    veil: 'rgba(206, 217, 222, 1)',
    /** Deeper at the glass, where the mist is thickest and picks up the cold of the wall. */
    bank: 'rgba(182, 200, 211, 1)',
    blob: 'rgba(220, 229, 231, 1)',
  },
  droplet: 'rgba(63, 107, 138, 0.80)',

  /**
   * Standing water: a puddle, a flooded drainage layer, a pond.
   *
   * Translucent rather than opaque, so the gravel and soil it is sitting in stay visible through it —
   * which is how you read depth in a real jar, and what stops a flooded drainage layer looking like a
   * solid blue brick. The surface line is what actually says "water" rather than "wet".
   */
  water: {
    body: 'rgba(96, 148, 176, 0.42)',
    surface: 'rgba(63, 107, 138, 0.72)',
    /** The light caught just under the surface, and the rings a pour makes on it. */
    glint: 'rgba(242, 248, 250, 0.55)',
    /** The pale broken strokes drifting inside a pond. */
    streak: 'rgba(232, 242, 247, 0.28)',
    /** Light dancing on the pond floor by day. */
    shimmer: 'rgba(250, 252, 236, 0.9)',
    /** A rising bubble: nearly clear, with a rim and a glint doing the work. */
    bubble: 'rgba(236, 246, 250, 0.35)',
    /**
     * Hornwort: dark, cool greens, as the real plant is under water. Three of them, so a bed has depth
     * rather than one flat colour, and still clearly apart from the lily pads' warmer green above.
     */
    hornwort: 'rgba(52, 104, 62, 0.95)',
    /** Older, lower growth: the darkest of the three. */
    hornwortDeep: 'rgba(34, 78, 50, 0.95)',
    /** New growth at the tips: a touch lighter, so a stem still reads as growing upward. */
    hornwortTip: 'rgba(76, 128, 72, 0.95)',
    /** Stones on the pond floor. */
    pebble: 'rgba(132, 122, 106, 0.95)',
    pebbleInk: 'rgba(60, 54, 46, 0.5)',
    /**
     * Algae at full bloom: a murky pea-green, deliberately NOT the jar's leaf greens, so green water
     * reads as something gone wrong with the water rather than as a plant growing in it.
     */
    algae: 'rgba(104, 128, 58, 1)',
  },

  /**
   * Lily pads: a deep, glossy leaf green, the one plant that sits ON the pond, with pink flowers and a
   * golden centre. A pond under lilies should look TENDED, and a green pond should look
   * neglected, at a glance.
   */
  lily: {
    pad: 'rgba(84, 142, 70, 1)',
    padEdge: 'rgba(40, 84, 40, 0.75)',
    /** The light catching the front rim of a pad. */
    padRim: 'rgba(196, 226, 150, 0.8)',
    /** The long stems down to the floor, seen through the water. */
    stem: 'rgba(92, 128, 72, 0.5)',
    /** The shade a bed of pads casts on the water beneath it. */
    shade: 'rgba(40, 70, 62, 1)',
    flowerPink: 'rgba(244, 188, 204, 1)',
    flowerInk: 'rgba(170, 120, 130, 0.6)',
    flowerCentre: 'rgba(242, 196, 64, 1)',
  },

  /**
   * Fish: a warm orange, the one strong colour in the pond, so a fish is the first thing the eye
   * finds in it. A darker tail and fins, a paler belly, and an eye.
   */
  fish: {
    body: 'rgba(232, 128, 58, 0.95)',
    belly: 'rgba(250, 196, 140, 0.9)',
    fin: 'rgba(200, 96, 44, 0.9)',
    ink: 'rgba(110, 52, 24, 0.6)',
    eye: 'rgba(30, 26, 22, 0.95)',
  },

  /** Reeds: a dusty sage green, and cattail heads in the deep brown they are named for. */
  reed: {
    stem: 'rgba(98, 128, 66, 0.95)',
    blade: 'rgba(126, 152, 78, 0.9)',
    head: 'rgba(112, 72, 42, 0.95)',
    ink: 'rgba(64, 40, 22, 0.6)',
  },

  /** Ramshorn snails: a warm reddish-brown shell, the colour the real ones are sold for. */
  snail: {
    shell: 'rgba(150, 82, 52, 0.95)',
    ink: 'rgba(70, 38, 24, 0.7)',
  },

  /**
   * Condensation on the inside of the glass. See `Renderer.drawCondensation`.
   *
   * Water on glass is not a blue dot: it is nearly colourless, and what makes it read is the specular
   * highlight on its shoulder and the darker meniscus where it meets the pane. The bead body is
   * therefore barely tinted — almost all of the effect is `sheen` and `rim`.
   */
  bead: {
    /*
     * DEEPER than the fog it forms on, which is the only way it reads.
     *
     * The first pass tinted beads the same pale blue-grey as the mist and they disappeared into it —
     * water on misted glass is legible because the bead is denser than the film around it, refracting
     * a darker core and a hard white catchlight.
     */
    body: 'rgba(166, 195, 210, 0.6)',
    rim: 'rgba(68, 106, 132, 0.7)',
    sheen: 'rgba(255, 255, 255, 0.95)',
  },
  /** How many beads the glass can carry at once. Enough to read as a film, not so many it is noise. */
  beadCount: 54,

  /**
   * The jar as an ink-and-watercolour plate. See src/render/plate.ts.
   *
   * Ink is the page's warm near-black at two weights: strong for the glass and the soil surface, faint
   * for layer boundaries and the inner wall, so the plate has one confident line and quiet ones inside.
   */
  plate: {
    /** The paper inside the glass, a touch lighter than the page so the jar reads as an object. */
    interior: '#f4eee2',
    interiorRgb: 0xf4eee2,
    /** Glass wall thickness, in cells. */
    wall: 0.42,
    glassWash: 'rgba(140, 166, 170, 0.18)',
    lipOpen: 'rgba(140, 166, 170, 0.30)',
    /** A closed lid is a cork-toned cap, so the lid state is visible on the jar, not only the panel. */
    lipClosed: 'rgba(176, 142, 96, 0.55)',
    highlight: 'rgba(255, 255, 255, 0.55)',
    shadow: 'rgba(44, 42, 38, 0.10)',
    inkStrong: 'rgba(44, 42, 38, 0.72)',
    inkFaint: 'rgba(44, 42, 38, 0.28)',
    /** Paper grain laid over the substrate with `multiply`. */
    grainAlpha: 0.35,
    /** How strongly the ground's soft blotches show, under multiply. */
    mottleAlpha: 0.32,
    /** What the ground darkens toward with depth below its surface (see `paintWash`). */
    depthShade: 0x1c1610,
    pebbleFill: 'rgba(232, 226, 212, 0.55)',
    pebbleInk: 'rgba(60, 56, 50, 0.35)',
    charcoalFleck: 'rgba(28, 26, 24, 0.55)',
    soilSpeck: 'rgba(58, 40, 22, 0.35)',
    standingWater: 'rgba(63, 107, 138, 0.28)',
    /**
     * The Mud tool's hover preview. See `Plate.drawMudPreview`.
     *
     * `mudPreviewArea` is water's own blue at a fraction of its usual strength — a hint of the pond
     * that will exist, not the pond itself. `mudPreviewLiner` is mud's own wet colour, at enough
     * strength to read as "this ground becomes this" over the material rather than a wash on top of
     * it — a filled highlight rather than a UI marquee, since it is clipped to the ground's own
     * silhouette and can afford to be plainer about it.
     */
    mudPreviewArea: 'rgba(63, 107, 138, 0.14)',
    /** The brush preview: an ink outline round what will change, and a faint ring for its reach. */
    brushEdge: 'rgba(44, 42, 38, 0.85)',
    brushReach: 'rgba(44, 42, 38, 0.35)',
    /** What the Dig brush will clear: the paper showing through, a little brighter than air. */
    brushDig: 'rgba(252, 248, 238, 0.75)',
    mudPreviewLiner: 'rgba(70, 60, 48, 0.4)',
    /**
     * Soured ground: soil holding the acids decay leaves behind, and charcoal that has filled up.
     *
     * A cold blue-grey, chosen to be the one direction the substrate palette never otherwise travels —
     * every other soil colour is a warm brown, so sourness reads as wrongness rather than as dampness.
     * Toxin was previously drawn NOWHERE outside the debug overlay: a player whose roots were being
     * eaten by it had no way to see where it was or how bad, only the words "Sour soil" on a card.
     */
    sour: 0x5d6b66,
  },

  /**
   * Night, washed over the jar. The lamp is drawn as a warm pool from above.
   *
   * New in this pass: the jar previously looked identical at noon and midnight, because the only
   * place the renderer read the light field at all was the debug overlay.
   */
  night: { tint: 'rgba(72, 88, 122, 1)', maxAlpha: 0.17 },

  /**
   * The lamp's light, all warm: a glow falling from the top, a paler bloom right under the lamp, the
   * shafts, the pools they leave on the soil, the web of caustics on the back glass, and the dust in
   * the beams. Alphas live in lamplight.ts, scaled by how much light the lamp is giving.
   */
  lamp: {
    glow: [255, 208, 128],
    bloom: [255, 240, 205],
    shaft: [255, 228, 168],
    pool: [255, 214, 140],
    caustic: [255, 222, 150],
    mote: [255, 248, 226],
    /** The faint warm haze in the air by day, which the beams cut through and their shadows show. */
    haze: [96, 82, 60],
  } as const,

  /**
   * How each substrate is drawn, dry -> wet, packed 0xRRGGBB, keyed by SubstrateId.
   *
   * Lives here and not in `src/sim/config/content.ts`, where it used to sit beside genuine physics
   * like permeability and cohesion. Wet is always DARKER than dry: that is what makes moisture
   * legible at a glance, and it works the same way on paper as it did on black.
   */
  substrate: {
    0: { dry: 0xefe7d8, wet: 0xefe7d8 }, // air — the page shows through
    1: { dry: 0xcacac7, wet: 0x9d9d9a }, // drainage gravel: a light stone grey
    2: { dry: 0x6d665c, wet: 0x3f3a33 }, // activated charcoal
    3: { dry: 0xb08a5e, wet: 0x6b4a2c }, // potting soil
    /*
     * Cool grey-brown, and barely changing when wet — mud is already wet.
     *
     * Pushed away from soil's warm orange on purpose. At the first values it was merely a darker
     * brown, which against soil in shadow was almost indistinguishable — and a liner you cannot see
     * is a liner you cannot check before pouring.
     */
    5: { dry: 0x6b6459, wet: 0x4a463f }, // mud
    4: { dry: 0xefe7d8, wet: 0xefe7d8 }, // glass — stroked, never filled
  } as Record<number, { dry: number; wet: number }>,

  /**
   * Per-species look, indexed by SpeciesId (Fern 0, Herb 1, Succulent 2).
   *
   * The `stressed` and `dying` ends are kept close across species on purpose: chlorosis has to read
   * as chlorosis no matter what the plant is, or the single most important diagnostic in the game
   * stops being legible. Species differ in their HEALTHY colour and in leaf shape.
   */
  // `shape` picks the leaf drawing in plants.ts. `length` scales the leaf against the distance from its
  // stem node to its leaf node (about one cell); `width` is the blade's half-width as a fraction of length.
  /*
   * Leaf sizes are the cheapest lever the jar has on LUSHNESS, and the only one that costs the
   * simulation nothing.
   *
   * A sealed jar's total leaf is bounded by the light reaching it, so no amount of tuning makes it grow
   * more tissue. How much green that tissue COVERS is a drawing decision, though, and it is what
   * actually sells the gap between a bare landscape and an overgrown one. Enlarged roughly a third over
   * the first pass, which reads as a fuller canopy from identical simulation state.
   */
  species: [
    { leaf: { healthy: [0x33, 0x6b, 0x44], stressed: [0xb0, 0x82, 0x28], dying: [0x7a, 0x4c, 0x24] },
      stem: '#2f5a38', shape: 'frond', length: 2.0, width: 0.2,
      // A spray of tiny cream florets.
      bloom: { petal: 'rgba(255, 249, 222, 1)', ink: 'rgba(104, 92, 52, 0.85)', centre: '#dcae3a' } },
    { leaf: { healthy: [0x4b, 0x83, 0x38], stressed: [0xb0, 0x82, 0x28], dying: [0x7a, 0x4c, 0x24] },
      stem: '#3d6530', shape: 'ovate', length: 1.7, width: 0.34,
      // A spike of lilac blossoms.
      bloom: { petal: 'rgba(170, 140, 212, 1)', ink: 'rgba(92, 64, 128, 0.55)', centre: '#e9dcf4' } },
    { leaf: { healthy: [0x6d, 0x96, 0x7c], stressed: [0xb0, 0x82, 0x28], dying: [0x7a, 0x4c, 0x24] },
      stem: '#5a7352', shape: 'paddle', length: 1.6, width: 0.27,
      // A magenta daisy with a golden heart.
      bloom: { petal: 'rgba(222, 72, 138, 1)', ink: 'rgba(130, 36, 80, 0.5)', centre: '#f2c24a' } },
  ],
  /**
   * The overgrowth that frames a FINISHED jar. See src/render/overgrowth.ts.
   *
   * Its own green, deliberately, and deeper and bluer than any of the three species. The vines were
   * first drawn with `species[0]` — which is the Fern — so they inherited a fern's stem colour and a
   * fern's leaf green, and then read as more ferns arriving rather than as the jar being reclaimed by
   * something else. A finished jar should look like a different place, and that starts with a colour
   * nothing already growing in it uses.
   */
  vine: {
    stem: '#2c4f33',
    leaf: [0x3f, 0x6b, 0x45] as const,
    /** The air of an overgrown jar, laid over the interior like the fog wash. Kept very low. */
    air: 'rgba(86, 132, 84, 1)',
    /** Motes drifting in that air. */
    mote: 'rgba(122, 168, 110, 1)',
  },

  /**
   * A starving stem, laid OVER the species colour in proportion to the plant's starvation stress.
   *
   * Overlaid rather than blended so no stem colour has to be parsed out of its hex string, and so a
   * Fern, a Herb and a Succulent all yellow toward the same sickly tone while keeping their own greens
   * underneath at lower stress.
   */
  stemStarved: '#c4812c',
  /**
   * What a plant that died of natural causes leaves standing.
   *
   * A naturally dead plant keeps its stems — it loses every leaf and root, and the bare frame remains
   * as a record of what grew there. Only a seedling that never established is cleared away outright.
   */
  stemDead: '#6d5439',
  /** Rot blotching the dead frame. */
  stemDeadSpot: 'rgba(30, 24, 18, 0.6)',
  /**
   * Pests on a leaf: pale cottony specks with a dark edge, like mealybugs.
   *
   * Pale on purpose. Every other thing on a blade — veins, health tint, thirst curl — is a darker or
   * yellower green, so a bright speck is the one mark that cannot be mistaken for the leaf's own
   * condition. The ink edge keeps it legible on the yellowed leaf of a plant that is already failing.
   */
  /**
   * The pencilled note above a plant while the pesticide tool is out.
   *
   * A SYSTEM script face, never a web font: the whole game ships as one HTML file that has to work with
   * no network, and a downloaded font would either break that or have to be inlined as base64. The
   * per-letter jitter in `drawPestNotes` is what carries the handwriting when the fallback is plain.
   */
  noteFont: "'Segoe Script', 'Ink Free', 'Bradley Hand', 'Snell Roundhand', 'Comic Sans MS', cursive",
  /** Pencil, not ink: a note the keeper scribbled, not part of the printed plate. */
  noteInk: 'rgba(52, 46, 38, 0.92)',
  /** Paper halo behind the note, so it stays readable over leaves, soil and fog alike. */
  notePaper: 'rgba(245, 240, 228, 0.86)',
  pest: 'rgba(250, 247, 234, 0.96)',
  pestInk: 'rgba(58, 50, 38, 0.75)',

  /** The faint ink edge on leaves, petals and under stems — the plate's layer-line weight. */
  plantInk: 'rgba(44, 42, 38, 0.30)',
  /** A herb leaf's midrib. */
  leafVein: 'rgba(44, 42, 38, 0.22)',
  /** The soft sheen along a succulent paddle. */
  leafHighlight: 'rgba(255, 255, 255, 0.35)',
  /**
   * The ground's grains, as they look against the glass (see `Plate.drawDetail`): soil specks fine and
   * coarse, pale grit and the shadow it sits in, root fibre; the stone tones gravel and soil pebbles are
   * drawn from, and their ink; the gaps between gravel; charcoal chunks, their lit edges and glints;
   * streaks in mud; and the shade toward the glass at the jar's sides and bottom.
   */
  ground: {
    speck: 'rgba(52, 36, 20, 0.42)',
    speckDark: 'rgba(40, 27, 15, 0.55)',
    grit: 'rgba(236, 229, 212, 0.9)',
    gritShade: 'rgba(40, 28, 16, 0.3)',
    fibre: 'rgba(72, 46, 24, 0.55)',
    // Light greys, a shade cooler or warmer apiece: gravel reads as pale grey stone.
    stones: [
      [206, 206, 204],
      [190, 190, 189],
      [220, 220, 218],
      [178, 179, 181],
      [198, 197, 194],
    ] as ReadonlyArray<readonly [number, number, number]>,
    stoneInk: 'rgba(48, 42, 36, 0.45)',
    gravelGap: 'rgba(80, 80, 80, 0.2)',
    charcoal: 'rgba(30, 28, 26, 0.9)',
    charcoalLight: 'rgba(58, 55, 52, 0.9)',
    charcoalEdge: 'rgba(150, 146, 140, 0.55)',
    glint: 'rgba(235, 235, 230, 0.85)',
    mudStreak: 'rgba(40, 36, 32, 0.35)',
    glassShade: 'rgba(24, 18, 12, 0.07)',
  },
  /** Water beading on the leaves: the bead, its thin edge, the glint of the lamp in it, and its splash. */
  dew: {
    bead: 'rgba(214, 234, 242, 0.82)',
    edge: 'rgba(64, 98, 118, 0.5)',
    glint: 'rgba(255, 255, 255, 0.95)',
    splash: 'rgba(190, 220, 236, 0.9)',
    /** The spot of lamplight a bead focuses onto the leaf, in the middle of its shadow. */
    focus: 'rgba(255, 246, 214, 0.85)',
  },
  /**
   * How leaves take the lamp and their age (see `PlantArt.drawLeaves`): a fresh light green for new
   * growth, a deep green for old, the cool dark of shade (the far edge of a leaf, or one under the
   * canopy), the warm pale light on the edge facing the lamp, and the soft shadow the planting casts.
   * No gold: a golden leaf reads as a yellowing one, and yellowing is how a leaf says it is sick.
   */
  leafLight: {
    fresh: [150, 196, 96],
    deep: [28, 66, 40],
    shade: [24, 44, 38],
    highlight: [246, 240, 206],
    cast: [34, 44, 30],
  } as const,
  /** Root hairs: the fine fuzz around a living root, in its own light brown. */
  rootHair: 'rgba(206, 184, 148, 0.5)',
  /** The same fuzz seen as a whole: a faint haze along every root. */
  rootGlow: 'rgba(206, 184, 148, 0.07)',
  /** A thin warm edge under each root, so a pale root still reads against gravel. */
  rootInk: 'rgba(88, 72, 52, 0.38)',
  flowerCentre: '#e3bf62',
  /** Fallback for anything drawn without a species in hand. */
  leaf: { healthy: [0x5c, 0xa8, 0x4a], stressed: [0xc9, 0xa8, 0x2e], dying: [0x8a, 0x5a, 0x2a] },
  litter: 'rgba(122, 88, 48, 0.80)',
  moss: [0x4f, 0x7a, 0x3a] as const,
  // Mold and springtails were once plain near-white specks, which only read on a near-black jar. On
  // paper, pale needs more than colour to show: mold gets its halo, springtails an outline and a shape.
  /*
   * Pale and cool, deliberately unlike anything else on the plate.
   *
   * This was a muted olive-grey at 0.66 alpha, which sat at almost exactly the soil's own value — so a
   * jar at 100% mold coverage, every hostable cell fully overrun, read as slightly dusty soil and was
   * indistinguishable from the litter flecks drawn beside it. Real mold on soil is whitish fuzz, and
   * the contrast is the whole point: this is the jar's most alarming diagnosis and the player has to
   * be able to see it without hunting.
   */
  mold: 'rgba(196, 202, 184, 0.95)',
  /** The soft halo around a colony, which is what makes it read as fuzz rather than as blobs. */
  moldFuzz: 'rgba(196, 202, 184, 0.35)',
  /**
   * Springtails are cream, as the white Folsomia real terrarium keepers culture are. The ink outline,
   * the legs and the antennae keep them reading as bugs rather than as flecks of mold.
   */
  springtail: '#f1eadb',
  springtailInk: 'rgba(72, 60, 44, 0.75)',
  springtailLeg: 'rgba(84, 70, 52, 0.8)',
  stem: '#3d6530',
  /** Living roots are a very light brown, as they look against the glass of a real jar. */
  root: '#cdb592',
  flower: '#c4587c',

  gauge: {
    good: '#5f7f4a',
    warn: '#b8892c',
    bad: '#a9462f',
    track: 'rgba(44, 42, 38, 0.10)',
    text: '#2c2a26',
    dim: '#7a7265',
  },

  /** Fog opacity follows an EMA of its target, never the raw value, or it visibly strobes. */
  fogEmaAlpha: 0.04,
  /**
   * How thick the glass gets, 0-1, the moment the jar fogs.
   *
   * Deliberately high rather than the start of a ramp: fog appears at 80% RH and NOWHERE below it, so
   * the only thing it can mean is that the latch has tripped and mold can now take hold. An earlier
   * version faded a haze in from 55% and topped out gently, which made the threshold invisible — the
   * glass looked much the same either side of the one line the player is judged against.
   */
  fogOn: 0.85,

  /**
   * Hard ceiling on live effect sprites.
   *
   * Not a nicety. `consumeEvents` drains once per TICK rather than per frame, so at 32x about five
   * ticks' worth of events land in a single frame. The uncapped version of exactly this already bit
   * once: the `watered` branch pushed a bead per event with no limit, and a held pour at 32x
   * projected to roughly 2,000 sprites.
   */
  maxEffects: 96,

  /** Colours for the moments the sim reports. Restrained and physical, never UI flashes. */
  fx: {
    /** A plant giving up: its tissue browns where it stood. */
    wither: '#7a5836',
    /** A root torn free by digging, or damaged by amending around it. */
    severExposed: '#b4705a',
    severAmended: '#9a7f5c',
    /** The comeback — a leafless plant putting out a new leaf. */
    rescue: '#7fd48a',
    /** The sweep of light across the glass when the jar is sealed. */
    /**
     * A pesticide spray: a sickly yellow-green mist, deliberately NOT the jar's healthy greens or the
     * clean blue of water, so a spray never reads as watering and the colour itself says "chemical".
     */
    spray: 'rgba(196, 204, 92, 0.55)',
    /** Failure pulse at the glass edge. Matches the panel's bad state so they read as one signal. */
    alarm: 'rgba(169, 70, 47, 0.45)',
    /** The glow around a flower as it opens. The only effect that gets one. */
    bloomGlow: 'rgba(196, 88, 124, 0.38)',
    /**
     * The glint that sweeps across a hollow the moment mud lines it. Wet mud's own colour rather than
     * water's blue — this is the seal being pressed into place, not the pond it will later hold.
     */
    liner: 'rgba(70, 60, 48, 0.55)',
  },
} as const;

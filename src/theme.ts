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
    pebbleFill: 'rgba(232, 226, 212, 0.55)',
    pebbleInk: 'rgba(60, 56, 50, 0.35)',
    charcoalFleck: 'rgba(28, 26, 24, 0.55)',
    soilSpeck: 'rgba(58, 40, 22, 0.35)',
    standingWater: 'rgba(63, 107, 138, 0.28)',
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
   * How each substrate is drawn, dry -> wet, packed 0xRRGGBB, keyed by SubstrateId.
   *
   * Lives here and not in `src/sim/config/content.ts`, where it used to sit beside genuine physics
   * like permeability and cohesion. Wet is always DARKER than dry: that is what makes moisture
   * legible at a glance, and it works the same way on paper as it did on black.
   */
  substrate: {
    0: { dry: 0xefe7d8, wet: 0xefe7d8 }, // air — the page shows through
    1: { dry: 0xb9b2a4, wet: 0x8a8478 }, // drainage gravel
    2: { dry: 0x6d665c, wet: 0x3f3a33 }, // activated charcoal
    3: { dry: 0xb08a5e, wet: 0x6b4a2c }, // potting soil
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
      stem: '#2f5a38', shape: 'frond', length: 2.0, width: 0.2 },
    { leaf: { healthy: [0x4b, 0x83, 0x38], stressed: [0xb0, 0x82, 0x28], dying: [0x7a, 0x4c, 0x24] },
      stem: '#3d6530', shape: 'ovate', length: 1.7, width: 0.34 },
    { leaf: { healthy: [0x6d, 0x96, 0x7c], stressed: [0xb0, 0x82, 0x28], dying: [0x7a, 0x4c, 0x24] },
      stem: '#5a7352', shape: 'paddle', length: 1.6, width: 0.27 },
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
  rootHair: 'rgba(95, 74, 44, 0.45)',
  flowerCentre: '#e3bf62',
  /** Fallback for anything drawn without a species in hand. */
  leaf: { healthy: [0x5c, 0xa8, 0x4a], stressed: [0xc9, 0xa8, 0x2e], dying: [0x8a, 0x5a, 0x2a] },
  litter: 'rgba(122, 88, 48, 0.80)',
  moss: [0x4f, 0x7a, 0x3a] as const,
  // Both of these used to be near-WHITE, which only worked because the jar was near-black. On paper
  // they would have vanished completely — and a dark speck is closer to a real springtail anyway.
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
  springtail: '#4a453c',
  stem: '#3d6530',
  root: '#5f4a2c',
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
    // Raised from 0.22 after looking at it: what read clearly over near-black is nearly invisible
    // over cream, and sealing the jar is a one-time transition worth actually seeing.
    seal: 'rgba(63, 107, 138, 0.34)',
    /**
     * A pesticide spray: a sickly yellow-green mist, deliberately NOT the jar's healthy greens or the
     * clean blue of water, so a spray never reads as watering and the colour itself says "chemical".
     */
    spray: 'rgba(196, 204, 92, 0.55)',
    /** Failure pulse at the glass edge. Matches the panel's bad state so they read as one signal. */
    alarm: 'rgba(169, 70, 47, 0.45)',
    /** The glow around a flower as it opens. The only effect that gets one. */
    bloomGlow: 'rgba(196, 88, 124, 0.38)',
  },
} as const;

// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Canvas 2D renderer.
 *
 * Reads world state and drains `world.events`. It NEVER writes simulation state — that one-way rule
 * is what lets the entire sim core run headless under Node for balance sweeps and replay checks.
 */

import { SUBSTRATES, Substrate, type SubstrateId } from '../sim/config/content.js';
import { humidity } from '../sim/atmosphere.js';
import { LightField } from '../sim/light.js';
import { NodeKind } from '../sim/plant.js';
import type { World } from '../sim/world.js';
import { THEME } from '../theme.js';
import { Plate, hash2, withAlpha } from './plate.js';
import { Overgrowth } from './overgrowth.js';
import { PlantArt } from './plants.js';
import { LampLight } from './lamplight.js';

/**
 * The moments the simulation reports, given a body.
 *
 * One list rather than an array per kind: there are eleven of these, and the previous shape — a
 * dedicated array, update loop and draw method per effect — does not survive that.
 */
/**
 * Soft lobes drifting inside the fog. Seven is the point where the veil stops reading as a flat filter;
 * past a dozen they average back out into one and only cost radial gradients per frame.
 */
const FOG_BLOBS = 7;

/** How long a refused dose keeps saying so, in real milliseconds. */
const TOO_SOON_MS = 4000;

/** Divisor for the fog scratch layer. The wash carries no detail, so it is composed small. */
const FOG_LAYER_SCALE = 4;

/** Where a bead detaches, in cells. Shared so the runnel starts exactly where the bead was born. */
const DROPLET_START_Y = 1.5;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Shortest gap between two pour ripples in the same column, in real milliseconds. */
const RIPPLE_GAP_MS = 250;

const enum Fx {
  Droplet,
  Splash,
  Sprout,
  LeafFall,
  BloomGlow,
  Sever,
  Rescue,
  Culture,
  MossSeed,
  Alarm,
  Spray,
  Liner,
  Ripple,
  SinkLeaf,
}

interface Effect {
  kind: Fx;
  /** Grid space, the same units node positions use. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 1 -> 0. */
  life: number;
  /** Per FRAME, not per tick, so an effect lasts the same wall-clock time at any sim speed. */
  decay: number;
  /** Kind-specific: spin, tint choice, or the millilitres a droplet carries. */
  a: number;
  /**
   * Frames to sit inert before `life` starts counting down. Lets a single event fire a whole group of
   * effects that then reveal themselves in sequence rather than all at once — the liner sweep is the
   * one thing that currently uses it.
   */
  delay: number;
  /** SinkLeaf only: the water's surface, and the floor it sinks to, in cells. */
  y2?: number;
  y3?: number;
}

export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;
  /**
   * Set while the player has the pesticide tool out. Turns on the pencilled notes over infested
   * plants — they are an answer to "what happens if I click here", so they belong to the tool and
   * would be clutter at any other time.
   */
  pesticideMode = false;
  /**
   * The Build brush in hand, or null when the tool is not a Build tool. Turns on the brush preview:
   * without it, "what will this click change" is a question the player can only answer by clicking,
   * which is exactly backwards for an amendment that costs water and roots to undo.
   */
  brush: { radius: number; material: SubstrateId } | null = null;
  /** Every live effect. Exposed for the browser check that the cap actually holds under load. */
  readonly fx: Effect[] = [];
  /** The jar as an illustration: vessel, watercolour substrate, glass. See plate.ts. */
  readonly plate: Plate;
  /** The plants as botanical silhouettes: roots, tapering stems, leaves per species, flowers. */
  private readonly plants: PlantArt;
  /** The lamp's glow, shafts and caustics. */
  private readonly lampLight: LampLight;
  /** What a finished jar looks like: vines, glass moss, green air. See overgrowth.ts. */
  private readonly overgrowth: Overgrowth;
  /** Wall-clock stamp for the vine creep, which is paced in real seconds, not sim time. */
  private lastFrameMs = 0;
  /**
   * The coordinate space every draw call works in: the grid at `cellPx` per cell, 792 × 408.
   *
   * The canvas's real pixel size is whatever it occupies on screen times the device pixel ratio, and
   * `scale` maps one onto the other. Keeping the logical space fixed is what let the move to
   * screen-resolution drawing leave every existing coordinate in this file untouched.
   */
  readonly logicalW: number;
  readonly logicalH: number;
  private scale = 1;
  /** Smoothed humidity for the fog. Driven by an EMA because raw RH visibly strobes. */
  private fogEma = 0;
  /** Film of beads on the glass, eased so it forms and drains rather than popping in. */
  private beadEma = 0;
  /** When each plant last had a dose refused for being too soon, in real ms. See `drawPestNotes`. */
  private readonly tooSoonAt = new Map<number, number>();
  /** Real seconds of fog drift. Real, not sim, so the speed control does not blow the fog around. */
  private fogDrift = 0;
  /**
   * Real seconds for the springtails' crawl and spring. Real, not sim, for the same reason as the fog:
   * at 64x a colony paced in sim time would be a blur.
   */
  private lifeClock = 0;
  /**
   * Lag-free mode, from the player's settings: the costliest visuals are skipped (light beams, caustics,
   * leaf shading and shadows, water beads). Nothing the player needs to read goes with them.
   */
  lowFx = false;
  /** The lamp's light as it SHINES this frame: dimmed by fog and beaded glass. See `render`. */
  private shine = 0;
  /** This frame's open air: inside the glass, above the ground. */
  private air = new Path2D();
  /** When each column was last watered, in real seconds (`lifeClock`): its leaves are splashed. */
  private readonly splashedAt: Float64Array;
  /** Whether the player's system asks for reduced motion. */
  private readonly still =
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  /**
   * Scratch layer for the fog, for the same reason the overgrowth has one: the veil, the banks at the
   * glass and the drifting lobes all have to be cut off at the soil line TOGETHER, and the cut is a
   * `destination-out` fill. Done on the main context that erase would take the jar out with it.
   */
  private readonly fogLayer: HTMLCanvasElement;
  private readonly fogLayerCtx: CanvasRenderingContext2D;
  hoverCell = -1;
  showDebug = false;
  /** When each column last threw a pour ripple, in real ms. See the `watered` event. */
  private readonly rippledAt = new Map<number, number>();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly world: World,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.logicalW = world.grid.w * THEME.cellPx;
    this.logicalH = world.grid.h * THEME.cellPx;
    this.plate = new Plate(world, THEME.cellPx);
    this.plants = new PlantArt(world, THEME.cellPx);
    this.overgrowth = new Overgrowth(world.grid.w, world.grid.h, THEME.cellPx);
    this.lampLight = new LampLight(this.logicalW, this.logicalH, THEME.cellPx);
    this.splashedAt = new Float64Array(world.grid.w).fill(-Infinity);
    // Quarter res, like the moss wash: fog is nothing but soft gradients, so there is no detail to
    // lose, and the upscale's own smoothing softens the terrain cut for free.
    this.fogLayer = document.createElement('canvas');
    this.fogLayer.width = Math.max(1, Math.round(this.logicalW / FOG_LAYER_SCALE));
    this.fogLayer.height = Math.max(1, Math.round(this.logicalH / FOG_LAYER_SCALE));
    const fctx = this.fogLayer.getContext('2d');
    if (!fctx) throw new Error('2D canvas context unavailable for the fog layer');
    this.fogLayerCtx = fctx;
    this.resize();
    // Layout changes (the jar column resizing) and window resizes both change the on-screen size.
    // The window listener also catches browser zoom, which changes devicePixelRatio.
    new ResizeObserver(() => this.resize()).observe(canvas);
    window.addEventListener('resize', () => this.resize());
  }

  get cell(): number {
    return THEME.cellPx;
  }

  /**
   * Match the canvas's backing store to its on-screen size.
   *
   * The canvas used to be a fixed 792×408 stretched by CSS with nearest-neighbour scaling, which is
   * why the jar was visibly made of square blocks at any size above 1×. Drawing at the real pixel
   * size is what lets smooth ink lines and soft washes stay smooth.
   */
  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const cssW = rect.width > 0 ? rect.width : this.logicalW;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round((bw * this.logicalH) / this.logicalW));
    if (this.canvas.width !== bw) this.canvas.width = bw;
    if (this.canvas.height !== bh) this.canvas.height = bh;
    this.scale = bw / this.logicalW;
  }

  /**
   * Screen pixel -> grid coords, including the padded border offset.
   *
   * Scales by the LOGICAL size, not `canvas.width`: once the backing store tracks the screen, the two
   * are no longer the same number, and mixing them up would put every click several cells off.
   */
  toGrid(px: number, py: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const sx = this.logicalW / rect.width;
    const sy = this.logicalH / rect.height;
    return {
      x: Math.floor(((px - rect.left) * sx) / this.cell),
      y: Math.floor(((py - rect.top) * sy) / this.cell),
    };
  }

  /**
   * Spawn one effect, if there is room.
   *
   * Every spawn path goes through here so the cap cannot be forgotten on a new kind — which is
   * exactly how the uncapped bead bug got in.
   */
  private spawn(kind: Fx, x: number, y: number, decay: number, vx = 0, vy = 0, a = 0, delay = 0): void {
    if (this.fx.length >= THEME.maxEffects) return;
    this.fx.push({ kind, x, y, vx, vy, life: 1, decay, a, delay });
  }

  /**
   * The height of the water standing over a ground cell, in cells, or null when it is dry.
   *
   * Walks up the open column from the ground to the top of the water, and reads how full that last
   * cell is, which is where the drawn waterline sits.
   */
  private waterSurfaceAbove(ground: number): number | null {
    const g = this.world.grid;
    let top = -1;
    for (let i = ground - g.w; i >= 0 && g.substrate[i] === Substrate.Air && g.standing[i] > 0.001; i -= g.w) top = i;
    if (top < 0) return null;
    const cap = this.world.cfg.raw.standing.cellMl;
    return g.yOf(top) + 1 - Math.min(1, g.standing[top] / cap);
  }

  /**
   * Pull anything visual out of this tick's events. Called once per tick, not per frame.
   *
   * ONE RULE MATTERS MOST HERE: read every node position NOW, never store a node id to look up on a
   * later frame. `NodePool.retirePlant` hands a dead plant's slots to other plants, possibly within
   * the same tick, so a stored id can silently come to mean a completely different plant — and a
   * dead Fern's wither particles would appear on whichever Succulent inherited its slots.
   */
  consumeEvents(): void {
    const w = this.world;
    const g = w.grid;
    const P = w.pool;
    for (const e of w.events) {
      switch (e.t) {
        case 'droplet':
          this.spawn(Fx.Droplet, e.x + 0.5, DROPLET_START_Y, 0.012, 0, 0.18, e.ml);
          break;
        case 'dropletLanded':
          // A bead of condensation dripping off the glass: a small splash where it lands, not a pour.
          this.spawn(Fx.Splash, g.xOf(e.cell) + 0.5, g.yOf(e.cell) + 0.2, 0.03, 0, 0, e.ml);
          break;
        case 'watered': {
          /*
           * Every pour rings where it lands: on a pond's surface, or on the ground. One effect for
           * pouring wherever it happens. (Poured into a pond, the event names the mud under the water,
           * so the ring goes up at the water's surface rather than down on the floor.)
           */
          const col = g.xOf(e.cell);
          // The leaves around a pour are splashed: they bead up and drip (see PlantArt.drawDew).
          for (let x = Math.max(0, col - 3); x <= Math.min(g.w - 1, col + 3); x++) this.splashedAt[x] = this.lifeClock;
          const surface = this.waterSurfaceAbove(e.cell) ?? g.yOf(e.cell);
          const now = performance.now();
          // A held pour fires every tick in five columns; one ring per column every quarter second is
          // a busy surface rather than a strobe, and stays far inside the effect cap.
          if (now - (this.rippledAt.get(col) ?? -Infinity) < RIPPLE_GAP_MS) break;
          this.rippledAt.set(col, now);
          this.spawn(Fx.Ripple, col + 0.5, surface, 0.028);
          break;
        }
        case 'seeded': {
          const surface = g.surfaceOfColumn[e.x];
          if (surface >= 0) this.spawn(Fx.Sprout, e.x + 0.5, g.yOf(surface), 0.008);
          break;
        }
        case 'flowered':
          // The petals opening are drawn from the node's age in plants.ts; this is only the glow.
          // `a` carries the species, so the glow takes the colour of that species' own bloom.
          this.spawn(Fx.BloomGlow, P.x[e.node], P.y[e.node], 0.011, 0, 0, this.world.plants[P.plantId[e.node]]?.species ?? -1);
          break;
        case 'leafDropped': {
          /*
           * A leaf that lands on a pond does not fall straight through it. It comes down to the surface,
           * floats a while, drifting, then soaks through and sinks to the floor, where it becomes the
           * litter that feeds the algae. Everywhere else it tumbles to the ground as it always did.
           */
          const surface = this.waterSurfaceAbove(e.cell);
          if (surface !== null && this.fx.length < THEME.maxEffects) {
            this.fx.push({
              kind: Fx.SinkLeaf,
              x: P.x[e.node],
              y: P.y[e.node],
              vx: 0,
              vy: 0,
              life: 1,
              decay: 0.0022,
              a: Math.random() * 6.28,
              delay: 0,
              y2: surface,
              y3: g.yOf(e.cell),
            });
            break;
          }
          // Falls from where the leaf actually was to the litter cell it becomes. A little sideways
          // drift and spin so a canopy shedding several at once does not look like rain.
          this.spawn(Fx.LeafFall, P.x[e.node], P.y[e.node], 0.012, (Math.random() - 0.5) * 0.04, 0.05, Math.random() * 6.28);
          break;
        }
        case 'rootSevered':
          // Only a root the PLAYER cut reports itself. Roots lost to sour soil or mold die in numbers
          // — a whole system can go at once — and a burst of motes for each would be the same spray
          // the death case above exists to avoid. The soil's colour already says why.
          if (e.reason === 'sickened') break;
          this.spawn(Fx.Sever, P.x[e.node], P.y[e.node], 0.02, 0, 0, e.reason === 'exposed' ? 0 : 1);
          break;
        case 'rootReanchored':
          this.spawn(Fx.Sever, P.x[e.node], P.y[e.node], 0.03, 0, 0, 2);
          break;
        case 'resprouted': {
          const plant = w.plants[e.plant];
          if (plant) this.spawn(Fx.Rescue, P.x[plant.crown], P.y[plant.crown], 0.012);
          break;
        }
        /*
         * A plant dying spawns NOTHING. It is read from the plant itself.
         *
         * This used to spawn a wither mote at every node, so a mature plant burst into fifty drifting
         * brown dots at once — which read as debris being thrown off rather than as something dying,
         * and got far more common once hazards could actually kill. The death is already legible: the
         * foliage browns through its health colours, the plant stops being drawn, and the Diagnosis
         * card names it. A cloud of particles was adding noise on top of a clear signal.
         */
        case 'plantDied':
          break;
        case 'plantRefused': {
          /*
           * Mark the spot the seed was turned down, so the refusal is visible where the player clicked.
           *
           * Reuses the severed-root puff rather than inventing a sprite: it is already the plate's
           * "this did not take" mark, in the right warm red, and it is drawn at a point. The surface
           * may be missing entirely for an unrootable column, hence the guard.
           */
          const cell = g.surfaceOfColumn[e.x];
          if (cell < 0) break;
          this.spawn(Fx.Sever, e.x + 0.5, g.yOf(cell) + 0.2, 0.018, 0, 0, 0);
          break;
        }
        case 'sprayTooSoon':
          // Real time, not sim time: this is a message to the player, and it has to stay up long
          // enough to read at 128x, where a sim-hour goes by in a blink.
          this.tooSoonAt.set(e.plant, performance.now());
          break;
        case 'sprayed': {
          // Centred on the plant's canopy and sized to it, read NOW per the rule above. The spray
          // covers the whole plant, so the mist should too.
          const plant = w.plants[e.plant];
          if (!plant) break;
          let x0 = Infinity;
          let x1 = -Infinity;
          let y0 = Infinity;
          let y1 = -Infinity;
          for (const n of plant.nodeIds) {
            if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
            x0 = Math.min(x0, P.x[n]);
            x1 = Math.max(x1, P.x[n]);
            y0 = Math.min(y0, P.y[n]);
            y1 = Math.max(y1, P.y[n]);
          }
          if (x0 > x1) break;
          this.spawn(Fx.Spray, (x0 + x1) / 2, (y0 + y1) / 2, 0.02, 0, 0, Math.max(1.5, (x1 - x0) / 2 + 1));
          break;
        }
        case 'immunised': {
          // The course paying off. The rising ring is the game's one piece of good news, and a plant
          // made safe from its pests is exactly that.
          const plant = w.plants[e.plant];
          if (plant) this.spawn(Fx.Rescue, P.x[plant.crown], P.y[plant.crown] - 2, 0.008);
          break;
        }
        case 'springtailsAdded':
          this.spawn(Fx.Culture, g.xOf(e.cell) + 0.5, g.yOf(e.cell) + 0.4, 0.014);
          break;
        case 'mossPlanted':
          this.spawn(Fx.MossSeed, g.xOf(e.cell) + 0.5, g.yOf(e.cell) + 0.3, 0.012);
          break;
        case 'hornwortPlanted':
        case 'fishAdded':
        case 'reedsPlanted':
        case 'snailsAdded': {
          const surface = this.waterSurfaceAbove(g.surfaceOfColumn[e.x]);
          if (surface !== null) this.spawn(Fx.Ripple, e.x + 0.5, surface, 0.022);
          break;
        }
        case 'pondCleared': {
          /*
           * The dead plants going down: a withered leaf per column, settling from the surface to the
           * floor, the sinking running outward from the click, so the whole pond is seen to go at once
           * rather than the cover simply vanishing between two frames.
           */
          for (let col = e.from; col <= e.to && this.fx.length < THEME.maxEffects; col++) {
            const floor = g.surfaceOfColumn[col];
            const surface = this.waterSurfaceAbove(floor);
            if (surface === null) continue;
            this.fx.push({
              kind: Fx.SinkLeaf,
              x: col + 0.2 + Math.random() * 0.6,
              y: surface - 0.1,
              vx: 0,
              vy: 0,
              life: 1,
              decay: 0.0045,
              a: Math.random() * 6.28,
              delay: Math.min(Math.abs(col - e.x), 30) * 2,
              y2: surface,
              y3: g.yOf(floor),
            });
          }
          break;
        }
        case 'liliesPlanted': {
          // A ring on the water where it lands: the same mark a pour makes, because it is the same act.
          const surface = this.waterSurfaceAbove(g.surfaceOfColumn[e.x]);
          if (surface !== null) this.spawn(Fx.Ripple, e.x + 0.5, surface, 0.022);
          break;
        }
        case 'basinLined':
          /*
           * One glint per lined cell, staggered so the light runs outward from the click — the same
           * shape `lineBasin` swept when it decided which cells to replace. That is the whole point of
           * the effect: a hollow can be lined all the way around from a single click, and without this
           * the only proof is the colour of a dozen cells changing between one frame and the next.
           *
           * The stagger is a few frames per cell, capped, so a basin large enough to need many cells
           * still finishes sweeping well inside a second rather than crawling.
           */
          for (let k = 0; k < e.cells.length; k++) {
            const cell = e.cells[k];
            const delay = Math.min(k, 40) * 1.4;
            this.spawn(Fx.Liner, g.xOf(cell) + 0.5, g.yOf(cell) + 0.5, 0.045, 0, 0, 0, delay);
          }
          break;
        case 'failure':
          // Stale air never flashes the jar red. A settled jar lives near the stall line and crosses
          // it night after night, so the alarm would be a nightly false alarm; the plant card's "growth
          // paused" note says it quietly, and the music ignores it for the same reason.
          if (e.mode === 'co2Stall') break;
          // One pulse, never a stack: several modes tripping together must not strobe.
          if (!this.fx.some((f) => f.kind === Fx.Alarm)) this.spawn(Fx.Alarm, 0, 0, 0.011);
          break;
        // `warning` and `warningCleared` are deliberately panel-only — the jar reacts to real
        // trouble, not to a counter fluctuating. `substrateSettled` would fire on every paint
        // stroke for no information.
        default:
          break;
      }
    }
  }

  render(alpha: number): void {
    const ctx = this.ctx;
    // Assigning canvas.width resets all context state, so the transform and smoothing are re-applied
    // every frame rather than trusted to survive a resize.
    ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, this.logicalW, this.logicalH);

    // The vine creep is paced in REAL seconds, not sim time, so fast-forwarding the jar does not
    // whip the overgrowth across the glass. Clamped so a backgrounded tab does not snap it open.
    const nowMs = performance.now();
    const dt = this.lastFrameMs === 0 ? 0 : Math.min(0.25, (nowMs - this.lastFrameMs) / 1000);
    this.lastFrameMs = nowMs;
    this.overgrowth.update(this.world.phase === 'climax', dt);
    this.fogDrift += dt;
    this.lifeClock += dt;

    // How much light the lamp is giving right now: its setting, by the time of day. The same product
    // the plants grow on, so what the player sees lit is what is actually being lit.
    const light = LightField.dayFraction(this.world.cfg, this.world.tickCount) * this.world.atmo.lampIntensity;
    /*
     * How much of that SHINES: the glow, the beams and the caustics dim as the glass fogs and beads
     * over, to about a third at the worst, so a misted jar is not a glare on top of its fog. Last
     * frame's eased fog and bead levels, which change over seconds, not frames.
     */
    this.shine = light * (1 - 0.68 * Math.max(this.fogEma, this.beadEma * 0.85));
    // The open air of the jar: inside the glass, above the ground. Beams and the lamp's bloom stay in it.
    const air = new Path2D();
    air.addPath(this.plate.vessel);

    this.plate.drawGround(ctx);
    // On the back wall, so everything in the jar stands in front of it.
    if (!this.lowFx) this.lampLight.drawCaustics(ctx, this.plate.vessel, this.shine, this.lifeClock);
    this.plate.drawSubstrate(ctx, alpha);
    // The ground is only known once the substrate is drawn.
    if (this.plate.ground) air.addPath(this.plate.ground);
    this.air = air;

    // Over the substrate, under everything alive: water fills the pores and pools you can see into.
    this.plate.drawWater(ctx);
    this.drawSoilLife();
    if (this.brush) this.plate.drawBrushPreview(ctx, this.hoverCell, this.brush.radius, this.brush.material);
    // The lamp's shafts, in the air BEHIND the plants, so a leaf in front of one blocks it.
    if (!this.lowFx) {
      const c = this.cell;
      const ground = this.plate.ground;
      // The share of the lamp's light the sim says reaches a point: after every leaf above, none in soil.
      const w = this.world;
      const incident = w.cfg.raw.light.lampPpfd * light;
      const lightAt = (px: number, py: number): number =>
        incident <= 0 ? 0 : Math.min(1, w.light.at(Math.floor(px / c), Math.floor(py / c)) / incident);
      this.lampLight.drawShafts(
        ctx,
        air,
        ground,
        (px) => this.surfaceAt(Math.floor(px / c)) * c,
        lightAt,
        this.shine,
        this.lifeClock,
      );
    }
    {
      /*
       * What wets the leaves. Dew from humid air, starting a little below the fog line and full once the
       * jar is fogged; and a pour's splash, drying off over about twelve real seconds.
       */
      const w = this.world;
      const rh = humidity(w.cfg, w.atmo);
      const fogAt = w.cfg.raw.atmosphere.condensation.fogOnHumidity;
      const dew = clamp01(Math.max((rh - (fogAt - 6)) / 12, this.fogEma * 0.85));
      const now = this.lifeClock;
      this.plants.draw(ctx, this.plate.vessel, this.plate.ground, {
        seconds: now,
        dew,
        splashedAt: (x) => clamp01(1 - (now - this.splashedAt[x]) / 12),
        still: this.still,
        lowFx: this.lowFx,
      });
    }

    // Everything that washes over the jar stays inside the glass, so the page around it stays paper.
    ctx.save();
    ctx.clip(this.plate.vessel);
    // In FRONT of the plants: the overgrowth is the jar closing over what it grew, so it reads as
    // being nearest the glass, between the viewer and the planting. The soil line is passed in so a
    // strand stops at the substrate instead of being drawn down through the gravel, and the moss cover
    // so the moss climbing the walls reflects what this jar actually grew.
    this.overgrowth.draw(
      ctx,
      (x) => this.surfaceAt(x),
      this.world.moss.surfaceFraction(this.world.grid),
    );
    this.drawPestNotes(ctx);
    this.drawEffects(alpha);
    this.drawTimeOfDay();
    this.drawFog(alpha);
    // Beads sit ON the glass, so they go in front of the mist they formed out of.
    this.drawCondensation(alpha);
    // Last of the washes: the green cast of a finished jar sits over the fog, not under it.
    this.overgrowth.drawAir(ctx, this.logicalW, this.logicalH);
    ctx.restore();

    this.plate.drawGlass(ctx);
    if (this.showDebug) this.drawDebug();
  }

  /**
   * Soil height at one column, in cells, clamped to the jar.
   *
   * Per column rather than jar-wide: terrain is uneven, and a single figure put the overgrowth's wall
   * moss in mid-air above a low corner.
   */
  private surfaceAt(xCell: number): number {
    const g = this.world.grid;
    const x = Math.max(1, Math.min(g.w - 2, xCell));
    const cell = g.surfaceOfColumn[x];
    return cell < 0 ? g.h : g.yOf(cell);
  }

  /**
   * Litter, mold and springtails, drawn under the plants so the canopy sits in front of the soil crew.
   *
   * Springtails are a population float in the simulation, not agents — so the sprites here are purely
   * a reading of that number. Their positions come from a hash of the cell index rather than any
   * stored per-insect state, which keeps them stable frame to frame without the sim knowing they exist.
   */
  private drawSoilLife(): void {
    const w = this.world;
    const g = w.grid;
    const c = this.cell;
    const ctx = this.ctx;

    /*
     * Litter and springtails batch into one path each and fill once.
     *
     * Per-cell `fillRect` was affordable at five flecks a cell. It is not once litter draws as a real
     * layer, and the whole surface of a mature jar carries some.
     */
    const duff = new Path2D();
    const duffDark = new Path2D();
    const moldy: number[] = [];
    const colony: number[] = [];

    for (const i of g.activeCells) {
      const px = g.xOf(i) * c;
      const py = g.yOf(i) * c;

      // Moss is drawn by the plate, along the surface curve (see Plate.drawMoss), so it wraps over
      // mounds and slopes instead of sitting as a flat band on each cell.

      /*
       * Leaf litter, as a layer rather than a sprinkle.
       *
       * The old version drew at most FIVE flecks of 0.2c x 0.12c — under 12% of a cell — and saturated
       * there, so a jar burying itself in leaf fall looked identical to one carrying a trace. Litter is
       * the visible half of the decomposer loop and the only warm texture on bare soil, so the count
       * AND the depth it reaches both follow the pile now. Two tones, because a duff layer is old
       * leaves under new ones rather than one flat brown.
       */
      const litter = g.organic[i];
      if (litter > 0.05) {
        const flecks = Math.min(18, 2 + Math.round(litter * 3));
        const depth = Math.min(1, 0.35 + litter * 0.12);
        for (let k = 0; k < flecks; k++) {
          const h = hash2(i, k);
          const fx = px + (h % 92) * 0.01 * c;
          const fy = py + ((h >> 7) % 100) * 0.01 * c * depth;
          const fw = c * (0.14 + ((h >> 14) % 10) * 0.012);
          const fh = c * (0.08 + ((h >> 18) % 6) * 0.01);
          ((h & 3) === 0 ? duffDark : duff).rect(fx, fy, fw, fh);
        }
      }

      if (g.mold[i] > 0.02) moldy.push(i);

      if (w.fauna.pop[i] >= 1) colony.push(i);
    }

    // Litter first, then mold over it — fungus grows ON the pile — then the colony on top of both.
    ctx.fillStyle = THEME.litter;
    ctx.fill(duff);
    ctx.fillStyle = THEME.fx.wither;
    ctx.fill(duffDark);

    /*
     * Mold as a soft irregular bloom, not a filled cell.
     *
     * A full-cell `fillRect` was the only thing in the whole jar drawn as a bare rectangle, and it read
     * as a UI overlay laid on the plate rather than as something growing in it. Alpha still carries the
     * coverage, so the diagnosis a player reads off it is unchanged; only the shape is.
     */
    /*
     * Drawn twice: a soft halo, then the colony over it. That is what reads as FUZZ.
     *
     * The previous version was too faint to find. Alpha was being halved twice — the theme colour
     * carried 0.66 and `globalAlpha` then multiplied by the coverage again, so a cell at 40% mold came
     * out around 0.26 — and the lobes were small enough to leave most of the cell bare. A jar with
     * every hostable cell completely overrun looked like dusty soil.
     *
     * Coverage still drives the alpha, so the reading a player takes off it is unchanged; it starts
     * from a floor now rather than from nothing, because mold worth drawing at all is worth seeing.
     */
    for (const i of moldy) {
      const px = g.xOf(i) * c;
      const py = g.yOf(i) * c;
      const mold = g.mold[i];
      const spread = Math.min(1, 0.55 + mold);
      const lobes = 4 + Math.round(mold * 5);

      const blob = new Path2D();
      const halo = new Path2D();
      for (let k = 0; k < lobes; k++) {
        const h = hash2(i, k + 61);
        const bx = px + (0.12 + (h % 76) * 0.01) * c;
        const by = py + (0.12 + ((h >>> 6) % 76) * 0.01) * c;
        const r = c * (0.24 + ((h >>> 12) % 16) * 0.012) * spread;
        blob.moveTo(bx + r, by);
        blob.arc(bx, by, r, 0, Math.PI * 2);
        const hr = r * 1.7;
        halo.moveTo(bx + hr, by);
        halo.arc(bx, by, hr, 0, Math.PI * 2);
      }
      ctx.globalAlpha = Math.min(1, 0.2 + mold * 0.75);
      ctx.fillStyle = THEME.moldFuzz;
      ctx.fill(halo);
      ctx.fillStyle = THEME.mold;
      ctx.fill(blob);
    }
    ctx.globalAlpha = 1;

    this.drawSpringtails(colony);
  }

  /**
   * The springtails: a handful of small cream bugs per cell standing in for the colony, capped so a
   * swarm stays readable.
   *
   * Each is a real little animal up close: a segmented abdomen, a head, two antennae and six legs,
   * turned to face the way it is going. They crawl slowly in their cell, legs stepping as they go.
   * Those on the surface now and then spring, the flick of the tail they are named for: a quick
   * tumbling arc to a spot beside them, and a spring back later, so none wander off their cell.
   * Those deeper in are the ones seen through the glass in the top of the soil, in its pores, so
   * they only crawl, and a little dimmer.
   *
   * The sim knows populations, not bugs, so every bug is a hash of its cell and slot plus the clock:
   * the same bug is in the same place frame to frame, with no state kept anywhere.
   */
  private drawSpringtails(colony: number[]): void {
    const w = this.world;
    const g = w.grid;
    const c = this.cell;
    const ctx = this.ctx;
    const now = this.lifeClock;
    const surface: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    const pores: Path2D[] = [new Path2D(), new Path2D(), new Path2D()];
    const HOP_SECONDS = 0.45;

    for (const i of colony) {
      const x = g.xOf(i);
      const px = x * c;
      const py = g.yOf(i) * c;
      // On top only where the ground here is open to the air: no hopping up through water or soil.
      const onTop = g.surfaceOfColumn[x] === i && !(g.standing[i - g.w] > 0);
      const shown = Math.min(6, Math.ceil(w.fauna.pop[i] / 4));
      for (let k = 0; k < shown; k++) {
        const h = hash2(i, k + 17);
        const r = (b: number): number => ((h >>> b) % 1000) / 1000;
        // Half the bugs of a surface cell walk the top; the rest, and every bug below, are in the pores.
        const top = onTop && k % 2 === 0;
        const speed = 0.25 + 0.3 * r(3);
        const ph = r(7) * 6.283;
        const tt = now * speed + ph;
        let bx: number;
        let by: number;
        let vx: number;
        let vy: number;
        let tumble = 0;
        let lift = 0;
        if (top) {
          // Crawl along the surface, and spring. A spring every 5 to 14 seconds, alternately out and back.
          bx = px + c * (0.33 + 0.18 * Math.sin(tt) + 0.04 * Math.sin(2.7 * tt));
          vx = Math.cos(tt) + 0.6 * Math.cos(2.7 * tt);
          vy = 0;
          // Standing ON the ground line, not across it.
          by = py - c * 0.1;
          const period = 5 + 9 * r(11);
          const clock = now + r(13) * period;
          const n = Math.floor(clock / period);
          const into = clock - n * period;
          const dir = r(17) < 0.5 ? 1 : -1;
          const out = (n & 1) === 0;
          let u = 1;
          if (into < HOP_SECONDS) {
            u = into / HOP_SECONDS;
            lift = c * 0.7 * 4 * u * (1 - u);
            tumble = dir * u * 6.283;
          }
          // Out-hops leave it 0.35c over; back-hops return it.
          const reach = c * 0.35 * dir;
          bx += out ? reach * (into < HOP_SECONDS ? u : 1) : reach * (into < HOP_SECONDS ? 1 - u : 0);
          by -= lift;
          if (into < HOP_SECONDS) vx = out ? dir : -dir;
        } else {
          bx = px + c * (0.5 + 0.3 * Math.sin(tt) + 0.05 * Math.sin(3.1 * tt + 1));
          by = py + c * (0.5 + 0.28 * Math.sin(0.8 * tt + ph * 2));
          vx = Math.cos(tt) + 0.155 * Math.cos(3.1 * tt + 1);
          vy = 0.75 * Math.cos(0.8 * tt + ph * 2);
        }
        const m = Math.hypot(vx, vy) || 1;
        let ax = vx / m;
        let ay = vy / m;
        if (tumble !== 0) {
          const cs = Math.cos(tumble);
          const sn = Math.sin(tumble);
          [ax, ay] = [ax * cs - ay * sn, ax * sn + ay * cs];
        }
        // Legs step while walking; tucked in mid-air.
        const step = lift > 0 ? 0 : Math.sin(now * 14 + ph * 3) > 0 ? 1 : -1;
        // A bug walking the surface is seen from the side; mid-spring, or in the pores, from any angle.
        this.springtail(top ? surface : pores, bx, by, ax, ay, step, now + ph, top && lift === 0);
      }
    }

    // Legs and antennae in ink, then the bodies over them, outlined, then the segment lines.
    ctx.save();
    ctx.lineCap = 'round';
    for (const [paths, alpha] of [[pores, 0.75], [surface, 1]] as const) {
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = THEME.springtailLeg;
      ctx.lineWidth = 0.5;
      ctx.stroke(paths[0]);
      ctx.fillStyle = THEME.springtail;
      ctx.fill(paths[1]);
      ctx.strokeStyle = THEME.springtailInk;
      ctx.lineWidth = 0.55;
      ctx.stroke(paths[1]);
      ctx.lineWidth = 0.4;
      ctx.stroke(paths[2]);
    }
    ctx.restore();
  }

  /**
   * One springtail at (x, y) facing (ax, ay), into [limbs, bodies, segment lines]. About 0.45 of a
   * cell nose to tail: a long abdomen, a rounder head, antennae nearly half the body long.
   *
   * `profile` draws it side-on, as one walking along the surface is seen through the glass: the near
   * three legs down to the ground, antennae forward and up. Seen from above, all six legs splay.
   */
  private springtail(
    into: Path2D[],
    x: number,
    y: number,
    ax: number,
    ay: number,
    step: number,
    t: number,
    profile: boolean,
  ): void {
    const c = this.cell;
    const [limbs, bodies, lines] = into;
    const nx = -ay;
    const ny = ax;
    // A point in the bug's own frame: `u` forward, `v` to its left, in cells.
    const at = (u: number, v: number): [number, number] => [x + (ax * u + nx * v) * c, y + (ay * u + ny * v) * c];
    const angle = Math.atan2(ay, ax);

    // The side that is down on screen, for a bug seen in profile: +1 where its left is downward.
    const down = ny >= 0 ? 1 : -1;
    // Six legs off the front half, the pairs stepping in turn; in profile, the near three.
    for (const [u, swing] of [
      [0.08, 1],
      [0.02, -1],
      [-0.04, 1],
    ] as const) {
      for (const side of profile ? [down] : [1, -1]) {
        const [x0, y0] = at(u, side * 0.04);
        const [x1, y1] = at(u + 0.035 * swing * step * side, side * (profile ? 0.1 : 0.11));
        limbs.moveTo(x0, y0);
        limbs.lineTo(x1, y1);
      }
    }
    // Antennae, feeling about: in profile both reach forward and up, one a little behind the other.
    const wave = 0.03 * Math.sin(t * 3.3);
    for (const side of [1, -1]) {
      const lean = profile ? -down * (side > 0 ? 0.05 : 0.1) : side * 0.06;
      const reach = profile ? -down * (side > 0 ? 0.1 : 0.15) : side * 0.1;
      const [x0, y0] = at(0.2, profile ? -down * 0.02 : side * 0.02);
      const [cx, cy] = at(0.29, lean + wave * (profile ? 1 : side));
      const [x1, y1] = at(0.36, reach - wave * (profile ? 1 : side));
      limbs.moveTo(x0, y0);
      limbs.quadraticCurveTo(cx, cy, x1, y1);
    }
    // Abdomen, then head.
    const [bx, by] = at(-0.05, 0);
    bodies.moveTo(bx + Math.cos(angle) * 0.16 * c, by + Math.sin(angle) * 0.16 * c);
    bodies.ellipse(bx, by, 0.16 * c, 0.065 * c, angle, 0, Math.PI * 2);
    const [hx, hy] = at(0.15, 0);
    bodies.moveTo(hx + Math.cos(angle) * 0.07 * c, hy + Math.sin(angle) * 0.07 * c);
    bodies.ellipse(hx, hy, 0.07 * c, 0.058 * c, angle, 0, Math.PI * 2);
    // Segment lines across the abdomen.
    for (const u of [-0.13, -0.06, 0.01]) {
      const [x0, y0] = at(u, 0.05);
      const [x1, y1] = at(u, -0.05);
      lines.moveTo(x0, y0);
      lines.lineTo(x1, y1);
    }
  }

  /**
   * Update and draw every live effect in one pass.
   *
   * Decay is per FRAME rather than per tick on purpose: these are presentation, so a leaf should
   * take the same wall-clock time to fall whether the jar is running at 1x or 32x. Events arrive
   * 32x faster at 32x, which is what the spawn cap is for.
   */
  private drawEffects(alpha: number): void {
    const c = this.cell;
    const ctx = this.ctx;
    const W = this.logicalW;
    const H = this.logicalH;

    for (let k = this.fx.length - 1; k >= 0; k--) {
      const f = this.fx[k];
      // Held inert until its turn: neither moving, decaying, nor drawn. This is what lets one event
      // fan out into a sweep instead of every one of its effects appearing on the same frame.
      if (f.delay > 0) {
        f.delay -= 1;
        continue;
      }
      f.x += f.vx;
      f.y += f.vy;
      f.life -= f.decay;
      if (f.life <= 0 || f.y > this.world.grid.h) {
        this.fx.splice(k, 1);
        continue;
      }
      const px = f.x * c;
      const py = (f.y + f.vy * alpha) * c;
      const t = 1 - f.life; // 0 at birth, 1 at death

      switch (f.kind) {
        // Fx.Droplet is deliberately absent: a falling bead is drawn by `drawCondensation`, IN FRONT of
        // the fog, because it is on the glass and it has to sit inside the clear track it just cut.
        case Fx.Splash:
          ctx.globalAlpha = Math.min(1, f.life);
          ctx.fillStyle = THEME.droplet;
          circle(ctx, px, py, Math.max(1.5, c * 0.16));
          break;

        case Fx.Sprout:
          // An expanding ring: a three-node sprout is almost nothing against a full canopy.
          ctx.globalAlpha = f.life * 0.8;
          ctx.strokeStyle = THEME.flower;
          ctx.lineWidth = Math.max(1, c * 0.12);
          ctx.beginPath();
          ctx.arc(px, py + c * 0.5, c * (0.4 + t * 1.6), 0, Math.PI * 2);
          ctx.stroke();
          break;

        case Fx.BloomGlow: {
          // The one glow in the game, and it fades outward as it goes. Sized generously on purpose:
          // at barely-wider-than-the-flower it was invisible in a still, which defeats the point of
          // the win condition finally having a moment.
          const r = c * (0.9 + t * 3.2);
          const own = THEME.species[f.a]?.bloom.petal;
          const glow = own ? withAlpha(own, 0.4) : THEME.fx.bloomGlow;
          const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
          grad.addColorStop(0, glow);
          grad.addColorStop(0.45, withAlpha(glow, 0.16));
          grad.addColorStop(1, withAlpha(glow, 0));
          ctx.globalAlpha = f.life;
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        case Fx.SinkLeaf: {
          // Down to the water (the first eighth of its life), afloat and drifting (to just past half),
          // then soaking through and sinking to the floor, fading as it settles into the mud.
          const start = f.y;
          const top = f.y2 ?? start;
          const bottom = f.y3 ?? top;
          let ly: number;
          let lx = f.x;
          let spin = f.a;
          if (t < 0.12) {
            const u = t / 0.12;
            ly = start + (top - start) * u * u;
            spin += u * 3;
          } else if (t < 0.55) {
            const u = (t - 0.12) / 0.43;
            ly = top - 0.06 + Math.sin(u * 9) * 0.03;
            lx += Math.sin(u * 2.5 + f.a) * 0.6;
            spin += 3 + Math.sin(u * 4) * 0.2;
          } else {
            const u = (t - 0.55) / 0.45;
            ly = top + (bottom - 0.2 - top) * (1 - (1 - u) * (1 - u));
            lx += Math.sin(2.5 + f.a) * 0.6 + Math.sin(u * 6) * 0.15;
            spin += 3 + u * 1.5;
          }
          ctx.globalAlpha = t > 0.85 ? (1 - t) / 0.15 : 1;
          ctx.fillStyle = THEME.fx.wither;
          ctx.save();
          ctx.translate(lx * c, ly * c);
          // Lying flat on the water it is seen edge-on: squashed while afloat, tumbling once it sinks.
          ctx.rotate(t < 0.55 && t >= 0.12 ? Math.sin(spin) * 0.15 : spin);
          ctx.beginPath();
          ctx.ellipse(0, 0, c * 0.34, c * (t >= 0.12 && t < 0.55 ? 0.1 : 0.16), 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;
        }

        case Fx.LeafFall:
          // Tumbles: the ellipse rotates as it falls, and accelerates a little.
          f.vy = Math.min(0.09, f.vy + 0.0015);
          ctx.globalAlpha = Math.min(1, f.life * 1.4);
          ctx.fillStyle = THEME.fx.wither;
          ctx.save();
          ctx.translate(px, py);
          ctx.rotate(f.a + t * 5);
          ctx.beginPath();
          ctx.ellipse(0, 0, c * 0.34, c * 0.16, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
          break;

        case Fx.Sever:
          ctx.globalAlpha = f.life * 0.9;
          ctx.strokeStyle =
            f.a === 0 ? THEME.fx.severExposed : f.a === 1 ? THEME.fx.severAmended : THEME.fx.rescue;
          ctx.lineWidth = Math.max(1, c * 0.14);
          ctx.beginPath();
          ctx.arc(px, py, c * (0.3 + t * 0.5), 0, Math.PI * 2);
          ctx.stroke();
          break;

        case Fx.Rescue:
          // Rises as it fades — the one effect that moves upward, because it is the good news.
          ctx.globalAlpha = f.life * 0.75;
          ctx.strokeStyle = THEME.fx.rescue;
          ctx.lineWidth = Math.max(1, c * 0.1);
          ctx.beginPath();
          ctx.arc(px, py - t * c * 0.8, c * (0.35 + t * 0.7), 0, Math.PI * 2);
          ctx.stroke();
          break;

        case Fx.Spray: {
          // A mist that billows out over the plant's canopy and settles. `a` is its half-width in cells.
          // Starts already covering most of it, since the dose lands on the WHOLE plant at once.
          const r = f.a * c * (0.95 + t * 0.5);
          const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
          grad.addColorStop(0, THEME.fx.spray);
          grad.addColorStop(1, withAlpha(THEME.fx.spray, 0));
          ctx.globalAlpha = f.life;
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.ellipse(px, py, r, r * 1.6, 0, 0, Math.PI * 2);
          ctx.fill();
          break;
        }

        case Fx.Ripple: {
          // A ring on the water seen from the side, so a flat ellipse, widening as it fades.
          ctx.globalAlpha = f.life * 0.8;
          ctx.strokeStyle = THEME.water.glint;
          ctx.lineWidth = 1;
          const rx = c * (0.25 + t * 1.5);
          ctx.beginPath();
          ctx.ellipse(px, py, rx, rx * 0.2, 0, 0, Math.PI * 2);
          ctx.stroke();
          if (t < 0.5) {
            const rx2 = rx * 0.5;
            ctx.beginPath();
            ctx.ellipse(px, py, rx2, rx2 * 0.2, 0, 0, Math.PI * 2);
            ctx.stroke();
          }
          break;
        }

        case Fx.Liner: {
          /*
           * A cell-sized wash that brightens in and settles rather than bursting outward, because
           * nothing is flying off — a wall of soil is quietly becoming impermeable. Peaks a third of
           * the way through its life, past the moment the delay released it, then fades into the mud
           * colour the cell is left wearing anyway.
           */
          const pulse = Math.sin(Math.min(1, t / 0.35) * Math.PI * 0.5) * (1 - Math.max(0, t - 0.4) / 0.6);
          ctx.globalAlpha = Math.max(0, pulse) * 0.8;
          ctx.fillStyle = THEME.fx.liner;
          const half = c * 0.52;
          ctx.beginPath();
          ctx.roundRect(px - half, py - half, half * 2, half * 2, c * 0.15);
          ctx.fill();
          break;
        }

        case Fx.Culture:
          // A scatter of specks, deterministic from the effect's own position so they do not crawl.
          ctx.globalAlpha = f.life;
          ctx.fillStyle = THEME.springtail;
          for (let i = 0; i < 6; i++) {
            const ang = (i / 6) * Math.PI * 2;
            const rr = c * (0.2 + t * 0.9);
            circle(ctx, px + Math.cos(ang) * rr, py + Math.sin(ang) * rr * 0.5, Math.max(1, c * 0.07));
          }
          break;

        case Fx.MossSeed: {
          const [mr, mg, mb] = THEME.moss;
          ctx.globalAlpha = f.life * 0.85;
          ctx.fillStyle = `rgb(${mr}, ${mg}, ${mb})`;
          circle(ctx, px, py, c * (0.18 + t * 0.5));
          break;
        }

        case Fx.Alarm: {
          // An inward vignette at the glass, to pull the eye toward the panel. Peaks mid-life so it
          // reads as a pulse rather than a fade-out.
          const pulse = Math.sin(f.life * Math.PI);
          const grad = ctx.createLinearGradient(0, 0, 0, H);
          grad.addColorStop(0, THEME.fx.alarm);
          grad.addColorStop(0.35, withAlpha(THEME.fx.alarm, 0));
          grad.addColorStop(0.65, withAlpha(THEME.fx.alarm, 0));
          grad.addColorStop(1, THEME.fx.alarm);
          ctx.globalAlpha = pulse * 0.8;
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, W, H);
          break;
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Time of day, and the lamp.
   *
   * A full day/night cycle drives every part of the simulation; before this existed the jar looked
   * identical at noon and at midnight, because the only place the light field was read at all was the
   * debug overlay. Clipped to the vessel by `render`, so night falls inside the jar and not on the page.
   *
   * Both wash the jar BEFORE the fog, so a fogged jar at night still reads as fogged rather than as
   * a flat grey rectangle.
   */
  private drawTimeOfDay(): void {
    const w = this.world;
    const ctx = this.ctx;
    const W = this.logicalW;
    const H = this.logicalH;

    // The lamp first, so night settles over a lit jar rather than the other way round. Its glow follows
    // the day as well as the lamp's setting: the lamp is the sun here, and it goes down.
    this.lampLight.drawGlow(ctx, this.shine, this.air);

    // `dayFraction` is already a trapezoid with twilight ramps, so dawn and dusk come out for free.
    const night = 1 - LightField.dayFraction(w.cfg, w.tickCount);
    if (night > 0.01) {
      ctx.globalAlpha = night * THEME.night.maxAlpha;
      ctx.fillStyle = THEME.night.tint;
      ctx.fillRect(0, 0, W, H);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Fog on the inside of the glass.
   *
   * Driven by the sim's `fogged` LATCH, not by raw humidity, because fog is a rule and not just a mood:
   * at 80% RH the jar mists over and mold can take hold, and it stays that way until 74% clears it. The
   * old wash ramped from 55% and never read the latch at all, so the glass was already hazy twenty-five
   * points before fog meant anything and looked no different once it did. The threshold the player is
   * being judged against was the one thing the jar would not show them.
   *
   * There is deliberately NO haze below the latch. Fog means one thing — the jar is fogged and mold can
   * grow — and a gradient creeping in from the fifties only made that unreadable.
   *
   * Opacity follows an EMA of that target, so fog rolls in over a second or two rather than snapping,
   * and a jar hovering on the threshold does not strobe. The hysteresis is the sim's: once fogged it
   * stays fogged down to 74%, and the glass shows exactly that.
   */
  private drawFog(alpha: number): void {
    const w = this.world;
    const cond = w.cfg.raw.atmosphere.condensation;
    const rh = humidity(w.cfg, w.atmo);

    // Above the latch, thickening the rest of the way to saturation — where condensation takes over.
    const thick = clamp01((rh - cond.fogOnHumidity) / Math.max(1, cond.onHumidity - cond.fogOnHumidity));
    const target = w.atmo.fogged ? THEME.fogOn + (1 - THEME.fogOn) * thick : 0;
    this.fogEma += (target - this.fogEma) * THEME.fogEmaAlpha;

    const d = this.fogEma;
    if (d <= 0.01) return;

    const L = this.fogLayerCtx;
    const W = this.logicalW;
    const H = this.logicalH;
    const S = FOG_LAYER_SCALE;
    L.setTransform(1 / S, 0, 0, 1 / S, 0, 0);
    L.clearRect(0, 0, W, H);
    L.globalCompositeOperation = 'source-over';

    /*
     * The air space, which is the only part of the jar fog lives in.
     *
     * Taken from the HIGHEST ground rather than an average, because every soft term below is sized
     * against it: at canvas scale the lobes came out wider than the air itself and blanketed it evenly,
     * which is what made the first version read as a flat filter rather than as moving air.
     */
    const cell = this.cell;
    let airH = H;
    for (let x = 0; x < this.world.grid.w; x++) airH = Math.min(airH, this.surfaceAt(x) * cell);
    airH = Math.max(cell * 2, airH);

    // The veil gathers under the lid, because that is where the glass is coldest and the air stillest.
    // Kept deliberately thin: it is the floor the lobes sit on, and when it carried the density instead
    // the fog had no structure at all.
    const veil = L.createLinearGradient(0, 0, 0, H);
    veil.addColorStop(0, withAlpha(THEME.fog.veil, 0.62));
    veil.addColorStop(0.45, withAlpha(THEME.fog.veil, 0.4));
    veil.addColorStop(1, withAlpha(THEME.fog.veil, 0.28));
    L.fillStyle = veil;
    L.fillRect(0, 0, W, H);

    /*
     * Banks clinging to the glass at both edges, transparent through the middle.
     *
     * ONE fill with a four-stop gradient, never a rect per side. Two overlapping fills double their
     * alpha along the seam, which is exactly the picket-fence artefact the wall moss had before it was
     * rewritten as a single path.
     */
    const banks = L.createLinearGradient(0, 0, W, 0);
    banks.addColorStop(0, withAlpha(THEME.fog.bank, 0.72));
    banks.addColorStop(0.42, withAlpha(THEME.fog.bank, 0));
    banks.addColorStop(0.58, withAlpha(THEME.fog.bank, 0));
    banks.addColorStop(1, withAlpha(THEME.fog.bank, 0.72));
    L.fillStyle = banks;
    L.fillRect(0, 0, W, H);

    /*
     * Drifting lobes, to break up the flatness and prove the fog is a body of air rather than a filter
     * laid over the canvas.
     *
     * Paced in REAL seconds like the vine creep, so running the jar at 64x does not send the fog
     * tearing across the glass — at that speed it would read as wind, and a sealed jar has none.
     */
    for (let k = 0; k < FOG_BLOBS; k++) {
      const speed = 0.004 + (k % 3) * 0.0035;
      // Wrapped through -0.15..1.15 so a lobe crosses the glass and re-enters rather than popping.
      const px = (((k * 0.37 + this.fogDrift * speed) % 1.3) - 0.15) * W;
      // Sized and placed against the AIR, not the canvas, so seven of them read as seven.
      const py = (0.12 + ((k * 0.29) % 1) * 0.78) * airH + Math.sin(this.fogDrift * 0.25 + k) * airH * 0.05;
      const r = (0.5 + ((k * 0.13) % 1) * 0.45) * airH;
      const blob = L.createRadialGradient(px, py, 0, px, py, r);
      blob.addColorStop(0, withAlpha(THEME.fog.blob, 0.66));
      blob.addColorStop(0.55, withAlpha(THEME.fog.blob, 0.3));
      blob.addColorStop(1, withAlpha(THEME.fog.blob, 0));
      L.fillStyle = blob;
      L.fillRect(px - r, py - r, r * 2, r * 2);
    }

    /*
     * Cut the fog off at the ground.
     *
     * Fog is airborne, and the first version of this washed the whole frame: at 96% RH the gravel came
     * out nearly white, which reads as the renderer fading the picture rather than as a jar misting up.
     * The cut follows the terrain PER COLUMN rather than using one jar-wide soil line, because the
     * substrate is uneven and a flat cut either bleaches the raised corners or leaves the low ones clear.
     *
     * Two soft strokes along the same profile before the fill, so the fog thins into the ground instead
     * of ending on a hard white line.
     */
    const ground = new Path2D();
    ground.moveTo(0, this.surfaceAt(0) * cell);
    for (let x = 0; x < this.world.grid.w; x++) ground.lineTo(x * cell + cell / 2, this.surfaceAt(x) * cell);
    ground.lineTo(W, this.surfaceAt(this.world.grid.w - 1) * cell);
    const skirt = new Path2D(ground);
    ground.lineTo(W, H);
    ground.lineTo(0, H);
    ground.closePath();

    L.globalCompositeOperation = 'destination-out';
    L.lineCap = 'round';
    L.lineJoin = 'round';
    L.strokeStyle = 'rgba(0, 0, 0, 0.30)';
    L.lineWidth = cell * 4;
    L.stroke(skirt);
    L.lineWidth = cell * 2;
    L.stroke(skirt);
    L.fillStyle = '#000';
    L.fill(ground);

    /*
     * Runnels: the clear track a bead leaves as it runs down the pane.
     *
     * Erased out of the fog rather than painted over it, which is the whole reason this layer exists —
     * a track has to reveal the plants BEHIND the mist, and no amount of drawing on top can do that.
     * It heals as the bead's effect fades, so the glass mists back over behind it.
     */
    for (const f of this.fx) {
      if (f.kind !== Fx.Droplet) continue;
      const bx = (f.x + f.vx * alpha) * cell;
      const by = (f.y + f.vy * alpha) * cell;
      const cut = `rgba(0, 0, 0, ${(0.85 * f.life).toFixed(3)})`;
      L.strokeStyle = cut;
      L.fillStyle = cut;
      L.lineWidth = cell * 0.55;
      L.beginPath();
      L.moveTo(bx, DROPLET_START_Y * cell);
      L.lineTo(bx, by);
      L.stroke();
      // The bead's own head clears a wider spot than its tail.
      L.beginPath();
      L.arc(bx, by, cell * 0.5, 0, Math.PI * 2);
      L.fill();
    }

    L.globalCompositeOperation = 'source-over';

    /*
     * The veil, the banks and the lobes STACK where they overlap, so the glass reaches far higher than
     * any single figure above: roughly 0.62 through the middle the moment the jar fogs, and 0.8 at the
     * edges once it saturates. Stopped short of opaque on purpose — a fogged jar is a problem to be
     * read and fixed, so the plants behind the mist have to stay legible.
     */
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = d * 0.85;
    ctx.drawImage(this.fogLayer, 0, 0, W, H);
    ctx.restore();
  }

  /**
   * Beads of condensation clinging to the inside of the glass.
   *
   * The sim has always modelled this properly — `glassWaterMl` fills up and a bead detaches once it is
   * heavy enough, and the comment in `stepCondensation` says the quantum exists so the visual reads as
   * "beads forming and running down the glass". Nothing ever drew them: a droplet was one flat circle
   * falling from the lid, so the one mechanic the player could have watched build up was invisible.
   *
   * So the beads GROW. `glassWaterMl` cycles from nothing to one droplet's worth and back, and the
   * beads swell with it, which makes the run-off legible as a cycle rather than as random raindrops.
   */
  private drawCondensation(alpha: number): void {
    const w = this.world;
    const atmo = w.atmo;
    const quantum = w.cfg.raw.atmosphere.condensation.dropletMassMl;

    // Beads persist while there is water on the glass, not merely while the latch is held: the film
    // should drain away after condensing stops rather than vanish the instant the flag flips.
    const wet = atmo.condensing ? 1 : clamp01(atmo.glassWaterMl / Math.max(1e-6, quantum));
    this.beadEma += (wet - this.beadEma) * THEME.fogEmaAlpha;
    if (this.beadEma <= 0.02) return;

    const ctx = this.ctx;
    const c = this.cell;
    const W = this.logicalW;
    // Fill fraction of the current bead, 0 -> 1, which is literally how full the glass is.
    const swell = 0.55 + 0.45 * clamp01(atmo.glassWaterMl / Math.max(1e-6, quantum));

    ctx.save();
    ctx.globalAlpha = this.beadEma;
    for (let k = 0; k < THEME.beadCount; k++) {
      /*
       * Biased toward the two walls, matching where the sim actually puts its beads: `stepCondensation`
       * sends 35% of them to the edge columns because in a cross-section the side panes carry the most.
       * Squaring a centred coordinate pushes the scatter outward without banding it against the glass.
       */
      const u = (hash2(k, 7) % 1000) / 1000;
      const centred = u * 2 - 1;
      // A fractional power EXPANDS toward the walls. Cubing does the opposite — it compresses the
      // middle of the range toward zero and piles the beads up in the centre of the pane.
      const spread = Math.sign(centred) * Math.pow(Math.abs(centred), 0.45);
      const bx = (0.5 + spread * 0.48) * W;
      // Above the soil only, and never in the lid's shadow at the very top.
      const airH = Math.max(c * 3, this.surfaceAt(Math.round(bx / c)) * c);
      const by = c * 1.2 + ((hash2(k, 13) % 1000) / 1000) * (airH - c * 2);

      // Three sizes, so the film reads as a film rather than as a dotted pattern.
      const grade = (hash2(k, 29) % 100) / 100;
      const r = c * (0.14 + grade * grade * 0.3) * swell;
      if (r < 0.4) continue;

      // Slightly taller than wide: a bead on a vertical pane sags under its own weight.
      ctx.fillStyle = THEME.bead.body;
      ctx.beginPath();
      ctx.ellipse(bx, by, r, r * 1.18, 0, 0, Math.PI * 2);
      ctx.fill();

      // The meniscus, on the lower shoulder only — a full outline reads as a drawn circle, not water.
      ctx.strokeStyle = THEME.bead.rim;
      ctx.lineWidth = Math.max(0.4, r * 0.3);
      ctx.beginPath();
      ctx.ellipse(bx, by, r, r * 1.18, 0, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();

      // The highlight is what actually sells it as water. Always upper-left, because one light source.
      if (r > 0.7) {
        ctx.fillStyle = THEME.bead.sheen;
        circle(ctx, bx - r * 0.34, by - r * 0.42, Math.max(0.35, r * 0.26));
      }
    }

    /*
     * The bead currently running down, drawn over the track it cut through the fog.
     *
     * Stretched along its fall and given the same highlight as the ones on the glass, so a running bead
     * is recognisably one of them coming loose rather than a separate kind of object.
     */
    for (const f of this.fx) {
      if (f.kind !== Fx.Droplet) continue;
      const px = (f.x + f.vx * alpha) * c;
      const py = (f.y + f.vy * alpha) * c;
      const r = c * 0.19;
      ctx.globalAlpha = Math.min(1, f.life) * Math.max(0.35, this.beadEma);
      ctx.fillStyle = THEME.bead.body;
      ctx.beginPath();
      ctx.ellipse(px, py, r, r * 1.6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = THEME.bead.rim;
      ctx.lineWidth = Math.max(0.4, r * 0.3);
      ctx.stroke();
      ctx.fillStyle = THEME.bead.sheen;
      circle(ctx, px - r * 0.3, py - r * 0.5, Math.max(0.4, r * 0.28));
    }
    ctx.restore();
  }

  /**
   * A pencilled note over every plant the pesticide tool has something to say about.
   *
   * The course runs on two clocks the player cannot otherwise see — a dose inside the minimum gap does
   * not count, and one outside the maximum gap starts the course over — so a tool that silently
   * ignores a click is indistinguishable from a broken button. The note says what the NEXT press will
   * do and when it will count.
   *
   * Drawn under the effects so a spray's mist rolls over it, but above the plants and washes, so it
   * stays readable against a dark canopy or a fogged jar.
   */
  private drawPestNotes(ctx: CanvasRenderingContext2D): void {
    if (!this.pesticideMode) return;
    const w = this.world;
    const P = w.pool;
    const c = this.cell;
    const pc = w.cfg.raw.pesticide;
    const perDay = w.cfg.raw.time.dayLengthSimMinutes / w.cfg.dt;
    const nowMs = performance.now();
    const notes: Array<{ text: string; cx: number; cy: number; id: number }> = [];
    const span = (ticks: number): string => {
      const days = ticks / perDay;
      return days >= 1 ? `${days.toFixed(days < 10 ? 1 : 0)}d` : `${Math.max(1, Math.round(days * 24))}h`;
    };

    for (const plant of w.plants) {
      if (plant.stage === 'dead') continue;
      let infested = false;
      let top = Infinity;
      let x0 = Infinity;
      let x1 = -Infinity;
      for (const n of plant.nodeIds) {
        if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
        if (P.pests[n] >= w.cfg.raw.pests.visibleAt) infested = true;
        top = Math.min(top, P.y[n]);
        x0 = Math.min(x0, P.x[n]);
        x1 = Math.max(x1, P.x[n]);
      }
      if (x0 > x1) continue;

      const since = w.tickCount - plant.courseLastTick;
      const lapsed = plant.courseDoses > 0 && since > pc.courseMaxGapDays * perDay;
      const started = plant.courseDoses > 0 && !lapsed;
      /*
       * Nothing to say about a clean plant, and nothing at all about an immune one.
       *
       * A plant that has come through an infestation is quietly done with pests — no badge, no
       * countdown. The note exists to answer "what will this click do", and on a plant that can never
       * be infested again the answer is "nothing worth doing".
       */
      if (plant.pestImmune || (!started && !infested)) continue;

      /*
       * Kept SHORT. Plants stand five or six columns apart and the note is centred on the canopy, so a
       * wordier line on two neighbours overlaps into one unreadable smear — which is what "3 more
       * sprays · ready now" next to "2 more sprays · ready now" did.
       */
      const left = pc.courseDoses - (started ? plant.courseDoses : 0);
      const wait = started ? pc.courseMinGapDays * perDay - since : 0;
      const sprays = `${left} spray${left === 1 ? '' : 's'}`;
      const refused = nowMs - (this.tooSoonAt.get(plant.id) ?? -Infinity) < TOO_SOON_MS;
      const text = refused
        ? `too soon — wait ${span(Math.max(wait, 0))}`
        : wait > 0
          ? `${sprays} · wait ${span(wait)}`
          : `${sprays} · now`;
      notes.push({ text, cx: ((x0 + x1) / 2) * c, cy: Math.max(1.1, top - 1.1) * c, id: plant.id });
    }
    if (notes.length === 0) return;

    /*
     * Lay the notes out as a SET, not one at a time.
     *
     * Two plants five columns apart put their notes about sixty pixels apart, and a note is wider than
     * that, so neighbouring labels ran straight through each other. Placed left to right, each note is
     * lifted a line at a time until it clears every note already placed — the same thing you would do
     * writing them on the glass by hand.
     */
    const size = this.noteSize;
    ctx.save();
    ctx.font = `${size.toFixed(1)}px ${THEME.noteFont}`;
    const line = size * 1.35;
    const placed: Array<{ x0: number; x1: number; cy: number }> = [];
    notes.sort((a, b) => a.cx - b.cx);
    for (const note of notes) {
      const half = ctx.measureText(note.text).width / 2 + size * 0.4;
      /*
       * Held inside the GLASS, not merely inside the canvas.
       *
       * Everything here is drawn under the vessel clip, whose wall sits a little inside the canvas edge,
       * so clamping to the canvas still had the last few letters sliced off for a plant standing against
       * the wall — which is exactly where the player most needs to read the note.
       */
      const inset = this.cell * (THEME.plate.wall + 0.5);
      note.cx = Math.max(inset + half, Math.min(this.logicalW - inset - half, note.cx));
      const x0 = note.cx - half;
      const x1 = note.cx + half;
      // Lifting is bounded: against the lid there is nowhere left to go, and a note that has run out
      // of room is better slightly crowded than off the top of the jar.
      for (let guard = 0; guard < 6; guard++) {
        const clash = placed.some((q) => x0 < q.x1 && x1 > q.x0 && Math.abs(q.cy - note.cy) < line);
        if (!clash || note.cy - line < size) break;
        note.cy -= line;
      }
      placed.push({ x0, x1, cy: note.cy });
      this.handwritten(ctx, note.text, note.cx, note.cy, note.id);
    }
    ctx.restore();
  }

  /** One figure for the note type size, so measuring and drawing cannot disagree about it. */
  private get noteSize(): number {
    return Math.max(11, this.cell * 0.92);
  }

  /**
   * One line of pencil, centred on (x, y).
   *
   * Drawn a letter at a time with the baseline and angle nudged per letter, because the script faces
   * this asks for are not on every machine and a plain fallback drawn flat reads as a UI label pasted
   * over the plate. The nudges come from a hash of the letter's position and the plant's id, so a note
   * sits still frame to frame instead of shivering.
   */
  private handwritten(ctx: CanvasRenderingContext2D, text: string, cx: number, cy: number, salt: number): void {
    const size = this.noteSize;
    ctx.save();
    ctx.font = `${size.toFixed(1)}px ${THEME.noteFont}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';

    const widths: number[] = [];
    let total = 0;
    for (const ch of text) {
      const wch = ctx.measureText(ch).width;
      widths.push(wch);
      total += wch;
    }

    // A paper wash behind the whole line, so it reads over a dark canopy as well as over pale fog.
    ctx.fillStyle = THEME.notePaper;
    const padX = size * 0.35;
    const padY = size * 0.34;
    ctx.beginPath();
    ctx.ellipse(cx, cy - size * 0.3, total / 2 + padX, size * 0.62 + padY * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();

    let pen = cx - total / 2;
    for (let i = 0; i < widths.length; i++) {
      const h = hash2(salt + 1, i + 17);
      // +-0.09 rad and +-0.7px: enough to look written, not enough to look broken.
      const tilt = (((h % 100) / 100) * 2 - 1) * 0.09;
      const lift = ((((h >>> 8) % 100) / 100) * 2 - 1) * size * 0.07;
      ctx.save();
      ctx.translate(pen, cy + lift);
      ctx.rotate(tilt);
      ctx.fillStyle = THEME.noteInk;
      ctx.fillText(text[i], 0, 0);
      ctx.restore();
      pen += widths[i];
    }
    ctx.restore();
  }

  private drawDebug(): void {
    const w = this.world;
    const g = w.grid;
    const ctx = this.ctx;
    const c = this.cell;

    // Light field as a faint heatmap: makes shading and canopy occlusion legible at a glance.
    const maxLight = Math.max(1, w.cfg.raw.light.lampPpfd);
    for (let i = 0; i < g.size; i++) {
      if (g.substrate[i] !== Substrate.Air) continue;
      const v = w.light.value[i] / maxLight;
      if (v <= 0.02) continue;
      ctx.fillStyle = `rgba(255, 230, 120, ${(v * 0.14).toFixed(3)})`;
      ctx.fillRect(g.xOf(i) * c, g.yOf(i) * c, c, c);
    }

    if (this.hoverCell >= 0 && this.hoverCell < g.size) {
      const i = this.hoverCell;
      ctx.strokeStyle = '#ffd479';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(g.xOf(i) * c + 0.5, g.yOf(i) * c + 0.5, c - 1, c - 1);
      const lines = [
        `${SUBSTRATES[g.substrate[i] as SubstrateId].name}`,
        `moisture ${g.moisture[i].toFixed(1)} mL (${(g.saturation(i) * 100).toFixed(0)}%)`,
        `nutrients ${g.nutrients[i].toFixed(2)}  litter ${g.organic[i].toFixed(2)}`,
        `toxin ${g.toxin[i].toFixed(3)}  mold ${g.mold[i].toFixed(2)}  moss ${w.moss.cover[i].toFixed(2)}`,
        `springtails ${w.fauna.pop[i].toFixed(1)}`,
        `roots ${g.rootCount[i]}  light ${w.light.value[i].toFixed(0)}`,
      ];
      ctx.font = '11px ui-monospace, monospace';
      const bw = 210;
      const bx = Math.min(g.xOf(i) * c + c + 6, this.logicalW - bw - 4);
      const by = Math.min(g.yOf(i) * c, this.logicalH - 70);
      ctx.fillStyle = 'rgba(8, 12, 15, 0.88)';
      ctx.fillRect(bx, by, bw, 16 * lines.length + 8);
      ctx.fillStyle = '#cfe3ec';
      lines.forEach((l, k) => ctx.fillText(l, bx + 8, by + 18 + k * 16));
    }
  }
}

function circle(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The plate: the jar drawn as an illustration rather than a grid.
 *
 * Ink and watercolour, like a plate in a naturalist's notebook. Three techniques do almost all of the
 * work, and all of them read the simulation without ever writing to it:
 *
 *  - WATERCOLOUR BY UPSCALING. The substrate is painted at one pixel per cell into a tiny offscreen
 *    canvas, then drawn to full size with image smoothing on. Wet and dry, and one layer against the
 *    next, bleed into each other the way pigment does — for the cost of 2,244 pixels a frame.
 *  - INK FROM THE GRID. The soil surface and layer boundaries are smoothed curves traced through the
 *    cells, so the plate gets confident outlines without anything being stored twice.
 *  - A VESSEL FROM THE SIMULATION'S OWN GEOMETRY. The glass outline is built from the exact constants
 *    `SubstrateGrid.bakeJarSilhouette` uses, so what you see and where soil can physically sit agree.
 *
 * Which cells count as ground, where the surface line runs and how boundaries join all live in
 * plateGeometry.ts, which has no browser dependencies so the test suite can cover it.
 */

import { Substrate, type SubstrateId } from '../sim/config/content.js';
import { LightField } from '../sim/light.js';
import type { World } from '../sim/world.js';
import { THEME } from '../theme.js';
import {
  boundaries,
  groundTops,
  isSolid,
  looseCells,
  mossAlong,
  surfaceRuns,
  type Point,
} from './plateGeometry.js';
import { mossBushiness } from './plantGeometry.js';

/**
 * A cheap stable scatter. Purely presentational: it lets marks and sprites sit in the same spot every
 * frame without the simulation storing a position for something it does not model individually.
 */
export function hash2(a: number, b: number): number {
  let h = (a * 73856093) ^ (b * 19349663);
  h = (h ^ (h >>> 13)) >>> 0;
  return h;
}

/**
 * The jar's interior outline, in logical pixels.
 *
 * `bakeJarSilhouette` keeps cell (x, y) when it lies within a circle of radius `cornerRadius` about
 * (x0 + r, y1 − r) at the base corners, in cell indices. A cell's centre is at index + 0.5, so the
 * same circle in pixels is centred at (index + 0.5) × c — and a radius of (r + 0.5) × c puts the
 * curve's outermost point exactly on the grid's outer edge. `grow` pushes the sides and base outward,
 * which is how the glass wall's outer line is made.
 */
export function vesselPath(gw: number, gh: number, cornerRadius: number, c: number, grow = 0): Path2D {
  const r = cornerRadius;
  const x0 = 1;
  const x1 = gw - 2;
  const y1 = gh - 2;
  const left = x0 * c - grow;
  const right = (x1 + 1) * c + grow;
  const top = c;
  const bottom = (y1 + 1) * c + grow;
  const rad = (r + 0.5) * c + grow;
  const cy = (y1 - r + 0.5) * c;
  const cxL = (x0 + r + 0.5) * c;
  const cxR = (x1 - r + 0.5) * c;

  const p = new Path2D();
  p.moveTo(left, top);
  p.lineTo(right, top);
  p.lineTo(right, cy);
  p.arc(cxR, cy, rad, 0, Math.PI / 2);
  p.lineTo(cxL, bottom);
  p.arc(cxL, cy, rad, Math.PI / 2, Math.PI);
  p.closePath();
  return p;
}

/**
 * A THEME `rgba(r, g, b, a)` colour at a different alpha.
 *
 * Gradient fade-out stops used to be hand-written literals, and when the palette moved to paper they
 * were left behind as the old pink and pale blue — invisible as long as their alpha was zero, and a
 * trap the moment anyone changed one. Deriving them means they can never drift from their main stop.
 */
export function withAlpha(rgba: string, alpha: number): string {
  return rgba.replace(/rgba\(\s*([^,]+),\s*([^,]+),\s*([^,]+),[^)]*\)/, `rgba($1, $2, $3, ${alpha})`);
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** One column of reeds to draw: where its stems start, and where the water they stand in comes to. */
type ReedColumn = { x: number; base: number; water: number };

/**
 * How much of the gap to the real waterline is closed each frame.
 *
 * A low-pass, not a delay: it settles in a few frames at 60fps, and when the jar is running at 128x
 * it simply trails the level a little, which is what water does anyway.
 */
const WATER_EASE = 0.35;

/** Height of the surface swell, in cells. See `Plate.drawBody`. */
const WATER_SWELL = 0.045;

/**
 * A smooth line that passes THROUGH every point.
 *
 * Catmull-Rom converted to cubic Béziers, with each control point's height clamped between the two
 * points it joins, so the curve never overshoots — a peak is never drawn higher than the material, and
 * a slope never dips below the floor. The earlier midpoint-quadratic version cut every peak down to
 * about three quarters of its real height, which is how a lone mound came out flattened.
 */
function traceSmooth(path: Path2D, pts: readonly Point[], connect = false): void {
  const n = pts.length;
  // `connect` joins onto whatever the path has already drawn, which is how a closed shape gets a
  // smooth edge on both sides — an outline traced there and back, rather than two separate lines.
  if (connect) path.lineTo(pts[0][0], pts[0][1]);
  else path.moveTo(pts[0][0], pts[0][1]);
  if (n === 2) {
    path.lineTo(pts[1][0], pts[1][1]);
    return;
  }
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(n - 1, i + 2)];
    const lo = Math.min(p1[1], p2[1]);
    const hi = Math.max(p1[1], p2[1]);
    path.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6,
      clamp(p1[1] + (p2[1] - p0[1]) / 6, lo, hi),
      p2[0] - (p3[0] - p1[0]) / 6,
      clamp(p2[1] - (p3[1] - p1[1]) / 6, lo, hi),
      p2[0],
      p2[1],
    );
  }
}

/** Blend two packed 0xRRGGBB colours, returning packed. */
function mix(dry: number, wet: number, t: number): number {
  const dr = (dry >> 16) & 255;
  const dg = (dry >> 8) & 255;
  const db = dry & 255;
  const rr = Math.round(dr + (((wet >> 16) & 255) - dr) * t);
  const gg = Math.round(dg + (((wet >> 8) & 255) - dg) * t);
  const bb = Math.round(db + ((wet & 255) - db) * t);
  return (rr << 16) | (gg << 8) | bb;
}

const css = (v: number): string => `rgb(${(v >> 16) & 255}, ${(v >> 8) & 255}, ${v & 255})`;

/** The moss colour at a given opacity. */
const mossRgba = (alpha: number): string => {
  const [mr, mg, mb] = THEME.moss;
  return `rgba(${mr}, ${mg}, ${mb}, ${alpha.toFixed(3)})`;
};

/** How opaque a moss mat is at a given cover: a thin film first, then a thick cushion once established. */
/*
 * Both curves are pitched against the cover a jar can actually REACH, which is not 1.
 *
 * Moss grows only in daylight but dies back around the clock, so per-cell cover asymptotes near 0.68
 * and a well-kept jar measures about 0.54. The thick layer used to start at 0.3 and climb to 0.75, so
 * at 0.54 it resolved to roughly 0.34 alpha — which over the plate's cream paper composites to a pale
 * sage that barely reads as green at all. The mat was correct by its own arithmetic and nearly
 * invisible in practice, the same mistake the bush ramp made.
 */
const mossThin = (v: number): number => (v > 0.02 ? Math.min(1, 0.5 + v * 0.5) : 0);
const mossThick = (v: number): number => (v > 0.1 ? Math.min(0.95, ((v - 0.1) / 0.45) * 0.95) : 0);

/** A tileable paper grain, generated once and deterministically so it never shimmers. */
function makeGrain(): HTMLCanvasElement {
  const n = 96;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const gctx = cv.getContext('2d')!;
  const img = gctx.createImageData(n, n);
  let s = 0x9e3779b9;
  for (let i = 0; i < n * n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    // Mostly near-white (no effect under multiply) with a sparse scatter of darker specks.
    const v = s >>> 24;
    const tone = v > 232 ? 150 + (v % 40) : 236 + (v % 20);
    const o = i * 4;
    img.data[o] = tone;
    img.data[o + 1] = tone - 3;
    img.data[o + 2] = tone - 9;
    img.data[o + 3] = 255;
  }
  gctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Soft blotches for the ground: a coarse field of random tones that, drawn scaled up with smoothing,
 * becomes the uneven patchiness real soil has against glass. Near-white is no change under multiply.
 */
function makeMottle(): HTMLCanvasElement {
  const n = 48;
  const cv = document.createElement('canvas');
  cv.width = n;
  cv.height = n;
  const gctx = cv.getContext('2d')!;
  const img = gctx.createImageData(n, n);
  let s = 0x2545f491;
  for (let i = 0; i < n * n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const tone = 214 + ((s >>> 24) % 42);
    const o = i * 4;
    img.data[o] = tone;
    img.data[o + 1] = tone - 4;
    img.data[o + 2] = tone - 10;
    img.data[o + 3] = 255;
  }
  gctx.putImageData(img, 0, 0);
  return cv;
}

function roundedRect(p: Path2D, x: number, y: number, w: number, h: number, r: number): void {
  p.moveTo(x + r, y);
  p.lineTo(x + w - r, y);
  p.arcTo(x + w, y, x + w, y + r, r);
  p.lineTo(x + w, y + h - r);
  p.arcTo(x + w, y + h, x + w - r, y + h, r);
  p.lineTo(x + r, y + h);
  p.arcTo(x, y + h, x, y + h - r, r);
  p.lineTo(x, y + r);
  p.arcTo(x, y, x + r, y, r);
  p.closePath();
}

/**
 * The outline of one loose piece of material: a smooth, slightly lumpy pebble for gravel, a crumb for
 * soil, an angular chunk for charcoal.
 *
 * The shape is seeded by COLUMN rather than cell. A falling grain changes cell every tick, so seeding
 * by cell would give it a new outline every tick and it would visibly boil on the way down.
 */
function clumpPath(cx: number, cy: number, radius: number, seed: number, id: number): Path2D {
  const p = new Path2D();
  const angular = id === Substrate.Charcoal;
  const count = angular ? 5 : 8;
  const jitter = id === Substrate.Soil ? 0.3 : id === Substrate.Gravel ? 0.14 : 0.22;
  const pts: Point[] = [];
  for (let k = 0; k < count; k++) {
    const h = hash2(seed, k + 500);
    const a = (k / count) * Math.PI * 2 + ((h >> 5) % 30) * 0.01;
    const r = radius * (1 - jitter + ((h % 100) / 100) * jitter);
    // Gravel sits a little flatter, the way pebbles do.
    const squash = id === Substrate.Gravel ? 0.78 : 0.9;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r * squash]);
  }
  if (angular) {
    p.moveTo(pts[0][0], pts[0][1]);
    for (let k = 1; k < count; k++) p.lineTo(pts[k][0], pts[k][1]);
    p.closePath();
    return p;
  }
  // Closed smooth outline through the midpoints.
  const mid = (a: Point, b: Point): Point => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[count - 1], pts[0]);
  p.moveTo(start[0], start[1]);
  for (let k = 0; k < count; k++) {
    const m = mid(pts[k], pts[(k + 1) % count]);
    p.quadraticCurveTo(pts[k][0], pts[k][1], m[0], m[1]);
  }
  p.closePath();
  return p;
}

export class Plate {
  /** The jar's interior. Exposed so the renderer can clip to it, and so the browser check can prove
   * every substrate cell lies inside it. */
  readonly vessel: Path2D;
  private readonly outer: Path2D;
  private readonly small: HTMLCanvasElement;
  private readonly smallCtx: CanvasRenderingContext2D;
  private readonly img: ImageData;
  /** Packed colour per cell for the current frame's wash; -1 while unresolved. */
  private readonly colour: Int32Array;
  private readonly grain: HTMLCanvasElement;
  /** Soft ground blotches (see `makeMottle`), and the ground's cached detail with the key it was built for. */
  private readonly mottle: HTMLCanvasElement;
  private detail: HTMLCanvasElement | null = null;
  private detailKey = '';
  private grainPattern: CanvasPattern | null = null;
  /**
   * Eased moss bushiness per column. Springtail populations shift every tick, and bushes drawn from the
   * raw value would visibly pulse as the colony moves.
   */
  private readonly bush: Float32Array;

  constructor(
    private readonly world: World,
    private readonly c: number,
  ) {
    const g = world.grid;
    const r = world.cfg.raw.grid.cornerRadius;
    this.vessel = vesselPath(g.w, g.h, r, c);
    this.outer = vesselPath(g.w, g.h, r, c, c * THEME.plate.wall);
    this.small = document.createElement('canvas');
    this.small.width = g.w;
    this.small.height = g.h;
    this.smallCtx = this.small.getContext('2d')!;
    this.img = this.smallCtx.createImageData(g.w, g.h);
    this.colour = new Int32Array(g.size);
    this.grain = makeGrain();
    this.mottle = makeMottle();
    this.bush = new Float32Array(g.w);
    this.line = new Float64Array(g.w).fill(NaN);
  }

  /**
   * The ground's drawn silhouette, kept from the last `drawSubstrate` so the water can be cut by it.
   *
   * Null when the jar has no ground at all, which is a real state while a jar is being built.
   */
  private groundFill: Path2D | null = null;

  /** The ground's drawn silhouette as of the last frame, for anything that must stay inside it. */
  get ground(): Path2D | null {
    return this.groundFill;
  }

  /**
   * The DRAWN waterline per column, eased toward wherever the simulation has put it.
   *
   * The sim steps ten times a second and the screen draws sixty, so a level taken straight from the
   * grid holds still for six frames and then jumps — which is exactly what a falling grain would do
   * without the sub-tick easing `drawLoose` already has, and it reads as stutter rather than as
   * water. NaN means the column is dry.
   */
  private readonly line: Float64Array;

  /** The cast shadow on the page and the paper inside the glass. Drawn before anything else. */
  drawGround(ctx: CanvasRenderingContext2D): void {
    const g = this.world.grid;
    const c = this.c;
    ctx.fillStyle = THEME.plate.shadow;
    ctx.beginPath();
    ctx.ellipse((g.w / 2) * c, (g.h - 0.55) * c, (g.w / 2 - 3) * c, 0.5 * c, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = THEME.plate.interior;
    ctx.fill(this.vessel);
  }

  /**
   * Watercolour ground, grain, material marks, standing water, the ink over it, moss, and any loose
   * grains.
   *
   * Only GROUND — solid material resting on the glass — is washed and clipped as one mass. A grain
   * with air beneath it is drawn on its own, so the air under a falling particle is never painted as
   * soil and a lone grain is never joined into the surface line.
   *
   * `alpha` is the same sub-tick fraction the renderer hands every other draw call, threaded down to
   * `drawLoose` so a falling grain eases across the gap between two cells instead of snapping a whole
   * 12px on every tick.
   */
  drawSubstrate(ctx: CanvasRenderingContext2D, alpha: number): void {
    const g = this.world.grid;
    const c = this.c;
    const tops = groundTops(g);
    const runs = surfaceRuns(g, tops, c);

    this.groundFill = null;
    if (runs.length > 0) {
      const fill = new Path2D();
      const line = new Path2D();
      for (const run of runs) {
        traceSmooth(line, run);
        traceSmooth(fill, run);
        fill.lineTo(run[run.length - 1][0], g.h * c);
        fill.lineTo(run[0][0], g.h * c);
        fill.closePath();
      }
      this.groundFill = fill;

      this.paintWash(tops);
      if (!this.grainPattern) this.grainPattern = ctx.createPattern(this.grain, 'repeat');

      ctx.save();
      ctx.clip(this.vessel);
      ctx.clip(fill);
      ctx.drawImage(this.small, 0, 0, g.w * c, g.h * c);

      if (this.grainPattern) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = THEME.plate.grainAlpha;
        ctx.fillStyle = this.grainPattern;
        ctx.fillRect(0, 0, g.w * c, g.h * c);
        // The blotches, scaled up so each is a few cells across.
        ctx.globalAlpha = THEME.plate.mottleAlpha;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(this.mottle, 0, 0, this.mottle.width * c * 2.2, this.mottle.height * c * 2.2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      this.drawDetail(ctx);

      // Standing water: a soft blue wash hugging the top of saturated cells.
      const pools = new Path2D();
      let anyPool = false;
      for (const i of g.activeCells) {
        if (g.saturation(i) <= 1) continue;
        pools.rect(g.xOf(i) * c, g.yOf(i) * c, c, c * 0.45);
        anyPool = true;
      }
      if (anyPool) {
        ctx.fillStyle = THEME.plate.standingWater;
        ctx.fill(pools);
      }

      // Quiet lines between layers — inside the ground clip, so where the surface slopes away at the
      // side of a mound, a boundary cannot poke out into the air past it.
      const bnd = new Path2D();
      for (const chain of boundaries(g, tops, c)) traceSmooth(bnd, chain);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = THEME.plate.inkFaint;
      ctx.lineWidth = 0.8;
      ctx.stroke(bnd);
      ctx.restore();

      // One confident line along the surface, slopes included.
      ctx.save();
      ctx.clip(this.vessel);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = THEME.plate.inkStrong;
      ctx.lineWidth = 1.3;
      ctx.stroke(line);
      ctx.restore();

      this.drawMoss(ctx, runs, tops);
    }

    this.drawLoose(ctx, looseCells(g, tops), alpha);
  }

  /** Glass walls, highlights and the lip, drawn over the jar's contents. */
  /**
   * Free water, drawn over the substrate it is sitting in or on.
   *
   * The surface is a CURVE through the columns, not a rectangle per cell. Water levels itself, so
   * neighbouring columns differ by a sliver at most — but drawn as separate squares with a separate
   * stroke each, that sliver is a staircase with a broken line on top, and the eye reads blocks
   * rather than a liquid. One smooth edge across the whole body is the difference.
   *
   * The floor is left stepped on purpose. It is the shape of the basin that was dug, and rounding it
   * off would only disagree with the soil drawn right beneath it.
   */
  drawWater(ctx: CanvasRenderingContext2D): void {
    const g = this.world.grid;
    const c = this.c;
    const cap = this.world.cfg.raw.standing.cellMl;

    /*
     * Per column: the waterline of the topmost body of water, and the floor that body rests on. A
     * column can hold two separated bodies — a pond above, a flooded hollow below a shelf — so
     * whatever is not part of the top one is drawn plainly afterwards.
     */
    const surf = new Float64Array(g.w).fill(NaN);
    const floor = new Float64Array(g.w);
    const deeper = new Path2D();
    let any = false;

    for (let x = 1; x <= g.w - 2; x++) {
      let top = -1;
      let bottom = -1;
      for (let y = 1; y <= g.h - 2; y++) {
        const ml = g.standing[g.idx(x, y)];
        if (ml <= 0.001) {
          if (top >= 0) break;
          continue;
        }
        if (top < 0) top = y;
        bottom = y;
      }
      if (top < 0) continue;
      any = true;
      const fill = Math.min(1, g.standing[g.idx(x, top)] / cap);
      surf[x] = (top + 1 - fill) * c;
      floor[x] = (bottom + 1) * c;

      // Anything below a gap in the same column: rare, and not part of the smooth body.
      for (let y = bottom + 2; y <= g.h - 2; y++) {
        const ml = g.standing[g.idx(x, y)];
        if (ml <= 0.001) continue;
        const depth = Math.min(1, ml / cap) * c;
        deeper.rect(x * c, (y + 1) * c - depth, c, depth);
      }
    }
    // Real seconds, not sim time: the swell and the streaks are presentation, and must not race at 128x.
    const seconds = performance.now() / 1000;
    if (!any) {
      this.drawGroundReeds(ctx, surf, seconds);
      return;
    }

    /*
     * Ease each column's waterline toward the level the sim reports, and draw the eased one.
     *
     * A column that has just flooded starts where it is rather than sliding down from the last thing
     * drawn there, and one that has just dried snaps away: those are events, not movement. Everything
     * in between — a pond filling, a puddle soaking in — glides. Clamped to the bed, because a lagging
     * line that overshot its own floor would turn the body inside out.
     */
    for (let i = 1; i <= g.w - 2; i++) {
      const target = surf[i];
      if (Number.isNaN(target)) {
        this.line[i] = NaN;
        continue;
      }
      const prev = this.line[i];
      const eased = Number.isNaN(prev) ? target : prev + (target - prev) * WATER_EASE;
      this.line[i] = Math.min(eased, floor[i]);
    }

    /*
     * Every drop is cut by the GROUND'S OWN outline, and that is what makes the waterline reliable.
     *
     * Water and soil used to be two smooth curves built from the same points and hoped to agree; where
     * they did not, the page showed through the gap. Clipping to the shape the soil was actually drawn
     * with removes the whole class of seam: the water can be traced generously, over the bank and a
     * third of a cell into the bed, and the clip puts the edge exactly where the ground is.
     *
     * Even-odd against the jar's interior is the inverse: inside the glass AND outside the ground.
     */
    ctx.save();
    const open = new Path2D();
    open.addPath(this.vessel);
    if (this.groundFill) open.addPath(this.groundFill);
    ctx.clip(open, 'evenodd');

    ctx.fillStyle = THEME.water.body;
    ctx.fill(deeper);

    // Each unbroken stretch of watered columns is one body of water, with one continuous edge.
    let x = 1;
    while (x <= g.w - 2) {
      if (Number.isNaN(surf[x])) {
        x++;
        continue;
      }
      let last = x;
      while (last + 1 <= g.w - 2 && !Number.isNaN(surf[last + 1])) last++;
      this.drawBody(ctx, x, last, this.line, floor, seconds);
      x = last + 1;
    }
    this.drawGroundReeds(ctx, surf, seconds);
    ctx.restore();
  }

  /**
   * Reeds standing on GROUND rather than in water: on a pond's bank, one column out from its edge, or
   * left behind in a pond that has dried up. The stem rises straight from the ground surface.
   */
  private drawGroundReeds(ctx: CanvasRenderingContext2D, surf: Float64Array, seconds: number): void {
    const g = this.world.grid;
    const pond = this.world.pond;
    const c = this.c;
    const cols: ReedColumn[] = [];
    for (let x = 1; x <= g.w - 2; x++) {
      if (pond.reeds[x] < 0.03 || !Number.isNaN(surf[x])) continue;
      const ground = g.surfaceOfColumn[x];
      if (ground < 0) continue;
      const y = g.yOf(ground) * c;
      cols.push({ x, base: y, water: y });
    }
    this.drawReeds(ctx, cols, seconds);
  }

  /**
   * One body of water, from column `from` to column `to`.
   *
   * BOTH edges are traced with `traceSmooth`, the same curve the soil surface is drawn with. That is
   * not decoration on the underside: the ground is drawn as a smooth ramp, so a water floor stepped
   * cell by cell disagreed with it, and where a basin wall rose two rows in one column the page
   * showed through the gap between them.
   *
   * The surface runs on to the CENTRE of the bank column on each side, not just to the edge of the
   * last wet one. The bank is drawn as a ramp that only reaches its full height at that centre, so a
   * waterline stopping at the cell edge left a sliver of open air between the water and the soil at
   * the top of every pond. The clip in `drawWater` trims the overrun back to the soil's own edge.
   */
  private drawBody(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    surf: Float64Array,
    floor: Float64Array,
    seconds: number,
  ): void {
    const c = this.c;
    const mid = (x: number): number => x * c + c / 2;

    /*
     * A slow swell on the surface: two sines at unrelated speeds and wavelengths, so it never visibly
     * repeats. Half a pixel at the default cell size, and less over a film too thin to carry it — just
     * enough that a pond reads as liquid that is standing still rather than a flat blue shape.
     */
    const swell = (x: number): number => {
      const depth = Math.max(0, floor[x] - surf[x]);
      const amp = Math.min(c * WATER_SWELL, depth * 0.25);
      return amp * (Math.sin(seconds * 1.4 + x * 0.55) + 0.5 * Math.sin(seconds * 2.3 - x * 1.3));
    };

    const top: Point[] = [[mid(from - 1), surf[from]]];
    for (let x = from; x <= to; x++) top.push([mid(x), surf[x] + swell(x)]);
    top.push([mid(to + 1), surf[to]]);

    /*
     * Traced right to left, to carry straight on from the surface into a closed outline, and pushed a
     * third of a cell into the bed it rests on. The clip cuts it back to the ground's own edge, so this
     * only has to be deep enough to cover any disagreement, and shallow enough to stay inside the
     * material it is sinking into rather than reappearing in a hollow beneath it.
     */
    const bias = c * 0.35;
    const bed: Point[] = [[mid(to + 1), floor[to] + bias]];
    for (let x = to; x >= from; x--) bed.push([mid(x), floor[x] + bias]);
    bed.push([mid(from - 1), floor[from] + bias]);

    const body = new Path2D();
    traceSmooth(body, top);
    traceSmooth(body, bed, true);
    body.closePath();

    const line = new Path2D();
    traceSmooth(line, top);

    // Reeds before the water, so the pond tints the part of each stem that stands in it.
    const reedCols: ReedColumn[] = [];
    for (let x = from; x <= to; x++) if (this.world.pond.reeds[x] >= 0.03) reedCols.push({ x, base: floor[x], water: surf[x] });
    this.drawReeds(ctx, reedCols, seconds);

    /*
     * Deeper water reads darker, which is most of what tells a pond from a puddle at a glance. The
     * gradient spans the body rather than each cell, so it does not restart at every cell boundary.
     */
    let hi = Infinity;
    let lo = 0;
    for (let x = from; x <= to; x++) {
      if (surf[x] < hi) hi = surf[x];
      if (floor[x] > lo) lo = floor[x];
    }
    const grad = ctx.createLinearGradient(0, hi, 0, lo);
    grad.addColorStop(0, withAlpha(THEME.water.body, 0.3));
    grad.addColorStop(1, withAlpha(THEME.water.body, 0.62));
    ctx.fillStyle = grad;
    ctx.fill(body);

    ctx.save();
    ctx.clip(body);
    // Under the green, so a murky pond hides its own floor the way real green water does.
    this.drawPebbles(ctx, from, to, floor);
    // Also under the green: in a murky pond the fronds are shapes in the gloom, not a clear picture.
    this.drawHornwort(ctx, from, to, surf, floor, seconds);
    this.drawAlgae(ctx, from, to);
    this.drawWaterGrain(ctx, from, to, surf, floor, seconds);
    this.drawShimmer(ctx, from, to, floor, seconds);
    this.drawBubbles(ctx, from, to, surf, floor, seconds);
    this.drawFish(ctx, from, to, surf, floor, seconds);
    ctx.restore();

    // Light caught just under the surface: what separates a waterline from an ink outline.
    ctx.save();
    ctx.translate(0, c * 0.16);
    ctx.strokeStyle = THEME.water.glint;
    ctx.lineWidth = 1;
    ctx.stroke(line);
    ctx.restore();

    ctx.strokeStyle = THEME.water.surface;
    ctx.lineWidth = 1.1;
    ctx.lineJoin = 'round';
    ctx.stroke(line);

    this.drawSnails(ctx, from, to, floor);
    this.drawLilies(ctx, from, to, surf, floor, seconds);
  }

  /**
   * Ramshorn snails: small coiled shells sitting on the pond floor, one drawn for every few snails.
   *
   * Hashed positions, so each shell stays put rather than crawling about as the colony's numbers
   * shift; a colony that grows gains shells, and one that thins loses them.
   */
  private drawSnails(ctx: CanvasRenderingContext2D, from: number, to: number, floor: Float64Array): void {
    const pond = this.world.pond;
    const c = this.c;
    const shells = new Path2D();
    const coils = new Path2D();
    let any = false;
    /*
     * Shells are shared out across the WHOLE pond by its total, one per snail for a small colony, then
     * more thinly for a big one. Rounding each column on its own drew nothing at all: six snails spread
     * over nine columns is under one per column, every column rounded to zero, and the colony seemed to
     * die within the hour of being added.
     */
    let total = 0;
    for (let x = from; x <= to; x++) total += pond.snails[x];
    const perSnail = total <= 18 ? 1 : (18 + (total - 18) / 3) / total;
    let running = 0;
    for (let x = from; x <= to; x++) {
      const before = Math.floor(running + 0.5);
      running += pond.snails[x] * perSnail;
      const shown = Math.min(4, Math.floor(running + 0.5) - before);
      for (let k = 0; k < shown; k++) {
        const h = hash2(x, 211 + k);
        const r = c * (0.13 + ((h >>> 4) & 3) * 0.015);
        const px = x * c + (0.2 + ((h & 15) / 15) * 0.6) * c;
        // Resting ON the floor, not half-buried in it.
        const py = floor[x] - r;
        shells.moveTo(px + r, py);
        shells.arc(px, py, r, 0, Math.PI * 2);
        // The coil: a smaller turn inside the shell, the one detail that says "snail" not "pebble".
        coils.moveTo(px + r * 0.5, py);
        coils.arc(px, py, r * 0.5, 0, Math.PI * 1.6);
        any = true;
      }
    }
    if (!any) return;
    ctx.fillStyle = THEME.snail.shell;
    ctx.fill(shells);
    ctx.strokeStyle = THEME.snail.ink;
    ctx.lineWidth = 0.7;
    ctx.stroke(shells);
    ctx.stroke(coils);
  }

  /**
   * Lily pads: broad round leaves lying on the water on long stems from the floor, the V notch that
   * says "lily" at a glance, and pink flowers once a bed has taken hold.
   *
   * Every pad is the SAME plant. They vary in size and spacing (big mature pads and small young ones,
   * in clumps with open water between) so a bed never reads as a green line, but in nothing else. Pads
   * with curled red undersides, rolled-up new leaves standing out of the water, yellowing old ones and
   * pointed buds were tried, and read as other kinds of plant among the lilies rather than as one lily
   * at different ages.
   *
   * Hashed per column and slot, so each pad keeps its place as the bed shifts. Seen from the side, a
   * flat pad is a flattened disc. The water under a closed bed is shaded, because the pads are a roof.
   */
  private drawLilies(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    surf: Float64Array,
    floor: Float64Array,
    seconds: number,
  ): void {
    const pond = this.world.pond;
    const c = this.c;
    const t = THEME.lily;
    let any = false;
    for (let x = from; x <= to && !any; x++) if (pond.lilies[x] >= 0.03) any = true;
    if (!any) return;

    // --- The shade under the pads, column by column, butted edge to edge so it never stripes.
    for (let x = from; x <= to; x++) {
      const cover = Math.min(1, pond.lilies[x]);
      if (cover < 0.03) continue;
      const depth = c * 1.3;
      const fade = ctx.createLinearGradient(0, surf[x], 0, surf[x] + depth);
      fade.addColorStop(0, withAlpha(t.shade, cover * 0.45));
      fade.addColorStop(1, withAlpha(t.shade, 0));
      ctx.fillStyle = fade;
      const x0 = x === from ? (x - 1) * c : x * c;
      const x1 = x === to ? (x + 2) * c : (x + 1) * c;
      ctx.fillRect(x0, surf[x], x1 - x0, depth);
    }

    type Pad = { px: number; py: number; r: number; tilt: number; notch: number };
    type Bloom = { fx: number; fy: number; s: number };
    const pads: Pad[] = [];
    const blooms: Bloom[] = [];
    const stems = new Path2D();

    for (let x = from; x <= to; x++) {
      const cover = Math.min(1, pond.lilies[x]);
      if (cover < 0.03) continue;
      // Three slots a column, each filled or left open by its own hash against the cover: a thin bed
      // is a few scattered clumps, a full one is crowded, and neither is ever an even row.
      for (let k = 0; k < 3; k++) {
        const h = hash2(x, 601 + k);
        const r1 = (h & 255) / 255;
        const r2 = ((h >>> 8) & 255) / 255;
        const r3 = ((h >>> 16) & 255) / 255;
        if (r1 > cover * 0.95) continue;
        // Mostly middling, now and then a big mature pad or a small young one.
        const size = r2 < 0.2 ? 0.55 : r2 > 0.85 ? 1.35 : 0.8 + 0.3 * r3;
        const r = c * 0.42 * size;
        const px = x * c + ((k + 0.5) / 3) * c + (r3 - 0.5) * c * 0.45;
        const bob = Math.sin(seconds * 1.4 + x * 0.55 + k) * c * 0.02;
        const py = surf[x] + bob - c * 0.02;
        pads.push({ px, py, r, tilt: (r3 - 0.5) * 0.06, notch: ((h >>> 7) & 1) === 0 ? 0.25 : Math.PI - 0.25 });

        const sway = Math.sin(seconds * 0.5 + x + k * 2.3) * c * 0.12;
        stems.moveTo(px, py + c * 0.03);
        stems.bezierCurveTo(px + sway, py + (floor[x] - py) * 0.35, px - sway * 0.6, py + (floor[x] - py) * 0.7, px + (r1 - 0.5) * c * 0.3, floor[x]);

        // A pink flower on roughly one pad in four, once the bed has taken hold.
        if (cover > 0.4 && ((h >>> 13) & 3) === 0) {
          blooms.push({ fx: px + (r2 - 0.5) * r, fy: py, s: c * (0.18 + 0.06 * r3) });
        }
      }
    }

    ctx.strokeStyle = t.stem;
    ctx.lineWidth = 0.8;
    ctx.lineCap = 'round';
    ctx.stroke(stems);

    // Small pads first, big last, so the big ones lie over the small as they do on a real pond.
    pads.sort((p, q) => p.r - q.r);
    for (const pad of pads) {
      ctx.save();
      ctx.translate(pad.px, pad.py);
      ctx.rotate(pad.tilt);
      const rx = pad.r;
      const ry = pad.r * 0.28;
      const half = 0.3;
      // The flat disc, with its notch cut out.
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.ellipse(0, 0, rx, ry, 0, pad.notch + half, pad.notch + Math.PI * 2 - half);
      ctx.closePath();
      ctx.fillStyle = t.pad;
      ctx.fill();
      ctx.strokeStyle = t.padEdge;
      ctx.lineWidth = 0.6;
      ctx.stroke();
      // The rim catching the light along its front edge.
      ctx.beginPath();
      ctx.ellipse(0, ry * 0.18, rx * 0.92, ry * 0.8, 0, 0.35, Math.PI - 0.35);
      ctx.strokeStyle = t.padRim;
      ctx.lineWidth = 0.9;
      ctx.stroke();
      ctx.restore();
    }

    // Flowers last, sitting up on top: a cup of pointed pink petals and a golden centre.
    for (const b of blooms) {
      ctx.save();
      ctx.translate(b.fx, b.fy);
      const petals = [-0.95, -0.5, 0, 0.5, 0.95];
      for (const a of petals) {
        ctx.beginPath();
        const tipX = Math.sin(a) * b.s * 1.1;
        const tipY = -Math.cos(a) * b.s * 1.35;
        ctx.moveTo(-b.s * 0.25, 0);
        ctx.quadraticCurveTo(tipX - b.s * 0.35, tipY * 0.45, tipX, tipY);
        ctx.quadraticCurveTo(tipX + b.s * 0.35, tipY * 0.45, b.s * 0.25, 0);
        ctx.closePath();
        ctx.fillStyle = t.flowerPink;
        ctx.fill();
        ctx.strokeStyle = t.flowerInk;
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.ellipse(0, -b.s * 0.3, b.s * 0.3, b.s * 0.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = t.flowerCentre;
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * A scatter of small stones on the pond floor: a floor you can see is what makes water look like
   * water you can see INTO. Hashed, so they never move; drawn under the green, so a murky pond hides
   * them, which is the point.
   */
  private drawPebbles(ctx: CanvasRenderingContext2D, from: number, to: number, floor: Float64Array): void {
    const c = this.c;
    const stones = new Path2D();
    for (let x = from; x <= to; x++) {
      const count = 1 + (hash2(x, 401) % 3);
      for (let k = 0; k < count; k++) {
        const h = hash2(x, 411 + k);
        const r = c * (0.07 + ((h >>> 4) & 7) / 7 * 0.08);
        const px = x * c + (0.15 + ((h & 15) / 15) * 0.7) * c;
        const py = floor[x] - r * 0.55;
        stones.moveTo(px + r, py);
        stones.ellipse(px, py, r, r * 0.62, (((h >>> 8) & 7) - 3.5) * 0.08, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = THEME.water.pebble;
    ctx.fill(stones);
    ctx.strokeStyle = THEME.water.pebbleInk;
    ctx.lineWidth = 0.6;
    ctx.stroke(stones);
  }

  /**
   * Hornwort: stems growing up from the floor, ringed with whorls of needle leaves that crowd into a
   * bushy "foxtail" tip.
   *
   * No two stems alike, because a bed of identical ones read as a comb. Each stem, hashed so it keeps
   * its character, gets its own height (from a young shoot to one reaching the surface), its own lean,
   * a chance of arching over at the top the way long hornwort does, its own bushiness, sometimes a
   * side branch, and one of three greens. They sway slowly as the water moves.
   */
  private drawHornwort(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    surf: Float64Array,
    floor: Float64Array,
    seconds: number,
  ): void {
    const pond = this.world.pond;
    const c = this.c;
    const w = THEME.water;
    const shades = [w.hornwortDeep, w.hornwort, w.hornwortTip];
    const stems = shades.map(() => new Path2D());
    const needles = shades.map(() => new Path2D());
    const tips = shades.map(() => new Path2D());
    let any = false;

    /** One stem: a curve from (bx, by) through a control point to its tip, with whorls up it. */
    const grow = (
      shade: number,
      bx: number,
      by: number,
      cx: number,
      cy: number,
      tx: number,
      ty: number,
      bushiness: number,
      phase: number,
    ): void => {
      stems[shade].moveTo(bx, by);
      stems[shade].quadraticCurveTo(cx, cy, tx, ty);
      const length = Math.hypot(tx - bx, ty - by);
      const whorls = Math.max(3, Math.round((length / (c * 0.17)) * bushiness));
      for (let n = 1; n <= whorls; n++) {
        const u = Math.pow(n / whorls, 0.75);
        const iu = 1 - u;
        const px = iu * iu * bx + 2 * iu * u * cx + u * u * tx;
        const py = iu * iu * by + 2 * iu * u * cy + u * u * ty;
        // The stem's own direction here, so needles stand out from a leaning stem, not straight up.
        const dx = 2 * iu * (cx - bx) + 2 * u * (tx - cx);
        const dy = 2 * iu * (cy - by) + 2 * u * (ty - cy);
        const along = Math.atan2(dy, dx);
        const len = c * (0.21 - 0.09 * u) * (0.8 + 0.4 * bushiness);
        for (const dir of [-1, 1]) {
          for (const spread of [0.7, 1.2]) {
            const ang = along + dir * spread + Math.sin(seconds * 0.6 + n + phase) * 0.06;
            needles[shade].moveTo(px, py);
            needles[shade].lineTo(px + Math.cos(ang) * len, py + Math.sin(ang) * len);
          }
        }
      }
      const r = c * (0.07 + 0.05 * bushiness);
      tips[shade].moveTo(tx + r, ty);
      tips[shade].ellipse(tx, ty, r, r * 1.35, 0, 0, Math.PI * 2);
    };

    for (let x = from; x <= to; x++) {
      const cover = pond.hornwort[x];
      if (cover < 0.03) continue;
      const depth = floor[x] - surf[x];
      if (depth < c * 0.4) continue;
      const count = cover > 0.6 ? 3 : cover > 0.25 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const h = hash2(x, 491 + k);
        const r1 = (h & 255) / 255;
        const r2 = ((h >>> 8) & 255) / 255;
        const r3 = ((h >>> 16) & 255) / 255;
        const r4 = ((h >>> 24) & 255) / 255;
        // From a young shoot a third of the way up to one reaching the surface.
        const reach = 0.35 + 0.65 * cover;
        const height = Math.min(depth - c * 0.08, depth * reach * (0.45 + 0.6 * r1));
        const bx = x * c + ((k + 0.5) / count + (r2 - 0.5) * 0.3 / count) * c;
        const by = floor[x];
        const sway = Math.sin(seconds * 0.6 + x * 0.9 + k * 2.1) * c * 0.15 * (height / c);
        const lean = (r3 - 0.5) * c * 0.9;
        const bushiness = 0.6 + 0.8 * r4;
        const shade = Math.floor(r1 * 2.99 * 0.6 + r4 * 2.99 * 0.4);
        let tx = bx + lean + sway;
        let ty = by - height;
        // Roughly one tall stem in four arches over near the top, as long hornwort does.
        if (height > depth * 0.6 && (h >>> 5) % 4 === 0) {
          const side = r3 < 0.5 ? -1 : 1;
          tx += side * c * 0.55;
          ty += c * 0.25;
        }
        grow(shade, bx, by, bx + lean * 0.3, by - height * 0.55, tx, ty, bushiness, k + x);
        any = true;

        // A side branch on some of the taller stems, forking off partway up.
        if (height > c * 1.2 && ((h >>> 9) & 3) === 0) {
          const u = 0.4 + 0.2 * r2;
          const fx = bx + (tx - bx) * u * u + lean * 0.3 * 2 * u * (1 - u);
          const fy = by + (ty - by) * u;
          const side = r2 < 0.5 ? -1 : 1;
          const bl = height * (0.35 + 0.2 * r4);
          const ex = fx + side * bl * 0.55 + sway * 0.5;
          const ey = fy - bl * 0.8;
          grow(Math.min(2, shade + 1), fx, fy, fx + side * bl * 0.15, fy - bl * 0.5, ex, ey, bushiness * 0.8, k + x + 3);
        }
      }
    }
    if (!any) return;
    ctx.lineCap = 'round';
    for (let i = 0; i < shades.length; i++) {
      ctx.strokeStyle = shades[i];
      ctx.lineWidth = 1.2;
      ctx.stroke(stems[i]);
      ctx.lineWidth = 0.8;
      ctx.stroke(needles[i]);
    }
    ctx.fillStyle = w.hornwortTip;
    for (const path of tips) ctx.fill(path);
  }

  /**
   * Sunlight in the water: soft slanting shafts coming down from the surface and fading with depth,
   * swaying slowly as the surface moves.
   *
   * Shafts rather than the bright web light throws on a pond floor. The jar is seen from the side, so
   * the floor is edge-on, and that web drawn along it read as clumps of white foam between the stones.
   * Only by day, only as bright as the lamp, and dimmed by green water, because a bloom is exactly
   * what stops light getting down into a pond.
   */
  private drawShimmer(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    floor: Float64Array,
    seconds: number,
  ): void {
    const w = this.world;
    const light = LightField.dayFraction(w.cfg, w.tickCount) * w.atmo.lampIntensity;
    if (light <= 0.02) return;
    const c = this.c;
    let murk = 0;
    let top = Infinity;
    for (let x = from; x <= to; x++) {
      murk = Math.max(murk, w.pond.greenness(w.cfg, x));
      top = Math.min(top, this.line[x]);
    }
    const strength = Math.min(1, light) * (1 - murk * 0.85);
    if (strength <= 0.02 || !Number.isFinite(top)) return;
    const span = (to - from + 1) * c;
    const shafts = Math.max(2, Math.round((to - from + 1) / 2.5));
    ctx.save();
    for (let k = 0; k < shafts; k++) {
      const h = hash2(from * 31 + k, 471);
      const x0 = from * c + ((k + 0.5) / shafts) * span + Math.sin(seconds * 0.25 + k * 1.9) * c * 0.35 - c * 0.3;
      const width = c * (0.3 + 0.18 * Math.sin(seconds * 0.45 + k * 2.3) + ((h & 7) / 7) * 0.15);
      const col = Math.max(from, Math.min(to, Math.floor(x0 / c)));
      const bottom = floor[col];
      const slant = (bottom - top) * 0.35;
      const grad = ctx.createLinearGradient(0, top, 0, bottom);
      grad.addColorStop(0, withAlpha(THEME.water.shimmer, 0.3 * strength));
      grad.addColorStop(0.75, withAlpha(THEME.water.shimmer, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0, top);
      ctx.lineTo(x0 + width, top);
      ctx.lineTo(x0 + width * 1.6 + slant, bottom);
      ctx.lineTo(x0 + slant, bottom);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  /**
   * Bubbles rising from the floor, wobbling as they go and vanishing at the surface.
   *
   * A few columns always have a stream, so any pond has some life in it; one where something is
   * rotting on the floor or snails are feeding gets one too. Each stream runs on its own period, in
   * real seconds, so they never rise in step.
   */
  private drawBubbles(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    surf: Float64Array,
    floor: Float64Array,
    seconds: number,
  ): void {
    const w = this.world;
    const g = w.grid;
    const c = this.c;
    const bubbles = new Path2D();
    const shine = new Path2D();
    for (let x = from; x <= to; x++) {
      const depth = floor[x] - surf[x];
      if (depth < c * 0.6) continue;
      const bed = g.surfaceOfColumn[x];
      const rotting = bed >= 0 && g.organic[bed] > 0.2;
      // Hornwort in daylight gives off oxygen: fine streams of bubbles from among the fronds.
      const breathing = w.pond.hornwort[x] > 0.2 && LightField.dayFraction(w.cfg, w.tickCount) > 0.3;
      const busy = rotting || breathing || w.pond.snails[x] > 0.5;
      const h = hash2(x, 451);
      if (!busy && (h & 3) !== 0) continue;
      const streams = busy ? 2 : 1;
      for (let k = 0; k < streams; k++) {
        const hk = hash2(x, 461 + k);
        const period = 3.5 + ((hk >>> 4) & 15) * 0.35;
        const p = ((seconds + (hk & 255) * 0.07) % period) / period;
        if (p > 0.96) continue;
        const r = c * (0.04 + ((hk >>> 8) & 3) * 0.012) * (0.8 + p * 0.4);
        const bx = x * c + (0.25 + ((hk >>> 12) & 15) / 15 * 0.5) * c + Math.sin(seconds * 5 + x + k * 2) * c * 0.05;
        const by = floor[x] - r - p * (depth - r * 2);
        bubbles.moveTo(bx + r, by);
        bubbles.arc(bx, by, r, 0, Math.PI * 2);
        shine.moveTo(bx - r * 0.35 + r * 0.22, by - r * 0.35);
        shine.arc(bx - r * 0.35, by - r * 0.35, r * 0.22, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = THEME.water.bubble;
    ctx.fill(bubbles);
    ctx.strokeStyle = THEME.water.surface;
    ctx.lineWidth = 0.6;
    ctx.stroke(bubbles);
    ctx.fillStyle = THEME.water.glint;
    ctx.fill(shine);
  }

  /**
   * Fish, swimming back and forth across the pond: each on its own depth and pace, turning at the ends,
   * tail beating as it goes.
   *
   * Drawn per body of water rather than per column, because a fish swims the whole pond; how many is
   * the pond's total, rounded. Faded by green water, so a bloom visibly hides them, which is as good a
   * reason as any to keep the water clear.
   */
  private drawFish(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    surf: Float64Array,
    floor: Float64Array,
    seconds: number,
  ): void {
    const pond = this.world.pond;
    const cfg = this.world.cfg;
    const c = this.c;
    let total = 0;
    let murk = 0;
    for (let x = from; x <= to; x++) {
      total += pond.fish[x];
      murk = Math.max(murk, pond.greenness(cfg, x));
    }
    const count = Math.min(10, Math.round(total));
    if (count <= 0) return;
    /*
     * Swim only over water deep enough to draw a fish in. They used to lap the whole pond, banks and
     * shelf included, and over the shallows there was no room, so each one blinked out of existence
     * every time it swam across them. Now they turn back at the edge of the deep water.
     */
    const room = c * 0.9;
    let deepFrom = -1;
    let deepTo = -1;
    for (let x = from; x <= to; x++) {
      if (floor[x] - surf[x] < room) continue;
      if (deepFrom < 0) deepFrom = x;
      deepTo = x;
    }
    if (deepFrom < 0) return;
    const left = deepFrom * c;
    const width = (deepTo - deepFrom + 1) * c;
    const margin = Math.min(c * 0.5, width * 0.25);
    const t = THEME.fish;

    ctx.save();
    ctx.globalAlpha = 1 - murk * 0.6;
    for (let i = 0; i < count; i++) {
      const h = hash2(from * 17 + i, 541);
      const speed = c * (0.35 + ((h >>> 4) & 7) * 0.05);
      const lap = (width - margin * 2) * 2;
      const u = ((seconds * speed + (h & 1023)) % lap) / lap;
      const heading = u < 0.5 ? 1 : -1;
      const along = u < 0.5 ? u * 2 : 2 - u * 2;
      const fx = left + margin + along * (width - margin * 2);
      const col = Math.max(deepFrom, Math.min(deepTo, Math.floor(fx / c)));
      const top = surf[col] + c * 0.35;
      const bottom = Math.max(top, floor[col] - c * 0.35);
      const depth = 0.2 + (((h >>> 8) & 255) / 255) * 0.6;
      const fy = top + (bottom - top) * depth + Math.sin(seconds * 1.1 + i) * c * 0.06;
      const len = c * (0.3 + ((h >>> 16) & 3) * 0.03);
      const wag = Math.sin(seconds * 9 + i * 1.7) * 0.35;

      ctx.save();
      ctx.translate(fx, fy);
      ctx.scale(heading, 1);
      // The tail, beating.
      ctx.save();
      ctx.translate(-len * 0.85, 0);
      ctx.rotate(wag);
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(-len * 0.55, -len * 0.38);
      ctx.lineTo(-len * 0.42, 0);
      ctx.lineTo(-len * 0.55, len * 0.38);
      ctx.closePath();
      ctx.fillStyle = t.fin;
      ctx.fill();
      ctx.restore();
      // The dorsal fin.
      ctx.beginPath();
      ctx.moveTo(-len * 0.2, -len * 0.3);
      ctx.quadraticCurveTo(len * 0.05, -len * 0.62, len * 0.25, -len * 0.3);
      ctx.fillStyle = t.fin;
      ctx.fill();
      // The body, with a paler belly.
      ctx.beginPath();
      ctx.ellipse(0, 0, len, len * 0.42, 0, 0, Math.PI * 2);
      ctx.fillStyle = t.body;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(len * 0.05, len * 0.16, len * 0.72, len * 0.2, 0, 0, Math.PI * 2);
      ctx.fillStyle = t.belly;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(0, 0, len, len * 0.42, 0, 0, Math.PI * 2);
      ctx.strokeStyle = t.ink;
      ctx.lineWidth = 0.6;
      ctx.stroke();
      // The eye.
      ctx.beginPath();
      ctx.arc(len * 0.62, -len * 0.08, len * 0.09, 0, Math.PI * 2);
      ctx.fillStyle = t.eye;
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  /**
   * Reeds: tall stems standing up out of the water, long leaves arching off them, and on a bed that has
   * taken hold, the brown velvet heads of cattails. The one thing in a pond that rises ABOVE it, which
   * is most of why a pond with reeds reads as a place rather than a patch of water.
   *
   * Each column is drawn from its `base` (the pond floor, or the ground on a bank) and its `water`
   * line (the same as the base on a bank, where the whole stem stands in the air). Hashed per column and
   * slot, so each stem keeps its place; a stem sways more the taller it stands.
   */
  private drawReeds(ctx: CanvasRenderingContext2D, cols: readonly ReedColumn[], seconds: number): void {
    const pond = this.world.pond;
    const c = this.c;
    const stems = new Path2D();
    const blades = new Path2D();
    const heads = new Path2D();
    const spikes = new Path2D();
    let any = false;
    for (const col of cols) {
      const x = col.x;
      const cover = pond.reeds[x];
      if (cover < 0.03) continue;
      const shown = Math.max(1, Math.round(cover * 4));
      for (let k = 0; k < shown; k++) {
        const h = hash2(x, 561 + k);
        const bx = x * c + (0.15 + ((h & 15) / 15) * 0.7) * c;
        const by = col.base;
        // Stands up to about two and a half cells above the water when the bed is full.
        const above = c * (0.6 + 1.9 * cover) * (0.75 + ((h >>> 4) & 7) / 28);
        const tipY = col.water - above;
        const height = by - tipY;
        const lean = (((h >>> 8) & 15) - 7.5) / 7.5 * c * 0.25;
        const sway = Math.sin(seconds * 0.7 + x * 0.8 + k * 1.9) * c * 0.06 * (height / c);
        const tx = bx + lean + sway;
        stems.moveTo(bx, by);
        stems.quadraticCurveTo(bx + lean * 0.3, by - height * 0.55, tx, tipY);
        any = true;

        /*
         * Two or three long blades peeling off the stem ABOVE the water, arching out and drooping.
         * Placed along the part of the stem that stands in the air, not at fixed heights up the whole
         * stem: in a deep pond those heights were all underwater, and most stems had no leaves at all.
         */
        const waterU = Math.max(0, Math.min(1, (by - col.water) / height));
        const bladeCount = 2 + ((h >>> 12) & 1);
        for (let b = 0; b < bladeCount; b++) {
          const side = (b + (h >>> 13)) % 2 === 0 ? 1 : -1;
          const u = waterU + (1 - waterU) * (0.1 + 0.28 * b);
          const sx = bx + (tx - bx) * u;
          const sy = by + (tipY - by) * u;
          const reach = c * (0.55 + ((h >>> 16) & 3) * 0.12);
          blades.moveTo(sx, sy);
          blades.quadraticCurveTo(sx + side * reach * 0.55, sy - reach * 0.8, sx + side * reach + sway, sy - reach * 0.1);
        }

        // Cattail heads on a bed that has taken hold: a brown velvet cylinder with a thin spike above.
        if (cover > 0.4 && ((h >>> 20) & 3) !== 0) {
          const hx = bx + (tx - bx) * 0.86;
          const hy = by + (tipY - by) * 0.86;
          const hl = c * 0.42;
          const hw = c * 0.075;
          heads.moveTo(hx - hw, hy - hl / 2);
          heads.roundRect(hx - hw, hy - hl / 2, hw * 2, hl, hw);
          spikes.moveTo(hx, hy - hl / 2);
          spikes.lineTo(tx, tipY);
        }
      }
    }
    if (!any) return;
    ctx.lineCap = 'round';
    ctx.strokeStyle = THEME.reed.blade;
    ctx.lineWidth = 1.1;
    ctx.stroke(blades);
    ctx.strokeStyle = THEME.reed.stem;
    ctx.lineWidth = 1.7;
    ctx.stroke(stems);
    ctx.lineWidth = 0.8;
    ctx.stroke(spikes);
    ctx.fillStyle = THEME.reed.head;
    ctx.fill(heads);
    ctx.strokeStyle = THEME.reed.ink;
    ctx.lineWidth = 0.6;
    ctx.stroke(heads);
  }

  /**
   * Green water: each column tinted by its own bloom.
   *
   * One gradient across the body with a stop at every column, the way the moss wash is done, so a bloom
   * reads as starting where the food fell and spreading outward rather than as a flat recolour of the
   * whole pond. Drawn under the streaks, so a green pond still reads as water.
   */
  private drawAlgae(ctx: CanvasRenderingContext2D, from: number, to: number): void {
    const pond = this.world.pond;
    const cfg = this.world.cfg;
    let any = false;
    for (let x = from; x <= to && !any; x++) if (pond.greenness(cfg, x) > 0.01) any = true;
    if (!any) return;
    const c = this.c;
    const left = from * c;
    const right = (to + 1) * c;
    const grad = ctx.createLinearGradient(left, 0, right, 0);
    for (let x = from; x <= to; x++) {
      const stop = (x * c + c / 2 - left) / (right - left);
      // Steep on purpose: by the warning's 30% the water must read as GREEN, not as slightly murky
      // blue. A linear mapping left a pond at 19% looking like clean water at a glance.
      const alpha = Math.min(0.9, pond.greenness(cfg, x) * 2.2);
      grad.addColorStop(Math.max(0, Math.min(1, stop)), withAlpha(THEME.water.algae, alpha));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(left - c, 0, right - left + 2 * c, this.world.grid.h * c);
  }

  /**
   * The inside of the water: a few pale streaks drifting slowly sideways at different depths.
   *
   * The same device a watercolourist uses for water: broken horizontal strokes, not a pattern. Where
   * each streak sits is hashed from its column, so they hold their places instead of flickering; only
   * the drift moves, in real seconds, so fast-forwarding the jar does not whip them across the pond.
   * Drawn inside a clip to the body, so a streak never pokes past the bank or out of the surface.
   */
  private drawWaterGrain(
    ctx: CanvasRenderingContext2D,
    from: number,
    to: number,
    surf: Float64Array,
    floor: Float64Array,
    seconds: number,
  ): void {
    const c = this.c;
    const left = from * c;
    const span = (to - from + 1) * c;
    const streaks = new Path2D();
    for (let x = from; x <= to; x++) {
      const depth = floor[x] - surf[x];
      if (depth < c * 0.45) continue;
      const h = hash2(x, 7);
      // Roughly one streak per column-and-a-bit of water, more in deep water than shallow.
      const count = depth > c * 1.6 ? 2 : 1;
      for (let k = 0; k < count; k++) {
        const hk = hash2(x, 31 + k * 17);
        if ((hk & 3) === 0) continue;
        const speed = 0.12 + ((hk >>> 4) & 15) / 100;
        const along = ((((x - from) * c + ((h >>> 8) & 63) + seconds * speed * c) % span) + span) % span;
        const px = left + along;
        const frac = 0.25 + (((hk >>> 12) & 255) / 255) * 0.6;
        const py = surf[x] + depth * frac + Math.sin(seconds * 0.9 + x) * c * 0.04;
        const len = c * (0.45 + (((hk >>> 20) & 15) / 15) * 0.7);
        streaks.moveTo(px - len / 2, py);
        streaks.quadraticCurveTo(px, py - c * 0.05, px + len / 2, py);
      }
    }
    ctx.strokeStyle = THEME.water.streak;
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';
    ctx.stroke(streaks);
  }

  /**
   * What the Build brush will do, shown before the click.
   *
   * Mud centred in a dug hollow previews the liner, because that is what the click does there.
   * Everything else previews its footprint: every cell that will change, tinted in the colour it will
   * become (or struck through, for digging), with one outline round the whole shape. Cells a paint
   * would leave alone (glass, or already that material) are left out, so the preview is exactly the
   * change. `SubstrateGrid.brushCells` is the same query the brush commits with.
   */
  drawBrushPreview(ctx: CanvasRenderingContext2D, hoverCell: number, radius: number, material: SubstrateId): void {
    if (hoverCell < 0) return;
    const g = this.world.grid;
    const x = g.xOf(hoverCell);
    const y = g.yOf(hoverCell);
    if (material === Substrate.Mud && g.basinLiner(x, y)) {
      this.drawMudPreview(ctx, hoverCell);
      return;
    }
    const cells = g.brushCells(x, y, radius, material);
    const c = this.c;
    const inside = new Set(cells);
    const fill = new Path2D();
    const edge = new Path2D();
    for (const i of cells) {
      const px = g.xOf(i) * c;
      const py = g.yOf(i) * c;
      fill.rect(px, py, c, c);
      // One outline round the shape: an edge only where the neighbour is not also changing.
      if (!inside.has(i - g.w)) { edge.moveTo(px, py); edge.lineTo(px + c, py); }
      if (!inside.has(i + g.w)) { edge.moveTo(px, py + c); edge.lineTo(px + c, py + c); }
      if (!inside.has(i - 1)) { edge.moveTo(px, py); edge.lineTo(px, py + c); }
      if (!inside.has(i + 1)) { edge.moveTo(px + c, py); edge.lineTo(px + c, py + c); }
    }
    ctx.save();
    ctx.clip(this.vessel);
    if (material === Substrate.Air) {
      // Digging: the paper showing through, as the hole will.
      ctx.fillStyle = THEME.plate.brushDig;
    } else {
      const tone = THEME.substrate[material].dry;
      ctx.fillStyle = `rgba(${(tone >> 16) & 255}, ${(tone >> 8) & 255}, ${tone & 255}, 0.6)`;
    }
    ctx.fill(fill);
    ctx.strokeStyle = THEME.plate.brushEdge;
    ctx.lineWidth = 1.2;
    ctx.stroke(edge);
    ctx.restore();

    // The brush's own reach, faintly, so its size reads even where it will change nothing.
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = THEME.plate.brushReach;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const rr = (radius + 0.5) * c;
    ctx.arc((x + 0.5) * c, (y + 0.5) * c, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * What one click of the Mud tool would actually do, shown before the click.
   *
   * Lining a basin replaces ground the player cannot easily see the extent of — the far wall of a
   * hollow is a bank of ordinary soil until the moment it becomes mud, and finding out by clicking
   * costs the water and roots any amendment costs. `SubstrateGrid.basinLiner` is the exact same
   * query the tool commits with, so this can never promise something the click then does not do.
   *
   * BOTH washes are clipped to `groundFill`, the same silhouette `drawWater` cuts against — one to
   * its outside, one to its inside. Without that, a cell on a sloped bank is only part soil, and a
   * flat per-cell rectangle drawn over it hangs a corner out into open air: the exact seam chasing
   * `drawWater` out of the ground curve taught was worth avoiding here too, before it shipped rather
   * than after.
   */
  drawMudPreview(ctx: CanvasRenderingContext2D, hoverCell: number): void {
    if (hoverCell < 0) return;
    const g = this.world.grid;
    const found = g.basinLiner(g.xOf(hoverCell), g.yOf(hoverCell));
    if (!found) return;
    const c = this.c;

    const areaFill = new Path2D();
    for (const i of found.area) areaFill.rect(g.xOf(i) * c, g.yOf(i) * c, c, c);
    const linerFill = new Path2D();
    for (const i of found.liner) linerFill.rect(g.xOf(i) * c, g.yOf(i) * c, c, c);

    ctx.save();
    ctx.clip(this.vessel);

    // The pond-to-be: a hint of water's own blue, confined to actually-open cells.
    if (this.groundFill) {
      const open = new Path2D();
      open.addPath(this.vessel);
      open.addPath(this.groundFill);
      ctx.save();
      ctx.clip(open, 'evenodd');
      ctx.fillStyle = THEME.plate.mudPreviewArea;
      ctx.fill(areaFill);
      ctx.restore();

      // The mud-to-be: confined to the ground the liner query actually names, so the highlight
      // hugs the drawn slope instead of squaring off across it.
      ctx.save();
      ctx.clip(this.groundFill);
      ctx.fillStyle = THEME.plate.mudPreviewLiner;
      ctx.fill(linerFill);
      ctx.restore();
    }
    ctx.restore();
  }

  drawGlass(ctx: CanvasRenderingContext2D): void {
    const w = this.world;
    const g = w.grid;
    const c = this.c;
    const t = THEME.plate;
    const r = w.cfg.raw.grid.cornerRadius;
    const wall = c * t.wall;

    // The wall's thickness, as the band between the outer and inner outlines.
    const band = new Path2D();
    band.addPath(this.outer);
    band.addPath(this.vessel);
    ctx.fillStyle = t.glassWash;
    ctx.fill(band, 'evenodd');

    // Soft vertical highlights just inside each wall, stopping before the base curves.
    const top = c * 2.2;
    const straightEnd = (g.h - 2 - r + 0.5) * c;
    ctx.save();
    ctx.clip(this.vessel);
    // Round-capped strokes whose gradient runs ALONG the streak, so both ends fade out. The first
    // version was a filled rectangle with a sideways gradient, and its bottom stopped at a hard edge.
    const streak = (x: number, width: number, alpha: number): void => {
      const grad = ctx.createLinearGradient(0, top, 0, straightEnd);
      grad.addColorStop(0, withAlpha(t.highlight, 0));
      grad.addColorStop(0.25, t.highlight);
      grad.addColorStop(0.7, t.highlight);
      grad.addColorStop(1, withAlpha(t.highlight, 0));
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = grad;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, straightEnd);
      ctx.stroke();
    };
    streak(c * 1.7, c * 0.32, 1);
    streak((g.w - 2.2) * c, c * 0.2, 0.6);
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.lineJoin = 'round';
    ctx.strokeStyle = t.inkStrong;
    ctx.lineWidth = 1.4;
    ctx.stroke(this.outer);
    ctx.strokeStyle = t.inkFaint;
    ctx.lineWidth = 0.9;
    ctx.stroke(this.vessel);

    // The lip. A closed lid reads as a cork-toned cap; an open one is just glass.
    const lip = new Path2D();
    const lipL = c - wall - c * 0.3;
    const lipR = (g.w - 1) * c + wall + c * 0.3;
    roundedRect(lip, lipL, c * 0.45, lipR - lipL, c * 0.75, c * 0.22);
    ctx.fillStyle = w.atmo.lidOpen ? t.lipOpen : t.lipClosed;
    ctx.fill(lip);
    ctx.strokeStyle = t.inkStrong;
    ctx.lineWidth = 1.2;
    ctx.stroke(lip);
  }

  /**
   * Moss laid ALONG the surface curve, so it wraps over mounds and down their slopes.
   *
   * It used to be a flat band across the top of each mossy cell, which sat as a stepped strip on any
   * slope. Now each run of ground gets one stroke of its own surface curve, coloured by a horizontal
   * gradient with a stop at every column. A stop per column means moss fades smoothly from sparse to
   * established with no seams at cell edges, which a separate clip per column could not avoid. Two
   * strokes give it body: a thin film wherever there is any moss, and a thick cushion where it is
   * established. Tufts then sprout from the surface where the mat is well grown.
   */
  private drawMoss(ctx: CanvasRenderingContext2D, runs: readonly Point[][], tops: Int32Array): void {
    const w = this.world;
    const g = w.grid;
    const c = this.c;
    const cover = w.moss.cover;

    ctx.save();
    ctx.clip(this.vessel);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const run of runs) {
      const along = mossAlong(g, tops, cover, run, c);
      if (!along.some((v) => v > 0.02)) continue;
      const x0 = run[0][0];
      const x1 = run[run.length - 1][0];
      const path = new Path2D();
      traceSmooth(path, run);
      const thin = ctx.createLinearGradient(x0, 0, x1, 0);
      const thick = ctx.createLinearGradient(x0, 0, x1, 0);
      run.forEach(([x], k) => {
        const t = (x - x0) / (x1 - x0);
        thin.addColorStop(t, mossRgba(mossThin(along[k])));
        thick.addColorStop(t, mossRgba(mossThick(along[k])));
      });
      /*
       * Dropped so the mat lies ON the ground instead of floating above it.
       *
       * A stroke is centred on its path, so half the mat's width sat above the surface curve, over bare
       * paper — a flat green bar with a dead-straight top edge hovering over the soil. That edge is what
       * read as a strange line lying through the moss: the cushions above it are lumpy and organic, and
       * the bar underneath them plainly was not.
       *
       * Shifting down by half the thick stroke puts its top edge on the surface curve itself, so
       * everything breaking the ground line is cushion and tuft, which have irregular silhouettes. The
       * green is not lost, only moved from paper onto soil, where it still reads.
       */
      ctx.save();
      ctx.translate(0, c * 0.46);
      ctx.strokeStyle = thick;
      ctx.lineWidth = c * 0.95;
      ctx.stroke(path);
      ctx.strokeStyle = thin;
      ctx.lineWidth = c * 0.42;
      ctx.stroke(path);
      ctx.restore();
    }

    // Tufts: short curved blades standing up from the surface where the mat is well grown. Placed
    // near each column's centre, which is exactly where the curve passes through the column's top.
    const tufts = new Path2D();
    for (let x = 1; x <= g.w - 2; x++) {
      if (tops[x] < 0) continue;
      const i = g.idx(x, tops[x]);
      const v = cover[i];
      if (v <= 0.4) continue;
      const y = tops[x] * c;
      for (let k = 0; k < 3; k++) {
        const h = hash2(i, k + 41);
        if ((h & 3) === 0) continue;
        const bx = (x + 0.25 + (h % 50) * 0.01) * c;
        const lean = (((h >> 6) % 20) - 10) * 0.012 * c;
        const len = c * (0.18 + v * 0.14);
        tufts.moveTo(bx, y);
        tufts.quadraticCurveTo(bx + lean * 0.3, y - len * 0.6, bx + lean, y - len);
      }
    }
    const [mr, mg, mb] = THEME.moss;
    ctx.strokeStyle = `rgb(${Math.round(mr * 0.75)}, ${Math.round(mg * 0.75)}, ${Math.round(mb * 0.75)})`;
    ctx.lineWidth = Math.max(0.8, c * 0.08);
    ctx.stroke(tufts);

    // Bushes where springtails crowd: overlapping rounded cushions standing on the surface, taller the
    // denser the colony. A look only — see `mossBushiness` — and never where there is little moss.
    const cap = w.cfg.raw.fauna.springtail.popCapPerCell;
    const pop = w.fauna.pop;
    const domes = new Path2D();
    // The same cushions again as ARCS ONLY, for the outline. See the note at the stroke below.
    const domeCaps = new Path2D();
    const bushTufts = new Path2D();
    let anyBush = false;
    for (let x = 1; x <= g.w - 2; x++) {
      const top = tops[x];
      let target = 0;
      if (top >= 0) {
        const i = g.idx(x, top);
        let near = pop[i];
        if (top + 1 <= g.h - 2) near += pop[g.idx(x, top + 1)];
        if (top + 2 <= g.h - 2) near += pop[g.idx(x, top + 2)];
        target = mossBushiness(cover[i], near, cap);
      }
      this.bush[x] += (target - this.bush[x]) * 0.03;
      const b = this.bush[x];
      if (top < 0 || b < 0.03) continue;
      anyBush = true;
      const y = top * c;
      /*
       * A full cushion stands about a whole cell proud of the surface. The first version topped out
       * near 7px on a 12px cell and — because the crowding ramp was mis-pitched too — only ever drew
       * about 4px of that in a real jar, which read as a slightly lumpy mat rather than as bushes.
       *
       * Size was only half of it. Three identical arcs in every column read as a scalloped fence, and
       * once they were big enough to see, that regularity was far more conspicuous than the old size
       * problem had ever been. So the count, the radius and the depth all vary per column now.
       */
      const count = 2 + (hash2(x, 690) % 3);
      for (let k = 0; k < count; k++) {
        const h = hash2(x, k + 700);
        const cx = (x + 0.15 + k * (0.7 / count) + ((h % 14) - 7) * 0.012) * c;
        const r = c * (0.34 + b * 0.66) * (0.62 + (h % 55) * 0.01);
        // Sunk a little BELOW the surface line, so neighbouring cushions merge into one lumpy
        // silhouette instead of stacking a row of separate semicircles.
        const cy = y + r * (0.12 + (h % 9) * 0.02);
        domes.moveTo(cx - r, cy);
        domes.arc(cx, cy, r, Math.PI, 0);
        domes.closePath();
        // The outline gets the arc WITHOUT that closing chord. Filling needs the closed shape; stroking
        // it drew a hard flat line under every single cushion, and across a mossy surface dozens of them
        // ran together into one continuous rule lying through the moss.
        domeCaps.moveTo(cx - r, cy);
        domeCaps.arc(cx, cy, r, Math.PI, 0);
        const blade = c * (0.2 + b * 0.28);
        bushTufts.moveTo(cx, cy - r);
        bushTufts.quadraticCurveTo(cx + blade * 0.2, cy - r - blade * 0.6, cx + ((h % 7) - 3) * 0.3, cy - r - blade);
      }
    }
    if (anyBush) {
      ctx.fillStyle = mossRgba(0.92);
      ctx.fill(domes);
      ctx.strokeStyle = `rgb(${Math.round(mr * 0.62)}, ${Math.round(mg * 0.62)}, ${Math.round(mb * 0.62)})`;
      // A shade heavier than the mat's own line, so a cushion reads as a body sitting ON the surface
      // rather than as more of the same film. Strokes `domeCaps`, never `domes`.
      ctx.lineWidth = 1;
      ctx.stroke(domeCaps);
      ctx.lineWidth = Math.max(0.9, c * 0.09);
      ctx.stroke(bushTufts);
    }
    ctx.restore();
  }

  /**
   * Grains with air beneath them — mid-fall, or perched — each drawn as a small piece of its own
   * material: the same wash colour and paper grain as the ground it will land in, with that material's
   * mark inside and an irregular outline. The first version drew rounded squares with a hard outline,
   * which read as a UI token rather than a clump of soil, and nothing like the ground it turned into.
   *
   * A grain with moss on it gets that moss along the top of its own outline.
   *
   * A piece that fell this tick — `grid.fallFrom[i] >= 0` — is drawn EASING from its old cell to this
   * one as `alpha` runs 0 -> 1 across the wait for the next tick, rather than appearing here already.
   * That is the whole fix for the choppy fall: the grid still moves a grain a full cell at a time, one
   * tick apart, but the drawing spreads that jump smoothly across the frames in between. A piece that
   * did not move this tick (fallFrom -1, the common case once a jar is at rest) draws at its own centre
   * exactly as before.
   */
  private drawLoose(ctx: CanvasRenderingContext2D, loose: readonly number[], alpha: number): void {
    if (loose.length === 0) return;
    const g = this.world.grid;
    const c = this.c;
    const cover = this.world.moss.cover;
    if (!this.grainPattern) this.grainPattern = ctx.createPattern(this.grain, 'repeat');

    ctx.save();
    ctx.clip(this.vessel);
    for (const i of loose) {
      const id = g.substrate[i];
      if (!isSolid(id)) continue;
      const look = THEME.substrate[id];
      const x = g.xOf(i);
      const toCx = (x + 0.5) * c;
      const toCy = (g.yOf(i) + 0.5) * c;
      const from = g.fallFrom[i];
      let cx = toCx;
      let cy = toCy;
      if (from >= 0) {
        const fromCx = (g.xOf(from) + 0.5) * c;
        const fromCy = (g.yOf(from) + 0.5) * c;
        cx = fromCx + (toCx - fromCx) * alpha;
        cy = fromCy + (toCy - fromCy) * alpha;
      }
      const piece = clumpPath(cx, cy, c * 0.47, x * 7 + id, id);

      ctx.fillStyle = css(mix(look.dry, look.wet, Math.min(1, g.saturation(i))));
      ctx.fill(piece);

      ctx.save();
      ctx.clip(piece);
      if (this.grainPattern) {
        ctx.globalCompositeOperation = 'multiply';
        ctx.globalAlpha = THEME.plate.grainAlpha;
        ctx.fillStyle = this.grainPattern;
        ctx.fillRect(cx - c, cy - c, c * 2, c * 2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      const h = hash2(x, id + 900);
      if (id === Substrate.Gravel) {
        const mark = new Path2D();
        mark.ellipse(cx - c * 0.08, cy - c * 0.06, c * 0.2, c * 0.14, (h % 31) * 0.1, 0, Math.PI * 2);
        ctx.fillStyle = THEME.plate.pebbleFill;
        ctx.fill(mark);
      } else if (id === Substrate.Charcoal) {
        ctx.fillStyle = THEME.plate.charcoalFleck;
        ctx.beginPath();
        ctx.moveTo(cx - c * 0.15, cy);
        ctx.lineTo(cx, cy - c * 0.12);
        ctx.lineTo(cx + c * 0.13, cy + c * 0.04);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = THEME.plate.soilSpeck;
        for (let k = 0; k < 3; k++) {
          const hk = hash2(x, k + 950);
          ctx.beginPath();
          ctx.arc(cx + ((hk % 50) - 25) * 0.01 * c, cy + (((hk >> 6) % 50) - 25) * 0.01 * c, Math.max(0.5, c * 0.05), 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // A faint edge only — the same weight as the lines between layers, not the surface's strong ink.
      ctx.strokeStyle = THEME.plate.pebbleInk;
      ctx.lineWidth = 0.7;
      ctx.stroke(piece);

      // Moss on this grain wraps its TOP border: the outline, clipped to the upper half of the piece.
      const moss = cover[i];
      if (moss > 0.02) {
        ctx.save();
        const upper = new Path2D();
        upper.rect(cx - c, cy - c, c * 2, c * 0.95);
        ctx.clip(upper);
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = mossRgba(mossThin(moss));
        ctx.lineWidth = c * (0.18 + moss * 0.22);
        ctx.stroke(piece);
        ctx.restore();
      }
    }
    ctx.restore();
  }

  /**
   * Paint one pixel per cell into the offscreen wash canvas.
   *
   * Only the ground's colours matter, since the wash is clipped to the ground; every other cell just
   * borrows a nearby ground colour so that smoothing does not bleed paper into the ground's edges —
   * including the slopes, which reach half a cell into an empty neighbouring column.
   */
  private paintWash(tops: Int32Array): void {
    const g = this.world.grid;
    const W = g.w;
    const H = g.h;
    const col = this.colour;
    const paper = THEME.plate.interiorRgb;
    const sour = THEME.plate.sour;
    const charCap = this.world.cfg.raw.decay.charcoalToxinCapacity;
    /*
     * Souring is folded into the cell's own colour, not laid over it.
     *
     * Two sources, drawn the same way because they are the same problem: loose toxin in the ground,
     * and a charcoal layer that has filled up with what it adsorbed. Showing both means the player can
     * SEE a spent layer in the jar rather than only reading it off a gauge, which is what makes
     * replacing it feel like a response to something.
     *
     * The floor matters. Ordinary soil carries a little toxin all the time and roots are unharmed
     * below 0.30, so tinting from zero would leave a healthy jar permanently looking slightly ill.
     */
    const SOUR_FLOOR = 0.1;
    const colourOf = (i: number): number => {
      const look = THEME.substrate[g.substrate[i]];
      const base = mix(look.dry, look.wet, Math.min(1, g.saturation(i)));
      const loose = Math.max(0, g.toxin[i] - SOUR_FLOOR) / (1 - SOUR_FLOOR);
      const bound = charCap > 0 ? g.charcoalLoad[i] / charCap : 0;
      /*
       * Square-rooted, so the warning arrives BEFORE the damage does.
       *
       * Linear mixing left the tint barely started at 0.30 toxin, which is exactly where roots begin
       * taking damage — the player would first see the soil discolour at the moment it was already
       * hurting them. The curve front-loads the visible range so souring shows while there is still
       * time to act, and full sourness still reads as unmistakably wrong.
       */
      const t = Math.sqrt(Math.min(1, Math.max(loose, bound))) * 0.8;
      const tinted = t > 0.01 ? mix(base, sour, t) : base;
      /*
       * Depth: the ground darkens the further it is below its own surface, as the light that gets into
       * it fades. Measured from each column's own top, so a mound and a hollow darken alike, and eased
       * in, so the top few cells keep their colour where the eye reads the layers.
       */
      const top = tops[g.xOf(i)];
      const below = top >= 0 ? g.yOf(i) - top : 0;
      const depth = Math.min(1, Math.max(0, below - 1) / (H * 0.55));
      // Gravel keeps most of its light: it darkens within its own layer instead (see `buildDetail`),
      // and being the bottom layer it would otherwise take the full depth shade and read dark.
      const strength = g.substrate[i] === Substrate.Gravel ? 0.1 : 0.34;
      return mix(tinted, THEME.plate.depthShade, strength * depth * depth * (3 - 2 * depth));
    };

    col.fill(-1);

    // 1. The ground takes its own colours. Everything above a column's ground — air, and any loose
    //    grain — takes the colour of that ground's top, which is what the surface edge bleeds into.
    for (let x = 1; x <= W - 2; x++) {
      const top = tops[x];
      if (top < 0) continue;
      const topColour = colourOf(g.idx(x, top));
      for (let y = 0; y < H; y++) {
        const i = g.idx(x, y);
        const id = g.substrate[i];
        if (y < top) {
          if (id !== Substrate.Glass) col[i] = topColour;
        } else if (isSolid(id)) {
          col[i] = colourOf(i);
        }
      }
    }

    // 2. Everything still unresolved — glass, and whole columns with no ground — borrows the nearest
    //    resolved colour: the cell above for glass under the ground, otherwise sideways. This is what
    //    keeps pale halos off the vessel's curve and off the slopes of a pile next to an empty column.
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = g.idx(x, y);
        if (col[i] >= 0) continue;
        let found = -1;
        if (g.substrate[i] === Substrate.Glass && y > 0) {
          const up = col[g.idx(x, y - 1)];
          if (up >= 0) found = up;
        }
        for (let d = 1; found < 0 && d <= 8; d++) {
          const l = x - d;
          const r = x + d;
          if (l >= 0 && col[g.idx(l, y)] >= 0) found = col[g.idx(l, y)];
          else if (r < W && col[g.idx(r, y)] >= 0) found = col[g.idx(r, y)];
        }
        col[i] = found >= 0 ? found : paper;
      }
    }

    const data = this.img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = col[g.idx(x, y)];
        const o = (y * W + x) * 4;
        data[o] = (v >> 16) & 255;
        data[o + 1] = (v >> 8) & 255;
        data[o + 2] = v & 255;
        data[o + 3] = 255;
      }
    }
    this.smallCtx.putImageData(this.img, 0, 0);
  }

  /**
   * The ground's texture as it looks pressed against the glass, drawn once into a cached layer and
   * reused until the ground itself changes. Each material is recognisable by its grains alone:
   *
   *   - SOIL: fine dark grains, now and then a pale fleck of grit or a curl of root fibre, and rarely
   *     a small stone.
   *   - CHARCOAL: angular black chunks, their upper edges catching the light, the odd glint.
   *   - GRAVEL: rounded light grey stones, each lit from above and shadowed beneath, with the dark of
   *     the gaps between them.
   *
   * Kept sparse on purpose: it was first drawn about twice this dense, and the ground out-detailed
   * everything else on the plate.
   *   - MUD: smooth clay with faint streaks where it was pressed.
   *
   * Over all of it, the ground darkens toward the glass at the jar's curved sides and bottom, where it
   * is seen through the thickest glass. Hashed on each cell, so a cell always looks the same; rebuilt
   * only when the layout changes, since it is thousands of small shapes.
   */
  private drawDetail(ctx: CanvasRenderingContext2D): void {
    const g = this.world.grid;
    const c = this.c;
    const scale = ctx.getTransform().a || 1;
    let sum = g.activeCells.length;
    for (const i of g.activeCells) sum = (Math.imul(sum, 31) + i * 7 + g.substrate[i]) | 0;
    const key = `${sum}:${scale}`;
    if (key !== this.detailKey || !this.detail) {
      this.detail = this.buildDetail(scale);
      this.detailKey = key;
    }
    ctx.drawImage(this.detail, 0, 0, g.w * c, g.h * c);
  }

  private buildDetail(scale: number): HTMLCanvasElement {
    const g = this.world.grid;
    const c = this.c;
    const D = THEME.ground;
    const cv = this.detail ?? document.createElement('canvas');
    cv.width = Math.ceil(g.w * c * scale);
    cv.height = Math.ceil(g.h * c * scale);
    const dc = cv.getContext('2d')!;
    dc.setTransform(scale, 0, 0, scale, 0, 0);
    dc.clearRect(0, 0, g.w * c, g.h * c);
    dc.lineCap = 'round';
    dc.lineJoin = 'round';
    const r01 = (h: number, bit: number): number => ((h >>> bit) % 1000) / 1000;

    const specks = new Path2D();
    const bigSpecks = new Path2D();
    const grit = new Path2D();
    const gritShade = new Path2D();
    const fibres = new Path2D();
    const chunks = new Path2D();
    const chunksLight = new Path2D();
    const chunkEdges = new Path2D();
    const glints = new Path2D();
    const streaks = new Path2D();
    const stones: Array<[number, number, number, number, number, number, number]> = [];
    // Gaps between gravel stones, in bands by depth: the deeper, the darker.
    const GAP_BANDS = 4;
    const gapBands = Array.from({ length: GAP_BANDS }, () => new Path2D());

    /*
     * How deep each gravel cell sits in its own column's gravel, 0 at the top of the layer and 1 at the
     * bottom. The stones darken with it, so the drainage layer reads as a bed with depth, lit where it
     * meets the charcoal and dim down at the glass floor, rather than one flat band of pebbles.
     */
    const gravelTop = new Int32Array(g.w).fill(-1);
    const gravelBottom = new Int32Array(g.w).fill(-1);
    for (const i of g.activeCells) {
      if (g.substrate[i] !== Substrate.Gravel) continue;
      const x = g.xOf(i);
      const y = g.yOf(i);
      if (gravelTop[x] < 0 || y < gravelTop[x]) gravelTop[x] = y;
      if (y > gravelBottom[x]) gravelBottom[x] = y;
    }
    const gravelDepth = (i: number): number => {
      const x = g.xOf(i);
      const span = gravelBottom[x] - gravelTop[x];
      return span > 0 ? (g.yOf(i) - gravelTop[x]) / span : 0;
    };

    for (const i of g.activeCells) {
      const id = g.substrate[i];
      const px = g.xOf(i) * c;
      const py = g.yOf(i) * c;
      if (id === Substrate.Soil) {
        // Fine grains, a few sizes.
        for (let k = 0; k < 3; k++) {
          const h = hash2(i, k + 307);
          const x = px + r01(h, 0) * c;
          const y = py + r01(h, 10) * c;
          const rr = c * (0.025 + 0.05 * r01(h, 20) ** 2);
          const into = rr > c * 0.05 ? bigSpecks : specks;
          into.moveTo(x + rr, y);
          into.arc(x, y, rr, 0, Math.PI * 2);
        }
        const h = hash2(i, 331);
        // Pale grit, with the little shadow that sits it on the soil rather than on top of it.
        if (r01(h, 0) < 0.16) {
          const x = px + (0.15 + 0.7 * r01(h, 4)) * c;
          const y = py + (0.15 + 0.7 * r01(h, 14)) * c;
          const rr = c * (0.05 + 0.05 * r01(h, 24));
          gritShade.moveTo(x + rr * 1.1 + 0.4, y + 0.5);
          gritShade.ellipse(x + 0.4, y + 0.5, rr * 1.1, rr * 0.9, 0, 0, Math.PI * 2);
          grit.moveTo(x + rr, y);
          grit.ellipse(x, y, rr, rr * 0.85, r01(h, 8) * 3, 0, Math.PI * 2);
        }
        // A curl of fibre or bark.
        const f = hash2(i, 347);
        if (r01(f, 0) < 0.09) {
          const x = px + r01(f, 4) * c;
          const y = py + r01(f, 14) * c;
          const len = c * (0.25 + 0.3 * r01(f, 24));
          const ang = r01(f, 8) * Math.PI;
          const bend = (r01(f, 18) - 0.5) * len * 0.8;
          const ex = x + Math.cos(ang) * len;
          const ey = y + Math.sin(ang) * len;
          fibres.moveTo(x, y);
          fibres.quadraticCurveTo((x + ex) / 2 - Math.sin(ang) * bend, (y + ey) / 2 + Math.cos(ang) * bend, ex, ey);
        }
        // Now and then a small stone.
        const st = hash2(i, 359);
        if (r01(st, 0) < 0.025) {
          stones.push([px + (0.3 + 0.4 * r01(st, 4)) * c, py + (0.3 + 0.4 * r01(st, 14)) * c, c * (0.1 + 0.08 * r01(st, 24)), r01(st, 8), 0, 0, 0]);
        }
      } else if (id === Substrate.Gravel) {
        // The dark of the gaps, then the stones over it.
        const depth = gravelDepth(i);
        gapBands[Math.min(GAP_BANDS - 1, Math.floor(depth * GAP_BANDS))].rect(px, py, c, c);
        for (let k = 0; k < 2; k++) {
          const h = hash2(i, k + 101);
          const x = px + (0.12 + 0.76 * r01(h, 0)) * c;
          const y = py + (0.12 + 0.76 * r01(h, 10)) * c;
          const rr = c * (0.19 + 0.13 * r01(h, 20));
          stones.push([x, y, rr, r01(h, 5), r01(h, 15) * Math.PI, 1, depth]);
        }
      } else if (id === Substrate.Charcoal) {
        // Broken, angular pieces of mixed sizes: three a cell, some a shade lighter.
        for (let k = 0; k < 3; k++) {
          const h = hash2(i, k + 211);
          const x = px + (0.05 + 0.9 * r01(h, 0)) * c;
          const y = py + (0.05 + 0.9 * r01(h, 10)) * c;
          const sz = c * (0.08 + 0.2 * r01(h, 20) ** 1.5);
          const rot = r01(h, 5) * Math.PI * 2;
          const verts = 4 + (h & 1);
          const pts: Array<[number, number]> = [];
          for (let v = 0; v < verts; v++) {
            const hv = hash2(h, v);
            const a = rot + ((v + (r01(hv, 4) - 0.5) * 0.6) / verts) * Math.PI * 2;
            const rr = sz * (0.45 + 0.75 * r01(hv, 0));
            pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85]);
          }
          const into = r01(h, 26) < 0.3 ? chunksLight : chunks;
          into.moveTo(pts[0][0], pts[0][1]);
          for (let v = 1; v < verts; v++) into.lineTo(pts[v][0], pts[v][1]);
          into.closePath();
          // The upper edge catches the light: the two vertices nearest the top.
          const order = [...pts].sort((p, q) => p[1] - q[1]);
          chunkEdges.moveTo(order[0][0], order[0][1]);
          chunkEdges.lineTo(order[1][0], order[1][1]);
          if (r01(h, 30) < 0.05) {
            glints.moveTo(order[0][0] + 0.45, order[0][1] + 0.4);
            glints.arc(order[0][0], order[0][1] + 0.4, 0.45, 0, Math.PI * 2);
          }
        }
      } else if (id === Substrate.Mud) {
        const h = hash2(i, 401);
        if (r01(h, 0) < 0.6) {
          const y = py + (0.2 + 0.6 * r01(h, 4)) * c;
          const x = px + r01(h, 14) * c * 0.3;
          streaks.moveTo(x, y);
          streaks.quadraticCurveTo(x + c * 0.4, y + (r01(h, 24) - 0.5) * c * 0.25, x + c * (0.6 + 0.3 * r01(h, 8)), y);
        }
      }
    }

    // Gravel gaps first, so the stones sit in them.
    dc.fillStyle = D.gravelGap;
    for (let b = 0; b < GAP_BANDS; b++) {
      dc.globalAlpha = 0.7 + 0.3 * (b / (GAP_BANDS - 1));
      dc.fill(gapBands[b]);
    }
    dc.globalAlpha = 1;
    // Stones: a base tone of their own, lit from above, shadowed beneath, outlined in fine ink, and
    // darker the deeper they lie: about a third darker at the bottom of the gravel than at its top.
    for (const [x, y, rr, tone, rot, kind, depth] of stones) {
      const pick = D.stones[Math.floor(tone * D.stones.length) % D.stones.length];
      const dim = 1 - 0.32 * depth;
      const base = [Math.round(pick[0] * dim), Math.round(pick[1] * dim), Math.round(pick[2] * dim)];
      const grad = dc.createRadialGradient(x - rr * 0.35, y - rr * 0.45, rr * 0.1, x, y, rr * 1.1);
      grad.addColorStop(0, `rgb(${Math.min(255, base[0] + 40)}, ${Math.min(255, base[1] + 38)}, ${Math.min(255, base[2] + 34)})`);
      grad.addColorStop(0.55, `rgb(${base[0]}, ${base[1]}, ${base[2]})`);
      grad.addColorStop(1, `rgb(${Math.round(base[0] * 0.62)}, ${Math.round(base[1] * 0.62)}, ${Math.round(base[2] * 0.62)})`);
      dc.fillStyle = grad;
      dc.beginPath();
      dc.ellipse(x, y, rr, rr * (kind ? 0.74 : 0.8), rot, 0, Math.PI * 2);
      dc.fill();
      dc.strokeStyle = D.stoneInk;
      dc.lineWidth = 0.45;
      dc.stroke();
    }
    dc.fillStyle = D.speck;
    dc.fill(specks);
    dc.fillStyle = D.speckDark;
    dc.fill(bigSpecks);
    dc.strokeStyle = D.fibre;
    dc.lineWidth = 0.55;
    dc.stroke(fibres);
    dc.fillStyle = D.gritShade;
    dc.fill(gritShade);
    dc.fillStyle = D.grit;
    dc.fill(grit);
    dc.fillStyle = D.charcoal;
    dc.fill(chunks);
    dc.fillStyle = D.charcoalLight;
    dc.fill(chunksLight);
    dc.strokeStyle = D.charcoalEdge;
    dc.lineWidth = 0.45;
    dc.stroke(chunkEdges);
    dc.fillStyle = D.glint;
    dc.fill(glints);
    dc.strokeStyle = D.mudStreak;
    dc.lineWidth = 0.6;
    dc.stroke(streaks);

    // Darker toward the glass at the jar's sides and bottom: soft, stacked strokes of the vessel's own
    // outline, kept inside it.
    dc.save();
    dc.clip(this.vessel);
    dc.strokeStyle = D.glassShade;
    for (const width of [c * 3.2, c * 2.2, c * 1.4, c * 0.7]) {
      dc.lineWidth = width;
      dc.stroke(this.vessel);
    }
    dc.restore();
    return cv;
  }
}

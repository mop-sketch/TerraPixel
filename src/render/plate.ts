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

import { Substrate } from '../sim/config/content.js';
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

/**
 * A smooth line that passes THROUGH every point.
 *
 * Catmull-Rom converted to cubic Béziers, with each control point's height clamped between the two
 * points it joins, so the curve never overshoots — a peak is never drawn higher than the material, and
 * a slope never dips below the floor. The earlier midpoint-quadratic version cut every peak down to
 * about three quarters of its real height, which is how a lone mound came out flattened.
 */
function traceSmooth(path: Path2D, pts: readonly Point[]): void {
  const n = pts.length;
  path.moveTo(pts[0][0], pts[0][1]);
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
    this.bush = new Float32Array(g.w);
  }

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
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      this.drawMarks(ctx);

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
      return t > 0.01 ? mix(base, sour, t) : base;
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
   * What makes each layer identifiable without colour alone: pebbles in the gravel, angular flecks in
   * the charcoal, fine specks in the soil. Batched into one path per material, so this is a handful of
   * draw calls a frame however many cells there are. Drawn inside the ground clip, so loose grains get
   * theirs from `drawLoose` instead.
   */
  private drawMarks(ctx: CanvasRenderingContext2D): void {
    const g = this.world.grid;
    const c = this.c;
    const pebbles = new Path2D();
    const flecks = new Path2D();
    const specks = new Path2D();

    for (const i of g.activeCells) {
      const id = g.substrate[i];
      const px = g.xOf(i) * c;
      const py = g.yOf(i) * c;
      if (id === Substrate.Gravel) {
        for (let k = 0; k < 2; k++) {
          const h = hash2(i, k + 101);
          const cx = px + (0.2 + (h % 60) * 0.01) * c;
          const cy = py + (0.2 + ((h >> 6) % 60) * 0.01) * c;
          const rx = (0.2 + ((h >> 12) % 12) * 0.01) * c;
          pebbles.moveTo(cx + rx, cy);
          pebbles.ellipse(cx, cy, rx, rx * 0.72, ((h >> 3) % 31) * 0.1, 0, Math.PI * 2);
        }
      } else if (id === Substrate.Charcoal) {
        for (let k = 0; k < 2; k++) {
          const h = hash2(i, k + 211);
          const cx = px + (0.18 + (h % 64) * 0.01) * c;
          const cy = py + (0.18 + ((h >> 6) % 64) * 0.01) * c;
          const s = (0.12 + ((h >> 12) % 8) * 0.01) * c;
          flecks.moveTo(cx - s, cy);
          flecks.lineTo(cx, cy - s * 0.8);
          flecks.lineTo(cx + s * 0.9, cy + s * 0.2);
          flecks.lineTo(cx - s * 0.2, cy + s * 0.7);
          flecks.closePath();
        }
      } else if (id === Substrate.Soil) {
        for (let k = 0; k < 3; k++) {
          const h = hash2(i, k + 307);
          if ((h & 3) === 0) continue;
          const cx = px + (0.1 + (h % 80) * 0.01) * c;
          const cy = py + (0.1 + ((h >> 7) % 80) * 0.01) * c;
          const rr = Math.max(0.5, c * 0.05);
          specks.moveTo(cx + rr, cy);
          specks.arc(cx, cy, rr, 0, Math.PI * 2);
        }
      }
    }

    ctx.fillStyle = THEME.plate.pebbleFill;
    ctx.fill(pebbles);
    ctx.strokeStyle = THEME.plate.pebbleInk;
    ctx.lineWidth = 0.7;
    ctx.stroke(pebbles);
    ctx.fillStyle = THEME.plate.charcoalFleck;
    ctx.fill(flecks);
    ctx.fillStyle = THEME.plate.soilSpeck;
    ctx.fill(specks);
  }
}

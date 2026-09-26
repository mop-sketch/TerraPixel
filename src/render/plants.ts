// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The plants, drawn as botanical silhouettes to match the ink-and-watercolour plate.
 *
 * Reads the node pool and never writes to it. Geometry that can be tested without a browser — stem
 * taper, a leaf's frame, wilting, eased per-slot state — lives in plantGeometry.ts.
 *
 * Draw order is roots, stems, leaves, flowers, so foliage sits in front of the stem it grows from and
 * blooms sit on top of everything.
 */

import { NodeKind, StressCause } from '../sim/plant.js';
import { LightField } from '../sim/light.js';
import type { World } from '../sim/world.js';
import { THEME } from '../theme.js';
import { hash2 } from './plate.js';
import {
  LEAF_FAN,
  LEAF_HANG,
  LEAF_RANK_STEP,
  LEAF_REACH,
  SlotEase,
  leafFrame,
  leafRank,
  leafTilt,
  stemWidth,
  wiltOf,
  type LeafFrame,
} from './plantGeometry.js';

type Look = (typeof THEME.species)[number];

/** Everything the roots are drawn with, built together and cached. */
type RootArt = {
  /** The roots the sim tracks, one path per half-pixel width band so the taper still reads. */
  bands: Map<number, Path2D>;
  /** Side rootlets off them, drawn only. */
  laterals: Path2D;
  /** Forks off the rootlets, finer again. */
  fine: Path2D;
  /** Root hairs along all of it. */
  hairs: Path2D;
};

/**
 * How far into its opening a node is, 0.35 -> 1 over `ticks` from birth.
 *
 * Never starts at zero: a brand-new node has to be visible immediately or the player sees nothing
 * happen at the moment they were told something did.
 */
function openness(spawnTick: number, now: number, ticks: number): number {
  const age = now - spawnTick;
  if (age >= ticks) return 1;
  return 0.35 + 0.65 * (age / ticks);
}

type Rgb = [number, number, number];

/**
 * What wets the leaves, handed in by the renderer each frame. `seconds` is REAL time, so beads grow
 * and drip at the same pace whatever speed the jar is running at.
 */
export interface LeafWater {
  seconds: number;
  /** Dew from humid air, 0..1, the same on every leaf. */
  dew: number;
  /** How freshly splashed by the watering can a column is, 0..1. */
  splashedAt: (xCell: number) => number;
  /** Hold the beads still, for players who ask for reduced motion. */
  still: boolean;
  /** Lag-free mode: flat leaves, no cast shadows, no beads. */
  lowFx: boolean;
}

/**
 * Health tint, so green -> yellow -> brown still reads as the plant's condition at a glance. As
 * numbers, so lighting and age can shift it before it becomes a colour.
 */
function leafRgb(t: Look['leaf'], health: number): Rgb {
  const [a, b] = health > 0.5 ? [t.stressed, t.healthy] : [t.dying, t.stressed];
  const f = health > 0.5 ? (health - 0.5) * 2 : health * 2;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

const mixRgb = (a: Rgb, b: readonly number[], t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];
const rgbStr = (c: Rgb): string => `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The turns a new leaf tries, in order, away from its preferred angle: none, then out a step at a time,
 * alternately down and up, to about 52 degrees either way.
 */
const TILT_STEPS = [0, 0.15, -0.15, 0.3, -0.3, 0.45, -0.45, 0.6, -0.6, 0.75, -0.75, 0.9, -0.9];

/** The shortest distance between segments (a0 -> a1) and (b0 -> b1). */
function segmentDistance(
  ax0: number,
  ay0: number,
  ax1: number,
  ay1: number,
  bx0: number,
  by0: number,
  bx1: number,
  by1: number,
): number {
  const ux = ax1 - ax0;
  const uy = ay1 - ay0;
  const vx = bx1 - bx0;
  const vy = by1 - by0;
  const wx = ax0 - bx0;
  const wy = ay0 - by0;
  const a = ux * ux + uy * uy;
  const b = ux * vx + uy * vy;
  const cc = vx * vx + vy * vy;
  const d = ux * wx + uy * wy;
  const e = vx * wx + vy * wy;
  const den = a * cc - b * b;
  let s = den > 1e-9 ? Math.max(0, Math.min(1, (b * e - cc * d) / den)) : 0;
  let t = cc > 1e-9 ? (b * s + e) / cc : 0;
  if (t < 0) {
    t = 0;
    s = a > 1e-9 ? Math.max(0, Math.min(1, -d / a)) : 0;
  } else if (t > 1) {
    t = 1;
    s = a > 1e-9 ? Math.max(0, Math.min(1, (b - d) / a)) : 0;
  }
  const dx = wx + s * ux - t * vx;
  const dy = wy + s * uy - t * vy;
  return Math.hypot(dx, dy);
}

/** A point in a leaf's local frame — `u` along the leaf, `v` toward its upper side — in logical pixels. */
const at = (f: LeafFrame, u: number, v: number): [number, number] => [
  f.ox + f.ax * u + f.nx * v,
  f.oy + f.ay * u + f.ny * v,
];

export class PlantArt {
  /** Eased wilt per pool slot, so leaves droop and perk up smoothly instead of twitching every tick. */
  private readonly wilt: SlotEase;
  /**
   * Each leaf's angle, decided ONCE when it first appears (see `settledTilt`), and the spawn tick it was
   * decided for, so a pool slot reused by a new leaf decides afresh. Deciding once is what keeps a leaf
   * from swinging about as others grow in around it.
   */
  private readonly tiltOf: Float32Array;
  private readonly tiltFor: Float64Array;
  /** Each decided leaf's blade as a capsule, [x0, y0, x1, y1, radius] in pixels, for later leaves to avoid. */
  private readonly blades: Float32Array;

  constructor(
    private readonly world: World,
    private readonly c: number,
  ) {
    this.wilt = new SlotEase(world.pool.capacity);
    this.tiltOf = new Float32Array(world.pool.capacity);
    this.tiltFor = new Float64Array(world.pool.capacity).fill(-1);
    this.blades = new Float32Array(world.pool.capacity * 5);
  }

  /**
   * A leaf's tilt: its own preferred angle, turned as little as it takes to clear every leaf already
   * in the jar.
   *
   * The preferred angle is the alternating fan (`leafTilt`) plus a turn of the leaf's own, roughly 5
   * to 20 degrees further the way it already swings and up to 7 either way, which is what makes each
   * blade sit differently. Random angles alone cannot stop blades crossing, though: a stem carries a
   * leaf every half cell on each side, and a blade is nearly two cells long. So a new leaf tries its
   * preferred angle first, then turns out from it a step at a time, up or down, and takes the first
   * angle where its blade touches no other. Where none is clear it takes the one that overlaps least,
   * and a turn away from its preference counts against it, so it never swings far for little gain.
   *
   * Decided once, the first frame a leaf is drawn, against the leaves decided before it, and kept for
   * the leaf's life: older leaves never move for newer ones, so nothing shuffles or flickers.
   */
  private settledTilt(n: number, host: number, rank: number, look: Look): number {
    const P = this.world.pool;
    if (this.tiltFor[n] === P.spawnTick[n]) return this.tiltOf[n];

    const swing = leafTilt(P.x[host], P.y[host], rank);
    const lh = hash2(n, 733);
    const preferred =
      swing * LEAF_FAN +
      rank * LEAF_RANK_STEP +
      swing * (0.08 + 0.27 * ((lh % 1000) / 1000)) +
      (((lh >>> 10) % 1000) / 1000 - 0.5) * 0.24;

    const others: number[] = [];
    for (let m = 0; m < P.count; m++) {
      if (m === n || !P.alive[m] || P.kind[m] !== NodeKind.Leaf || this.tiltFor[m] !== P.spawnTick[m]) continue;
      others.push(m);
    }

    const cap = new Float32Array(5);
    let best = preferred;
    let bestCost = Infinity;
    for (const step of TILT_STEPS) {
      // Kept between about 57 degrees up and 63 down, so a blade never stands on end.
      const tilt = Math.max(-1.0, Math.min(1.1, preferred + step));
      this.capsule(cap, n, host, look, tilt);
      let overlap = 0;
      for (const m of others) {
        const o = m * 5;
        const b = this.blades;
        const d = segmentDistance(cap[0], cap[1], cap[2], cap[3], b[o], b[o + 1], b[o + 2], b[o + 3]);
        overlap += Math.max(0, cap[4] + b[o + 4] - d);
      }
      if (overlap === 0) {
        best = tilt;
        break;
      }
      const cost = overlap + Math.abs(step) * this.c * 0.4;
      if (cost < bestCost) {
        bestCost = cost;
        best = tilt;
      }
    }

    this.tiltOf[n] = best;
    this.tiltFor[n] = P.spawnTick[n];
    this.capsule(cap, n, host, look, best);
    this.blades.set(cap, n * 5);
    return best;
  }

  /** A leaf's grown blade at `tilt`, as a capsule along its midrib: [x0, y0, x1, y1, radius], in pixels. */
  private capsule(out: Float32Array, n: number, host: number, look: Look, tilt: number): void {
    const P = this.world.pool;
    const c = this.c;
    const side = P.x[n] < P.x[host] ? -LEAF_REACH : LEAF_REACH;
    const f = leafFrame(P.x[host] * c, P.y[host] * c, (P.x[host] + side) * c, P.y[host] * c, LEAF_HANG, tilt);
    const L = f.len * look.length;
    // From 40% of the way out: the body of the blade. Leaves meet at the stem, as real ones do, and two
    // on one side of a node grow from the same point, so counting their bases as overlap asked for
    // something no angle could give, and sent new leaves swinging wide for nothing.
    out[0] = f.ox + f.ax * L * 0.4;
    out[1] = f.oy + f.ay * L * 0.4;
    out[2] = f.ox + f.ax * L * 0.95;
    out[3] = f.oy + f.ay * L * 0.95;
    // Half the blade's width, near enough: a fern frond's leaflets reach a little wider than its width.
    out[4] = L * Math.max(look.width * 0.8, look.shape === 'frond' ? 0.2 : 0);
  }

  /**
   * `vessel` and `ground` bound the roots: their drawn rootlets wander past the cells the sim tracks,
   * and must never poke out into the air or through the glass.
   */
  draw(ctx: CanvasRenderingContext2D, vessel: Path2D, ground: Path2D | null, water: LeafWater): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (ground) {
      ctx.save();
      ctx.clip(vessel);
      ctx.clip(ground);
      this.drawRoots(ctx);
      ctx.restore();
    }
    this.drawStems(ctx);
    this.drawLeaves(ctx, water);
    this.drawFlowers(ctx);
    ctx.restore();
  }

  /**
   * Roots as they look against the glass of a real jar: light brown, branching, and furred with root hairs.
   *
   * The simulation's root path is genuinely angular (a mean turn of 65 degrees per joint, up to 135),
   * so each chain from the crown to a tip is run through one Catmull-Rom, exactly as the stems are,
   * carrying the curve THROUGH each node instead of kinking at it.
   *
   * The sim's roots are the skeleton only. Everything finer is drawn, hashed per node so it holds still:
   * side rootlets off every segment, wandering out and down, forking as they go; and along all of
   * it, the fuzz of root hairs, thickest just behind each tip where real roots carry theirs. None of
   * that finer drawing is simulated; it is how the root the sim does track would look.
   *
   * Layered soft to sharp: a faint pale haze (the fuzz seen as a whole), a thin ink edge so the pale root
   * reads on gravel as well as dark soil, the light core, then the individual hairs.
   *
   * All of this is thousands of tiny strokes, and roots change rarely, so the paths are cached and
   * rebuilt only when a root is added, lost or moved.
   */
  private drawRoots(ctx: CanvasRenderingContext2D): void {
    const art = this.rootArt();
    if (!art) return;
    // The glow: every width, widened, very faint. It is what makes the hairs read as fuzz, not lines.
    ctx.strokeStyle = THEME.rootGlow;
    art.bands.forEach((path, key) => {
      ctx.lineWidth = key / 2 + 3.2;
      ctx.stroke(path);
    });
    ctx.lineWidth = 2.6;
    ctx.stroke(art.laterals);
    // The ink edge, then the core over it.
    ctx.strokeStyle = THEME.rootInk;
    art.bands.forEach((path, key) => {
      ctx.lineWidth = key / 2 + 0.9;
      ctx.stroke(path);
    });
    ctx.lineWidth = 1.3;
    ctx.stroke(art.laterals);
    ctx.lineWidth = 1.0;
    ctx.stroke(art.fine);
    ctx.strokeStyle = THEME.root;
    art.bands.forEach((path, key) => {
      ctx.lineWidth = key / 2;
      ctx.stroke(path);
    });
    ctx.lineWidth = 0.75;
    ctx.stroke(art.laterals);
    ctx.lineWidth = 0.5;
    ctx.stroke(art.fine);
    // The hairs last, finest of all.
    ctx.strokeStyle = THEME.rootHair;
    ctx.lineWidth = 0.4;
    ctx.stroke(art.hairs);
  }

  /** The cached root drawing, and the fingerprint of the roots it was built from. */
  private rootCache: { key: number; art: RootArt | null } = { key: NaN, art: null };

  /** The root paths, rebuilt only when the living roots have changed since the last frame. */
  private rootArt(): RootArt | null {
    const P = this.world.pool;
    // A cheap fingerprint of every living root: which slots, and where. Anything that changes the
    // drawing changes this.
    let key = P.count;
    for (let n = 0; n < P.count; n++) {
      if (P.alive[n] === 0 || P.kind[n] !== NodeKind.Root) continue;
      key = (Math.imul(key, 31) + n * 7919 + Math.round(P.x[n] * 64) * 131 + Math.round(P.y[n] * 64)) | 0;
    }
    if (key !== this.rootCache.key) this.rootCache = { key, art: this.buildRoots() };
    return this.rootCache.art;
  }

  private buildRoots(): RootArt | null {
    const w = this.world;
    const P = w.pool;
    const c = this.c;
    const maxDepth = Math.max(1, w.cfg.raw.plant.growth.maxRootDepth);
    const art: RootArt = { bands: new Map(), laterals: new Path2D(), fine: new Path2D(), hairs: new Path2D() };
    // Half-pixel bands: finer than the eye separates on a ~2px line, coarse enough to batch.
    const bandFor = (width: number): Path2D => {
      const key = Math.max(1, Math.round(width * 2));
      let p = art.bands.get(key);
      if (!p) {
        p = new Path2D();
        art.bands.set(key, p);
      }
      return p;
    };
    // A steady 0..1 per node and purpose, so the drawn detail never flickers between frames.
    const rand = (n: number, k: number): number => (hash2(n * 7 + 3, k * 131 + 17) % 10007) / 10007;

    /*
     * Root hairs along a stretch from (x0, y0) heading (hx, hy) for `len` pixels: short fine strokes out
     * to both sides, leaning a little toward the tip as real ones do. `dense` is 0..1, more near a tip.
     */
    const fur = (seed: number, x0: number, y0: number, hx: number, hy: number, len: number, dense: number): void => {
      const step = 1.7 - 0.8 * dense;
      let k = 0;
      for (let d = step * rand(seed, 90); d < len; d += step) {
        const px = x0 + hx * d;
        const py = y0 + hy * d;
        for (let side = -1; side <= 1; side += 2) {
          const l = c * (0.06 + 0.1 * rand(seed, 100 + k)) * (0.7 + 0.6 * dense);
          const lean = 0.35 + 0.4 * rand(seed, 300 + k);
          k++;
          // Perpendicular to the root, tilted forward by `lean`, starting from the root's edge.
          const ux = -hy * side + hx * lean;
          const uy = hx * side + hy * lean;
          const m = Math.hypot(ux, uy) || 1;
          const sx = px - hy * side * 0.4;
          const sy = py + hx * side * 0.4;
          art.hairs.moveTo(sx, sy);
          art.hairs.lineTo(sx + (ux / m) * l, sy + (uy / m) * l);
        }
      }
    };

    /*
     * A side rootlet leaving (x0, y0) heading (dx, dy), `len` pixels long, grown as a real one feels its
     * way through soil: in short steps, each turning a little, with a steady curl of its own (so it
     * sweeps round rather than zigzagging) and a gentle pull downward, so a rootlet that sets off
     * sideways wanders out and then bends down. Hairs follow every step. It forks as it goes, finer
     * each time, two orders deep, and a first-order rootlet thins halfway along.
     */
    const rootlet = (seed: number, x0: number, y0: number, dx: number, dy: number, len: number, order: number): void => {
      const steps = Math.max(3, Math.round(len / (c * 0.33)));
      const seg = len / steps;
      const curl = (rand(seed, 50) - 0.5) * 0.5;
      let hx = dx;
      let hy = dy;
      const xs = [x0];
      const ys = [y0];
      for (let s = 1; s <= steps; s++) {
        const a = curl + (rand(seed, 200 + s) - 0.5) * 0.8;
        const rx = hx * Math.cos(a) - hy * Math.sin(a);
        const ry = hx * Math.sin(a) + hy * Math.cos(a) + 0.1;
        const m = Math.hypot(rx, ry) || 1;
        hx = rx / m;
        // Roots may wander level, or up a little, but never climb for long.
        hy = Math.max(-0.25, ry / m);
        const px = xs[s - 1];
        const py = ys[s - 1];
        xs.push(px + hx * seg);
        ys.push(py + hy * seg);
        const u = s / steps;
        fur(seed * 5 + s, px, py, hx, hy, seg, (0.3 + 0.5 * u) * (order === 2 ? 0.6 : 1));
        if (order < 2 && s < steps - 1 && rand(seed, 40 + s) < (order === 0 ? 0.3 : 0.16)) {
          const side = rand(seed, 60 + s) < 0.5 ? 1 : -1;
          const ang = side * (0.6 + 0.7 * rand(seed, 80 + s));
          rootlet(
            seed * 3 + s,
            xs[s],
            ys[s],
            hx * Math.cos(ang) - hy * Math.sin(ang),
            hx * Math.sin(ang) + hy * Math.cos(ang),
            len * (1 - u) * (0.45 + 0.4 * rand(seed, 70 + s)),
            order + 1,
          );
        }
      }
      // Drawn through the midpoints between steps, so the wander is smooth rather than faceted. A
      // first-order rootlet is drawn at its own weight to halfway, then finer to its tip.
      const half = order === 0 ? Math.ceil(steps / 2) : 0;
      let into = order === 0 ? art.laterals : art.fine;
      into.moveTo(x0, y0);
      for (let s = 1; s < steps; s++) {
        const mx2 = (xs[s] + xs[s + 1]) / 2;
        const my2 = (ys[s] + ys[s + 1]) / 2;
        into.quadraticCurveTo(xs[s], ys[s], mx2, my2);
        if (s === half) {
          into = art.fine;
          into.moveTo(mx2, my2);
        }
      }
      into.lineTo(xs[steps], ys[steps]);
    };

    const isRoot = (n: number): boolean => n >= 0 && P.alive[n] !== 0 && P.kind[n] === NodeKind.Root;
    // Where a node is drawn. The sim steps roots cell to cell, which draws as ruled diagonals; a
    // steady wander of up to a third of a cell makes them meander as grown things do. The crown stays
    // put, so a root always meets its stem.
    const mx = (n: number): number => P.x[n] * c + (isRoot(n) ? (rand(n, 61) - 0.5) * 0.65 * c : 0);
    const my = (n: number): number => P.y[n] * c + (isRoot(n) ? (rand(n, 62) - 0.5) * 0.65 * c : 0);

    // A chain starts where a root hangs off something that is not a root — the crown — and runs to a
    // tip. A fork starts another chain AT the fork, so a branch stays joined to what it grew from.
    const pending: number[][] = [];
    for (let n = 0; n < P.count; n++) {
      if (isRoot(n) && P.parent[n] >= 0 && !isRoot(P.parent[n])) pending.push([P.parent[n], n]);
    }
    if (pending.length === 0) return null;
    while (pending.length > 0) {
      const chain = pending.pop()!;
      let tip = chain[chain.length - 1];
      for (;;) {
        let next = -1;
        for (let ch = P.firstChild[tip]; ch >= 0; ch = P.nextSibling[ch]) {
          if (!isRoot(ch)) continue;
          if (next < 0) next = ch;
          else pending.push([tip, ch]);
        }
        if (next < 0) break;
        chain.push(next);
        tip = next;
      }

      const last = chain.length - 1;
      for (let i = 0; i < last; i++) {
        const n0 = chain[Math.max(0, i - 1)];
        const n1 = chain[i];
        const n2 = chain[i + 1];
        const n3 = chain[Math.min(last, i + 2)];
        const t = Math.min(1, Math.max(0, (P.depth[n2] - 1) / maxDepth));
        const x1 = mx(n1);
        const y1 = my(n1);
        const x2 = mx(n2);
        const y2 = my(n2);
        const b1x = x1 + (x2 - mx(n0)) / 6;
        const b1y = y1 + (y2 - my(n0)) / 6;
        const b2x = x2 - (mx(n3) - x1) / 6;
        const b2y = y2 - (my(n3) - y1) / 6;
        const band = bandFor(2.2 - 1.4 * t);
        band.moveTo(x1, y1);
        band.bezierCurveTo(b1x, b1y, b2x, b2y, x2, y2);

        // Walk the curve in short steps: hairs along each, and rootlets leaving from some.
        const toTip = last - (i + 1);
        const nearTip = Math.max(0, 1 - toTip / 3);
        const steps = 5;
        let qx = x1;
        let qy = y1;
        for (let s = 1; s <= steps; s++) {
          const u = s / steps;
          const v = 1 - u;
          const nx = v * v * v * x1 + 3 * v * v * u * b1x + 3 * v * u * u * b2x + u * u * u * x2;
          const ny = v * v * v * y1 + 3 * v * v * u * b1y + 3 * v * u * u * b2y + u * u * u * y2;
          const sl = Math.hypot(nx - qx, ny - qy);
          if (sl > 0.01) {
            const hx = (nx - qx) / sl;
            const hy = (ny - qy) / sl;
            fur(n2 * 11 + s, qx, qy, hx, hy, sl, 0.25 + 0.75 * nearTip);
            // Rootlets: none on the last segment (it is still growing) or the first (it leaves the
            // crown right at the surface), up to three per segment between, on alternating sides,
            // leaving at anything from a steep 30 degrees to nearly square, so some strike out level
            // before they turn down.
            if (s % 2 === 1 && i > 0 && toTip >= 1 && rand(n2, s) < 0.5) {
              const side = (s === 3) === (rand(n2, 9) < 0.5) ? 1 : -1;
              const ang = side * (0.5 + 0.95 * rand(n2, s + 10));
              let dx = hx * Math.cos(ang) - hy * Math.sin(ang);
              let dy = Math.max(-0.05, hx * Math.sin(ang) + hy * Math.cos(ang) + 0.15);
              const m = Math.hypot(dx, dy) || 1;
              dx /= m;
              dy /= m;
              // Longer higher up, where the root is older.
              const len = c * (1.0 + 2.2 * rand(n2, s + 20)) * (1.2 - 0.5 * t);
              rootlet(n2 * 13 + s, nx, ny, dx, dy, len, 0);
            }
          }
          qx = nx;
          qy = ny;
        }
      }
    }
    return art;
  }

  /**
   * Stems as smooth tapering chains from the crown upward.
   *
   * Each segment is a Catmull-Rom curve using its neighbours in the chain, drawn with round caps and
   * its own width, so the stem bends smoothly at every node and thins toward the tip without visible
   * joints. Ink underneath first, then green on top, so each outline never covers the green before it.
   */
  private drawStems(ctx: CanvasRenderingContext2D): void {
    const w = this.world;
    const P = w.pool;
    const c = this.c;

    for (const plant of w.plants) {
      /*
       * A DEAD plant is still drawn, as long as its nodes are still there.
       *
       * Natural death — every leaf and root gone — leaves the stems standing in the pool: only a
       * seedling that never established is cleared out, and `P.alive[crown]` is what tells the two
       * apart. So the bare frame of a plant that lived and died stays in the jar as a record of it,
       * while a failed sprout leaves nothing.
       */
      if (!P.alive[plant.crown]) continue;
      const dead = plant.stage === 'dead';
      const look = THEME.species[plant.species] ?? THEME.species[1];
      const crownDepth = P.depth[plant.crown];
      // Starvation yellows a living stem. Overlaid at the end rather than blended into the species
      // colour, so nothing has to unpack a hex string to interpolate it.
      const starved = dead ? 0 : Math.min(1, plant.stressBy[StressCause.Starvation] * 1.6);

      // Chains of stems: follow the first stem child upward; any extra branch starts its own chain.
      const chains: number[][] = [];
      const pending: number[][] = [[plant.crown]];
      let maxDepth = 0;
      while (pending.length > 0) {
        const chain = pending.pop()!;
        let tip = chain[chain.length - 1];
        for (;;) {
          let next = -1;
          for (let ch = P.firstChild[tip]; ch >= 0; ch = P.nextSibling[ch]) {
            if (!P.alive[ch] || P.kind[ch] !== NodeKind.Stem) continue;
            if (next < 0) next = ch;
            else pending.push([tip, ch]);
          }
          if (next < 0) break;
          chain.push(next);
          tip = next;
        }
        for (const n of chain) maxDepth = Math.max(maxDepth, P.depth[n] - crownDepth);
        if (chain.length > 1) chains.push(chain);
      }

      const base = c * 0.26;
      // pass 0 ink, pass 1 the stem itself, pass 2 the starvation wash (skipped when not starving).
      const passes = starved > 0.02 ? [0, 1, 2] : [0, 1];
      for (const pass of passes) {
        if (pass === 2) ctx.globalAlpha = starved * 0.85;
        ctx.strokeStyle =
          pass === 0 ? THEME.plantInk : pass === 2 ? THEME.stemStarved : dead ? THEME.stemDead : look.stem;
        for (const chain of chains) {
          const last = chain.length - 1;
          for (let i = 0; i < last; i++) {
            const n0 = chain[Math.max(0, i - 1)];
            const n1 = chain[i];
            const n2 = chain[i + 1];
            const n3 = chain[Math.min(last, i + 2)];
            const width = stemWidth(P.depth[n2] - crownDepth, maxDepth, base);
            ctx.lineWidth = pass === 0 ? width + 1.2 : width;
            const x1 = P.x[n1] * c;
            const y1 = P.y[n1] * c;
            const x2 = P.x[n2] * c;
            const y2 = P.y[n2] * c;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.bezierCurveTo(
              x1 + ((P.x[n2] - P.x[n0]) * c) / 6,
              y1 + ((P.y[n2] - P.y[n0]) * c) / 6,
              x2 - ((P.x[n3] - P.x[n1]) * c) / 6,
              y2 - ((P.y[n3] - P.y[n1]) * c) / 6,
              x2,
              y2,
            );
            ctx.stroke();
          }
        }
      }
      // The starvation pass leaves the context faded; nothing after it should inherit that.
      ctx.globalAlpha = 1;

      /*
       * Rot blotching a dead frame, so a skeleton reads as something that died rather than as a
       * stem drawn in a duller green.
       *
       * Placed from a hash of the node and index, so the blotches are fixed to the wood and stay put
       * frame to frame instead of crawling over it.
       */
      if (!dead) continue;
      ctx.fillStyle = THEME.stemDeadSpot;
      for (const chain of chains) {
        for (const n of chain) {
          const width = stemWidth(P.depth[n] - crownDepth, maxDepth, base);
          for (let k = 0; k < 3; k++) {
            const h = hash2(n, k + 131);
            if (h % 5 === 0) continue;
            const t = (h % 100) / 100;
            const px = (P.x[n] + ((((h >>> 7) % 100) / 100 - 0.5) * 0.5)) * c;
            const py = (P.y[n] + (t - 0.5) * 0.9) * c;
            const r = width * (0.22 + ((h >>> 14) % 10) * 0.035);
            if (r < 0.35) continue;
            ctx.beginPath();
            ctx.ellipse(px, py, r * 1.3, r, ((h >>> 20) % 10) * 0.3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
    }
  }

  /**
   * Every leaf, in its species' shape, drooping by its own eased wilt, lit by the lamp, and aged.
   *
   * LIGHT falls from a lamp above the middle of the jar, and is drawn three ways, none of which
   * changes a leaf's HUE, because hue is how a leaf says it is sick: a golden wash over leaves in full
   * light was tried first, and made healthy leaves read as yellowing.
   *
   *   - ACROSS each leaf: the edge facing the lamp takes a soft warm highlight and the far edge falls
   *     into shade, which is what gives a flat blade a shape and the light a direction.
   *   - UNDER the canopy: the sim's own `LightField` is what each leaf photosynthesises on, cut by
   *     every leaf above it. Relative to what falls on the jar, it says how shaded a leaf is, and those
   *     leaves darken as a whole, so what reads as shaded is what is starving.
   *   - BEHIND: all the leaves together cast ONE soft shadow down and away from the lamp, onto the
   *     stems and the jar behind, and each plant a soft contact shadow on the soil where it stands.
   *     One layer, not a shadow per leaf: per-leaf drop shadows read as stickers, darkened each other
   *     where they stacked, and fell on leaves ABOVE them as readily as below.
   *
   * All of it scales with the lamp and the time of day, and is gone at night, when the night wash over
   * the jar is the dark.
   *
   * AGE: a new leaf on a young plant is a fresh light green, and a mature leaf on an old plant a deep
   * one. Health is applied first and age and light only shift it, so a yellowing leaf still yellows.
   *
   * ANGLE varies by leaf, and is chosen so blades do not cross: see `settledTilt`. Size and reach stay
   * uniform. Only the picture moves; the node stays where the sim has it, since it is what the light
   * is sampled at.
   */
  private drawLeaves(ctx: CanvasRenderingContext2D, water: LeafWater): void {
    const w = this.world;
    const P = w.pool;
    const c = this.c;
    const visibleAt = w.cfg.raw.pests.visibleAt;
    const L = THEME.leafLight;
    const lightCfg = w.cfg.raw.light;
    const incident = lightCfg.lampPpfd * LightField.dayFraction(w.cfg, w.tickCount) * w.atmo.lampIntensity;
    const lampLit = clamp01(incident / Math.max(1, lightCfg.lampPpfd));
    const day = w.cfg.ticksPerSimDay;
    // The lamp, as a point well above the middle of the lid: light falls mostly straight down, and
    // spreads a little outward toward the walls.
    const lampX = (w.grid.w / 2) * c;
    const lampY = -w.grid.h * c * 0.9;

    interface Leaf {
      n: number;
      f: LeafFrame;
      look: Look;
      grow: number;
      thirst: number;
      rgb: Rgb;
      here: number;
      cx: number;
      cy: number;
      dx: number;
      dy: number;
      len: number;
    }
    const leaves: Leaf[] = [];
    for (let n = 0; n < P.count; n++) {
      if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
      const host = P.parent[n];
      if (host < 0) continue;
      const plant = w.plants[P.plantId[n]];
      if (!plant) continue;

      const need = w.cfg.species[plant.species].raw.photosynthesis.leafWaterNeed;
      const thirst = this.wilt.step(n, P.spawnTick[n], wiltOf(P.water[n], need), 0.06);
      /*
       * The frame hangs by thirst PLUS a small constant; the blade narrows by thirst alone.
       *
       * Splitting the two matters. A leaf that both drops and curls means the plant is dry, and that is
       * the single most readable diagnostic on the plate. Folding the cosmetic hang into the narrowing
       * as well would put a permanent slight curl on every healthy leaf in the jar and blunt it.
       */
      const hang = Math.min(1, thirst + LEAF_HANG);
      /*
       * The blade is drawn from a LEVEL reach plus an explicit splay, not from the node's own offset.
       *
       * `growLeaf` steps each pair of leaves half a cell further down the stem, which reads as a fan of
       * ever-drooping blades that overlap their neighbours and, by the last rank, hang far enough to be
       * mistaken for thirst. Rebuilding the angle here keeps the blades centred on the horizontal and
       * splays them apart instead — the node stays exactly where the simulation put it, since it is the
       * light sample that matters there, and only the picture changes.
       */
      const rank = leafRank(P.y[n] - P.y[host]);
      const look = THEME.species[plant.species] ?? THEME.species[1];
      // Its own angle, turned clear of the leaves around it: see `settledTilt`.
      const tilt = this.settledTilt(n, host, rank, look);
      const side = P.x[n] < P.x[host] ? -LEAF_REACH : LEAF_REACH;
      const f = leafFrame(P.x[host] * c, P.y[host] * c, (P.x[host] + side) * c, P.y[host] * c, hang, tilt);
      const grow = openness(P.spawnTick[n], w.tickCount, 60);

      // Age: the leaf's own, and its plant's. Fresh on a seedling, deep on an old plant's old leaves.
      const leafAge = (w.tickCount - P.spawnTick[n]) / day;
      const plantAge = (w.tickCount - P.spawnTick[plant.crown]) / day;
      const maturity = clamp01(0.55 * clamp01(leafAge / 10) + 0.45 * clamp01(plantAge / 30));
      let rgb = leafRgb(look.leaf, P.health[n]);
      rgb =
        maturity < 0.4
          ? mixRgb(rgb, L.fresh, 0.42 * (1 - maturity / 0.4))
          : mixRgb(rgb, L.deep, 0.35 * ((maturity - 0.4) / 0.6));

      // Under the canopy: darker, as a whole, the less of the jar's light reaches it.
      let here = 1;
      if (incident > 1) {
        here = clamp01(w.light.atNode(P, n) / incident);
        rgb = mixRgb(rgb, L.shade, 0.38 * (1 - here) * lampLit);
      }

      const len = f.len * look.length * grow;
      const cx = f.ox + f.ax * len * 0.55;
      const cy = f.oy + f.ay * len * 0.55;
      const lx = cx - lampX;
      const ly = cy - lampY;
      const lm = Math.hypot(lx, ly) || 1;
      leaves.push({ n, f, look, grow, thirst, rgb, here, cx, cy, dx: lx / lm, dy: ly / lm, len });
    }

    const shaded = !water.lowFx && lampLit > 0.03;
    if (shaded && leaves.length > 0) this.castShadows(ctx, leaves, lampLit);

    for (const lf of leaves) {
      const { f, look, grow, thirst, rgb, n } = lf;
      let fill: string | CanvasGradient = rgbStr(rgb);
      if (shaded) {
        // Across the leaf, along the way the light is travelling: lit edge, the leaf's own colour,
        // then its shaded edge. Strongest on leaves the canopy does not shade.
        const r = Math.max(lf.len * 0.5, c * 0.4);
        const grad = ctx.createLinearGradient(lf.cx - lf.dx * r, lf.cy - lf.dy * r, lf.cx + lf.dx * r, lf.cy + lf.dy * r);
        const lit = mixRgb(rgb, L.highlight, 0.34 * lampLit * (0.35 + 0.65 * lf.here));
        const dark = mixRgb(rgb, L.shade, 0.3 * lampLit);
        grad.addColorStop(0, rgbStr(lit));
        grad.addColorStop(0.45, rgbStr(rgb));
        grad.addColorStop(1, rgbStr(dark));
        fill = grad;
      }

      if (look.shape === 'frond') this.frond(ctx, f, look, grow, thirst, fill);
      else if (look.shape === 'paddle') this.paddle(ctx, f, look, grow, thirst, fill);
      else this.ovate(ctx, f, look, grow, thirst, fill);

      if (P.pests[n] >= visibleAt) this.pests(ctx, f, look.length * grow, n, (P.pests[n] - visibleAt) / (1 - visibleAt));
    }

    if (!water.lowFx) this.drawDew(ctx, leaves, water, lampLit);
  }

  /**
   * Water beading on the leaves, and dripping off them.
   *
   * Two things wet a leaf: humid air, which beads dew on every leaf as the jar nears fog, and the
   * watering can, which splashes the leaves around where it pours and dries off over a few seconds.
   *
   * A beaded leaf carries one bead or two, two the wetter it is. A bead swells where it formed, then
   * runs down the blade to its LOWER end (the tip of a leaf hanging down, the stem end of one reaching
   * up), gathers, lets go, and falls with gravity to the ground, where it splashes. Every step is worked
   * out from real time and a hash of the leaf, not stored, so there is nothing to keep in step with the
   * sim and nothing to leak, and the jar's speed has no say in it.
   *
   * By day each bead on a leaf casts a small soft shadow on it, away from the lamp, the same way the
   * leaves' own light falls; and a drop of water is a lens, so inside that shadow, on the far side of
   * the bead, sits a small bright spot of the light it has focused. A falling drop throws its shadow
   * on the ground below, faint while it is high and sharpening as it comes down. At night none of it.
   */
  private drawDew(
    ctx: CanvasRenderingContext2D,
    leaves: ReadonlyArray<{ n: number; f: LeafFrame; look: Look; cx: number; len: number; dx: number; dy: number }>,
    water: LeafWater,
    lampLit: number,
  ): void {
    const w = this.world;
    const g = w.grid;
    const c = this.c;
    const D = THEME.dew;
    const t = water.still ? 0 : water.seconds;
    // Pixels per second squared: a drop from a leaf a few cells up lands in about a third of a second.
    const GRAVITY = 900;
    const beads = new Path2D();
    const glints = new Path2D();
    const shadows = new Path2D();
    const focus = new Path2D();
    const splashes: Array<[number, number, number]> = [];
    const groundShadows: Array<[number, number, number, number]> = [];
    const lit = lampLit > 0.03;

    /** A bead at (x, y). On a leaf, with the light travelling (lx, ly), it also shades and focuses. */
    const bead = (x: number, y: number, rx: number, ry: number, lx = 0, ly = 0, onLeaf = false): void => {
      beads.moveTo(x + rx, y);
      beads.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      const gx = x - rx * 0.35;
      const gy = y - ry * 0.35;
      const gr = Math.max(0.25, rx * 0.32);
      glints.moveTo(gx + gr, gy);
      glints.arc(gx, gy, gr, 0, Math.PI * 2);
      if (!onLeaf || !lit) return;
      const sx = x + lx * rx * 0.75;
      const sy = y + ly * ry * 0.75;
      shadows.moveTo(sx + rx * 1.12, sy);
      shadows.ellipse(sx, sy, rx * 1.12, ry * 1.02, 0, 0, Math.PI * 2);
      const fx = x + lx * rx * 1.05;
      const fy = y + ly * ry * 1.05;
      const fr = Math.max(0.2, rx * 0.26);
      focus.moveTo(fx + fr, fy);
      focus.arc(fx, fy, fr, 0, Math.PI * 2);
    };

    /*
     * Only a couple of leaves on each plant bead up: two, or three once it is soaked. Every leaf beading
     * at once read as the whole plant sweating. Which ones is fixed by a hash of each leaf, so the same
     * leaves stay beaded rather than it hopping about from frame to frame.
     */
    const P = w.pool;
    const wetOf = (lf: { cx: number }): number =>
      Math.max(water.dew, water.splashedAt(Math.max(1, Math.min(g.w - 2, Math.floor(lf.cx / c)))));
    const byPlant = new Map<number, Array<{ lf: (typeof leaves)[number]; wet: number; pick: number }>>();
    for (const lf of leaves) {
      const wet = wetOf(lf);
      if (wet < 0.04 || lf.len < c * 0.4) continue;
      const id = P.plantId[lf.n];
      let list = byPlant.get(id);
      if (!list) byPlant.set(id, (list = []));
      list.push({ lf, wet, pick: hash2(lf.n, 887) % 100003 });
    }
    const chosen: Array<{ lf: (typeof leaves)[number]; wet: number }> = [];
    for (const list of byPlant.values()) {
      const soaked = list.reduce((m, e) => Math.max(m, e.wet), 0);
      list.sort((a, b) => a.pick - b.pick);
      chosen.push(...list.slice(0, soaked > 0.6 ? 3 : 2));
    }

    for (const { lf, wet } of chosen) {
      const f = lf.f;
      const L = lf.len;
      const W = L * lf.look.width;
      // Which end water runs to: whichever sits lower on screen.
      const [, tipY] = at(f, L * 0.92, 0);
      const [, baseY] = at(f, L * 0.22, 0);
      const endU = tipY >= baseY ? 0.92 : 0.22;
      const slots = wet > 0.4 ? 2 : 1;
      for (let k = 0; k < slots; k++) {
        const h = hash2(lf.n, 900 + k);
        const r = (bit: number): number => ((h >>> bit) % 1000) / 1000;
        // Wetter leaves cycle faster: a splashed leaf drips within seconds, dew takes its time.
        const cycle = (7 + 7 * r(0)) / (0.55 + 0.9 * wet);
        const u = (((t + r(8) * cycle) / cycle) % 1 + 1) % 1;
        const spotU = 0.35 + 0.35 * r(12);
        const spotV = (r(18) - 0.5) * 0.9 * W;
        const size = c * (0.055 + 0.05 * Math.sqrt(wet)) * (0.8 + 0.4 * r(22));

        if (water.still || u < 0.5) {
          // Swelling where it formed.
          const grow = water.still ? 1 : 0.35 + 0.65 * (u / 0.5);
          const [x, y] = at(f, L * spotU, spotV);
          bead(x, y, size * grow, size * grow * 0.92, lf.dx, lf.dy, true);
          continue;
        }
        const [ex, ey] = at(f, L * endU, 0);
        if (u < 0.74) {
          // Running down the blade to its lower end, drawing in toward the midrib as it goes.
          const s = (u - 0.5) / 0.24;
          const e = s * s;
          const [x, y] = at(f, L * (spotU + (endU - spotU) * e), spotV * (1 - e));
          bead(x, y, size, size * (1 + 0.15 * s), lf.dx, lf.dy, true);
          continue;
        }
        // Let go, and falling.
        const ground = g.surfaceOfColumn[Math.max(1, Math.min(g.w - 2, Math.floor(ex / c)))];
        const groundY = ground >= 0 ? g.yOf(ground) * c : g.h * c;
        const dt = (u - 0.74) * cycle;
        const fallY = ey + size + 0.5 * GRAVITY * dt * dt;
        if (fallY < groundY) {
          bead(ex, fallY, size * 0.8, size * 1.25);
          // Its shadow on the ground: soft and faint while it is high, drawing in as it comes down.
          if (lit) {
            const near = clamp01(1 - (groundY - fallY) / (c * 6));
            groundShadows.push([ex, groundY, size * (2.2 - 1.2 * near), near]);
          }
        } else {
          // Landed: a small splash for a quarter of a second.
          const landedAt = Math.sqrt((2 * Math.max(0, groundY - ey - size)) / GRAVITY);
          const since = dt - landedAt;
          if (since < 0.25) splashes.push([ex, groundY, since / 0.25]);
        }
      }
    }

    ctx.save();
    if (lit) {
      const [r, gg, b] = THEME.leafLight.cast;
      ctx.fillStyle = `rgba(${r}, ${gg}, ${b}, ${(0.32 * lampLit).toFixed(3)})`;
      ctx.fill(shadows);
      for (const [x, y, rx, near] of groundShadows) {
        ctx.globalAlpha = 0.25 + 0.75 * near;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, rx * 0.35, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = D.bead;
    ctx.fill(beads);
    ctx.strokeStyle = D.edge;
    ctx.lineWidth = 0.35;
    ctx.stroke(beads);
    ctx.fillStyle = D.glint;
    ctx.fill(glints);
    if (lit) {
      // The light each bead focuses, bright in the middle of its shadow.
      ctx.fillStyle = D.focus;
      ctx.globalAlpha = Math.min(1, 0.9 * lampLit + 0.2);
      ctx.fill(focus);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = D.splash;
    ctx.lineWidth = 0.5;
    for (const [x, y, k] of splashes) {
      ctx.globalAlpha = 1 - k;
      ctx.beginPath();
      ctx.ellipse(x, y - 0.5, c * (0.08 + 0.22 * k), c * (0.03 + 0.06 * k), 0, Math.PI, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * The soft shadow the planting casts: every leaf's, together, down and away from the lamp, and each
   * plant's on the soil where it stands.
   *
   * One path, filled once, so where two leaves' shadows overlap they do not darken twice. Softened
   * with the canvas's own shadow blur rather than a filter, which not every browser draws: the path is
   * filled far off to one side and only its blurred shadow is thrown back onto the jar.
   */
  private castShadows(
    ctx: CanvasRenderingContext2D,
    leaves: ReadonlyArray<{ n: number; f: LeafFrame; look: Look; cx: number; cy: number; dx: number; dy: number; len: number }>,
    lampLit: number,
  ): void {
    const w = this.world;
    const P = w.pool;
    const c = this.c;
    const L = THEME.leafLight;
    const AWAY = 100000;
    const throwBy = c * 0.85;

    const shade = new Path2D();
    for (const lf of leaves) {
      const x = lf.cx + lf.dx * throwBy - AWAY;
      const y = lf.cy + lf.dy * throwBy;
      const rx = lf.len * 0.46;
      const ry = Math.max(lf.len * lf.look.width * 0.85, lf.look.shape === 'frond' ? lf.len * 0.2 : 0);
      const ang = Math.atan2(lf.f.ay, lf.f.ax);
      shade.moveTo(x + Math.cos(ang) * rx, y + Math.sin(ang) * rx);
      shade.ellipse(x, y, rx, ry, ang, 0, Math.PI * 2);
    }

    // Each plant's contact shadow: a soft pool on the soil under it, as wide as its leaves spread.
    const ground = new Path2D();
    for (const plant of w.plants) {
      if (plant.stage === 'dead' || !P.alive[plant.crown]) continue;
      const x0 = P.x[plant.crown] * c;
      let spread = c * 0.8;
      for (const lf of leaves) {
        if (w.plants[P.plantId[lf.n]] !== plant) continue;
        spread = Math.max(spread, Math.abs(lf.cx - x0) + lf.len * 0.3);
      }
      const y0 = P.y[plant.crown] * c;
      const rx = Math.min(spread, c * 3.5);
      ground.moveTo(x0 + rx - AWAY, y0);
      ground.ellipse(x0 - AWAY, y0, rx, c * 0.45, 0, 0, Math.PI * 2);
    }

    const scale = ctx.getTransform().a || 1;
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.shadowOffsetX = AWAY * scale;
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = `rgba(${L.cast[0]}, ${L.cast[1]}, ${L.cast[2]}, ${(0.22 * lampLit).toFixed(3)})`;
    ctx.shadowBlur = 5 * scale;
    ctx.fill(shade);
    ctx.shadowColor = `rgba(${L.cast[0]}, ${L.cast[1]}, ${L.cast[2]}, ${(0.3 * lampLit).toFixed(3)})`;
    ctx.shadowBlur = 7 * scale;
    ctx.fill(ground);
    ctx.restore();
  }

  /**
   * Pests clustered on a blade, from two specks at the visible threshold to nine on a leaf overrun.
   *
   * Drawn from the SAME threshold the panel and the pest warning read, so a leaf the jar calls
   * infested always shows it and a dormant colony never does. Anything else would have the panel
   * telling the player to prune leaves they cannot find.
   *
   * Placed by hash on the node, so the specks sit still frame to frame instead of crawling, and bunch
   * toward the leaf's base the way sap-suckers gather where the veins are thickest.
   */
  private pests(ctx: CanvasRenderingContext2D, f: LeafFrame, reach: number, n: number, heavy: number): void {
    const L = f.len * reach;
    // Two at the threshold, not one: a lone speck at normal zoom reads as dust, and a fresh outbreak is
    // exactly when the player most needs to notice, since that is when a prune still contains it.
    const count = 2 + Math.round(heavy * 7);
    const r = this.c * 0.105;
    ctx.fillStyle = THEME.pest;
    ctx.strokeStyle = THEME.pestInk;
    ctx.lineWidth = 0.45;
    for (let k = 0; k < count; k++) {
      const h = hash2(n, k + 211);
      // Squared, so they crowd the base of the blade rather than spreading evenly to the tip.
      const along = (h % 1000) / 1000;
      const u = L * (0.22 + 0.62 * along * along);
      const v = L * 0.2 * ((((h >>> 10) % 1000) / 1000) * 2 - 1);
      const [x, y] = at(f, u, v);
      const ang = Math.atan2(f.ay, f.ax);
      ctx.beginPath();
      ctx.ellipse(x, y, r * 1.35, r, ang, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  private petiole(ctx: CanvasRenderingContext2D, f: LeafFrame, length: number, colour: string): void {
    const [x, y] = at(f, length, 0);
    ctx.strokeStyle = colour;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(f.ox, f.oy);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  /** Fill a blade from its upper-edge profile, mirrored for the lower edge. */
  private blade(
    ctx: CanvasRenderingContext2D,
    f: LeafFrame,
    profile: readonly [number, number][],
    fill: string | CanvasGradient,
  ): void {
    const path = new Path2D();
    const [sx, sy] = at(f, profile[0][0], 0);
    path.moveTo(sx, sy);
    for (const [u, v] of profile) {
      const [x, y] = at(f, u, v);
      path.lineTo(x, y);
    }
    for (let k = profile.length - 1; k >= 0; k--) {
      const [x, y] = at(f, profile[k][0], -profile[k][1]);
      path.lineTo(x, y);
    }
    path.closePath();
    ctx.fillStyle = fill;
    ctx.fill(path);
    ctx.strokeStyle = THEME.plantInk;
    ctx.lineWidth = 0.6;
    ctx.stroke(path);
  }

  /** Herb: an oval blade with a pointed tip and a midrib. */
  private ovate(
    ctx: CanvasRenderingContext2D,
    f: LeafFrame,
    look: Look,
    grow: number,
    droop: number,
    fill: string | CanvasGradient,
  ): void {
    const L = f.len * look.length * grow;
    const W = L * look.width * (1 - 0.35 * droop);
    const pet = L * 0.18;
    const profile: [number, number][] = [];
    const N = 12;
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      profile.push([pet + t * (L - pet), W * Math.pow(Math.sin(Math.PI * t), 0.85) * (1 - 0.3 * t)]);
    }
    this.petiole(ctx, f, pet, look.stem);
    this.blade(ctx, f, profile, fill);
    const [x0, y0] = at(f, pet, 0);
    const [x1, y1] = at(f, L * 0.92, 0);
    ctx.strokeStyle = THEME.leafVein;
    ctx.lineWidth = 0.55;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  /** Succulent: a thick rounded paddle with a soft highlight along its upper edge. */
  private paddle(
    ctx: CanvasRenderingContext2D,
    f: LeafFrame,
    look: Look,
    grow: number,
    droop: number,
    fill: string | CanvasGradient,
  ): void {
    const L = f.len * look.length * grow;
    const W = L * look.width * (1 - 0.35 * droop);
    const pet = L * 0.1;
    const profile: [number, number][] = [];
    const N = 14;
    // An ellipse profile run slightly past 1 so both ends close into rounded tips.
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * 1.1;
      const e = (t - 0.55) / 0.55;
      profile.push([pet + (t / 1.1) * (L - pet), W * Math.sqrt(Math.max(0, 1 - e * e))]);
    }
    this.petiole(ctx, f, pet, look.stem);
    this.blade(ctx, f, profile, fill);
    ctx.strokeStyle = THEME.leafHighlight;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let k = 4; k <= 10; k++) {
      const [x, y] = at(f, profile[k][0], profile[k][1] * 0.55);
      if (k === 4) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  /** Fern: a gently curved frond of small leaflets that shrink toward the tip. */
  private frond(
    ctx: CanvasRenderingContext2D,
    f: LeafFrame,
    look: Look,
    grow: number,
    droop: number,
    fill: string | CanvasGradient,
  ): void {
    const L = f.len * look.length * grow;
    const arc = L * 0.12;
    const rachis = (t: number): [number, number] => at(f, t * L, arc * Math.sin(Math.PI * t));

    ctx.strokeStyle = look.stem;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let k = 0; k <= 10; k++) {
      const [x, y] = rachis(k / 10);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const leaflets = new Path2D();
    for (let k = 0; k < 6; k++) {
      const t = 0.22 + k * 0.13;
      const [bx, by] = rachis(t);
      const s = L * 0.2 * (1 - k * 0.11) * (1 - 0.3 * droop);
      for (const dir of [1, -1]) {
        // Each leaflet leans a little toward the frond's tip.
        const ox = f.nx * dir + f.ax * 0.35;
        const oy = f.ny * dir + f.ay * 0.35;
        const ol = Math.hypot(ox, oy) || 1;
        const cx = bx + (ox / ol) * s * 0.55;
        const cy = by + (oy / ol) * s * 0.55;
        const rot = Math.atan2(oy, ox);
        const rx = s * 0.55;
        leaflets.moveTo(cx + Math.cos(rot) * rx, cy + Math.sin(rot) * rx);
        leaflets.ellipse(cx, cy, rx, s * 0.22, rot, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = fill;
    ctx.fill(leaflets);
    ctx.strokeStyle = THEME.plantInk;
    ctx.lineWidth = 0.5;
    ctx.stroke(leaflets);
  }

  /**
   * Flowers: a short stalk from the stem, then each species' own bloom, unfolding over the 90-tick
   * `openness`.
   *
   *   - FERN: a loose spray of tiny cream-white starry florets, each on its own hair-thin stalk.
   *   - HERB: a spike of small lilac blossoms stacked up a short stalk, smaller toward its tip, as
   *     lavender and basil carry theirs.
   *   - SUCCULENT: a many-petalled magenta daisy round a golden centre, as an ice plant opens.
   *
   * Each is hashed on its node for its small turns and counts, so it holds still frame to frame.
   */
  private drawFlowers(ctx: CanvasRenderingContext2D): void {
    const w = this.world;
    const P = w.pool;
    const c = this.c;

    for (let n = 0; n < P.count; n++) {
      if (!P.alive[n] || P.kind[n] !== NodeKind.Flower) continue;
      const host = P.parent[n];
      const look = this.lookOf(n);
      const open = openness(P.spawnTick[n], w.tickCount, 90);
      const fx = P.x[n] * c;
      const fy = P.y[n] * c;

      if (host >= 0 && P.alive[host]) {
        const hx = P.x[host] * c;
        const hy = P.y[host] * c;
        ctx.strokeStyle = look.stem;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.quadraticCurveTo(hx + (fx - hx) * 0.2 + 1.5, (hy + fy) / 2, fx, fy);
        ctx.stroke();
      }

      if (look.shape === 'frond') this.fernSpray(ctx, n, fx, fy, open, look);
      else if (look.shape === 'paddle') this.succulentDaisy(ctx, n, fx, fy, open, look);
      else this.herbSpike(ctx, n, fx, fy, open, look);
    }
  }

  /** A small star of `points` petals at (x, y), radius r, into `into`. */
  private static star(into: Path2D, x: number, y: number, r: number, points: number, spin: number): void {
    for (let k = 0; k < points; k++) {
      const ang = (k / points) * Math.PI * 2 + spin;
      const cx = x + Math.cos(ang) * r * 0.55;
      const cy = y + Math.sin(ang) * r * 0.55;
      into.moveTo(cx + Math.cos(ang) * r * 0.5, cy + Math.sin(ang) * r * 0.5);
      into.ellipse(cx, cy, r * 0.5, r * 0.26, ang, 0, Math.PI * 2);
    }
  }

  /** Fern: tiny cream florets on hair-thin stalks, fanning up and out from the flower's point. */
  private fernSpray(ctx: CanvasRenderingContext2D, n: number, fx: number, fy: number, open: number, look: Look): void {
    const c = this.c;
    const B = look.bloom;
    const count = 5 + (hash2(n, 3) % 3);
    const stalks = new Path2D();
    const florets = new Path2D();
    const hearts: Array<[number, number, number]> = [];
    for (let k = 0; k < count; k++) {
      const h = hash2(n, 40 + k);
      // Fanned across the upper half, each reaching its own way.
      const ang = -Math.PI / 2 + ((k / (count - 1)) - 0.5) * 2.2 + (((h % 100) / 100) - 0.5) * 0.3;
      const reach = c * (0.4 + 0.25 * (((h >>> 8) % 100) / 100)) * open;
      const x = fx + Math.cos(ang) * reach;
      const y = fy + Math.sin(ang) * reach;
      stalks.moveTo(fx, fy);
      stalks.quadraticCurveTo(fx + Math.cos(ang) * reach * 0.5, fy + Math.sin(ang) * reach * 0.4 - c * 0.05, x, y);
      // Big enough to read against the pale paper behind them: a cream flower on cream vanished.
      const r = c * (0.19 + 0.06 * (((h >>> 16) % 100) / 100)) * open;
      PlantArt.star(florets, x, y, r, 5, (h % 10) * 0.12);
      hearts.push([x, y, r]);
    }
    ctx.strokeStyle = look.stem;
    ctx.lineWidth = 0.6;
    ctx.stroke(stalks);
    ctx.fillStyle = B.petal;
    ctx.fill(florets);
    ctx.strokeStyle = B.ink;
    ctx.lineWidth = 0.55;
    ctx.stroke(florets);
    ctx.fillStyle = B.centre;
    for (const [x, y, r] of hearts) {
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.5, r * 0.3), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Herb: a short upright spike of lilac blossoms, largest at its foot, a bud at its tip. */
  private herbSpike(ctx: CanvasRenderingContext2D, n: number, fx: number, fy: number, open: number, look: Look): void {
    const c = this.c;
    const B = look.bloom;
    const lean = (((hash2(n, 5) % 100) / 100) - 0.5) * 0.35;
    const len = c * 0.85 * open;
    const tx = fx + Math.sin(lean) * len;
    const ty = fy - Math.cos(lean) * len;
    ctx.strokeStyle = look.stem;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    const blossoms = new Path2D();
    const tiers = 5;
    for (let k = 0; k < tiers; k++) {
      const t = k / (tiers - 1);
      const x = fx + (tx - fx) * (0.15 + 0.85 * t);
      const y = fy + (ty - fy) * (0.15 + 0.85 * t);
      const r = c * (0.17 - 0.08 * t) * (0.4 + 0.6 * open);
      // A pair either side of the stalk, offset a little so the spike reads as whorls, not a ladder.
      for (const side of [-1, 1]) {
        const ox = x + side * r * 0.75;
        const oy = y + (side > 0 ? r * 0.2 : 0);
        blossoms.moveTo(ox + r, oy);
        blossoms.ellipse(ox, oy, r, r * 0.78, side * 0.5, 0, Math.PI * 2);
      }
    }
    // The bud at the tip.
    const tr = c * 0.07 * (0.4 + 0.6 * open);
    blossoms.moveTo(tx + tr, ty);
    blossoms.ellipse(tx, ty, tr, tr * 1.4, lean, 0, Math.PI * 2);
    ctx.fillStyle = B.petal;
    ctx.fill(blossoms);
    ctx.strokeStyle = B.ink;
    ctx.lineWidth = 0.4;
    ctx.stroke(blossoms);
  }

  /** Succulent: a daisy of many thin magenta petals round a wide golden centre. */
  private succulentDaisy(ctx: CanvasRenderingContext2D, n: number, fx: number, fy: number, open: number, look: Look): void {
    const c = this.c;
    const B = look.bloom;
    const R = c * 0.5 * open;
    const count = 14;
    const spin = (hash2(n, 7) % 20) * 0.02;
    const petals = new Path2D();
    for (let k = 0; k < count; k++) {
      const ang = (k / count) * Math.PI * 2 + spin;
      const cx = fx + Math.cos(ang) * R * 0.58;
      const cy = fy + Math.sin(ang) * R * 0.58;
      petals.moveTo(cx + Math.cos(ang) * R * 0.42, cy + Math.sin(ang) * R * 0.42);
      petals.ellipse(cx, cy, R * 0.42, R * 0.09 * (0.5 + 0.5 * open), ang, 0, Math.PI * 2);
    }
    ctx.fillStyle = B.petal;
    ctx.fill(petals);
    ctx.strokeStyle = B.ink;
    ctx.lineWidth = 0.35;
    ctx.stroke(petals);
    ctx.fillStyle = B.centre;
    ctx.beginPath();
    ctx.arc(fx, fy, Math.max(0.8, R * 0.3), 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = B.ink;
    ctx.lineWidth = 0.35;
    ctx.stroke();
  }

  /** The species look for the plant that owns a node. Retired slots carry -1, hence the fallback. */
  private lookOf(n: number): Look {
    const plant = this.world.plants[this.world.pool.plantId[n]];
    return THEME.species[plant?.species ?? 1] ?? THEME.species[1];
  }
}

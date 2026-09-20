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

/** Health tint, so green -> yellow -> brown still reads as the plant's condition at a glance. */
function leafColor(t: Look['leaf'], health: number): string {
  const [a, b] = health > 0.5 ? [t.stressed, t.healthy] : [t.dying, t.stressed];
  const f = health > 0.5 ? (health - 0.5) * 2 : health * 2;
  const mix = (i: number) => Math.round(a[i] + (b[i] - a[i]) * f);
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`;
}

/** A point in a leaf's local frame — `u` along the leaf, `v` toward its upper side — in logical pixels. */
const at = (f: LeafFrame, u: number, v: number): [number, number] => [
  f.ox + f.ax * u + f.nx * v,
  f.oy + f.ay * u + f.ny * v,
];

export class PlantArt {
  /** Eased wilt per pool slot, so leaves droop and perk up smoothly instead of twitching every tick. */
  private readonly wilt: SlotEase;

  constructor(
    private readonly world: World,
    private readonly c: number,
  ) {
    this.wilt = new SlotEase(world.pool.capacity);
  }

  draw(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    this.drawRoots(ctx);
    this.drawStems(ctx);
    this.drawLeaves(ctx);
    this.drawFlowers(ctx);
    ctx.restore();
  }

  /**
   * Fine ink roots, drawn as smooth chains rather than segment by segment.
   *
   * The simulation's root path is genuinely angular — measured at a mean turn of 65 degrees per joint,
   * and up to 135 — so drawing each segment on its own rendered a root as bent wire, kinking at every
   * node. Running one Catmull-Rom through the whole chain, exactly as the stems do, carries the curve
   * THROUGH each node and rounds those corners into something that grew rather than something bent.
   *
   * Segments collect into one path per width band, so a root system costs a few strokes instead of one
   * per node, and the taper still reads.
   */
  private drawRoots(ctx: CanvasRenderingContext2D): void {
    const w = this.world;
    const P = w.pool;
    const c = this.c;
    const maxDepth = Math.max(1, w.cfg.raw.plant.growth.maxRootDepth);
    const hairs = new Path2D();
    // Half-pixel bands: finer than the eye separates on a ~1.8px line, coarse enough to batch.
    const bands = new Map<number, Path2D>();
    const bandFor = (width: number): Path2D => {
      const key = Math.max(1, Math.round(width * 2));
      let p = bands.get(key);
      if (!p) {
        p = new Path2D();
        bands.set(key, p);
      }
      return p;
    };

    const isRoot = (n: number): boolean => n >= 0 && P.alive[n] !== 0 && P.kind[n] === NodeKind.Root;

    // A chain starts where a root hangs off something that is not a root — the crown — and runs to a
    // tip. A fork starts another chain AT the fork, so a branch stays joined to what it grew from.
    const pending: number[][] = [];
    for (let n = 0; n < P.count; n++) {
      if (isRoot(n) && P.parent[n] >= 0 && !isRoot(P.parent[n])) pending.push([P.parent[n], n]);
    }
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
        const path = bandFor(1.8 - 1.2 * t);
        const x1 = P.x[n1] * c;
        const y1 = P.y[n1] * c;
        const x2 = P.x[n2] * c;
        const y2 = P.y[n2] * c;
        path.moveTo(x1, y1);
        path.bezierCurveTo(
          x1 + ((P.x[n2] - P.x[n0]) * c) / 6,
          y1 + ((P.y[n2] - P.y[n0]) * c) / 6,
          x2 - ((P.x[n3] - P.x[n1]) * c) / 6,
          y2 - ((P.y[n3] - P.y[n1]) * c) / 6,
          x2,
          y2,
        );
      }

      // Hairs at the tip only, following where the root was last heading. Short and curved: the
      // straight radiating version read as a rake head.
      if (last >= 1) {
        const a = chain[last - 1];
        const b = chain[last];
        const dx = (P.x[b] - P.x[a]) * c;
        const dy = (P.y[b] - P.y[a]) * c;
        const len = Math.hypot(dx, dy) || 1;
        const hx = dx / len;
        const hy = dy / len;
        const bx = P.x[b] * c;
        const by = P.y[b] * c;
        for (let k = 0; k < 3; k++) {
          const h = hash2(b, k + 20);
          const ang = (k - 1) * (0.5 + (h % 40) / 200);
          const ux = hx * Math.cos(ang) - hy * Math.sin(ang);
          const uy = hx * Math.sin(ang) + hy * Math.cos(ang);
          const l = c * (0.14 + ((h >> 8) % 10) / 100);
          hairs.moveTo(bx, by);
          hairs.quadraticCurveTo(
            bx + ux * l * 0.6 - uy * l * 0.2,
            by + uy * l * 0.6 + ux * l * 0.2,
            bx + ux * l,
            by + uy * l,
          );
        }
      }
    }

    ctx.strokeStyle = THEME.root;
    ctx.globalAlpha = 0.72;
    bands.forEach((path, key) => {
      ctx.lineWidth = key / 2;
      ctx.stroke(path);
    });
    ctx.globalAlpha = 1;
    ctx.strokeStyle = THEME.rootHair;
    ctx.lineWidth = 0.55;
    ctx.stroke(hairs);
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

  /** Every leaf, in its species' shape, drooping by its own eased wilt. */
  private drawLeaves(ctx: CanvasRenderingContext2D): void {
    const w = this.world;
    const P = w.pool;
    const c = this.c;
    const visibleAt = w.cfg.raw.pests.visibleAt;

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
      const side = P.x[n] < P.x[host] ? -LEAF_REACH : LEAF_REACH;
      const tilt = leafTilt(P.x[host], P.y[host], rank) * LEAF_FAN + rank * LEAF_RANK_STEP;
      const f = leafFrame(
        P.x[host] * c,
        P.y[host] * c,
        (P.x[host] + side) * c,
        P.y[host] * c,
        hang,
        tilt,
      );
      const look = THEME.species[plant.species] ?? THEME.species[1];
      const grow = openness(P.spawnTick[n], w.tickCount, 60);
      const fill = leafColor(look.leaf, P.health[n]);

      if (look.shape === 'frond') this.frond(ctx, f, look, grow, thirst, fill);
      else if (look.shape === 'paddle') this.paddle(ctx, f, look, grow, thirst, fill);
      else this.ovate(ctx, f, look, grow, thirst, fill);

      if (P.pests[n] >= visibleAt) this.pests(ctx, f, look.length * grow, n, (P.pests[n] - visibleAt) / (1 - visibleAt));
    }
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
  private blade(ctx: CanvasRenderingContext2D, f: LeafFrame, profile: readonly [number, number][], fill: string): void {
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
  private ovate(ctx: CanvasRenderingContext2D, f: LeafFrame, look: Look, grow: number, droop: number, fill: string): void {
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
  private paddle(ctx: CanvasRenderingContext2D, f: LeafFrame, look: Look, grow: number, droop: number, fill: string): void {
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
  private frond(ctx: CanvasRenderingContext2D, f: LeafFrame, look: Look, grow: number, droop: number, fill: string): void {
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
   * Flowers: a short stalk from the stem, then five petals around a centre. The existing 90-tick
   * `openness` now unfolds the petals outward rather than growing a dot.
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

      const R = c * 0.42 * open;
      const spin = (hash2(n, 1) % 10) * 0.03;
      const petals = new Path2D();
      for (let k = 0; k < 5; k++) {
        const ang = (k / 5) * Math.PI * 2 - Math.PI / 2 + spin;
        const cx = fx + Math.cos(ang) * R * 0.55;
        const cy = fy + Math.sin(ang) * R * 0.55;
        const rx = R * 0.5;
        petals.moveTo(cx + Math.cos(ang) * rx, cy + Math.sin(ang) * rx);
        petals.ellipse(cx, cy, rx, R * 0.3 * (0.5 + 0.5 * open), ang, 0, Math.PI * 2);
      }
      ctx.fillStyle = THEME.flower;
      ctx.fill(petals);
      ctx.strokeStyle = THEME.plantInk;
      ctx.lineWidth = 0.5;
      ctx.stroke(petals);
      ctx.fillStyle = THEME.flowerCentre;
      ctx.beginPath();
      ctx.arc(fx, fy, Math.max(0.8, R * 0.24), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** The species look for the plant that owns a node. Retired slots carry -1, hence the fallback. */
  private lookOf(n: number): Look {
    const plant = this.world.plants[this.world.pool.plantId[n]];
    return THEME.species[plant?.species ?? 1] ?? THEME.species[1];
  }
}

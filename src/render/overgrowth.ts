// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The overgrowth: what a FINISHED jar looks like.
 *
 * Owns everything the climax adds to the picture — vines framing the glass, tendrils curling off their
 * tips, moss climbing the walls, the green cast of the air and the motes drifting in it. This was
 * called `vines.ts` while it only drew vines; it draws the whole finished-jar look now, and a file
 * named for one of the five things inside it is how a codebase stops being readable.
 *
 * Purely presentational. Nothing here is known to the simulation — no carbon, no water, no nodes —
 * which is deliberate and is what makes it safe. A sealed jar is a closed carbon loop, so real vines
 * would have to take their mass from the plants already standing, and the jar would look LESS overgrown
 * for having them. The sim decides WHEN a jar is finished; this decides what finished looks like.
 *
 * Progress is eased locally rather than stored in the sim, so `src/sim` keeps knowing nothing about
 * presentation. The trade is that the overgrowth grows in from nothing on a reload rather than resuming
 * mid-creep, which is the right way round: the ending re-announces itself instead of just being there.
 *
 * TWO LAYOUT RULES, both learned by looking at the thing rather than by reasoning about it:
 *
 *  - Everything lives in the AIR SPACE. An early version ran strands around the whole inner frame and
 *    half of them came out buried in gravel, which is the one place a climbing plant cannot be.
 *  - Growth belongs at the EDGES. A curtain across the full width of the lid buried the planting the
 *    player spent the whole game growing, which is exactly backwards: the overgrowth should frame the
 *    jar, not hide it.
 */

import { THEME } from '../theme.js';
import { hash2 } from './plate.js';

/** Real seconds for the overgrowth to reach full extent. Slow: this creeps, it does not drop. */
const GROW_SECONDS = 16;
/** Faster coming back than going out — a release answers a player action and should read at once. */
const RECEDE_SECONDS = 3;
/**
 * Motes drifting in the air of a finished jar.
 *
 * A fixed field, NOT the renderer's `Fx` list. `Renderer.spawn` refuses past `THEME.maxEffects` (96),
 * so a continuous stream of these would quietly starve droplets, leaf-fall and every other real event
 * the jar needs to report. A fixed size also means no allocation per frame.
 */
const MOTE_COUNT = 25;

/*
 * NOTE ON `>>>`: every shift of a `hash2` value in this file is UNSIGNED, and must stay that way.
 *
 * `hash2` ends in `>>> 0`, so it returns up to 4.29e9 — but `>>` coerces to int32 first, which makes
 * any hash above 2^31 come out NEGATIVE. That produced a negative mote radius, `arc()` threw, and the
 * throw escaped the animation loop and killed it: the whole jar froze after two frames over a
 * one-character mistake.
 */

/** Divisor for the moss scratch layer. The wash carries no detail, so it is composed small. */
const LAYER_SCALE = 4;

/** How far the moss rises from the ground at the JAR'S EDGES, in cells, at full cover. */
const MOSS_CLIMB = 9;
/**
 * Share of the edge strength the CENTRE of the jar keeps, in HEIGHT.
 *
 * Not zero: the rise spans the whole jar and simply thins toward the middle, so the centre is the
 * lightest part of one continuous gradient rather than a gap between two separate patches.
 */
const MOSS_CENTRE = 0.22;

/**
 * How much of the moss's OPACITY is erased at the centre of the jar, 0..1.
 *
 * Height alone was not enough. With one path and one vertical gradient the green is equally strong at
 * the base everywhere — the middle is merely shorter, not fainter — and the ask was for the centre to
 * be the most transparent part. A canvas fill takes a single gradient, so strength cannot vary in two
 * axes in one pass; this is applied as a separate erase. See `drawMossRise`.
 */
const MOSS_CENTRE_FADE = 0.84;

interface Strand {
  /** Cells along the lid for a hanger; cells in from the wall for a climber. */
  at: number;
  /** How far it runs at full growth, in cells. */
  reach: number;
  side: -1 | 1;
  kind: 'hang' | 'climb';
  seed: number;
}

interface Mote {
  /** Unit space, 0..1 across the jar, so the field is independent of the canvas size. */
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
}

export class Overgrowth {
  /** 0 = none, 1 = fully grown. Eased toward the phase's target every frame. */
  private progress = 0;
  private readonly strands: Strand[] = [];
  private readonly motes: Mote[] = [];
  /**
   * Scratch layer for the moss, so its opacity can fall off HORIZONTALLY as well as vertically.
   *
   * The moss is composed here and stamped onto the jar in one go. Doing the horizontal fade directly
   * on the main context is not an option: `destination-out` erases whatever is already under it, which
   * would punch a hole through the soil and the plants rather than through the moss.
   */
  private readonly layer: HTMLCanvasElement;
  private readonly layerCtx: CanvasRenderingContext2D;

  constructor(
    private readonly gw: number,
    gh: number,
    private readonly c: number,
  ) {
    // Deterministic from the jar's size alone, so a given jar's overgrowth is the same every time it
    // finishes rather than reshuffling on each visit.

    // Climbers down both walls: the backbone of the frame, and the longest thing here.
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 4; i++) {
        const h = hash2(i, side === -1 ? 613 : 811);
        this.strands.push({
          at: 0.9 + ((h % 7) / 7) * 2.2,
          reach: gh * (0.4 + ((h >>> 6) % 15) * 0.018),
          side,
          kind: 'climb',
          seed: h,
        });
      }
    }
    // Short hangers, kept INSIDE the corners so the middle of the lid stays clear.
    const corner = Math.min(9, Math.round(gw * 0.16));
    for (const side of [-1, 1] as const) {
      for (let i = 0; i < 4; i++) {
        const h = hash2(i, side === -1 ? 421 : 977);
        const into = 1.6 + (i / 4) * corner + (h % 5) / 5;
        this.strands.push({
          at: side === -1 ? into : gw - into,
          reach: gh * (0.1 + ((h >>> 4) % 13) * 0.012),
          side,
          kind: 'hang',
          seed: h,
        });
      }
    }

    /*
     * QUARTER resolution, and that is a performance fix, not a shortcut.
     *
     * The moss is a soft wash with no detail worth a full-size buffer, and compositing it at full
     * resolution with `ctx.filter = blur(...)` to feather its edges cost more than half the frame
     * rate: measured at 22 fps against 48 with the blur removed. Drawing it small and letting the
     * upscale do the smoothing gives the same soft edge, costs a sixteenth of the fill, and needs no
     * filter at all.
     */
    this.layer = document.createElement('canvas');
    this.layer.width = Math.max(1, Math.round((gw * c) / LAYER_SCALE));
    this.layer.height = Math.max(1, Math.round((gh * c) / LAYER_SCALE));
    const lctx = this.layer.getContext('2d');
    if (!lctx) throw new Error('2D canvas context unavailable for the overgrowth layer');
    this.layerCtx = lctx;

    for (let i = 0; i < MOTE_COUNT; i++) {
      const h = hash2(i, 5501);
      this.motes.push({
        x: (h % 1000) / 1000,
        y: ((h >>> 10) % 1000) / 1000,
        // Slow drift, mostly sideways with a faint rise — dust hanging in still air, not falling snow.
        vx: (((h >>> 3) % 100) / 100 - 0.5) * 0.012,
        vy: -0.004 - (((h >>> 7) % 50) / 50) * 0.006,
        r: 0.9 + (((h >>> 13) % 100) / 100) * 1.5,
      });
    }
  }

  /** Ease toward the phase's target, and drift the motes. `dt` is REAL seconds. */
  update(climax: boolean, dt: number): void {
    const target = climax ? 1 : 0;
    const rate = dt / (climax ? GROW_SECONDS : RECEDE_SECONDS);
    if (this.progress < target) this.progress = Math.min(target, this.progress + rate);
    else if (this.progress > target) this.progress = Math.max(target, this.progress - rate);

    if (this.progress <= 0.001) return;
    for (const m of this.motes) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      // Wrap in unit space, so the field never empties however long a jar sits finished.
      if (m.x < -0.02) m.x = 1.02;
      if (m.x > 1.02) m.x = -0.02;
      if (m.y < -0.02) m.y = 1.02;
    }
  }

  get grown(): number {
    return this.progress;
  }

  /**
   * The vines, tendrils and glass moss. Drawn in front of the plants, inside the vessel clip.
   *
   * @param surfaceAt Soil height in cells at a given column — the lowest anything there may reach.
   *                  Per COLUMN rather than one jar-wide figure, because a jar's terrain is uneven: a
   *                  single "highest surface" left the wall moss floating in mid-air above a low
   *                  corner, and stopped the wall vines short of ground they should have reached.
   * @param mossCover Mean moss coverage in the jar, 0..1. The moss climbing the glass scales with what
   *                  the jar ACTUALLY grew, so a jar that was never mossed gets none of it.
   */
  draw(ctx: CanvasRenderingContext2D, surfaceAt: (xCell: number) => number, mossCover: number): void {
    if (this.progress <= 0.001) return;
    const c = this.c;
    const vine = THEME.vine;
    const [lr, lg, lb] = vine.leaf;
    const fill = `rgb(${lr}, ${lg}, ${lb})`;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    this.drawMossRise(ctx, surfaceAt, mossCover);

    for (const s of this.strands) {
      // Staggered starts, so the overgrowth arrives as a spread rather than one synchronised sweep.
      const lag = ((s.seed >>> 3) % 45) / 100;
      const p = Math.min(1, Math.max(0, (this.progress - lag) / (1 - lag)));
      if (p <= 0) continue;

      const steps = 18;
      const pts: [number, number][] = [];
      for (let k = 0; k <= steps; k++) {
        const f = k / steps;
        let gx: number;
        let gy: number;
        if (s.kind === 'hang') {
          // Falls from the lid, wandering as it goes. A vine never hangs plumb.
          gx = s.at + Math.sin(f * 4.5 + (s.seed % 6)) * 1.1 * f + s.side * f * 0.5;
          gy = 0.7 + s.reach * p * f;
        } else {
          const wallX = s.side === -1 ? s.at : this.gw - s.at;
          // Bows off the wall and meanders on the way down, rather than ruling a straight line.
          const bow = Math.sin(Math.PI * f) * 1.5 * p;
          const wander = Math.sin(f * 6.5 + (s.seed % 5)) * 0.5;
          gx = wallX + -s.side * (bow + wander);
          gy = 0.7 + s.reach * p * f;
        }
        if (gy > surfaceAt(Math.round(gx))) break;
        pts.push([gx * c, gy * c]);
      }
      if (pts.length < 3) continue;

      // Stem, tapering toward the tip the way a real runner thins as it extends.
      ctx.strokeStyle = vine.stem;
      ctx.globalAlpha = 0.92;
      const base = s.kind === 'climb' ? 2.1 : 1.5;
      for (let k = 1; k < pts.length; k++) {
        const t = k / pts.length;
        ctx.lineWidth = base * (1 - 0.5 * t);
        ctx.beginPath();
        ctx.moveTo(pts[k - 1][0], pts[k - 1][1]);
        ctx.lineTo(pts[k][0], pts[k][1]);
        ctx.stroke();
      }

      /*
       * Leaves: ALTERNATING and widely spaced, which is the whole difference between a vine and a fern.
       *
       * The version this replaces put a PAIR of blades at EVERY step — opposite leaflets packed along a
       * rachis, which is the botanical signature of a pinnate frond, and is most of why the overgrowth
       * read as more ferns arriving. One blade per node, every third node, on alternating sides, with
       * bare stem showing between them, reads as a creeper instead.
       */
      for (let k = 2; k < pts.length; k += 3) {
        const [x, y] = pts[k];
        const [px, py] = pts[k - 1];
        const dx = x - px;
        const dy = y - py;
        const len = Math.hypot(dx, dy) || 1;
        const open = Math.min(1, Math.max(0, p * 1.5 - k / (pts.length + 2)));
        if (open <= 0) continue;

        const h = hash2(s.seed, k);
        const side = (k / 3) % 2 === 0 ? 1 : -1;
        const nx = (-dy / len) * side;
        const ny = (dx / len) * side;
        const rr = c * (0.22 + (h % 9) * 0.011) * open;

        // A short petiole, then the blade — so a leaf stands off the stem instead of being stuck to it.
        const stalk = rr * 0.55;
        const bx = x + nx * stalk;
        const by = y + ny * stalk;
        ctx.strokeStyle = vine.stem;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(bx, by);
        ctx.stroke();

        this.heartLeaf(ctx, bx, by, rr, Math.atan2(ny + 0.4, nx), fill);

        // An occasional bloom, so the green mass does not read as one flat colour.
        if ((h >>> 6) % 7 === 0 && open > 0.7) {
          ctx.fillStyle = THEME.flower;
          ctx.globalAlpha = 0.9;
          ctx.beginPath();
          ctx.arc(x - nx * rr * 0.3, y - ny * rr * 0.3, c * 0.09, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 0.92;
        }
      }

      // A curling tendril off the tip. Ferns never do this, so it is the strongest single cue that
      // what is growing here is a vine.
      this.tendril(ctx, pts[pts.length - 1], pts[pts.length - 2], p, s.seed);
    }

    ctx.restore();
  }

  /** A heart-shaped blade: two lobes at the base narrowing to a point. Ivy, not frond. */
  private heartLeaf(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    angle: number,
    fill: string,
  ): void {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    // Local (u along the leaf, v across it) -> canvas.
    const ax = (u: number, v: number): number => x + u * cos - v * sin;
    const ay = (u: number, v: number): number => y + u * sin + v * cos;
    const p = new Path2D();
    p.moveTo(ax(0, 0), ay(0, 0));
    // Out along one side to the tip, then back along the other, leaving the notch at the base.
    p.bezierCurveTo(
      ax(r * 0.15, -r * 0.85), ay(r * 0.15, -r * 0.85),
      ax(r * 1.05, -r * 0.5), ay(r * 1.05, -r * 0.5),
      ax(r * 1.45, 0), ay(r * 1.45, 0),
    );
    p.bezierCurveTo(
      ax(r * 1.05, r * 0.5), ay(r * 1.05, r * 0.5),
      ax(r * 0.15, r * 0.85), ay(r * 0.15, r * 0.85),
      ax(0, 0), ay(0, 0),
    );
    p.closePath();
    ctx.fillStyle = fill;
    ctx.globalAlpha = 0.93;
    ctx.fill(p);
    ctx.strokeStyle = THEME.plantInk;
    ctx.lineWidth = 0.55;
    ctx.stroke(p);
  }

  /** A spiral off the growing tip, opening as the strand finishes. */
  private tendril(
    ctx: CanvasRenderingContext2D,
    tip: [number, number],
    prev: [number, number],
    p: number,
    seed: number,
  ): void {
    if (p < 0.55) return;
    const t = Math.min(1, (p - 0.55) / 0.45);
    const dx = tip[0] - prev[0];
    const dy = tip[1] - prev[1];
    const len = Math.hypot(dx, dy) || 1;
    let ang = Math.atan2(dy, dx);
    const dir = (seed & 1) === 0 ? 1 : -1;
    let x = tip[0];
    let y = tip[1];
    let step = len * 0.55;

    ctx.strokeStyle = THEME.vine.stem;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);
    const turns = Math.round(9 * t);
    for (let k = 0; k < turns; k++) {
      ang += dir * 0.62;
      // Tightening is what makes it read as a curl rather than as an arc.
      step *= 0.86;
      x += Math.cos(ang) * step;
      y += Math.sin(ang) * step;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 0.92;
  }

  /**
   * Moss rising from the ground, ACROSS THE WHOLE JAR, fading as it climbs.
   *
   * One continuous gradient, not two patches at the walls, and strongest in three ways at once:
   *
   *  - VERTICALLY it is densest at the soil and fades out as it rises, so it reads as growth coming up
   *    off the ground rather than as a tint hanging in the air.
   *  - HORIZONTALLY it is strongest at the two edges and most transparent through the middle, so the
   *    jar looks grown-in at its corners and open where the planting is.
   *  - Its HEIGHT follows the same curve, tallest at the edges and lowest at the centre.
   *
   * Composed on a scratch layer, because those first two cannot be done in one pass: a canvas fill
   * takes exactly one gradient, so the shape is filled with the vertical one and the horizontal
   * falloff is then ERASED out of it with `destination-out`. That erase has to happen on its own layer
   * — run against the main context it would punch through the soil and the plants underneath instead.
   *
   * ONE PATH, never a rect per column. Per-column rects cannot be made seamless with transparency:
   * butted together they leave antialiasing hairlines, and overlapped even half a pixel they DOUBLE
   * the alpha along every boundary, which rendered the jar as a picket fence of bright vertical lines.
   *
   * The bottom edge follows the real soil height column by column, so the rise sits on a slope instead
   * of floating above the low side of it.
   */
  private drawMossRise(
    ctx: CanvasRenderingContext2D,
    surfaceAt: (xCell: number) => number,
    mossCover: number,
  ): void {
    if (mossCover <= 0.02) return;
    const c = this.c;
    const [mr, mg, mb] = THEME.moss;
    const strength = Math.min(1, mossCover / 0.5) * this.progress;
    if (strength <= 0.02) return;

    const lo = 1;
    const hi = this.gw - 2;
    /** 1 at either edge, 0 dead centre. Squared so the middle stays open and the corners do the work. */
    const weightAt = (x: number): number => {
      const t = (x - lo) / Math.max(1, hi - lo);
      const edge = Math.abs(t - 0.5) * 2;
      return MOSS_CENTRE + (1 - MOSS_CENTRE) * edge * edge;
    };
    /** Smooth undulation along the jar — never per-column random, which reads as jitter. */
    const climbAt = (x: number): number =>
      MOSS_CLIMB *
      weightAt(x) *
      (0.86 + 0.1 * Math.sin(x * 0.34) + 0.07 * Math.sin(x * 0.13 + 2.1)) *
      strength;

    let deepest = 0;
    let highest = Number.POSITIVE_INFINITY;
    for (let x = lo; x <= hi; x++) {
      const b = surfaceAt(x) * c;
      if (b > deepest) deepest = b;
      const t = b - climbAt(x) * c;
      if (t < highest) highest = t;
    }
    if (!(deepest > highest)) return;

    const L = this.layerCtx;
    const W = this.layer.width;
    const H = this.layer.height;
    // Draw in LOGICAL coordinates; the transform maps them into the small buffer.
    L.setTransform(1 / LAYER_SCALE, 0, 0, 1 / LAYER_SCALE, 0, 0);
    L.clearRect(0, 0, W * LAYER_SCALE, H * LAYER_SCALE);
    L.globalCompositeOperation = 'source-over';

    // --- the rise itself, dense at the soil and fading upward ---------------------------------
    const path = new Path2D();
    path.moveTo(lo * c, surfaceAt(lo) * c);
    for (let x = lo; x <= hi; x++) path.lineTo((x + 1) * c, surfaceAt(x) * c);
    for (let x = hi; x >= lo; x--) path.lineTo(x * c, surfaceAt(x) * c - climbAt(x) * c);
    path.closePath();

    /*
     * BLURRED, and that is a fix rather than a flourish.
     *
     * The gradient runs from the jar's lowest soil to its highest top, but each column's shape ends at
     * ITS OWN top — which for every column except the tallest is well short of that. So only the
     * tallest column faded to nothing and all the others were cut off mid-fade at whatever alpha the
     * shared gradient happened to be at, which read as the moss stopping dead along a hard line.
     *
     * A per-column fade cannot fix it: a canvas fill takes one gradient, and that gradient is already
     * spent on the vertical axis. Feathering the whole shape instead softens every column's top edge
     * regardless of where it happens to end, and costs one property.
     *
     * Safe to bleed: this layer is stamped inside the vessel clip, so nothing escapes the glass, and
     * spreading a little DOWN over the soil is what moss on the ground should do anyway.
     */
    const a = 0.85 * strength;
    const grad = L.createLinearGradient(0, deepest, 0, highest);
    grad.addColorStop(0, `rgba(${mr}, ${mg}, ${mb}, ${a.toFixed(3)})`);
    grad.addColorStop(0.45, `rgba(${mr}, ${mg}, ${mb}, ${(a * 0.4).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${mr}, ${mg}, ${mb}, 0)`);
    L.fillStyle = grad;
    L.fill(path);

    // --- splotches: soft, round, their own greens. Round shapes cannot stripe. -----------------
    L.save();
    L.clip(path);
    // Softened as well, or crisp discs would sit on the feathered wash and give back the hard edge.
    const blobs = 42;
    for (let k = 0; k < blobs; k++) {
      const h = hash2(k, 6151);
      const x = lo + ((h % 1000) / 1000) * (hi - lo);
      const climb = climbAt(x);
      if (climb <= 0.2) continue;
      // Squared so splotches crowd toward the ground, where the moss is thickest.
      const f = ((h >>> 10) % 1000) / 1000;
      const cy = surfaceAt(Math.round(x)) * c - climb * c * f * f;
      const rr = c * (0.22 + ((h >>> 20) % 11) * 0.055);
      const alpha = 0.42 * strength * (1 - f * 0.75);
      if (alpha <= 0.015 || rr <= 0.5) continue;
      const tone = ((h >>> 5) % 21) / 10 - 1;
      L.fillStyle = `rgba(${Math.round(mr + tone * 9)}, ${Math.round(mg + tone * 13)}, ${Math.round(mb + tone * 6)}, ${alpha.toFixed(3)})`;
      L.beginPath();
      L.ellipse(x * c, cy, rr * 1.45, rr, 0, 0, Math.PI * 2);
      L.fill();
    }
    L.restore();

    // --- erase the middle, so the edges are the strongest green and the centre the faintest ----
    const fade = L.createLinearGradient(0, 0, W * LAYER_SCALE, 0);
    fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fade.addColorStop(0.5, `rgba(0, 0, 0, ${MOSS_CENTRE_FADE})`);
    fade.addColorStop(1, 'rgba(0, 0, 0, 0)');
    L.globalCompositeOperation = 'destination-out';
    L.fillStyle = fade;
    L.fillRect(0, 0, W * LAYER_SCALE, H * LAYER_SCALE);
    L.globalCompositeOperation = 'source-over';

    ctx.globalAlpha = 1;
    // Upscaled from the small buffer. The bilinear smoothing IS the feathering.
    ctx.drawImage(this.layer, 0, 0, this.layer.width * LAYER_SCALE, this.layer.height * LAYER_SCALE);
    ctx.globalAlpha = 0.92;
  }

  /**
   * The green cast of a finished jar's air, and the motes drifting in it.
   *
   * Separate from `draw` because this is a WASH over the whole interior, and has to land alongside the
   * fog and the time-of-day tint — after the plants and the effects — rather than in among the foliage.
   */
  drawAir(ctx: CanvasRenderingContext2D, w: number, h: number): void {
    if (this.progress <= 0.001) return;
    // Deliberately faint. This is a cast on the air, and the jar still has to read as a jar.
    ctx.globalAlpha = this.progress * 0.13;
    ctx.fillStyle = THEME.vine.air;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = THEME.vine.mote;
    for (const m of this.motes) {
      ctx.globalAlpha = this.progress * (0.16 + m.r * 0.1);
      ctx.beginPath();
      ctx.arc(m.x * w, m.y * h, m.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

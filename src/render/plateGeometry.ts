// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The plate's geometry, kept free of any browser API so the test suite can run it under Node.
 *
 * Everything here answers one question the first version of the plate got wrong: WHAT COUNTS AS
 * GROUND? It used `surfaceOfColumn` — the topmost solid cell — and treated everything beneath it as
 * soil. That is only true once the jar has come to rest. Three bugs came straight out of it:
 *
 *  - A grain falling through an empty column became "the surface", so the air beneath it was
 *    painted and grained as soil: a grey smear under every dropped particle.
 *  - A lone grain above the pile was joined into the smooth surface line, so ink ran diagonally
 *    from it down to its neighbours, as if the grains were connected.
 *  - Layer boundaries were paired by count down each column ("the first change joins the first
 *    change"). A gravel patch on the soil shifts that count, so its boundary was joined to the
 *    neighbours' soil/charcoal boundary far below — a line cutting through the soil.
 *
 * The rules now: ground is the unbroken solid span that rests on the glass; anything with air beneath
 * it is loose and drawn on its own; the surface slopes down into any empty neighbouring column the way
 * a real pile would, rather than dropping off in a straight vertical line; and boundaries only join
 * across columns when they are the same pair of materials at a similar depth.
 */

import { Substrate } from '../sim/config/content.js';
import type { SubstrateGrid } from '../sim/grid.js';

export type Point = readonly [number, number];

/** How far apart in depth, in cells, two boundaries in neighbouring columns can be and still join. */
export const CLIFF_CELLS = 2;

export const isSolid = (id: number): boolean => id !== Substrate.Air && id !== Substrate.Glass;

/** The row just below a column's lowest open cell — its floor — which is higher where the base curves. */
export function floorRow(g: SubstrateGrid, x: number): number {
  let y = g.h - 2;
  while (y >= 1 && g.substrate[g.idx(x, y)] === Substrate.Glass) y--;
  return y + 1;
}

/**
 * Per column, the top row of the GROUND: the unbroken solid span that rests on the glass floor.
 * -1 when the column has none — it is empty, or everything in it has air underneath.
 */
export function groundTops(g: SubstrateGrid): Int32Array {
  const tops = new Int32Array(g.w).fill(-1);
  for (let x = 1; x <= g.w - 2; x++) {
    let y = floorRow(g, x) - 1;
    if (y < 1 || !isSolid(g.substrate[g.idx(x, y)])) continue; // air on the floor: no ground here
    while (y - 1 >= 1 && isSolid(g.substrate[g.idx(x, y - 1)])) y--;
    tops[x] = y;
  }
  return tops;
}

/** Solid cells that are not ground: falling grains, and anything else with air beneath it. */
export function looseCells(g: SubstrateGrid, tops: Int32Array): number[] {
  const out: number[] = [];
  for (let x = 1; x <= g.w - 2; x++) {
    const limit = tops[x] < 0 ? g.h - 1 : tops[x];
    for (let y = 1; y < limit; y++) {
      const i = g.idx(x, y);
      if (isSolid(g.substrate[i])) out.push(i);
    }
  }
  return out;
}

/**
 * The ground's surface line: one point list per run of neighbouring columns that have ground, in
 * logical pixels, with one point on top of every column.
 *
 * Where a run meets an empty column, the line carries on to that column's centre at FLOOR level, so a
 * pile slopes down into the gap like a real heap of material. A lone grain on the floor therefore
 * reads as a small mound rather than a box with straight sides. At the jar wall the line simply meets
 * the glass at the same height. Heights inside a run are never broken up: a tall column standing on the
 * pile is joined to its neighbours as a slope, not a cliff.
 */
export function surfaceRuns(g: SubstrateGrid, tops: Int32Array, c: number): Point[][] {
  const runs: Point[][] = [];
  let x = 1;
  while (x <= g.w - 2) {
    if (tops[x] < 0) {
      x++;
      continue;
    }
    const start = x;
    const pts: Point[] = [];
    while (x <= g.w - 2 && tops[x] >= 0) {
      pts.push([(x + 0.5) * c, tops[x] * c]);
      x++;
    }
    const end = x - 1;
    const left: Point = start === 1 ? [c, pts[0][1]] : [(start - 0.5) * c, floorRow(g, start - 1) * c];
    const right: Point =
      end === g.w - 2 ? [(g.w - 1) * c, pts[pts.length - 1][1]] : [(end + 1.5) * c, floorRow(g, end + 1) * c];
    runs.push([left, ...pts, right]);
  }
  return runs;
}

/**
 * Ink lines between layers, as smooth-line point lists.
 *
 * Each boundary is identified by the PAIR of materials meeting there. A boundary in one column only
 * continues a line from the previous column if that line is the same pair at a similar depth, which
 * is what keeps a gravel patch's edge to the patch instead of dragging it down through the soil.
 */
export function boundaries(g: SubstrateGrid, tops: Int32Array, c: number): Point[][] {
  interface Open {
    key: number;
    y: number;
    chain: Point[];
  }
  const done: Point[][] = [];
  let open: Open[] = [];

  for (let x = 1; x <= g.w - 2; x++) {
    const here: { key: number; y: number }[] = [];
    if (tops[x] >= 0) {
      for (let y = tops[x]; y + 1 <= g.h - 2; y++) {
        const a = g.substrate[g.idx(x, y)];
        const b = g.substrate[g.idx(x, y + 1)];
        if (a !== b && isSolid(a) && isSolid(b)) here.push({ key: a * 8 + b, y: (y + 1) * c });
      }
    }

    const next: Open[] = [];
    const taken = new Set<number>();
    for (const bnd of here) {
      let best = -1;
      let bestDy = Infinity;
      open.forEach((o, j) => {
        if (taken.has(j) || o.key !== bnd.key) return;
        const dy = Math.abs(o.y - bnd.y);
        if (dy <= CLIFF_CELLS * c && dy < bestDy) {
          best = j;
          bestDy = dy;
        }
      });
      let chain: Point[];
      if (best >= 0) {
        taken.add(best);
        chain = open[best].chain;
        chain.push([(x + 0.5) * c, bnd.y]);
      } else {
        chain = [
          [x * c, bnd.y],
          [(x + 0.5) * c, bnd.y],
        ];
        done.push(chain);
      }
      next.push({ key: bnd.key, y: bnd.y, chain });
    }
    // Lines that did not continue into this column end at its left edge.
    open.forEach((o, j) => {
      if (!taken.has(j)) o.chain.push([x * c, o.y]);
    });
    open = next;
  }
  for (const o of open) o.chain.push([(g.w - 1) * c, o.y]);
  return done;
}

/**
 * Moss cover sampled at each point of a surface run, so moss can be laid ALONG the curve instead of as
 * a flat band on top of each cell.
 *
 * Interior points read the cover of their column's ground-top cell. The two end points carry on the
 * cover of the column beside them, which is what lets moss follow a mound's slope down to the floor
 * rather than stopping where the column ends. Only the TOP cell counts: moss that has been buried under
 * newly added material is not drawn through it.
 */
export function mossAlong(
  g: SubstrateGrid,
  tops: Int32Array,
  cover: ArrayLike<number>,
  run: readonly Point[],
  c: number,
): number[] {
  const last = run.length - 1;
  const vals = run.map(([x], k) => {
    if (k === 0 || k === last) return 0;
    const col = Math.round(x / c - 0.5);
    return tops[col] >= 0 ? cover[g.idx(col, tops[col])] : 0;
  });
  if (last >= 2) {
    vals[0] = vals[1];
    vals[last] = vals[last - 1];
  }
  return vals;
}

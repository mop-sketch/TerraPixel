// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The plate's geometry: what counts as ground, where the surface line runs, how layer boundaries join,
 * and how moss follows the surface. One test per problem a player reported, plus the slopes that
 * replaced straight vertical edges.
 *
 * Runs under Node because plateGeometry.ts deliberately uses no browser API.
 */

import { describe, expect, it } from 'vitest';
import { cloneBalance } from '../src/sim/config/balance.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';
import {
  CLIFF_CELLS,
  boundaries,
  floorRow,
  groundTops,
  looseCells,
  mossAlong,
  surfaceRuns,
  type Point,
} from '../src/render/plateGeometry.js';

const C = 12;

function emptyJar(): World {
  return new World(cloneBalance());
}

function laidJar(): World {
  const w = new World(cloneBalance());
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  let n = 0;
  do {
    tick(w);
    n++;
  } while (w.substrateDirty && n < 4000);
  return w;
}

function place(w: World, cells: [number, number, number][]): void {
  const g = w.grid;
  for (const [x, y, id] of cells) g.substrate[g.idx(x, y)] = id;
  g.reindex();
}

/** The largest vertical step between consecutive points of any line. */
const worstStep = (lines: Point[][]): number => {
  let worst = 0;
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) worst = Math.max(worst, Math.abs(line[k][1] - line[k - 1][1]));
  }
  return worst;
};

describe('plate geometry', () => {
  it('treats a grain falling through an empty column as loose, not as ground', () => {
    // The grey smear: this grain used to become "the surface", and the air under it was painted as soil.
    const w = emptyJar();
    place(w, [[30, 6, Substrate.Gravel]]);
    const tops = groundTops(w.grid);

    expect(tops[30]).toBe(-1);
    expect(looseCells(w.grid, tops)).toContain(w.grid.idx(30, 6));
    expect(surfaceRuns(w.grid, tops, C)).toHaveLength(0);
  });

  it('never joins a lone grain above the pile into the surface line', () => {
    // The phantom connection: ink used to run from the grain diagonally down to its neighbours.
    const w = laidJar();
    const before = groundTops(w.grid)[30];
    const grainY = before - 9;
    place(w, [[30, grainY, Substrate.Soil]]);
    const tops = groundTops(w.grid);

    expect(tops[30]).toBe(before);
    expect(looseCells(w.grid, tops)).toContain(w.grid.idx(30, grainY));
    for (const run of surfaceRuns(w.grid, tops, C)) for (const [, y] of run) expect(y).not.toBe(grainY * C);
  });

  it('keeps a gravel patch boundary to the patch instead of cutting through the soil', () => {
    // The strange line: boundaries used to be paired by count, so the patch shifted every pairing.
    const w = laidJar();
    const top = groundTops(w.grid)[23];
    const patch: [number, number, number][] = [];
    for (let x = 20; x <= 26; x++) patch.push([x, top - 1, Substrate.Gravel], [x, top - 2, Substrate.Gravel]);
    place(w, patch);
    const lines = boundaries(w.grid, groundTops(w.grid), C);

    // No boundary line may jump in depth between neighbouring columns.
    expect(worstStep(lines)).toBeLessThanOrEqual(CLIFF_CELLS * C);

    // The patch's own gravel/soil line stays within the patch's columns...
    const patchLine = lines.find((l) => l.some(([, y]) => y === top * C));
    expect(patchLine).toBeDefined();
    for (const [x] of patchLine!) {
      expect(x).toBeGreaterThanOrEqual(20 * C);
      expect(x).toBeLessThanOrEqual(27 * C);
    }
    // ...while the soil/charcoal line still runs across the jar in one piece.
    const spans = lines.map((l) => [Math.min(...l.map(([x]) => x)), Math.max(...l.map(([x]) => x))]);
    expect(spans.some(([a, b]) => a <= 8 * C && b >= (w.grid.w - 8) * C)).toBe(true);
  });

  it('slopes a lone landed grain down to the floor on both sides, like a small mound', () => {
    // No straight vertical sides: the line runs from the empty neighbour's floor, over the grain, and
    // back down to the other neighbour's floor.
    const w = emptyJar();
    const floor = floorRow(w.grid, 30);
    place(w, [[30, floor - 1, Substrate.Gravel]]);
    const runs = surfaceRuns(w.grid, groundTops(w.grid), C);

    expect(runs).toHaveLength(1);
    const run = runs[0];
    expect(run[0]).toEqual([29.5 * C, floorRow(w.grid, 29) * C]);
    expect(run).toContainEqual([30.5 * C, (floor - 1) * C]);
    expect(run[run.length - 1]).toEqual([31.5 * C, floorRow(w.grid, 31) * C]);
    // Every point is a different x: nothing is a vertical drop.
    const xs = run.map(([x]) => x);
    expect(new Set(xs).size).toBe(xs.length);
  });

  it('joins a tall column standing on the pile to its neighbours as a slope, not a cliff', () => {
    const w = laidJar();
    const top = groundTops(w.grid)[30];
    const stack: [number, number, number][] = [];
    for (let k = 1; k <= 5; k++) stack.push([30, top - k, Substrate.Soil]);
    place(w, stack);
    const tops = groundTops(w.grid);
    const runs = surfaceRuns(w.grid, tops, C);

    expect(tops[30]).toBe(top - 5);
    // One unbroken run across the jar, passing exactly through the top of the stack.
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContainEqual([30.5 * C, (top - 5) * C]);
  });

  it('carries moss down both slopes of a mound, not just across its top', () => {
    const w = emptyJar();
    const floor = floorRow(w.grid, 30);
    place(w, [[29, floorRow(w.grid, 29) - 1, Substrate.Soil], [30, floor - 1, Substrate.Soil], [30, floor - 2, Substrate.Soil], [31, floorRow(w.grid, 31) - 1, Substrate.Soil]]);
    const tops = groundTops(w.grid);
    w.moss.cover[w.grid.idx(29, tops[29])] = 0.6;
    w.moss.cover[w.grid.idx(30, tops[30])] = 0.9;
    w.moss.cover[w.grid.idx(31, tops[31])] = 0.7;
    const run = surfaceRuns(w.grid, tops, C)[0];
    const along = mossAlong(w.grid, tops, w.moss.cover, run, C);

    // One value per point: the slope ends carry on the moss of the column beside them.
    expect(along).toHaveLength(run.length);
    expect(along[0]).toBeCloseTo(0.6);
    expect(along[1]).toBeCloseTo(0.6);
    expect(along[2]).toBeCloseTo(0.9);
    expect(along[3]).toBeCloseTo(0.7);
    expect(along[along.length - 1]).toBeCloseTo(0.7);
  });

  it('does not draw moss that has been buried under newer material', () => {
    const w = laidJar();
    const top = groundTops(w.grid)[30];
    // Moss grew on the old surface, then two cells of soil were laid on top of it.
    w.moss.cover[w.grid.idx(30, top)] = 1;
    place(w, [[30, top - 1, Substrate.Soil], [30, top - 2, Substrate.Soil]]);
    const tops = groundTops(w.grid);
    const run = surfaceRuns(w.grid, tops, C)[0];
    const along = mossAlong(w.grid, tops, w.moss.cover, run, C);
    const k = run.findIndex(([x]) => x === 30.5 * C);

    expect(tops[30]).toBe(top - 2);
    expect(along[k]).toBe(0);
  });
});

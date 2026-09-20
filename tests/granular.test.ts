// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Granular physics: substrate falls, piles slump, and moisture makes soil cohesive.
 *
 * The load-bearing property under all of it is that material carries its water with it — a landslide
 * that leaves its water behind would break the closed-system audit on the first collapse.
 */

import { describe, expect, it } from 'vitest';
import { cloneBalance, type BalanceConfig, type DeepPartial } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { Substrate, SUBSTRATES, type SubstrateId } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

function emptyJar(overrides: DeepPartial<BalanceConfig> = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'seal' });
  tick(w);
  return w;
}

/**
 * Run until the substrate stops moving, or fail loudly if it never comes to rest.
 * Always ticks at least once: queued paint commands are only applied at the top of the next tick, so
 * checking `substrateDirty` first would read the state from before the paint landed.
 */
function settleFully(w: World, limit = 4000): number {
  let n = 0;
  do {
    tick(w);
    n++;
  } while (w.substrateDirty && n < limit);
  if (n >= limit) throw new Error('substrate never came to rest');
  return n;
}

function columnHeight(w: World, x: number): number {
  const g = w.grid;
  let n = 0;
  for (let y = 1; y <= g.h - 2; y++) {
    if (g.props(g.idx(x, y)).granular) n++;
  }
  return n;
}

function place(w: World, x: number, y: number, material: SubstrateId): void {
  w.commands.push({ t: 'paint', x, y, material });
}

/**
 * Every hop the last settling pass recorded, as {from, to} cell pairs.
 *
 * `fallFrom` is indexed BY DESTINATION — the value stored at a cell is where that cell's material came
 * from — so a TypedArray `forEach` hands back (from, to), not (to, from).
 */
function hops(w: World): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  w.grid.fallFrom.forEach((from, to) => {
    if (from >= 0) out.push({ from, to });
  });
  return out;
}

describe('falling', () => {
  it('drops material painted in mid-air down to the jar floor', () => {
    const w = emptyJar();
    place(w, 32, 4, Substrate.Gravel);
    const ticks = settleFully(w);

    const g = w.grid;
    expect(g.substrate[g.idx(32, 4)]).toBe(Substrate.Air);
    expect(g.substrate[g.idx(32, g.h - 2)]).toBe(Substrate.Gravel);
    // One cell per tick, exactly as gravity percolation is speed-limited — no teleporting.
    expect(ticks).toBeGreaterThanOrEqual(g.h - 2 - 4);
  });

  it('comes to rest fully supported, with nothing left floating', () => {
    const w = emptyJar();
    for (let k = 0; k < 5; k++) place(w, 32, 3 + k, Substrate.Charcoal);
    settleFully(w);

    const g = w.grid;
    let found = 0;
    for (let i = 0; i < g.size; i++) {
      if (g.substrate[i] !== Substrate.Charcoal) continue;
      found++;
      // Every grain at rest is sitting on something. A cell with open air beneath it means the
      // settling pass stopped early and left material hanging.
      expect(g.substrate[i + g.w]).not.toBe(Substrate.Air);
    }
    expect(found).toBe(5);
  });

  it('leaves glass alone — the jar does not fall into itself', () => {
    const w = emptyJar();
    const g = w.grid;
    const before = [...g.substrate];
    settleFully(w);
    for (let i = 0; i < g.size; i++) {
      if (before[i] === Substrate.Glass) expect(g.substrate[i]).toBe(Substrate.Glass);
    }
  });
});

/**
 * Settling moves a grain a whole cell at a time, one tick apart, which on its own reads as a grain
 * teleporting 12px at a time. The renderer smooths that by easing the drawn piece across the gap, and
 * the only thing it has to work from is `grid.fallFrom`.
 *
 * Nothing in the simulation ever reads that array back, so no gameplay test can fail if it rots. These
 * are the only checks standing between it and a silent return to the choppy version.
 */
describe('reporting the fall for the renderer', () => {
  it('reports where a falling grain came from, one cell at a time', () => {
    const w = emptyJar();
    place(w, 32, 4, Substrate.Gravel);
    // Paint lands at the top of a tick and settling runs in the same one, but bounding this keeps the
    // test about what `fallFrom` says rather than about which phase moves first.
    for (let i = 0; i < 3 && hops(w).length === 0; i++) tick(w);

    const g = w.grid;
    const moves = hops(w);
    expect(moves).toHaveLength(1);
    expect(g.xOf(moves[0].from)).toBe(32);
    expect(g.yOf(moves[0].to) - g.yOf(moves[0].from)).toBe(1);
  });

  it('stops reporting once the grain has come to rest', () => {
    const w = emptyJar();
    place(w, 32, 4, Substrate.Soil);
    settleFully(w);
    expect(hops(w)).toHaveLength(0);

    // And stays clean while the jar sits still. Without the reset at the top of `settle`, a grain that
    // landed ticks ago would go on reporting its final hop, and the renderer would re-animate that same
    // 12px slide on every frame for the rest of the session.
    for (let i = 0; i < 20; i++) tick(w);
    expect(hops(w)).toHaveLength(0);
  });

  it('never points further than one cell away, even mid-collapse', () => {
    const w = emptyJar();
    for (let k = 0; k < 14; k++) place(w, 32, 6 + k, Substrate.Gravel);

    const g = w.grid;
    let seen = 0;
    let diagonal = 0;
    for (let i = 0; i < 400; i++) {
      tick(w);
      for (const { from, to } of hops(w)) {
        seen++;
        const dx = Math.abs(g.xOf(to) - g.xOf(from));
        if (dx === 1) diagonal++;
        // One row down, at most one column across — the two places `settle` records a hop. Anything
        // further would have the renderer sliding a grain across a gap it never actually travelled.
        expect(g.yOf(to) - g.yOf(from)).toBe(1);
        expect(dx).toBeLessThanOrEqual(1);
      }
      if (!w.substrateDirty) break;
    }

    // Guards against the invariant above passing vacuously: the tower has to have genuinely collapsed,
    // and it has to have slumped sideways as well as dropped, or the diagonal branch went unvisited.
    expect(seen).toBeGreaterThan(20);
    expect(diagonal).toBeGreaterThan(0);
  });
});

describe('slumping', () => {
  it('collapses a tall tower into a wide pile instead of leaving a spire', () => {
    const w = emptyJar();
    // A one-cell-wide column of dry gravel, twelve high.
    for (let k = 0; k < 12; k++) place(w, 32, 8 + k, Substrate.Gravel);
    settleFully(w);

    expect(columnHeight(w, 32)).toBeLessThan(12);
    // The material spread sideways rather than vanishing.
    let spread = 0;
    for (let x = 26; x <= 38; x++) if (columnHeight(w, x) > 0) spread++;
    expect(spread).toBeGreaterThan(1);
  });

  it('conserves every cell of material through a collapse', () => {
    const w = emptyJar();
    for (let k = 0; k < 12; k++) place(w, 32, 8 + k, Substrate.Gravel);
    settleFully(w);

    let cells = 0;
    for (let i = 0; i < w.grid.size; i++) if (w.grid.substrate[i] === Substrate.Gravel) cells++;
    expect(cells).toBe(12);
  });

  it('gives gravel a shallower angle of repose than soil', () => {
    const build = (material: SubstrateId) => {
      const w = emptyJar();
      for (let k = 0; k < 14; k++) place(w, 32, 6 + k, material);
      settleFully(w);
      return columnHeight(w, 32);
    };
    // Gravel runs and self-levels; dry soil holds a steeper pile, so its peak stays taller.
    expect(build(Substrate.Gravel)).toBeLessThan(build(Substrate.Soil));
  });
});

describe('cohesion', () => {
  it('lets damp soil hold a bank that the same soil would not hold dry', () => {
    const bank = (water: number) => {
      const w = emptyJar();
      // A square block of soil with one open flank, so it can only spread by slumping sideways.
      for (let y = 20; y <= 26; y++) {
        for (let x = 30; x <= 34; x++) place(w, x, y, Substrate.Soil);
      }
      settleFully(w);
      if (water > 0) {
        for (let x = 30; x <= 34; x++) w.commands.push({ t: 'water', x, ml: water });
        for (let i = 0; i < 60; i++) tick(w);
      }
      // Undercut the flank, then let it collapse.
      for (let y = 24; y <= 26; y++) place(w, 35, y, Substrate.Soil);
      settleFully(w);
      let widest = 0;
      for (let x = 24; x <= 42; x++) if (columnHeight(w, x) > 0) widest++;
      return widest;
    };

    // Dry soil crumbles further across the floor than damp soil, which clumps and stays put.
    expect(bank(0)).toBeGreaterThan(bank(60));
  });

  it('gives the three materials distinct, ordered granular characters', () => {
    // Gravel runs freely and never cares how wet it is; soil is the stickiest and the most cohesive.
    expect(SUBSTRATES[Substrate.Gravel].cohesion).toBe(0);
    expect(SUBSTRATES[Substrate.Soil].cohesion).toBeGreaterThan(0.5);
    expect(SUBSTRATES[Substrate.Gravel].slide).toBeGreaterThan(SUBSTRATES[Substrate.Charcoal].slide);
    expect(SUBSTRATES[Substrate.Charcoal].slide).toBeGreaterThan(SUBSTRATES[Substrate.Soil].slide);
    expect(SUBSTRATES[Substrate.Glass].granular).toBe(false);
  });
});

describe('roots bind the substrate', () => {
  it('holds a root-anchored cell in place when everything under it is dug away', () => {
    const w = new World(cloneBalance());
    w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
    w.commands.push({ t: 'seal' });
    tick(w);
    settleFully(w);
    w.commands.push({ t: 'water', x: 32, ml: 200 });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    for (let i = 0; i < 400; i++) tick(w);

    const P = w.pool;
    let root = -1;
    for (let n = 0; n < P.count; n++) {
      if (P.alive[n] && P.kind[n] === 0) { root = n; break; }
    }
    expect(root).toBeGreaterThanOrEqual(0);
    const rx = P.cellX[root];
    const ry = P.cellY[root];
    expect(w.grid.rootCount[w.grid.idx(rx, ry)]).toBeGreaterThan(0);

    // Excavate the entire column beneath the root.
    for (let y = ry + 1; y <= w.grid.h - 2; y++) place(w, rx, y, Substrate.Air);
    settleFully(w);

    // The root's own cell is still soil and still where it was: roots hold their ground.
    expect(w.grid.substrate[w.grid.idx(rx, ry)]).toBe(Substrate.Soil);
  });
});

describe('conservation through granular motion', () => {
  it('carries water down with the material it belongs to', () => {
    const w = emptyJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    // Build a floor, wet it, then drop more soil on top and let it all resettle.
    for (let x = 28; x <= 36; x++) place(w, x, 24, Substrate.Soil);
    settleFully(w);
    for (let x = 28; x <= 36; x++) w.commands.push({ t: 'water', x, ml: 20 });
    for (let i = 0; i < 40; i++) tick(w);

    const before = w.grid.totalWaterMl();
    expect(before).toBeGreaterThan(0);

    // Knock the floor out so the wet soil falls.
    for (let x = 28; x <= 36; x++) place(w, x, 26, Substrate.Soil);
    settleFully(w);

    // Water came down with the soil rather than being stranded or dropped.
    expect(w.grid.totalWaterMl()).toBeCloseTo(before, 6);
  });

  it('keeps the closed-system audit satisfied through a wet collapse', () => {
    const w = emptyJar();
    for (let x = 28; x <= 36; x++) place(w, x, 20, Substrate.Soil);
    settleFully(w);
    for (let x = 28; x <= 36; x++) w.commands.push({ t: 'water', x, ml: 25 });
    for (let i = 0; i < 50; i++) tick(w);

    // The audit runs inside tick(), so a landslide that lost a millilitre throws here.
    expect(() => {
      for (let k = 0; k < 10; k++) place(w, 32, 10 + k, Substrate.Gravel);
      settleFully(w);
      for (let i = 0; i < 500; i++) tick(w);
    }).not.toThrow();
  });
});

describe('determinism', () => {
  it('settles identically from the same seed', () => {
    const build = () => {
      const w = emptyJar();
      for (let k = 0; k < 14; k++) place(w, 32, 6 + k, Substrate.Gravel);
      settleFully(w);
      return [...w.grid.substrate].join(',');
    };
    expect(build()).toBe(build());
  });
});

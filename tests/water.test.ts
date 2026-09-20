// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Water is a conserved quantity in a sealed jar. These tests are the enforcement of that as a design
 * pillar: "you left the lid off" only means something if everything else is airtight.
 */

import { describe, expect, it } from 'vitest';
import { cloneBalance, type DeepPartial, type BalanceConfig } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

function sealedJar(overrides: DeepPartial<BalanceConfig> = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  return w;
}

describe('water conservation', () => {
  it('conserves every millilitre across 1,000 ticks with no evaporation', () => {
    const w = sealedJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    const baseline = w.auditWaterMl();

    w.commands.push({ t: 'water', x: 30, ml: 500 });
    for (let i = 0; i < 1000; i++) tick(w);

    expect(w.auditWaterMl()).toBeCloseTo(baseline + 500, 2);
  });

  it('conserves water through the full evaporation and condensation cycle', () => {
    // The audit runs every tick inside tick(), so a leak anywhere in the loop throws here.
    const w = sealedJar();
    w.commands.push({ t: 'setLamp', intensity: 1 });
    w.commands.push({ t: 'water', x: 30, ml: 400 });
    w.commands.push({ t: 'water', x: 31, ml: 400 });
    expect(() => {
      for (let i = 0; i < 4000; i++) tick(w);
    }).not.toThrow();
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 1);
  });

  it('conserves water while a plant grows, transpires and sheds leaves', () => {
    const w = sealedJar();
    w.commands.push({ t: 'water', x: 32, ml: 300 });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    expect(() => {
      for (let i = 0; i < 5000; i++) tick(w);
    }).not.toThrow();
  });

  it('accounts for water leaving through an open lid rather than reporting a leak', () => {
    const w = sealedJar();
    w.commands.push({ t: 'water', x: 30, ml: 300 });
    w.commands.push({ t: 'setLid', open: true });
    expect(() => {
      for (let i = 0; i < 2000; i++) tick(w);
    }).not.toThrow();
  });
});

describe('percolation', () => {
  /**
   * Gravity flow specifically, with capillary diffusion switched off so the two mechanisms are not
   * confounded. Diffusion legitimately advances more than one cell per tick (it sub-steps), but it
   * moves a trickle; percolation moves the whole mobile surplus and must be speed-limited, or a
   * poured drop teleports to the bottom of the jar in a single tick.
   */
  it('gravity never moves water more than one cell downward per tick', () => {
    const w = sealedJar({
      atmosphere: { evapMlPerMinAtFullDrive: 0 },
      water: { diffusionCoefficient: 0, diffusionSubsteps: 1 },
    });
    const g = w.grid;
    const x = 30;
    const surface = g.surfaceOfColumn[x];
    const surfaceY = g.yOf(surface);

    g.moisture[surface] = 200; // wildly oversaturated, so the surplus is maximally mobile
    w.totalWaterAddedMl += 200;

    tick(w);
    expect(g.moisture[g.idx(x, surfaceY + 1)]).toBeGreaterThan(0);
    expect(g.moisture[g.idx(x, surfaceY + 2)]).toBe(0);
  });

  /**
   * The drainage layer's design claim: an over-watered jar parks its surplus in the gravel, BELOW the
   * root zone, instead of leaving it in the root zone. So the gravel jar shows standing water and a
   * root zone still short of the rot threshold, while an all-soil jar has nowhere to put a surplus and
   * shows none. (That absence of drainage causing actual rot is covered by the `no-drainage` scenario
   * in failures.test.ts — this test is about where the water GOES.)
   */
  it('parks an over-watering surplus in the drainage layer rather than the root zone', () => {
    const drained = new World(cloneBalance({ atmosphere: { evapMlPerMinAtFullDrive: 0 } }));
    drained.commands.push({ t: 'layerBands', gravelRows: 5, charcoalRows: 3, soilRows: 8 });
    drained.commands.push({ t: 'seal' });
    tick(drained);

    const soggy = new World(cloneBalance({ atmosphere: { evapMlPerMinAtFullDrive: 0 } }));
    soggy.commands.push({ t: 'layerBands', gravelRows: 0, charcoalRows: 0, soilRows: 16 });
    soggy.commands.push({ t: 'seal' });
    tick(soggy);

    // Flood both jars identically and let everything settle.
    for (const w of [drained, soggy]) {
      for (let x = 10; x < 56; x++) w.commands.push({ t: 'water', x, ml: 120 });
      for (let i = 0; i < 600; i++) tick(w);
    }

    // The surplus is visibly accounted for as standing water, and the player can read it on the gauge.
    expect(drained.sumpMl).toBeGreaterThan(0);
    // An all-soil jar has no drainage layer, so it reports no standing water at all — nowhere for the
    // surplus to declare itself, which is exactly why the mistake is invisible until roots rot.
    expect(soggy.sumpMl).toBe(0);
    // And the root zone is still short of waterlogged despite the over-watering.
    expect(topSoilSaturation(drained)).toBeLessThan(drained.cfg.raw.water.rootRotSaturation);
  });
});

describe('lateral diffusion', () => {
  it('spreads symmetrically, with no left-to-right bias from the pass direction', () => {
    const w = sealedJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    const g = w.grid;
    const cx = 32;
    // Wet one cell mid-soil and let only diffusion act on it.
    const y = g.yOf(g.surfaceOfColumn[cx]) + 2;
    const center = g.idx(cx, y);
    g.moisture[center] = 60;
    w.totalWaterAddedMl += 60;

    for (let i = 0; i < 200; i++) tick(w);

    for (let d = 1; d <= 5; d++) {
      const left = g.moisture[g.idx(cx - d, y)];
      const right = g.moisture[g.idx(cx + d, y)];
      // Any in-place (single-buffered) stencil would drift measurably in one direction here.
      expect(Math.abs(left - right)).toBeLessThan(0.02);
    }
  });
});

/** Mean saturation of the upper soil band — the root zone the player actually cares about. */
function topSoilSaturation(w: World): number {
  const g = w.grid;
  let sum = 0;
  let n = 0;
  for (const i of g.activeCells) {
    if (g.substrate[i] !== Substrate.Soil) continue;
    const surface = g.surfaceOfColumn[g.xOf(i)];
    if (surface < 0 || g.yOf(i) - g.yOf(surface) > 4) continue;
    sum += g.saturation(i);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * The watering can's rose. The stream used to wet a single column, which meant charging a jar
 * required dragging across ~58 of them one at a time.
 */
describe('the watering can rose', () => {
  /** Columns that actually have a surface to pour onto, left to right. */
  const pourable = (w: World) => {
    const xs: number[] = [];
    for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) xs.push(x);
    return xs;
  };

  /**
   * Millilitres the pour PLACED on each column this tick, read from the `watered` events.
   *
   * Deliberately not measured from `grid.moisture`: percolation and diffusion both run inside the
   * same tick that drains the command, so by the time the tick returns the water has already spread
   * sideways and downward and no longer says where it landed.
   */
  const placed = (w: World) => {
    const byColumn = new Map<number, number>();
    for (const e of w.events) {
      if (e.t !== 'watered') continue;
      const x = w.grid.xOf(e.cell);
      byColumn.set(x, (byColumn.get(x) ?? 0) + e.ml);
    }
    return byColumn;
  };

  it('divides the pour between neighbours rather than multiplying it', () => {
    const w = sealedJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    const baseline = w.auditWaterMl();
    w.commands.push({ t: 'water', x: 32, ml: 90, spread: 2 });
    tick(w);
    // The headline risk: a rose that hands `ml` to each of five columns pours five times what the
    // can says. The audit is what catches it.
    expect(w.auditWaterMl()).toBeCloseTo(baseline + 90, 6);
  });

  it('wets the columns either side, heaviest in the middle', () => {
    const w = sealedJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    w.commands.push({ t: 'water', x: 32, ml: 45, spread: 2 });
    tick(w);

    // Triangular weights [1,2,3,2,1]/9 on 45 mL: 5 / 10 / 15 / 10 / 5.
    const p = placed(w);
    expect(p.get(32)).toBeCloseTo(15, 6);
    expect(p.get(31)).toBeCloseTo(10, 6);
    expect(p.get(33)).toBeCloseTo(10, 6);
    expect(p.get(30)).toBeCloseTo(5, 6);
    expect(p.get(34)).toBeCloseTo(5, 6);
    expect(p.has(29)).toBe(false); // and nothing beyond the rose
    expect(p.has(35)).toBe(false);
  });

  it('loses nothing when poured against the jar wall', () => {
    const w = sealedJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    const xs = pourable(w);
    const baseline = w.auditWaterMl();

    // Half the rose is aimed at columns that do not exist here. Those shares must be redistributed
    // to the columns that DO, not quietly binned — otherwise the player is punished with a silent
    // loss of water for standing too close to the glass.
    w.commands.push({ t: 'water', x: xs[0], ml: 40, spread: 2 });
    w.commands.push({ t: 'water', x: xs[xs.length - 1], ml: 40, spread: 2 });
    tick(w);

    expect(w.auditWaterMl()).toBeCloseTo(baseline + 80, 6);
  });

  it('is still a no-op when there is no substrate to pour onto', () => {
    // An empty jar: no layers laid, so no column has a surface anywhere within the rose's reach.
    const w = new World(cloneBalance({ atmosphere: { evapMlPerMinAtFullDrive: 0 } }));
    const baseline = w.auditWaterMl();
    // A fresh jar already carries the water in its air, so compare against what was credited before
    // the pour rather than against zero.
    const creditedBefore = w.totalWaterAddedMl;
    w.commands.push({ t: 'water', x: 32, ml: 40, spread: 2 });
    tick(w);
    // Credited nothing at all — an empty pour must not move `totalWaterAddedMl`, or the audit
    // baseline drifts away from the water actually in the jar.
    expect(w.auditWaterMl()).toBeCloseTo(baseline, 6);
    expect(w.totalWaterAddedMl).toBe(creditedBefore);
  });

  it('leaves an unqualified pour on exactly one column', () => {
    const w = sealedJar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    w.commands.push({ t: 'water', x: 32, ml: 45 });
    tick(w);
    // The balance harness and every other water test prime jars with exact millilitres into exact
    // columns. The default has to stay a needle or all of that quietly re-tunes itself.
    const p = placed(w);
    expect(p.size).toBe(1);
    expect(p.get(32)).toBeCloseTo(45, 6);
  });
});

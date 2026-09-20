// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The promise every failure state has to keep: it is debounced, it warns before it triggers, the
 * warning comes from the SAME counter as the failure, and it clears when the player acts.
 */

import { describe, expect, it } from 'vitest';
import { cloneBalance, type Overrides } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';
import { runScenario, SCENARIOS } from '../tools/harness.js';

function jar(overrides: Overrides = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  return w;
}

describe('strike counters', () => {
  it('ignores a transient spike instead of firing on it', () => {
    const w = jar();
    w.commands.push({ t: 'water', x: 32, ml: 200 });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    for (let i = 0; i < 200; i++) tick(w);

    // A handful of bad ticks must not be enough to trigger anything.
    expect(w.strikes.dehydration.triggered).toBe(false);
    expect(w.strikes.rootRot.triggered).toBe(false);
  });

  it('warns at 40% of the counter, from the same counter that triggers', () => {
    const w = jar({ failure: { triggerTicks: { dehydration: 100 } } });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb }); // no water at all
    let warnedAt = -1;
    let failedAt = -1;
    for (let i = 0; i < 400; i++) {
      tick(w);
      for (const e of w.events) {
        if (e.t === 'warning' && e.mode === 'dehydration' && warnedAt < 0) warnedAt = w.strikes.dehydration.value;
        if (e.t === 'failure' && e.mode === 'dehydration' && failedAt < 0) failedAt = w.strikes.dehydration.value;
      }
    }
    expect(warnedAt).toBeGreaterThanOrEqual(40);
    expect(failedAt).toBe(100);
    // The warning must precede the failure, which is only guaranteed if they share a counter.
    expect(warnedAt).toBeLessThan(failedAt);
  });

  it('recovers twice as fast as it accrues, so acting is immediately rewarded', () => {
    const w = jar();
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    for (let i = 0; i < 150; i++) tick(w);
    const peak = w.strikes.dehydration.value;
    expect(peak).toBeGreaterThan(0);

    // The fix: water the whole root zone, not just the column the seed went into — by now the plant
    // has spread roots sideways.
    for (let x = 26; x <= 38; x++) w.commands.push({ t: 'water', x, ml: 80 });
    for (let i = 0; i < 600; i++) tick(w);

    expect(w.strikes.dehydration.value).toBe(0);
    expect(w.strikes.dehydration.warned).toBe(false);
  });
});

describe('each failure mode is individually inducible', () => {
  it('reaches dehydration, and only dehydration, when never watered', () => {
    const r = runScenario(SCENARIOS['cold-dry'], 10);
    expect(r.error).toBeUndefined();
    expect(r.failures).toContain('dehydration');
    expect(r.failures).not.toContain('rootRot');
  });

  it('reaches root rot when there is no drainage layer and heavy watering', () => {
    const r = runScenario(SCENARIOS['no-drainage'], 10);
    expect(r.error).toBeUndefined();
    expect(r.failures).toContain('rootRot');
  });

  it('reaches a CO2 stall when the jar is overplanted', () => {
    const r = runScenario(SCENARIOS.overplanted, 14);
    expect(r.error).toBeUndefined();
    expect([...r.failures, ...r.warnings]).toContain('co2Stall');
  });
});

describe('the well-built jar', () => {
  it('survives 30 sim-days unattended-ish without leaking water or dying', () => {
    const r = runScenario(SCENARIOS['well-built'], 30);
    expect(r.error).toBeUndefined();
    expect(r.died).toBe(false);
    expect(r.finalNodes).toBeGreaterThan(3);
  });

  it('settles instead of oscillating: late humidity swing stays bounded', () => {
    const r = runScenario(SCENARIOS['well-built'], 30);
    // A bare condensation threshold, or an in-place diffusion stencil, shows up here as a large
    // sustained swing in the last quarter of the run.
    expect(r.rhSwingLate).toBeLessThan(35);
  });
});

describe('build mode', () => {
  it('runs no simulation until the jar is sealed', () => {
    const w = new World(cloneBalance());
    w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
    const t0 = w.atmo.tempC;
    w.commands.push({ t: 'setLamp', intensity: 1 });
    for (let i = 0; i < 500; i++) tick(w);
    // Layout is a committed decision made with the clock stopped, not a live experiment.
    expect(w.atmo.tempC).toBe(t0);
    expect(w.phase).toBe('build');

    w.commands.push({ t: 'seal' });
    for (let i = 0; i < 500; i++) tick(w);
    expect(w.atmo.tempC).toBeGreaterThan(t0);
  });

  it('charges water and damages roots for a tend-mode amendment', () => {
    const w = jar();
    w.commands.push({ t: 'water', x: 32, ml: 200 });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    for (let i = 0; i < 800; i++) tick(w);

    const root = firstRoot(w);
    const healthBefore = w.pool.health[root];
    const cell = w.grid.idx(w.pool.cellX[root] + 1, w.pool.cellY[root]);
    const waterBefore = w.grid.moisture[cell];
    expect(waterBefore).toBeGreaterThan(0);

    w.commands.push({
      t: 'paint',
      x: w.pool.cellX[root] + 1,
      y: w.pool.cellY[root],
      material: 2, // charcoal
    });
    tick(w);

    expect(w.grid.moisture[cell]).toBeLessThan(waterBefore);
    expect(w.pool.health[root]).toBeLessThan(healthBefore);
  });
});

function firstRoot(w: World): number {
  for (let n = 0; n < w.pool.count; n++) if (w.pool.alive[n] && w.pool.kind[n] === 0) return n;
  throw new Error('no root');
}

// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The start of a game: the jar is sealed empty the moment the player is in, and built while it runs.
 */

import { describe, expect, it } from 'vitest';
import { cloneBalance, standardLayers } from '../src/sim/config/balance.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

/** A jar sealed empty, as the game now starts one. */
function sealedEmpty() {
  const w = new World(cloneBalance());
  w.commands.push({ t: 'seal' });
  tick(w);
  return w;
}

describe('a jar sealed empty at the start', () => {
  it('runs its clock straight away', () => {
    const w = sealedEmpty();
    expect(w.phase).toBe('tend');
    const before = w.simDay;
    for (let i = 0; i < 1440; i++) tick(w);
    expect(w.simDay).toBe(before + 1);
  });

  it('measures its air against the layout laid in it, not the bare jar, until it is established', () => {
    const w = sealedEmpty();
    const bare = w.baseAirCells;
    w.commands.push({ t: 'layerBands', ...standardLayers(w.cfg.raw.grid.interiorH) });
    tick(w);
    while (w.substrateDirty) tick(w);
    expect(w.established).toBe(false);
    // Laying the layers took the air with it: the gas balance is against the jar as built.
    expect(w.baseAirCells).toBeLessThan(bare * 0.7);
    expect(w.baseAirCells).toBe(w.countAirCells());
  });

  it('holds its air volume once watered, so reshaping a living jar tightens its air', () => {
    const w = sealedEmpty();
    w.commands.push({ t: 'layerBands', ...standardLayers(w.cfg.raw.grid.interiorH) });
    tick(w);
    while (w.substrateDirty) tick(w);
    w.commands.push({ t: 'water', x: 40, ml: 50 });
    tick(w);
    expect(w.established).toBe(true);
    const held = w.baseAirCells;
    const g = w.grid;
    const top = g.yOf(g.surfaceOfColumn[20]);
    w.paint(20, top - 1, Substrate.Soil);
    w.paint(21, top - 1, Substrate.Soil);
    expect(w.baseAirCells).toBe(held);
  });

  it('is established by anything alive, not only by water', () => {
    const w = sealedEmpty();
    w.commands.push({ t: 'layerBands', ...standardLayers(w.cfg.raw.grid.interiorH) });
    tick(w);
    while (w.substrateDirty) tick(w);
    w.commands.push({ t: 'addMoss', x: 30 });
    tick(w);
    expect(w.established).toBe(true);
  });
});

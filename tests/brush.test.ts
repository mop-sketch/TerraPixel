// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { cloneBalance } from '../src/sim/config/balance.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

/** A jar with the standard layers, still being built. */
function jar() {
  const w = new World(cloneBalance());
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  tick(w);
  while (w.substrateDirty) tick(w);
  return w;
}

describe('the build brush', () => {
  it('is a single cell at size 1, and a round footprint larger', () => {
    const w = jar();
    const g = w.grid;
    const y = g.yOf(g.surfaceOfColumn[32]) + 3;
    expect(g.brushCells(32, y, 0, Substrate.Gravel)).toEqual([g.idx(32, y)]);
    const wide = g.brushCells(32, y, 3, Substrate.Gravel);
    // Round, not square: wider than one cell, but missing the corners a 7x7 square would have.
    expect(wide.length).toBeGreaterThan(20);
    expect(wide.length).toBeLessThan(49);
    expect(wide).toContain(g.idx(32 + 3, y));
    expect(wide).not.toContain(g.idx(32 + 3, y + 3));
  });

  it('leaves out cells it would not change: glass, and cells already that material', () => {
    const w = jar();
    const g = w.grid;
    const y = g.yOf(g.surfaceOfColumn[32]) + 2;
    // All soil there already: painting soil changes nothing, so the brush previews nothing.
    expect(g.brushCells(32, y, 1, Substrate.Soil)).toEqual([]);
    // Against the wall, nothing on the glass side.
    for (const i of g.brushCells(1, y, 4, Substrate.Gravel)) expect(g.substrate[i]).not.toBe(Substrate.Glass);
  });

  it('paints every cell of its footprint in one click, and digs as widely', () => {
    const w = jar();
    const g = w.grid;
    const y = g.yOf(g.surfaceOfColumn[32]) + 3;
    const footprint = g.brushCells(32, y, 2, Substrate.Gravel);
    w.commands.push({ t: 'paintBrush', x: 32, y, radius: 2, material: Substrate.Gravel });
    tick(w);
    for (const i of footprint) expect(g.substrate[i]).toBe(Substrate.Gravel);

    const top = g.yOf(g.surfaceOfColumn[20]);
    const hole = g.brushCells(20, top, 2, Substrate.Air);
    w.commands.push({ t: 'paintBrush', x: 20, y: top, radius: 2, material: Substrate.Air });
    tick(w);
    expect(hole.length).toBeGreaterThan(5);
    // Every cell it dug is open space the liner will recognise. Counted rather than checked in place,
    // because the banks slump into a fresh hole and the open space moves as they do.
    let dug = 0;
    for (let i = 0; i < g.size; i++) {
      if (!g.dug[i]) continue;
      dug++;
      expect(g.substrate[i]).toBe(Substrate.Air);
    }
    expect(dug).toBe(hole.length);
  });

  it('with mud, lines a dug hollow when centred in it, rather than filling it with a blob', () => {
    const w = jar();
    const g = w.grid;
    const base = g.yOf(g.surfaceOfColumn[32]);
    for (let dy = 0; dy <= 2; dy++) {
      for (let x = 28; x <= 36; x++) {
        w.paint(x, base + dy, Substrate.Air);
        tick(w);
      }
    }
    for (let i = 0; i < 100; i++) tick(w);
    const liner = g.basinLiner(32, base)!;
    expect(liner).not.toBeNull();
    w.commands.push({ t: 'paintBrush', x: 32, y: base, radius: 3, material: Substrate.Mud });
    tick(w);
    for (const i of liner.liner) expect(g.substrate[i]).toBe(Substrate.Mud);
    // The hollow itself is still open, ready to fill.
    for (const i of liner.area) expect(g.substrate[i]).toBe(Substrate.Air);
  });
});

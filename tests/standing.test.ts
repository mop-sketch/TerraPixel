// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { cloneBalance, type Overrides } from '../src/sim/config/balance.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

/** A sealed jar with the standard three layers, settled and dry. */
function jar(overrides: Overrides = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  while (w.substrateDirty) tick(w);
  return w;
}

/** For tests of the liner: nothing leaves a pond except through the mud, if the mud is wrong. */
const NO_EVAPORATION: Overrides = { standing: { evapFactor: 0 } };

/** Dig a hollow under columns 28..36, three cells deep, and line it with one Mud click. */
function dugPond(w: World) {
  const g = w.grid;
  const base = g.yOf(g.surfaceOfColumn[32]);
  for (let dy = 0; dy <= 2; dy++) {
    for (let x = 28; x <= 36; x++) {
      w.paint(x, base + dy, Substrate.Air);
      tick(w);
    }
  }
  for (let i = 0; i < 100; i++) tick(w);
  w.commands.push({ t: 'paint', x: 32, y: base, material: Substrate.Mud });
  tick(w);
  while (w.substrateDirty) tick(w);
  return base;
}

const standingAt = (w: World, x: number) => {
  let ml = 0;
  for (let y = 1; y <= w.grid.h - 2; y++) ml += w.grid.standing[w.grid.idx(x, y)];
  return ml;
};

describe('free water', () => {
  it('is counted by the closed-system audit', () => {
    const w = jar();
    // Dropped straight into an air cell, the way a pond will be filled later.
    const top = w.grid.idx(32, 2);
    expect(w.grid.substrate[top]).toBe(Substrate.Air);
    w.grid.standing[top] = 30;
    w.totalWaterAddedMl += 30;

    // The audit throws on any mismatch, so simply ticking is the assertion.
    for (let i = 0; i < 600; i++) tick(w);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('soaks into the ground it is resting on rather than sitting on top forever', () => {
    const w = jar();
    const surface = w.grid.surfaceOfColumn[32];
    const above = surface - w.grid.w;
    w.grid.standing[above] = 8;
    w.totalWaterAddedMl += 8;
    const soilBefore = w.grid.totalWaterMl();

    for (let i = 0; i < 300; i++) tick(w);
    expect(standingAt(w, 32)).toBeLessThan(8);
    expect(w.grid.totalWaterMl()).toBeGreaterThan(soilBefore);
  });

  it('levels out instead of standing in a tower', () => {
    const w = jar();
    /*
     * A column of water in one place. Water finds its level, so the neighbouring columns must end up
     * wet too — and none of it may vanish.
     */
    const surface = w.grid.surfaceOfColumn[32];
    for (let k = 1; k <= 4; k++) w.grid.standing[surface - k * w.grid.w] = 12;
    w.totalWaterAddedMl += 48;

    /*
     * ONE tick, because a tick is a sim-MINUTE and water does not take minutes to fall over. This
     * used to tick twelve times and read the result, which worked only while levelling crawled a
     * quarter of a cell at a time; at the real speed the jar has drunk the whole 48 mL by then, and
     * the test passed by measuring a puddle on its way out rather than a puddle levelling.
     */
    tick(w);

    const left = standingAt(w, 30) + standingAt(w, 31);
    const right = standingAt(w, 33) + standingAt(w, 34);
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);

    // And the tower itself is gone: nothing is still stacked four cells deep over one column.
    expect(standingAt(w, 32)).toBeLessThan(48);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('settles to the floor within a single tick rather than sinking a cell at a time', () => {
    /*
     * The clock is the whole argument. Water dropped at the top of a sealed jar is at the bottom a
     * second later; a tick is a sim-minute, so it can never be seen in mid-air on the way down.
     */
    const w = jar();
    const g = w.grid;
    const surface = g.surfaceOfColumn[32];
    const high = g.idx(32, 2);
    expect(g.substrate[high]).toBe(Substrate.Air);
    g.standing[high] = 10;
    w.totalWaterAddedMl += 10;

    tick(w);

    expect(g.standing[high]).toBe(0);
    // It is resting on the ground it fell onto, not still somewhere in between.
    const restingY = g.yOf(surface) - 1;
    let found = 0;
    for (let x = 1; x <= g.w - 2; x++) found += g.standing[g.idx(x, restingY)];
    expect(found).toBeGreaterThan(0);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('never stacks more in a cell than a cell can hold', () => {
    const w = jar();
    const cap = w.cfg.raw.standing.cellMl;
    const top = w.grid.idx(20, 2);
    w.grid.standing[top] = cap * 3; // deliberately impossible
    w.totalWaterAddedMl += cap * 3;

    for (let i = 0; i < 400; i++) tick(w);
    for (let i = 0; i < w.grid.size; i++) {
      expect(w.grid.standing[i]).toBeLessThanOrEqual(cap + 1e-6);
    }
  });

  it('does not puddle on ordinary ground, however much is poured', () => {
    /*
     * Over-watering waterlogs a jar; it does not fill it like a bath. Free water standing anywhere a
     * player happened to over-water would make the mud liner pointless — the whole reason to dig and
     * line a basin is that water will not otherwise stay put.
     */
    const w = jar();
    for (let k = 0; k < 40; k++) w.commands.push({ t: 'water', x: 32, ml: 60 });
    for (let i = 0; i < 400; i++) tick(w);

    expect(w.grid.standingMl()).toBe(0);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('lines a dug hollow from a single click, and the pond then holds', () => {
    /*
     * The whole point of the tool. Lining by hand means painting the floor, then every step face, then
     * both banks — and one missed cell is a basin that quietly drains a day later. One click does the
     * lot, following whatever shape the digging and the slumping actually left.
     */
    /*
     * Evaporation off: this is a test of the LINER. A pond now loses water to the air as it should,
     * and that loss would pass or fail this for reasons that have nothing to do with the mud.
     */
    const w = jar(NO_EVAPORATION);
    const g = w.grid;
    const base = g.yOf(g.surfaceOfColumn[32]);
    // Dug a cell at a time with a tick in between, the way dragging the tool does it, so the soil
    // slumps to its own angle before anything is lined.
    for (let dy = 0; dy <= 2; dy++) {
      for (let x = 28; x <= 36; x++) {
        w.paint(x, base + dy, Substrate.Air);
        tick(w);
      }
    }
    for (let i = 0; i < 200; i++) tick(w);

    // No mud placed by hand anywhere: one click, at the depth the pond should reach.
    w.commands.push({ t: 'paint', x: 32, y: base, material: Substrate.Mud });
    tick(w);
    while (w.substrateDirty) tick(w);

    // Every cell the water will rest on or against is now something it cannot get into.
    for (let x = 28; x <= 36; x++) {
      const floorY = g.yOf(g.surfaceOfColumn[x]);
      expect(g.substrate[g.idx(x, floorY)]).toBe(Substrate.Mud);
    }

    w.commands.push({ t: 'seal' });
    tick(w);
    for (let k = 0; k < 10; k++) w.commands.push({ t: 'water', x: 32, ml: 25 });
    for (let i = 0; i < 400; i++) tick(w);
    const filled = w.grid.standingMl();
    expect(filled).toBeGreaterThan(0);

    for (let i = 0; i < 20 * 1440; i++) tick(w);
    expect(w.grid.standingMl()).toBeGreaterThan(filled * 0.9);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('previews exactly the cells a click would line, and nothing when it would not', () => {
    /*
     * `basinLiner` is a PURE QUERY, called every frame by the hover preview as well as once by the
     * tool that actually paints — so this is really a test that the preview can never promise
     * something the click then does not do. Same jar, same spot: the query result before painting
     * must equal the tool's own list of what it changed.
     */
    const w = jar();
    const g = w.grid;
    const base = g.yOf(g.surfaceOfColumn[32]);
    for (let dy = 0; dy <= 2; dy++) {
      for (let x = 28; x <= 36; x++) {
        w.paint(x, base + dy, Substrate.Air);
        tick(w);
      }
    }
    for (let i = 0; i < 200; i++) tick(w);

    const preview = g.basinLiner(32, base);
    expect(preview).not.toBeNull();
    expect(preview!.liner.length).toBeGreaterThan(0);
    // The area is every open cell the pond will occupy — at least the floor span itself.
    expect(preview!.area.length).toBeGreaterThanOrEqual(9);

    w.commands.push({ t: 'paint', x: 32, y: base, material: Substrate.Mud });
    tick(w);
    while (w.substrateDirty) tick(w);

    const actuallyMud = preview!.liner.every((i) => g.substrate[i] === Substrate.Mud);
    expect(actuallyMud).toBe(true);

    // And on ordinary flat ground, or in the open jar above everything, there is nothing to preview —
    // the tool would just place one ordinary cell, which needs no preview at all.
    expect(g.basinLiner(10, g.yOf(g.surfaceOfColumn[10]) - 1)).toBeNull();
    expect(g.basinLiner(10, 2)).toBeNull();
  });

  it('places a single cell when there is no hollow to line', () => {
    // The lining is for basins. Mud is still an ordinary material everywhere else, or the tool would
    // take the jar away from the player every time they wanted one impermeable cell.
    const w = jar();
    const g = w.grid;
    const surface = g.surfaceOfColumn[20];
    const before = g.substrate.filter((v) => v === Substrate.Mud).length;

    w.commands.push({ t: 'paint', x: 20, y: g.yOf(surface), material: Substrate.Mud });
    tick(w);

    expect(g.substrate[surface]).toBe(Substrate.Mud);
    expect(g.substrate.filter((v) => v === Substrate.Mud).length).toBe(before + 1);
  });

  it('stays flat under a steady pour, and spills at the rim rather than heaping over it', () => {
    /*
     * A pour lands 24 mL a tick in a handful of columns. Levelling that moved water a cell or so per
     * pass could not keep up: the surface heaped into a hill over the pour point, stepped down toward
     * the banks, shifted every tick, and a brimming pond stood piled above its own rim. Water in a
     * basin is flat long before a sim-minute is up, so it has to be flat at the end of every tick.
     */
    const w = jar();
    const g = w.grid;
    const cap = w.cfg.raw.standing.cellMl;
    const base = g.yOf(g.surfaceOfColumn[32]);
    for (let dy = 0; dy <= 2; dy++) {
      for (let x = 26; x <= 38; x++) {
        w.paint(x, base + dy, Substrate.Air);
        tick(w);
      }
    }
    for (let i = 0; i < 100; i++) tick(w);
    w.commands.push({ t: 'paint', x: 32, y: base, material: Substrate.Mud });
    tick(w);
    while (w.substrateDirty) tick(w);

    /** The waterline over a column, in cells from the top of the jar, or NaN if it is dry. */
    const surfaceAt = (x: number): number => {
      for (let y = 1; y <= g.h - 2; y++) {
        const ml = g.standing[g.idx(x, y)];
        if (ml > 1e-9) return y + 1 - ml / cap;
      }
      return NaN;
    };

    let worst = 0;
    for (let t = 0; t < 40; t++) {
      w.commands.push({ t: 'water', x: 30, ml: 24, spread: 2 });
      tick(w);
      const levels: number[] = [];
      for (let x = 26; x <= 38; x++) {
        const s = surfaceAt(x);
        if (!Number.isNaN(s)) levels.push(s);
      }
      if (levels.length < 2) continue;
      worst = Math.max(worst, Math.max(...levels) - Math.min(...levels));
    }
    // A hundredth of a cell: flat to the eye at any zoom the game offers.
    expect(worst).toBeLessThan(0.01);

    // Forty ticks of pouring is far more than the basin holds, so it has overflowed. The water inside
    // must not stand above the rim; the surplus has run out over the ground instead.
    const rim = g.yOf(g.surfaceOfColumn[20]);
    for (let x = 27; x <= 37; x++) expect(surfaceAt(x)).toBeGreaterThan(rim - 0.25);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('stands in a mud-lined basin, and stays there', () => {
    /*
     * Evaporation off: this is a test of the LINER. A pond now loses water to the air as it should,
     * and that loss would pass or fail this for reasons that have nothing to do with the mud.
     */
    const w = jar(NO_EVAPORATION);
    const g = w.grid;
    /*
     * A basin dug into the surface and lined: mud floor, mud walls, open air between them. Built
     * while the jar is still in its build phase, exactly as a player would before sealing.
     */
    const floorY = g.yOf(g.surfaceOfColumn[32]);
    for (let x = 28; x <= 36; x++) {
      w.paint(x, floorY, Substrate.Mud);
      for (let dy = 1; dy <= 2; dy++) w.paint(x, floorY - dy, Substrate.Air);
    }
    for (let dy = 0; dy <= 2; dy++) {
      w.paint(27, floorY - dy, Substrate.Mud);
      w.paint(37, floorY - dy, Substrate.Mud);
    }
    while (w.substrateDirty) tick(w);
    w.commands.push({ t: 'seal' });
    tick(w);

    for (let k = 0; k < 6; k++) w.commands.push({ t: 'water', x: 32, ml: 25 });
    for (let i = 0; i < 200; i++) tick(w);
    const filled = w.grid.standingMl();
    expect(filled).toBeGreaterThan(0);

    // And it is a pond rather than a puddle: still there days later, not soaked away.
    for (let i = 0; i < 20 * 1440; i++) tick(w);
    expect(w.grid.standingMl()).toBeGreaterThan(filled * 0.5);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('evaporates into a dry jar, and holds its level in one kept normally', () => {
    /*
     * A lined pond used to be an inert tank: measured over 40 days it held exactly the same water
     * throughout. Open water gives itself to the air, and dry soil draws that vapour back out, so in a
     * jar left dry the pond is spent: a reserve, drawn down exactly when the jar needs it.
     *
     * In a jar kept normally, the damp ground around it drains back in as fast as it evaporates, and it
     * holds. Without that, a pond in an ordinary jar drained away in 20 to 40 days and stayed empty.
     */
    const kept = (watered: boolean) => {
      const w = jar();
      const g = w.grid;
      dugPond(w);
      if (watered) {
        const cols: number[] = [];
        for (let x = 1; x <= g.w - 2; x++) if (g.surfaceOfColumn[x] >= 0 && (x < 28 || x > 36)) cols.push(x);
        for (const x of cols) w.commands.push({ t: 'water', x, ml: 2400 / cols.length, spread: 0 });
      }
      for (let k = 0; k < 10; k++) w.commands.push({ t: 'water', x: 32, ml: 25, spread: 0 });
      for (let i = 0; i < 200; i++) tick(w);
      const filled = g.standingMl();
      expect(filled).toBeGreaterThan(200);
      for (let i = 0; i < 10 * 1440; i++) tick(w);
      // It went to the air or the soil, never out of the closed system.
      expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
      return g.standingMl() / filled;
    };

    // Ten days on: a normally kept jar's pond is still essentially full...
    expect(kept(true)).toBeGreaterThan(0.85);
    // ...and a dry jar's has given most of itself away.
    expect(kept(false)).toBeLessThan(0.5);
  });

  it('catches the runoff from a drenching beside it', () => {
    /*
     * The pond is the jar's drain. Water the ground cannot hold runs along the surface into it,
     * rather than sitting in the soil as the waterlogging that rots roots.
     */
    const w = jar(NO_EVAPORATION);
    const g = w.grid;
    dugPond(w);
    for (let i = 0; i < 60; i++) tick(w);
    expect(g.standingMl()).toBe(0);

    for (let k = 0; k < 20; k++) w.commands.push({ t: 'water', x: 24, ml: 30, spread: 2 });
    for (let i = 0; i < 60; i++) tick(w);
    expect(g.standingMl()).toBeGreaterThan(10);
    expect(w.auditWaterMl()).toBeCloseTo(w.totalWaterAddedMl, 6);
  });

  it('sends no runoff to a mud cell that is not lower than the ground around it', () => {
    // A single cell of mud on flat ground is not a pond. It must not become a drain for the soil.
    const w = jar();
    const g = w.grid;
    const surface = g.surfaceOfColumn[32];
    w.commands.push({ t: 'paint', x: 32, y: g.yOf(surface), material: Substrate.Mud });
    tick(w);
    while (w.substrateDirty) tick(w);

    for (let k = 0; k < 20; k++) w.commands.push({ t: 'water', x: 28, ml: 30, spread: 2 });
    for (let i = 0; i < 120; i++) tick(w);
    expect(g.standingMl()).toBe(0);
  });
});

// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { cloneBalance, type Overrides } from '../src/sim/config/balance.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

const FROM = 28;
const TO = 36;

/**
 * A lined pond under columns 28..36, dug and lined while BUILDING, then sealed, charged like the
 * reference jar, and filled. Digging after the seal would leave the jar sitting dry, which costs the
 * plants their early growth for reasons nothing to do with ponds (see docs/water-bodies.md).
 */
function pondJar(lamp: number, overrides: Overrides = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  tick(w);
  while (w.substrateDirty) tick(w);
  const g = w.grid;
  const base = g.yOf(g.surfaceOfColumn[32]);
  for (let dy = 0; dy <= 2; dy++) {
    for (let x = FROM; x <= TO; x++) {
      w.paint(x, base + dy, Substrate.Air);
      tick(w);
    }
  }
  for (let i = 0; i < 100; i++) tick(w);
  w.commands.push({ t: 'paint', x: 32, y: base, material: Substrate.Mud });
  tick(w);
  while (w.substrateDirty) tick(w);
  w.commands.push({ t: 'setLamp', intensity: lamp });
  w.commands.push({ t: 'seal' });
  tick(w);
  const cols: number[] = [];
  for (let x = 1; x <= g.w - 2; x++) if (g.surfaceOfColumn[x] >= 0 && (x < FROM || x > TO)) cols.push(x);
  for (const x of cols) w.commands.push({ t: 'water', x, ml: 2400 / cols.length, spread: 0 });
  for (let k = 0; k < 12; k++) w.commands.push({ t: 'water', x: 32, ml: 30, spread: 0 });
  for (let i = 0; i < 200; i++) tick(w);
  return { w, base };
}

/** Litter landing in the pond, as leaves from a plant overhanging it would. */
const drop = (w: World, units: number) => {
  for (let x = FROM; x <= TO; x++) w.grid.organic[w.grid.surfaceOfColumn[x]] += units;
};

const days = (w: World, d: number) => {
  for (let i = 0; i < d * 1440; i++) tick(w);
};

const green = (w: World) => {
  let most = 0;
  for (let x = FROM; x <= TO; x++) most = Math.max(most, w.pond.greenness(w.cfg, x));
  return most;
};

describe('algae', () => {
  it('rots the litter that falls into a pond, instead of leaving it on the floor forever', () => {
    /*
     * The stuck-litter gap: decay only ever ran in soil, and a pond floor is mud, so a leaf that fell
     * into a pond never broke down at all. It locked its carbon and its food away for good.
     */
    const { w } = pondJar(0.6);
    drop(w, 3);
    const before = w.grid.organic[w.grid.surfaceOfColumn[32]];
    days(w, 5);
    expect(w.grid.organic[w.grid.surfaceOfColumn[32]]).toBeLessThan(before * 0.5);
    let food = 0;
    for (let x = FROM; x <= TO; x++) food += w.pond.nutrients[x] + w.pond.algae[x];
    expect(food).toBeGreaterThan(0);
  });

  it('greens a bright pond that keeps being fed, and leaves the same pond clear in shade', () => {
    const run = (lamp: number) => {
      const { w } = pondJar(lamp);
      let peak = 0;
      for (let d = 0; d < 30; d++) {
        drop(w, 0.8);
        days(w, 1);
        peak = Math.max(peak, green(w));
      }
      return peak;
    };
    // Past the point the lesson calls green water...
    expect(run(1.0)).toBeGreaterThan(0.3);
    // ...and shade is the lever that prevents it.
    expect(run(0.25)).toBeLessThan(0.1);
  });

  it('keeps the carbon books closed while algae grow and die', () => {
    // A bloom fixes CO2 out of the air; the algae must be counted or that reads as a leak.
    const { w } = pondJar(1.0);
    drop(w, 3);
    tick(w);
    const before = w.auditCarbonPpm();
    days(w, 12);
    // Enough algae to exercise the books; how green is another test's business.
    expect(green(w)).toBeGreaterThan(0.02);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(0.005);
  });

  it('sours the banks of a full, stale pond, and not those of one below its rim', () => {
    /*
     * A lined pond touches only mud. It meets bare soil when it is full to its rim, and then its stale
     * water sours the ground of its banks. Below the rim, the liner keeps everything in.
     */
    const bankToxin = (full: boolean) => {
      // Nothing moving water in or out, so the level stays where the test puts it.
      const { w, base } = pondJar(0.6, { standing: { evapFactor: 0, seepPerMin: 0, runoffPerMin: 0 } });
      const g = w.grid;
      if (!full) {
        // Everything at or above the rim's level taken away, so the water stands below the rim.
        for (let x = 1; x <= g.w - 2; x++) {
          for (let y = 1; y <= base; y++) {
            const i = g.idx(x, y);
            w.totalWaterAddedMl -= g.standing[i];
            g.standing[i] = 0;
          }
        }
        tick(w);
      }
      // Stale water, well past the line where roots take damage.
      for (let x = FROM; x <= TO; x++) w.pond.sour[x] = 0.6 * (w.pond.water[x] / w.cfg.raw.standing.cellMl);
      let worst = 0;
      for (let i = 0; i < 1440; i++) {
        tick(w);
        for (const x of [24, 25, 26, 27, 37, 38, 39, 40]) worst = Math.max(worst, g.toxin[g.surfaceOfColumn[x]]);
      }
      return worst;
    };
    expect(bankToxin(true)).toBeGreaterThan(0.1);
    expect(bankToxin(false)).toBeLessThan(0.02);
  });

  it('feeds the pond with the soil a flood washes in', () => {
    // Over-watering beside a pond is the most familiar cause of green water there is.
    const { w } = pondJar(0.6);
    let before = 0;
    for (let x = FROM; x <= TO; x++) before += w.pond.nutrients[x] + w.pond.algae[x];
    for (let k = 0; k < 20; k++) w.commands.push({ t: 'water', x: 24, ml: 30, spread: 2 });
    for (let i = 0; i < 120; i++) tick(w);
    let after = 0;
    for (let x = FROM; x <= TO; x++) after += w.pond.nutrients[x] + w.pond.algae[x];
    expect(after).toBeGreaterThan(before);
  });
});

describe('lilies', () => {
  const cover = (w: World) => {
    const out: number[] = [];
    for (let x = FROM; x <= TO; x++) out.push(w.pond.lilies[x]);
    return out;
  };

  it('spreads across a pond from one click', () => {
    const { w } = pondJar(1.0);
    w.commands.push({ t: 'addLilies', x: 29 });
    drop(w, 1);
    days(w, 8);
    const c = cover(w);
    // Planted at one end; the far end has it too.
    expect(c[c.length - 1]).toBeGreaterThan(0.1);
  });

  it('keeps a bright, fed pond clear where the same pond without it turns green', () => {
    const run = (weed: boolean) => {
      const { w } = pondJar(1.0);
      if (weed) w.commands.push({ t: 'addLilies', x: 32 });
      let peak = 0;
      for (let d = 0; d < 14; d++) {
        drop(w, 0.8);
        days(w, 1);
        peak = Math.max(peak, green(w));
      }
      return peak;
    };
    const without = run(false);
    const withWeed = run(true);
    expect(without).toBeGreaterThan(0.15);
    expect(withWeed).toBeLessThan(without / 3);
  });

  it('slows the evaporation of the water it covers', () => {
    /*
     * Measured on the pond's own columns, and on a mat that is FED. An unfed mat starves back to a
     * fraction of the surface within days, as lilies in clear water do, and then shields almost
     * nothing; the overflow film soaking into the ground around the pond would swamp the rest.
     */
    const pondMl = (w: World) => {
      let s = 0;
      for (let x = FROM; x <= TO; x++) s += w.pond.water[x];
      return s;
    };
    const lost = (weed: boolean) => {
      // Nothing flowing back in, so what leaves the pond is only evaporation.
      const { w } = pondJar(1.0, { standing: { seepPerMin: 0, runoffPerMin: 0 } });
      if (weed) for (let k = 0; k < 4; k++) for (let x = FROM; x <= TO; x += 2) w.commands.push({ t: 'addLilies', x });
      drop(w, 1);
      days(w, 1);
      const before = pondMl(w);
      for (let d = 0; d < 3; d++) {
        drop(w, 0.5);
        days(w, 1);
      }
      return before - pondMl(w);
    };
    expect(lost(true)).toBeLessThan(lost(false) * 0.85);
  });

  it('refuses to float on dry ground, and dies back when its pond dries up', () => {
    const { w } = pondJar(0.6);
    const g = w.grid;
    w.commands.push({ t: 'addLilies', x: 10 });
    tick(w);
    expect(w.pond.lilies[10]).toBe(0);
    expect(w.events.some((e) => e.t === 'plantRefused' && e.x === 10)).toBe(true);

    w.commands.push({ t: 'addLilies', x: 32 });
    tick(w);
    expect(w.pond.lilies[32]).toBeGreaterThan(0);
    const floor = g.surfaceOfColumn[32];
    const litterBefore = g.organic[floor];
    // The pond gone: every drop of free water taken out of the jar.
    for (let i = 0; i < g.size; i++) {
      w.totalWaterAddedMl -= g.standing[i];
      g.standing[i] = 0;
    }
    tick(w);
    expect(w.pond.lilies[32]).toBe(0);
    expect(g.organic[floor]).toBeGreaterThan(litterBefore);
  });

  it('keeps the carbon books closed as it is planted, grows and dies', () => {
    const { w } = pondJar(1.0);
    drop(w, 2);
    tick(w);
    const before = w.auditCarbonPpm();
    w.commands.push({ t: 'addLilies', x: 32 });
    days(w, 8);
    expect(Math.max(...cover(w))).toBeGreaterThan(0.2);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(0.005);
  });
});

describe('snails', () => {
  it('graze a pond that has already gone green back to clear', () => {
    // The usual order in play: the water turns green first, and the snails go in after.
    const { w } = pondJar(1.0);
    for (let d = 0; d < 12; d++) {
      drop(w, 0.8);
      days(w, 1);
    }
    const before = green(w);
    expect(before).toBeGreaterThan(0.1);
    w.commands.push({ t: 'addSnails', x: 32 });
    for (let d = 0; d < 6; d++) {
      drop(w, 0.8);
      days(w, 1);
    }
    expect(green(w)).toBeLessThan(before / 3);
  });

  it('keep a dormant few in a clean pond, and lose every one when the pond dries', () => {
    const { w } = pondJar(0.6);
    const g = w.grid;
    w.commands.push({ t: 'addSnails', x: 32 });
    days(w, 10);
    // Nothing much to eat, and they thin, but a colony is still there to come back from.
    expect(w.pond.snailCount()).toBeGreaterThan(0);

    for (let i = 0; i < g.size; i++) {
      w.totalWaterAddedMl -= g.standing[i];
      g.standing[i] = 0;
    }
    tick(w);
    expect(w.pond.snailCount()).toBe(0);
  });

  it('are killed by stale water: a bloom left to rot can wipe out its own cure', () => {
    const { w } = pondJar(0.6, { algae: { sourDecayPerMin: 0 } });
    w.commands.push({ t: 'addSnails', x: 32 });
    tick(w);
    const start = w.pond.snailCount();
    for (let i = 0; i < 2 * 1440; i++) {
      // Held well past what they can take.
      for (let x = FROM; x <= TO; x++) w.pond.sour[x] = 0.8 * (w.pond.water[x] / w.cfg.raw.standing.cellMl);
      tick(w);
    }
    expect(w.pond.snailCount()).toBeLessThan(start * 0.1);
  });

  it('hold on in a clean pond, living on the film on its surfaces', () => {
    // A culture put into a fresh pond with nothing growing in it used to halve inside twelve hours.
    const { w } = pondJar(0.6);
    w.commands.push({ t: 'addSnails', x: 32 });
    days(w, 3);
    expect(w.pond.snailCount()).toBeGreaterThanOrEqual(w.cfg.raw.snails.cultureSize);
  });

  it('are refused on dry ground', () => {
    const { w } = pondJar(0.6);
    w.commands.push({ t: 'addSnails', x: 10 });
    tick(w);
    expect(w.pond.snails[10]).toBe(0);
    expect(w.events.some((e) => e.t === 'plantRefused' && e.x === 10)).toBe(true);
  });

  it('keep the carbon books closed as they eat', () => {
    // What they eat is breathed straight back out; nothing may leak on the way.
    const { w } = pondJar(1.0);
    drop(w, 3);
    w.commands.push({ t: 'addSnails', x: 32 });
    tick(w);
    const before = w.auditCarbonPpm();
    days(w, 8);
    expect(w.pond.snailCount()).toBeGreaterThan(0);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(0.005);
  });
});

describe('hornwort', () => {
  it('keeps an ordinary pond clear where the bare one greens', () => {
    /*
     * An ORDINARY pond: the reference lamp, and fed only by what seeps in. Hornwort is everyday upkeep;
     * a pond being overfed under a bright lamp is more than it can hold back alone, which is what
     * lilies and snails are for.
     */
    const run = (plant: boolean) => {
      const { w } = pondJar(0.6);
      if (plant) w.commands.push({ t: 'addHornwort', x: 32 });
      let peak = 0;
      for (let d = 0; d < 16; d++) {
        days(w, 1);
        peak = Math.max(peak, green(w));
      }
      return peak;
    };
    const bare = run(false);
    expect(bare).toBeGreaterThan(0.15);
    expect(run(true)).toBeLessThan(bare / 2);
  });

  it('grows up through the pond from one planting', () => {
    const { w } = pondJar(0.8);
    w.commands.push({ t: 'addHornwort', x: 29 });
    drop(w, 1);
    days(w, 8);
    expect(w.pond.hornwort[29]).toBeGreaterThan(0.4);
    // And it has spread along the floor to the far end.
    expect(w.pond.hornwort[TO]).toBeGreaterThan(0.05);
  });

  it('is refused on dry ground, and keeps the carbon books closed', () => {
    const { w } = pondJar(1.0);
    w.commands.push({ t: 'addHornwort', x: 10 });
    tick(w);
    expect(w.pond.hornwort[10]).toBe(0);
    drop(w, 2);
    tick(w);
    const before = w.auditCarbonPpm();
    w.commands.push({ t: 'addHornwort', x: 32 });
    days(w, 8);
    expect(w.pond.hornwort[32]).toBeGreaterThan(0.2);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(0.005);
  });
});

describe('fish', () => {
  it('are never lost to the arithmetic of spreading across the pond', () => {
    /*
     * With births, starvation and stale water all switched off, the number of fish must not change.
     * It did: columns holding under a hundredth of a fish were rounded to zero, and fish spread into
     * the columns around them in exactly such trickles every tick, so three fish were gone in a day.
     */
    const { w } = pondJar(0.6, { fish: { breedPerMin: 0, starveDeathPerMin: 0, sourDeathPerMin: 0 } });
    w.commands.push({ t: 'addFish', x: 30 });
    tick(w);
    const start = w.pond.fishCount();
    days(w, 2);
    expect(w.pond.fishCount()).toBeCloseTo(start, 6);
  });

  it('live on in an ordinary pond, and go hungry only slowly in a spotless one', () => {
    const { w } = pondJar(0.6);
    w.commands.push({ t: 'addFish', x: 32 });
    days(w, 14);
    expect(w.pond.fishCount()).toBeGreaterThan(2);

    // Nothing to eat at all: hungry, not dead overnight.
    const bare = pondJar(0.6, { algae: { growthPerMin: 0 } }).w;
    bare.commands.push({ t: 'addFish', x: 32 });
    days(bare, 3);
    expect(bare.pond.fishCount()).toBeGreaterThan(2.3);
  });

  it('thrive in a pond kept clear by lilies and hornwort', () => {
    /*
     * The pond a player is being praised for. Fish used to starve in it: their meal counted an algae
     * appetite a clear pond could never fill, and three fish were under two in twenty days.
     */
    const { w } = pondJar(0.6);
    w.commands.push({ t: 'addLilies', x: 32 });
    w.commands.push({ t: 'addHornwort', x: 32 });
    w.commands.push({ t: 'addFish', x: 32 });
    tick(w);
    const start = w.pond.fishCount();
    days(w, 20);
    expect(w.pond.fishCount()).toBeGreaterThanOrEqual(start * 0.95);
  });

  it('starve back toward what the pond can feed when it is overstocked', () => {
    const { w } = pondJar(0.6);
    for (let k = 0; k < 5; k++) w.commands.push({ t: 'addFish', x: 32 });
    tick(w);
    const stocked = w.pond.fishCount();
    days(w, 20);
    expect(w.pond.fishCount()).toBeLessThan(stocked * 0.85);
    expect(w.pond.fishCount()).toBeGreaterThan(1);
  });

  it('die when the pond dries up, and in stale water', () => {
    const { w } = pondJar(0.6);
    const g = w.grid;
    w.commands.push({ t: 'addFish', x: 32 });
    tick(w);
    for (let i = 0; i < g.size; i++) {
      w.totalWaterAddedMl -= g.standing[i];
      g.standing[i] = 0;
    }
    tick(w);
    expect(w.pond.fishCount()).toBe(0);

    const stale = pondJar(0.6, { algae: { sourDecayPerMin: 0 } }).w;
    stale.commands.push({ t: 'addFish', x: 32 });
    tick(stale);
    for (let i = 0; i < 2 * 1440; i++) {
      for (let x = FROM; x <= TO; x++) stale.pond.sour[x] = 0.9 * (stale.pond.water[x] / stale.cfg.raw.standing.cellMl);
      tick(stale);
    }
    expect(stale.pond.fishCount()).toBeLessThan(0.3);
  });

  it('are refused on dry ground, and keep the carbon books closed', () => {
    const { w } = pondJar(0.8);
    w.commands.push({ t: 'addFish', x: 10 });
    tick(w);
    expect(w.pond.fish[10]).toBe(0);
    drop(w, 2);
    w.commands.push({ t: 'addFish', x: 32 });
    tick(w);
    const before = w.auditCarbonPpm();
    days(w, 8);
    expect(w.pond.fishCount()).toBeGreaterThan(0);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(0.005);
  });
});

describe('reeds', () => {
  /** The pond's two edge columns, and the bank column one out beyond each. */
  const edges = (w: World) => {
    let first = -1;
    let last = -1;
    for (let x = 1; x <= w.grid.w - 2; x++) {
      if (!w.pond.isPond(x)) continue;
      if (first < 0) first = x;
      last = x;
    }
    return { first, last, leftBank: first - 1, rightBank: last + 1 };
  };

  it('grow only at the edges of a pond and on the bank one tile out', () => {
    const { w } = pondJar(0.6);
    const e = edges(w);
    expect(e.last - e.first).toBeGreaterThan(3);
    for (const x of [e.first, e.last, e.leftBank, e.rightBank]) {
      expect(w.pond.canHoldReeds(x)).toBe(true);
    }
    // Not in the middle of the pond, and not two tiles out onto the bank.
    for (const x of [e.first + 2, Math.round((e.first + e.last) / 2), e.last - 2, e.leftBank - 1, e.rightBank + 1]) {
      expect(w.pond.canHoldReeds(x)).toBe(false);
    }
  });

  it('are refused two tiles out, and taken at the edge and the bank', () => {
    const { w } = pondJar(0.6);
    const e = edges(w);
    for (const x of [e.rightBank + 1, e.last, e.rightBank]) w.commands.push({ t: 'addReeds', x });
    tick(w);
    expect(w.pond.reeds[e.rightBank + 1]).toBe(0);
    expect(w.pond.reeds[e.last]).toBeGreaterThan(0);
    expect(w.pond.reeds[e.rightBank]).toBeGreaterThan(0);
    // One side clicked, one side planted.
    expect(w.pond.reeds[e.first]).toBe(0);
  });

  it('go in at both edges when the middle of a pond is clicked, never in the middle itself', () => {
    const { w } = pondJar(0.6);
    const e = edges(w);
    const mid = Math.round((e.first + e.last) / 2);
    w.commands.push({ t: 'addReeds', x: mid });
    tick(w);
    expect(w.pond.reeds[mid]).toBe(0);
    expect(w.pond.reeds[e.first]).toBeGreaterThan(0);
    expect(w.pond.reeds[e.last]).toBeGreaterThan(0);
    expect(w.events.some((ev) => ev.t === 'reedsPlanted')).toBe(true);
  });

  it('spread between the edge and its bank, never along the pond into its middle', () => {
    const { w } = pondJar(0.6);
    const e = edges(w);
    w.commands.push({ t: 'addReeds', x: e.last });
    days(w, 20);
    expect(w.pond.reeds[e.last]).toBeGreaterThan(0.1);
    expect(w.pond.reeds[e.rightBank]).toBeGreaterThan(0.05);
    for (let x = e.first + 1; x < e.last; x++) expect(w.pond.reeds[x]).toBe(0);
  });

  it('draw the pond up into the air faster than open water alone', () => {
    const lost = (plant: boolean) => {
      const { w } = pondJar(0.8, { standing: { seepPerMin: 0, runoffPerMin: 0 } });
      if (plant) {
        const e = edges(w);
        for (let k = 0; k < 5; k++) for (const x of [e.first, e.last, e.leftBank, e.rightBank]) w.commands.push({ t: 'addReeds', x });
      }
      tick(w);
      const before = w.grid.standingMl();
      days(w, 3);
      return before - w.grid.standingMl();
    };
    expect(lost(true)).toBeGreaterThan(lost(false) * 1.2);
  });

  it('ride out a dry spell, dying back slowly rather than at once', () => {
    /*
     * Nothing may refill the pond, or damp ground seeps back into it within hours and the reeds are
     * not in a dry spell at all. And the whole bed is measured, since reeds spread to the bank.
     */
    const { w } = pondJar(0.6, { standing: { seepPerMin: 0, runoffPerMin: 0 } });
    const g = w.grid;
    const e = edges(w);
    for (let k = 0; k < 4; k++) w.commands.push({ t: 'addReeds', x: e.last });
    tick(w);
    const bed = () => w.pond.reeds.reduce((a, v) => a + v, 0);
    const planted = bed();
    for (let i = 0; i < g.size; i++) {
      w.totalWaterAddedMl -= g.standing[i];
      g.standing[i] = 0;
    }
    days(w, 1);
    expect(bed()).toBeGreaterThan(planted * 0.7);
    expect(bed()).toBeLessThan(planted);
  });

  it('are refused on dry ground, and keep the carbon books closed', () => {
    const { w } = pondJar(0.8);
    w.commands.push({ t: 'addReeds', x: 10 });
    tick(w);
    expect(w.pond.reeds[10]).toBe(0);
    drop(w, 2);
    tick(w);
    const before = w.auditCarbonPpm();
    const e = edges(w);
    w.commands.push({ t: 'addReeds', x: e.last });
    w.commands.push({ t: 'addReeds', x: e.rightBank });
    days(w, 8);
    expect(Math.max(...w.pond.reeds)).toBeGreaterThan(0.1);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(0.005);
  });
});

describe('bigger ponds', () => {
  /** A pond dug under `from`..`to`, `depth` deep, lined with one click, sealed and charged. */
  const bigPond = (from: number, to: number, depth: number) => {
    const w = new World(cloneBalance());
    w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
    tick(w);
    while (w.substrateDirty) tick(w);
    const g = w.grid;
    const mid = Math.round((from + to) / 2);
    const base = g.yOf(g.surfaceOfColumn[mid]);
    for (let dy = 0; dy < depth; dy++) {
      for (let x = from; x <= to; x++) {
        w.paint(x, base + dy, Substrate.Air);
        tick(w);
      }
    }
    for (let i = 0; i < 100; i++) tick(w);
    const before = g.substrate.filter((v) => v === Substrate.Mud).length;
    w.commands.push({ t: 'paint', x: mid, y: base, material: Substrate.Mud });
    tick(w);
    while (w.substrateDirty) tick(w);
    const lined = g.substrate.filter((v) => v === Substrate.Mud).length - before;
    w.commands.push({ t: 'setLamp', intensity: 0.6 });
    w.commands.push({ t: 'seal' });
    tick(w);
    const cols: number[] = [];
    for (let x = 1; x <= g.w - 2; x++) if (g.surfaceOfColumn[x] >= 0 && (x < from || x > to)) cols.push(x);
    for (const x of cols) w.commands.push({ t: 'water', x, ml: 2400 / cols.length, spread: 0 });
    return { w, lined, mid };
  };

  it('lines a pond far wider than the old 24-column limit in one click, and it holds', () => {
    // The limit was there to stop the liner lining the undug jar between its own rounded corners. It
    // also made every pond wider than it impossible to line; the liner now checks what was dug instead.
    const { w, lined } = bigPond(10, 54, 3);
    expect(lined).toBeGreaterThan(40);
    for (let k = 0; k < 70; k++) {
      w.commands.push({ t: 'water', x: 10 + (k % 45), ml: 24, spread: 2 });
      tick(w);
    }
    for (let i = 0; i < 200; i++) tick(w);
    const filled = w.grid.standingMl();
    expect(filled).toBeGreaterThan(1000);
    days(w, 10);
    expect(w.grid.standingMl()).toBeGreaterThan(filled * 0.85);
  });

  it('keeps its plants when it is overfilled, as holding the watering can a few seconds does', () => {
    /*
     * A small pond holds about 300 mL, and the can pours 240 mL a second, so overfilling is the
     * ordinary case. The flood that stands over an overfilled pond used to count as pond: its food was
     * spread across the whole wet surface of the jar, and lilies starved within five days.
     */
    const { w } = pondJar(0.6);
    for (let k = 0; k < 42; k++) {
      w.commands.push({ t: 'water', x: 28 + (k % 9), ml: 24, spread: 2 });
      tick(w);
    }
    for (let i = 0; i < 200; i++) tick(w);
    w.commands.push({ t: 'addLilies', x: 32 });
    w.commands.push({ t: 'addHornwort', x: 32 });
    days(w, 10);
    expect(cover(w, 'lilies')).toBeGreaterThan(0.6);
    expect(cover(w, 'hornwort')).toBeGreaterThan(0.3);
  });

  it('keeps pond life out of the flood over ordinary ground', () => {
    const { w } = pondJar(0.6);
    for (let k = 0; k < 200; k++) {
      w.commands.push({ t: 'water', x: 28 + (k % 9), ml: 24, spread: 2 });
      tick(w);
    }
    for (let i = 0; i < 200; i++) tick(w);
    w.commands.push({ t: 'addFish', x: 32 });
    days(w, 2);
    // Water stands over the soil beside the pond, but nothing from the pond lives in it.
    for (const x of [20, 24, 40, 44]) {
      expect(w.pond.fish[x]).toBe(0);
      expect(w.pond.isPond(x)).toBe(false);
    }
  });
});

/** Mean cover of a pond plant across the pond. */
function cover(w: World, plant: 'lilies' | 'hornwort'): number {
  let sum = 0;
  for (let x = FROM; x <= TO; x++) sum += w.pond[plant][x];
  return sum / (TO - FROM + 1);
}


describe('clearing a pond', () => {
  /** A pond with every plant in it, fish and snails, and a bloom, a few days in. */
  const planted = () => {
    const { w } = pondJar(1.0);
    let first = -1;
    let last = -1;
    for (let x = 1; x <= w.grid.w - 2; x++) {
      if (!w.pond.isPond(x)) continue;
      if (first < 0) first = x;
      last = x;
    }
    w.commands.push({ t: 'addLilies', x: 30 });
    w.commands.push({ t: 'addHornwort', x: 34 });
    w.commands.push({ t: 'addReeds', x: first });
    w.commands.push({ t: 'addReeds', x: last + 1 });
    w.commands.push({ t: 'addFish', x: 32 });
    w.commands.push({ t: 'addSnails', x: 32 });
    drop(w, 2);
    days(w, 4);
    // A pond this well kept stays clear on its own, so the bloom is set directly: this is about killing
    // one, not growing it. Every check of the books is taken after this.
    for (let x = first; x <= last; x++) w.pond.algae[x] = 0.3;
    return { w, first, last };
  };
  const total = (field: Float64Array) => field.reduce((s, v) => s + v, 0);

  it('kills every plant in the pond from one click, bank reeds included, and spares the animals', () => {
    const { w, last } = planted();
    const p = w.pond;
    expect(total(p.lilies)).toBeGreaterThan(0);
    expect(total(p.hornwort)).toBeGreaterThan(0);
    expect(p.reeds[last + 1]).toBeGreaterThan(0);
    expect(total(p.algae)).toBeGreaterThan(0);
    const fish = p.fishCount();
    const snails = p.snailCount();
    const sour = total(p.sour);
    w.commands.push({ t: 'clearPond', x: 32 });
    tick(w);
    expect(total(p.lilies)).toBe(0);
    expect(total(p.hornwort)).toBe(0);
    expect(total(p.reeds)).toBe(0);
    // The spores are always there, so a trace may start again within the tick; the bloom itself is gone.
    expect(total(p.algae)).toBeLessThan(1e-3);
    expect(p.fishCount()).toBeGreaterThan(fish * 0.99);
    expect(p.snailCount()).toBeGreaterThan(snails * 0.99);
    // A bloom killed all at once sours the water, as one dying back on its own does.
    expect(total(p.sour)).toBeGreaterThan(sour);
    expect(w.events.some((e) => e.t === 'pondCleared')).toBe(true);
  });

  it('leaves the dead plants in the jar as litter, keeping the carbon books closed', () => {
    const { w, first, last } = planted();
    let litter = 0;
    for (let x = first - 1; x <= last + 1; x++) litter += w.grid.organic[w.grid.surfaceOfColumn[x]];
    const before = w.auditCarbonPpm();
    w.commands.push({ t: 'clearPond', x: 32 });
    tick(w);
    let after = 0;
    for (let x = first - 1; x <= last + 1; x++) after += w.grid.organic[w.grid.surfaceOfColumn[x]];
    expect(after).toBeGreaterThan(litter);
    expect(Math.abs(w.auditCarbonPpm() - before) / before).toBeLessThan(1e-3);
    // And that litter rots back into the water as food, which is what lets algae return.
    let food = 0;
    for (let x = first; x <= last; x++) food += w.pond.nutrients[x];
    days(w, 3);
    let later = 0;
    for (let x = first; x <= last; x++) later += w.pond.nutrients[x] + w.pond.algae[x];
    expect(later).toBeGreaterThan(food);
  });

  it('clears the pond a bank reed lives on when the bank is clicked, and refuses dry ground', () => {
    const { w, last } = planted();
    w.commands.push({ t: 'clearPond', x: 10 });
    tick(w);
    expect(w.events.some((e) => e.t === 'plantRefused' && e.x === 10)).toBe(true);
    expect(total(w.pond.lilies)).toBeGreaterThan(0);
    w.commands.push({ t: 'clearPond', x: last + 1 });
    tick(w);
    expect(total(w.pond.lilies)).toBe(0);
    expect(total(w.pond.reeds)).toBe(0);
  });
});

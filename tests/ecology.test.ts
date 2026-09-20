// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The detritus economy: litter, decomposers, toxins, mold, and the carbon loop that ties them
 * together. These are the systems that turn the jar from a plant in a box into an ecosystem.
 */

import { describe, expect, it } from 'vitest';
import { cloneBalance, type BalanceConfig, type DeepPartial } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';
import { runScenario, SCENARIOS } from '../tools/harness.js';

function jar(overrides: DeepPartial<BalanceConfig> = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  while (w.substrateDirty) tick(w);
  return w;
}

/** Wet the whole substrate and let it settle, so decay and fauna have workable conditions. */
function prime(w: World, ml = 2400): void {
  const cols: number[] = [];
  for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) cols.push(x);
  for (const x of cols) w.commands.push({ t: 'water', x, ml: ml / cols.length });
  for (let i = 0; i < 200; i++) tick(w);
}

describe('litter and decay', () => {
  it('returns nutrients at well under 100%, so the jar always runs downhill', () => {
    const w = jar();
    prime(w);
    const s = w.grid.surfaceOfColumn[32];
    w.grid.organic[s] = 40;
    w.grid.nutrients[s] = 0;

    for (let i = 0; i < 20000; i++) tick(w);

    const consumed = 40 - w.grid.organic[s];
    expect(consumed).toBeGreaterThan(1);
    // Nutrients spread by leaching, so measure the whole jar rather than the one cell.
    let recovered = 0;
    for (const i of w.grid.activeCells) recovered += w.grid.nutrients[i];
    const baseline = w.cfg.raw.water.soilStartingNutrients;
    let soilCells = 0;
    for (const i of w.grid.activeCells) if (w.grid.substrate[i] === Substrate.Soil) soilCells++;

    const fromLitter = recovered - baseline * soilCells;
    // Strictly less than the litter consumed: the missing fraction is the drain that stops a sealed
    // jar settling into a screensaver.
    expect(fromLitter).toBeLessThan(consumed);
  });

  it('decays faster in warm damp substrate than in a cold jar', () => {
    const run = (ambientC: number) => {
      const w = jar({ thermal: { ambientC, lampDeltaC: 0 } });
      w.commands.push({ t: 'setLamp', intensity: 0 });
      prime(w);
      const s = w.grid.surfaceOfColumn[32];
      w.grid.organic[s] = 50;
      for (let i = 0; i < 6000; i++) tick(w);
      return 50 - w.grid.organic[s];
    };
    expect(run(24)).toBeGreaterThan(run(6));
  });

  it('drops litter when a leaf falls, giving the decomposers a supply', () => {
    const w = jar();
    prime(w);
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });

    let dropped = 0;
    for (let i = 0; i < 30000; i++) {
      tick(w);
      for (const e of w.events) if (e.t === 'leafDropped') dropped++;
    }
    // Leaves senesce and fall even in a healthy jar — that is the whole point of a lifespan.
    expect(dropped).toBeGreaterThan(0);
    expect(w.totalLitter()).toBeGreaterThan(0);
  });
});

describe('springtails', () => {
  it('eat litter and hand back nutrients where they are working', () => {
    const w = jar();
    prime(w);
    const s = w.grid.surfaceOfColumn[32];
    w.grid.organic[s] = 30;
    w.grid.nutrients[s] = 0;
    w.commands.push({ t: 'addSpringtails', x: 32, y: w.grid.yOf(s) });
    tick(w);
    expect(w.fauna.pop[s]).toBeGreaterThan(0);

    const before = w.grid.organic[s];
    for (let i = 0; i < 3000; i++) tick(w);
    expect(w.grid.organic[s]).toBeLessThan(before);
  });

  it('tracks its food supply: a colony grows on a pile and falls back when it is gone', () => {
    const w = jar();
    prime(w);
    const s = w.grid.surfaceOfColumn[32];
    w.grid.organic[s] = 60;
    w.commands.push({ t: 'addSpringtails', x: 32, y: w.grid.yOf(s) });
    tick(w);

    let peak = 0;
    for (let i = 0; i < 40000; i++) {
      tick(w);
      peak = Math.max(peak, w.faunaPopulation);
    }
    // It booms on the pile...
    expect(peak).toBeGreaterThan(w.cfg.raw.fauna.springtail.cultureSize);
    // ...and falls back once the pile is eaten, rather than growing without bound.
    expect(w.faunaPopulation).toBeLessThan(peak);
  });

  it('falls dormant rather than dying out when starved, so the jar can recover', () => {
    const w = jar();
    prime(w);
    const s = w.grid.surfaceOfColumn[32];
    w.commands.push({ t: 'addSpringtails', x: 32, y: w.grid.yOf(s) });
    tick(w);
    w.grid.organic[s] = 0;

    // Starve them hard. Breeding is proportional to population, so reaching zero would be permanent.
    for (let i = 0; i < 30000; i++) tick(w);
    expect(w.faunaPopulation).toBeGreaterThan(0);

    // Now feed them again — a dormant colony has to be able to come back.
    //
    // Litter goes across a stretch of surface rather than into the single cell they started in,
    // because that is how leaf fall actually works and because a starved colony wanders: pinning the
    // food to one exact cell tests their luck at finding it, not their ability to recover.
    const low = w.faunaPopulation;
    for (let x = 1; x <= w.grid.w - 2; x++) {
      const cell = w.grid.surfaceOfColumn[x];
      if (cell >= 0) w.grid.organic[cell] = 8;
    }

    // Track the PEAK, not the endpoint: the colony booms on the new pile, eats it, and settles back to
    // dormancy. Sampling only at the end would measure the far side of the recovery and miss it.
    let peak = 0;
    for (let i = 0; i < 20000; i++) {
      tick(w);
      peak = Math.max(peak, w.faunaPopulation);
    }
    expect(peak).toBeGreaterThan(low * 10);
  });

  it('actually dies when the substrate dries out, so desiccation stays a real failure', () => {
    const w = jar({ atmosphere: { evapMlPerMinAtFullDrive: 3 }, thermal: { lampDeltaC: 20 } });
    prime(w, 200);
    const s = w.grid.surfaceOfColumn[32];
    w.grid.organic[s] = 50;
    w.commands.push({ t: 'addSpringtails', x: 32, y: w.grid.yOf(s) });
    w.commands.push({ t: 'setLamp', intensity: 1 });
    tick(w);

    for (let i = 0; i < 20000; i++) tick(w);
    // Desiccation kills outright — unlike starvation, it is not survivable as dormancy.
    expect(w.faunaPopulation).toBe(0);
  });
});

describe('springtail foraging', () => {
  /**
   * The exact bug a 50-day playthrough exposed: the panel read "leaf litter: piling up" and
   * "springtails: dormant" simultaneously for 35 sim-days. Movement was gated on `pop >= 1` while the
   * dormant floor sits at 0.25, so a starved colony was frozen in place permanently — a few cells
   * below an ever-growing food pile it could never reach.
   */
  it('escapes a dead zone and finds litter buried above it', () => {
    const w = jar();
    prime(w);
    const g = w.grid;
    const surface = g.surfaceOfColumn[32];
    const buried = surface + g.w * 4;

    w.fauna.pop[buried] = w.cfg.raw.fauna.springtail.dormantFloor;
    g.organic[surface] = 40;

    // Track the PEAK: once the pile is eaten the colony correctly crashes back to dormant, so the
    // end state says nothing about whether it ever got there.
    let peak = 0;
    for (let i = 0; i < 20000; i++) {
      tick(w);
      peak = Math.max(peak, w.faunaPopulation);
    }

    // They found it, ate it, and the colony grew on the back of it.
    expect(g.organic[surface]).toBeLessThan(20);
    expect(peak).toBeGreaterThan(w.cfg.raw.fauna.springtail.dormantFloor * 4);
  });

  /**
   * Guards the trap that letting dormant colonies move creates. The dormant floor is applied per-cell,
   * so a colony that SPLITS while dormant gets both halves floored back up to 0.25 — doubling the
   * population on every hop until springtails carpet the jar for free and the tool means nothing.
   * Dormant colonies therefore migrate whole, leaving the source at exactly zero.
   */
  it('does not multiply while wandering a jar with no food in it', () => {
    const w = jar();
    prime(w);
    for (const i of w.grid.activeCells) {
      w.grid.organic[i] = 0;
      w.grid.mold[i] = 0;
    }
    const start = w.cfg.raw.fauna.springtail.dormantFloor;
    w.fauna.pop[w.grid.surfaceOfColumn[32]] = start;

    let peak = 0;
    for (let i = 0; i < 20000; i++) {
      tick(w);
      for (const idx of w.grid.activeCells) w.grid.organic[idx] = 0;
      peak = Math.max(peak, w.fauna.total());
    }
    expect(peak).toBeLessThanOrEqual(start * 1.01);
  });

  it('seeds a culture into the litter layer regardless of where the player clicked', () => {
    const w = jar();
    prime(w);
    const g = w.grid;
    const surface = g.surfaceOfColumn[32];

    // Click deep in the soil body, the way a player pointing at "the soil" naturally would.
    w.commands.push({ t: 'addSpringtails', x: 32, y: g.yOf(surface) + 5 });
    tick(w);

    // It lands on the surface, where litter actually falls — not where the cursor happened to be.
    expect(w.fauna.pop[surface]).toBeGreaterThan(0);
  });
});

describe('moss', () => {
  const mossJar = () => {
    const w = jar();
    prime(w);
    w.commands.push({ t: 'setLamp', intensity: 0.35 });
    for (const x of [10, 22, 34, 46, 58]) w.commands.push({ t: 'addMoss', x });
    tick(w);
    return w;
  };

  it('establishes and creeps outward from the patches it was planted on', () => {
    const w = mossJar();
    for (let i = 0; i < 20000; i++) tick(w);
    expect(w.mossCover()).toBeGreaterThan(0.3);
  });

  it('survives the night — darkness pauses growth but must not kill the mat', () => {
    const w = mossJar();
    // Well over a full day/night cycle. Treating darkness as a stress condition wiped every mat out
    // within one night, which made moss impossible to establish at all.
    for (let i = 0; i < 4000; i++) tick(w);
    expect(w.moss.total()).toBeGreaterThan(0);
  });

  it('leaves the soil richer than the same jar without it', () => {
    const soil = (w: World) => {
      let s = 0;
      for (const i of w.grid.activeCells) s += w.grid.nutrients[i];
      return s;
    };
    const withMoss = mossJar();
    const bare = jar();
    prime(bare);
    bare.commands.push({ t: 'setLamp', intensity: 0.35 });
    tick(bare);

    for (const w of [withMoss, bare]) {
      for (const x of [16, 32, 48]) w.commands.push({ t: 'plantSeed', x, species: SpeciesId.Herb });
      for (let i = 0; i < 40000; i++) tick(w);
    }
    expect(soil(withMoss)).toBeGreaterThan(soil(bare));
  });

  it('crowds mold out of the damp surface it wants', () => {
    const withMoss = runScenario(
      { ...SCENARIOS.swampy, moss: [6, 14, 22, 30, 38, 46, 54], name: 'swampy+moss' },
      30,
    );
    const bare = runScenario(SCENARIOS.swampy, 30);

    // Measured as mold MASS, not coverage. In a permanently fogged jar mold reaches every damp cell
    // either way, so "what fraction of cells have any mold at all" cannot tell a suppressed jar from
    // an overrun one — the mat caps how far mold takes each cell, and that only shows up in mass.
    const last = (r: typeof bare) => r.samples.at(-1)!;
    expect(last(withMoss).moldMass).toBeLessThan(last(bare).moldMass * 0.75);
  });

  it('keeps carbon conserved — a growing mat is biomass, not carbon from nowhere', () => {
    const r = runScenario(SCENARIOS.mossy, 30);
    expect(r.error).toBeUndefined();
    const first = r.samples[0].carbon;
    const last = r.samples.at(-1)!.carbon;
    expect(Math.abs((last - first) / first)).toBeLessThan(0.03);
  });
});

describe('the carbon loop', () => {
  it('conserves carbon: decomposing a leaf returns what building it took', () => {
    const c = cloneBalance();
    const built = c.plant.growth.sugarCostPerNode * c.plant.photosynthesis.co2PpmPerUnit;
    const returned = c.decay.leafLitterMass * c.decay.co2PpmPerUnit;
    // If these drift apart the jar becomes a carbon fountain or a carbon sink, and CO2 runs away in
    // one direction no matter how the rest of the sim is tuned.
    expect(returned).toBeCloseTo(built, 6);
  });

  it('keeps a well-built jar off the CO2 floor for a sim-month', () => {
    const r = runScenario(SCENARIOS['well-built'], 30);
    expect(r.error).toBeUndefined();
    for (const s of r.samples.slice(10)) {
      expect(s.co2).toBeGreaterThan(cloneBalance().atmosphere.co2.stallBelowPpm);
    }
  });

  it('grows a bigger, better-flowering jar when decomposers are present', () => {
    const withFauna = runScenario(SCENARIOS['overplanted-fauna'], 40);
    const without = runScenario(SCENARIOS.overplanted, 40);
    expect(withFauna.error).toBeUndefined();
    expect(without.error).toBeUndefined();

    const last = (r: typeof withFauna) => r.samples.at(-1)!;
    // Recycled litter means recycled fertility, which buys more plant and more blooms.
    expect(last(withFauna).litter).toBeLessThan(last(without).litter);
    expect(last(withFauna).flowers).toBeGreaterThan(last(without).flowers);
  });
});

describe('charcoal and toxins', () => {
  it('neutralises toxins that decay leaves behind', () => {
    // Identical soil depth in both jars, so the ONLY difference is what sits under it: a charcoal band
    // versus the same thickness of inert gravel. Comparing jars with different soil volumes would
    // confound the result, since the same toxin spread through fewer cells simply reads higher.
    const withChar = new World(cloneBalance());
    withChar.commands.push({ t: 'layerBands', gravelRows: 3, charcoalRows: 4, soilRows: 9 });
    withChar.commands.push({ t: 'seal' });
    tick(withChar);
    while (withChar.substrateDirty) tick(withChar);

    const noChar = new World(cloneBalance());
    noChar.commands.push({ t: 'layerBands', gravelRows: 7, charcoalRows: 0, soilRows: 9 });
    noChar.commands.push({ t: 'seal' });
    tick(noChar);
    while (noChar.substrateDirty) tick(noChar);

    /**
     * Toxin in the SOIL only.
     *
     * Counting the whole jar would count the toxin sitting inside the charcoal itself — which is the
     * layer succeeding, not failing. What matters is whether the root zone stays clean.
     */
    const soilToxin = (w: World) => {
      let t = 0;
      for (const i of w.grid.activeCells) {
        if (w.grid.substrate[i] === Substrate.Soil) t += w.grid.toxin[i];
      }
      return t;
    };

    for (const w of [withChar, noChar]) {
      prime(w);
      const cols: number[] = [];
      for (let x = 1; x <= w.grid.w - 2; x++) {
        const s = w.grid.surfaceOfColumn[x];
        if (s >= 0) {
          w.grid.organic[s] = 20;
          cols.push(x);
        }
      }
      // Water periodically. Charcoal cleans what passes THROUGH it, so a jar nobody ever waters gives
      // it nothing to work on — the toxins simply sit in the surface layer where they were made. This
      // is the real behaviour, not a workaround: the layer earns its keep when water moves down.
      for (let i = 0; i < 20000; i++) {
        if (i % 900 === 0) for (const x of cols) w.commands.push({ t: 'water', x, ml: 1.2 });
        tick(w);
      }
    }

    expect(soilToxin(withChar)).toBeLessThan(soilToxin(noChar));
  });

  /*
   * Reads `charcoalLoad`, not `toxin`, and the distinction is the whole point.
   *
   * This test used to fill `grid.toxin` on the charcoal cells by hand, because that is where capacity
   * was measured from. It passed for as long as it existed while the mechanic underneath it was dead:
   * nothing in the running simulation ever left toxin sitting in charcoal, since `filterToxins`
   * scrubbed those cells too, so a real jar reported 100% capacity forever. A white-box test that sets
   * the field itself cannot notice that nothing else ever does.
   *
   * Bound load now has its own array, and the assertion is unchanged: a full layer reads as spent.
   */
  it('reports capacity that falls as the layer loads up', () => {
    const w = jar();
    expect(w.charcoalCapacity()).toBeCloseTo(1, 2);
    const cap = w.cfg.raw.decay.charcoalToxinCapacity;
    for (const i of w.grid.activeCells) {
      if (w.grid.substrate[i] === Substrate.Charcoal) w.grid.charcoalLoad[i] = cap;
    }
    expect(w.charcoalCapacity()).toBeCloseTo(0, 2);
  });

  /*
   * Drives the real adsorption path rather than a whole jar.
   *
   * A full-jar version of this was tried and is a bad test: with no plants there is no transpiration
   * and so no percolation, surface toxin never reaches the layer, and it takes twenty seconds to
   * report nothing. Putting toxin in the soil the layer actually touches tests `filterToxins` itself,
   * in a fraction of a second.
   */
  it('binds the toxin it filters, and renews when the layer is replaced', () => {
    const w = jar();
    expect(w.charcoalCapacity()).toBeCloseTo(1, 2);

    // Soil sitting directly on the charcoal — the cells the band draws from.
    const soilOnTop: number[] = [];
    for (const i of w.grid.activeCells) {
      if (w.grid.substrate[i] !== Substrate.Charcoal) continue;
      const above = i - w.grid.w;
      if (w.grid.substrate[above] === Substrate.Soil) soilOnTop.push(above);
    }
    expect(soilOnTop.length).toBeGreaterThan(0);
    for (const i of soilOnTop) w.grid.toxin[i] = 1;

    for (let i = 0; i < 600; i++) tick(w);

    // The toxin left the soil and is now HELD by the layer, which is therefore partly spent.
    const worstSoil = Math.max(...soilOnTop.map((i) => w.grid.toxin[i]));
    expect(worstSoil).toBeLessThan(0.5);
    const spent = w.charcoalCapacity();
    expect(spent).toBeLessThan(0.95);

    // Repainting charcoal ONTO charcoal is the maintenance action, and must actually renew it.
    for (const i of w.grid.activeCells) {
      if (w.grid.substrate[i] !== Substrate.Charcoal) continue;
      w.commands.push({ t: 'paint', x: w.grid.xOf(i), y: w.grid.yOf(i), material: Substrate.Charcoal });
    }
    tick(w);
    expect(w.charcoalCapacity()).toBeGreaterThan(spent + 0.02);
  });
});

describe('mold', () => {
  it('needs a sustained fog, not a momentary one', () => {
    const w = jar();
    prime(w, 9000);
    const s = w.grid.surfaceOfColumn[32];
    w.grid.organic[s] = 20;

    // A short damp spell must not be enough: the dwell counter exists precisely to absorb it.
    for (let i = 0; i < 60; i++) tick(w);
    expect(w.moldCoverage).toBe(0);
  });

  it('takes hold in a jar left fogged, and eats the litter that feeds it', () => {
    const r = runScenario(SCENARIOS.swampy, 30);
    expect(r.error).toBeUndefined();
    expect(r.samples.some((s) => s.moldCoverage > 0)).toBe(true);
  });

  it('stays out of a well-run jar entirely', () => {
    const r = runScenario(SCENARIOS['well-built'], 30);
    expect(r.samples.every((s) => s.moldCoverage === 0)).toBe(true);
  });
});

describe('nutrients', () => {
  it('travels downward with water, so surface litter can reach the root zone', () => {
    const w = jar({ atmosphere: { evapMlPerMinAtFullDrive: 0 } });
    const g = w.grid;
    const s = g.surfaceOfColumn[32];
    const below = s + g.w * 3;

    for (const i of g.activeCells) g.nutrients[i] = 0;
    g.nutrients[s] = 8;
    const before = g.nutrients[below];

    w.commands.push({ t: 'water', x: 32, ml: 60 });
    for (let i = 0; i < 400; i++) tick(w);

    // Leaching: without it, fertility released on the surface could never reach roots growing below.
    expect(g.nutrients[below]).toBeGreaterThan(before);
  });

  it('gates growth, so exhausted soil stops a plant even in perfect light', () => {
    const w = jar();
    prime(w);
    for (const i of w.grid.activeCells) w.grid.nutrients[i] = 0;
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });

    for (let i = 0; i < 8000; i++) tick(w);
    const plant = w.plants[0];
    expect(plant.nutrientStarved).toBe(true);
    // It is a stall, not a death: the plant waits for fertility rather than dying of its absence.
    expect(plant.stage).not.toBe('dead');
  });
});

describe('flowering', () => {
  it('rewards a jar held in balance, and withholds from one that is merely surviving', () => {
    const good = runScenario(SCENARIOS['well-built'], 40);
    const bad = runScenario(SCENARIOS['cold-dry'], 40);
    expect(good.samples.at(-1)!.flowers).toBeGreaterThan(0);
    expect(bad.samples.at(-1)!.flowers).toBe(0);
  });
});

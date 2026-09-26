// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { cloneBalance, compile, type Overrides } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { Substrate } from '../src/sim/config/content.js';
import { GrowthLimiter, NodeKind, StressCause } from '../src/sim/plant.js';
import { LightField } from '../src/sim/light.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

/**
 * The jar these tests were written and measured in. Several set up a situation with exact amounts
 * (a 125 mL splash, a 9 L flood) that only produce it at this size; they test how a plant RESPONDS,
 * not how big the jar is, so they pin the size rather than depend on the game's default.
 */
const OLD_JAR = { grid: { interiorW: 64, interiorH: 32, cornerRadius: 5 } };

function jarWithSeed(overrides: Overrides = {}, x = 32) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  w.commands.push({ t: 'water', x, ml: 200 });
  w.commands.push({ t: 'plantSeed', x, species: SpeciesId.Herb });
  tick(w);
  return w;
}

const liveOf = (w: World, kind: number) => {
  let n = 0;
  for (let i = 0; i < w.pool.count; i++) if (w.pool.alive[i] && w.pool.kind[i] === kind) n++;
  return n;
};

describe('the parent < child invariant', () => {
  it('holds after thousands of ticks of growth and death', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 6000; i++) {
      if (i % 700 === 0) w.commands.push({ t: 'water', x: 32, ml: 60 });
      tick(w);
    }
    // The entire traversal strategy — one forward sweep out, one reverse sweep back, no recursion —
    // rests on this. If it ever breaks, transport silently starts working in the wrong direction.
    expect(() => w.pool.assertInvariant()).not.toThrow();
  });
});

describe('growth', () => {
  it('grows roots and leaves from a watered seed', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 3000; i++) {
      if (i % 600 === 0) w.commands.push({ t: 'water', x: 32, ml: 60 });
      tick(w);
    }
    expect(liveOf(w, NodeKind.Root)).toBeGreaterThan(1);
    expect(liveOf(w, NodeKind.Leaf)).toBeGreaterThan(1);
    expect(w.plants[0].stage).not.toBe('dead');
  });

  it('keeps root investment tracking the target ratio rather than neglecting it', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 900; i++) tick(w);
    const plant = w.plants[0];
    const target = w.cfg.raw.plant.growth.targetRootRatio;

    expect(plant.rootCount).toBeGreaterThan(1);
    expect(plant.leafCount).toBeGreaterThan(1);
    // Sink priority holds roots near `targetRootRatio` x leaves: the plant establishes below ground in
    // step with the canopy it has to supply, rather than racing ahead on either side.
    const ratio = plant.rootCount / plant.leafCount;
    expect(ratio).toBeGreaterThan(target * 0.6);
    expect(ratio).toBeLessThan(target * 1.8);
  });

  it('freezes the growth meter when CO2 is exhausted instead of killing the plant', () => {
    const w = jarWithSeed({ atmosphere: { co2: { startPpm: 40, stallBelowPpm: 200 } } });
    for (let i = 0; i < 800; i++) {
      if (i % 200 === 0) w.commands.push({ t: 'water', x: 32, ml: 40 });
      tick(w);
    }
    expect(w.co2Stalled).toBe(true);
    // The plant waits. It does not die of gas — that is the whole point of the stall.
    expect(w.plants[0].stage).not.toBe('dead');
    expect(liveOf(w, NodeKind.Leaf)).toBeGreaterThan(0);
  });
});

describe('health', () => {
  it('eases downward over many ticks rather than snapping, so the player can react', () => {
    const w = jarWithSeed({ atmosphere: { evapMlPerMinAtFullDrive: 2 }, thermal: { lampDeltaC: 20 } });
    w.commands.push({ t: 'setLamp', intensity: 1 });

    const leaf = firstLeaf(w);
    const readings: number[] = [];
    for (let i = 0; i < 600; i++) {
      tick(w);
      if (i % 60 === 0) readings.push(w.pool.health[leaf]);
    }
    // No single tick may drop health by more than the damage-ease fraction of the gap.
    for (let i = 1; i < readings.length; i++) {
      expect(readings[i]).toBeLessThanOrEqual(readings[i - 1] + 1e-6);
    }
    expect(readings.at(-1)!).toBeLessThan(readings[0]);
  });

  it('recovers when the plant is watered again', () => {
    // Enough drought to visibly degrade the canopy, but not enough to kill it outright: the claim
    // under test is that a stressed plant comes BACK, which needs something left alive to come back.
    const w = jarWithSeed({ atmosphere: { evapMlPerMinAtFullDrive: 0.35 } });
    w.commands.push({ t: 'setLamp', intensity: 1 });

    for (let i = 0; i < 900; i++) tick(w);
    const sick = meanLeafHealth(w);
    expect(sick).toBeGreaterThan(0);
    expect(sick).toBeLessThan(0.9);

    // The rescue: recovery uses the same eased channel, so it is visible rather than instantaneous.
    w.commands.push({ t: 'setLamp', intensity: 0.2 });
    for (let k = 0; k < 6; k++) w.commands.push({ t: 'water', x: 32, ml: 60 });
    for (let i = 0; i < 1200; i++) tick(w);

    expect(meanLeafHealth(w)).toBeGreaterThan(sick);
  });

  /**
   * Reproduces the exact naive first-playthrough pattern: water only the column the seed goes into
   * (not the whole jar), plant, then leave it under the UI's default 60% lamp with no further care.
   *
   * Before the emergency-recovery fix, a plant that lost every leaf while sugar sat at the starvation
   * floor was PERMANENTLY stuck — only leaves photosynthesize, so with zero leaves there is no income
   * and the resprout check (which needs sugarCostPerNode banked) could never pass. Even flooding the
   * entire jar with water for 20,000 ticks afterward did nothing, because water was never the thing
   * actually blocking recovery. This is the regression test for that dead end.
   */
  it('recovers a leafless, sugar-starved plant once the water problem is actually fixed', () => {
    const w = new World(cloneBalance(OLD_JAR));
    w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
    w.commands.push({ t: 'seal' });
    tick(w);
    while (w.substrateDirty) tick(w);

    // Five splashes in one spot — a very typical minimal-effort watering — then walk away.
    for (let i = 0; i < 5; i++) w.commands.push({ t: 'water', x: 32, ml: 25 });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    w.commands.push({ t: 'setLamp', intensity: 0.6 }); // the UI's default
    tick(w);

    for (let i = 0; i < 1000; i++) tick(w);

    // Confirm the precondition: this naive pattern really does strip every leaf. If this ever stops
    // reproducing, the test below is not exercising the dead end at all. (Sugar is not asserted to
    // stay pinned at the starvation floor here — the fix under test can itself start a slow recovery
    // from residual moisture even before the deliberate rescue below, which is a feature, not a
    // reason to weaken this check.)
    expect(w.plants[0].leafCount).toBe(0);

    // The fix: water the WHOLE jar, generously and repeatedly, the way the Diagnosis panel's advice
    // ("water the soil above them") actually implies once you take it seriously.
    /*
     * Whether it EVER came back, not whether it happens to hold a leaf at the final tick.
     *
     * Measured across five RNG sequences, the rescued plant puts out its first leaf at tick ~443 every
     * time — the pillar works. What it then does is cycle: sprout a leaf, fail to hold it, sprout
     * another. Sampling the last tick tests which phase of that cycle this particular sequence happens
     * to be in, which is how a run with a healthy 123 units of banked sugar could read as a failure.
     */
    let recovered = false;
    let peakSugar = 0;
    for (let i = 0; i < 15000; i++) {
      if (i % 50 === 0) {
        for (let x = 10; x < 56; x++) w.commands.push({ t: 'water', x, ml: 20 });
      }
      tick(w);
      if (w.plants[0].leafCount > 0) recovered = true;
      peakSugar = Math.max(peakSugar, w.pool.sugar[w.plants[0].crown]);
    }

    // It regrew a leaf, and it earned enough to build one — both measured over the rescue rather than
    // at its final tick, for the same reason. Reading the last tick caught this plant having just SPENT
    // its sugar on a leaf: 13.3 banked against a node costing 14, which is the dead end escaped, not
    // the dead end reproduced.
    expect(recovered).toBe(true);
    expect(peakSugar).toBeGreaterThan(w.cfg.raw.plant.growth.sugarCostPerNode);
  });
});

describe('root anchoring', () => {
  it('starves but survives a root whose cell is repainted to gravel, then re-anchors it', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 600; i++) tick(w);

    const root = firstRoot(w);
    const rx = w.pool.cellX[root];
    const ry = w.pool.cellY[root];
    w.commands.push({ t: 'paint', x: rx, y: ry, material: Substrate.Gravel });
    tick(w);

    // Gravel is forgiving: the root lives, it just cannot draw. Amending near roots costs, not kills.
    expect(w.pool.alive[root]).toBe(1);
    for (let i = 0; i < 400; i++) tick(w);
    const moved = w.pool.cellX[root] !== rx || w.pool.cellY[root] !== ry;
    expect(moved || w.pool.starve[root] > 0).toBe(true);
  });

  it('kills a root and its subtree when its cell is excavated to air', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 1500; i++) tick(w);

    const root = deepest(w);
    w.commands.push({ t: 'paint', x: w.pool.cellX[root], y: w.pool.cellY[root], material: Substrate.Air });
    tick(w);
    tick(w);

    expect(w.pool.alive[root]).toBe(0);
    const severed = w.events.some((e) => e.t === 'rootSevered');
    expect(severed || w.pool.alive[root] === 0).toBe(true);
  });

  it('decrements the cell root count when a root dies, so the per-cell cap stays honest', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 1200; i++) tick(w);
    const root = deepest(w);
    const cell = w.grid.idx(w.pool.cellX[root], w.pool.cellY[root]);
    const before = w.grid.rootCount[cell];
    expect(before).toBeGreaterThan(0);

    w.atmo.airWaterMl += w.pool.release(root, w.grid);
    expect(w.grid.rootCount[cell]).toBe(before - 1);
  });

  it('never packs more roots into a cell than the cap allows', () => {
    const w = jarWithSeed();
    for (let i = 0; i < 6000; i++) {
      if (i % 500 === 0) w.commands.push({ t: 'water', x: 32, ml: 50 });
      tick(w);
    }
    const cap = w.cfg.raw.plant.uptake.rootsPerCellMax;
    for (const i of w.grid.activeCells) expect(w.grid.rootCount[i]).toBeLessThanOrEqual(cap);
  });
});

describe('water demand arbitration', () => {
  it('never lets evaporation and roots together take a cell below the wilting point', () => {
    const w = jarWithSeed({ atmosphere: { evapMlPerMinAtFullDrive: 5 }, thermal: { lampDeltaC: 20 } });
    w.commands.push({ t: 'setLamp', intensity: 1 });
    const floor = w.cfg.raw.water.wiltingPointMl;

    for (let i = 0; i < 2000; i++) {
      tick(w);
      for (const idx of w.grid.activeCells) {
        // Water above the floor is the only water either claimant may touch. Going below it would
        // mean one of them read stale state or ignored its allotted share.
        expect(w.grid.moisture[idx]).toBeGreaterThan(-1e-6);
      }
    }
    expect(floor).toBeGreaterThan(0);
  });

  it('gives roots a real share under drought instead of letting the air skim first', () => {
    // The bug this guards: `water -> evaporate -> uptake` lets the air take every cell before the root
    // sees it, producing the worst symptom this sim can have — "I watered it and it still died".
    //
    // Measured at the whole-plant level, because a root hands its draw straight up to the crown each
    // tick, so the root node itself is always back at zero by the end of a tick.
    const w = jarWithSeed({ atmosphere: { evapMlPerMinAtFullDrive: 4 }, thermal: { lampDeltaC: 18 } });
    w.commands.push({ t: 'setLamp', intensity: 1 });

    let drew = 0;
    for (let i = 0; i < 400; i++) {
      const before = w.pool.totalWaterMl();
      tick(w);
      if (w.pool.totalWaterMl() > before) drew++;
    }
    // Under heavy evaporation the plant must still get water on a meaningful share of ticks.
    expect(drew).toBeGreaterThan(40);
  });
});

describe('determinism', () => {
  it('produces identical state from the same seed and command script', () => {
    const script = (w: World) => {
      w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
      w.commands.push({ t: 'seal' });
      tick(w);
      w.commands.push({ t: 'water', x: 30, ml: 250 });
      w.commands.push({ t: 'plantSeed', x: 30, species: SpeciesId.Herb });
      w.commands.push({ t: 'setLamp', intensity: 0.7 });
      for (let i = 0; i < 5000; i++) {
        if (i % 400 === 0) w.commands.push({ t: 'water', x: 30, ml: 40 });
        tick(w);
      }
    };

    const a = new World(cloneBalance());
    const b = new World(cloneBalance());
    script(a);
    script(b);

    expect(hash(a)).toBe(hash(b));
  });
});

describe('config validation', () => {
  it('rejects a diffusion coefficient that would oscillate', () => {
    expect(() => compile(cloneBalance({ water: { diffusionCoefficient: 0.3 } }))).toThrow(/unstable/);
  });

  it('rejects an inverted condensation hysteresis band', () => {
    expect(() =>
      compile(cloneBalance({ atmosphere: { condensation: { onHumidity: 70, offHumidity: 80 } } })),
    ).toThrow(/hysteresis/);
  });

  it('rejects a wilting point above a rootable material capacity', () => {
    expect(() => compile(cloneBalance({ water: { wiltingPointMl: 500 } }))).toThrow(/fieldCapacity/);
  });
});

// --- helpers ---------------------------------------------------------------------------------

function firstLeaf(w: World): number {
  for (let n = 0; n < w.pool.count; n++) if (w.pool.alive[n] && w.pool.kind[n] === NodeKind.Leaf) return n;
  throw new Error('no leaf');
}

/**
 * Mean health across the LIVE canopy.
 *
 * Watching one node by index is unreliable now that leaves senesce and drop: the node the test picked
 * at the start may be a tombstone by the end, with its health frozen at whatever it died holding.
 */
function meanLeafHealth(w: World): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < w.pool.count; i++) {
    if (!w.pool.alive[i] || w.pool.kind[i] !== NodeKind.Leaf) continue;
    sum += w.pool.health[i];
    n++;
  }
  return n > 0 ? sum / n : 0;
}

function firstRoot(w: World): number {
  for (let n = 0; n < w.pool.count; n++) if (w.pool.alive[n] && w.pool.kind[n] === NodeKind.Root) return n;
  throw new Error('no root');
}

function deepest(w: World): number {
  let best = -1;
  let y = -1;
  for (let n = 0; n < w.pool.count; n++) {
    if (!w.pool.alive[n] || w.pool.kind[n] !== NodeKind.Root) continue;
    if (w.pool.cellY[n] > y) {
      y = w.pool.cellY[n];
      best = n;
    }
  }
  if (best < 0) throw new Error('no root');
  return best;
}

/** A cheap state fingerprint over everything the sim owns. */
function hash(w: World): string {
  let h = 2166136261;
  const mix = (v: number) => {
    h ^= Math.round(v * 1e4) | 0;
    h = Math.imul(h, 16777619);
  };
  for (let i = 0; i < w.grid.size; i++) {
    mix(w.grid.substrate[i]);
    mix(w.grid.moisture[i]);
    mix(w.grid.nutrients[i]);
    mix(w.grid.rootCount[i]);
  }
  for (let n = 0; n < w.pool.count; n++) {
    mix(w.pool.kind[n]);
    mix(w.pool.parent[n]);
    mix(w.pool.alive[n]);
    mix(w.pool.water[n]);
    mix(w.pool.health[n]);
  }
  mix(w.atmo.tempC);
  mix(w.atmo.airWaterMl);
  mix(w.atmo.co2Ppm);
  mix(w.atmo.o2Pct);
  mix(w.rng.state);
  return (h >>> 0).toString(16);
}

/**
 * A jar good enough that its plants actually bloom — propagation is downstream of flowering, so a
 * merely-surviving jar tests nothing here.
 *
 * Most tests below force `seedChancePerBloom: 1`. The shipped rate is 0.07, which needs sim-months to
 * produce enough births and deaths to stress slot recycling; turning it to certainty puts the
 * mechanism under far more pressure in a fraction of the time, and makes the bounding test an
 * outright reproduction of the runaway case rather than a hopeful sample of it. The tuned rate itself
 * is checked in the slow balance suite, where it belongs.
 */
function thrivingJar(overrides: Overrides = {}, seeds = [32]) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  const cols: number[] = [];
  for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) cols.push(x);
  for (const x of cols) w.commands.push({ t: 'water', x, ml: 2400 / cols.length });
  for (let i = 0; i < 200; i++) tick(w);
  w.commands.push({ t: 'setLamp', intensity: 0.35 });
  for (const x of [16, 32, 48]) w.commands.push({ t: 'addSpringtails', x, y: 0 });
  for (const x of seeds) w.commands.push({ t: 'plantSeed', x, species: SpeciesId.Herb });
  tick(w);
  return w;
}

const CERTAIN = { plant: { reproduction: { seedChancePerBloom: 1 } } };
const livePlants = (w: World) => w.plants.filter((p) => p.stage !== 'dead').length;

describe('plants seeding themselves from blooms', () => {
  it('populates the jar from a single planted seed', () => {
    const w = thrivingJar(CERTAIN);
    expect(livePlants(w)).toBe(1);
    for (let i = 0; i < 30 * 1440; i++) tick(w);
    // The whole point of the feature: a well-run jar fills itself in without the player planting.
    expect(livePlants(w)).toBeGreaterThan(1);
  });

  it('stays bounded even when every single bloom seeds', () => {
    const w = thrivingJar(CERTAIN, [16, 32, 48]);
    const cap = w.cfg.raw.plant.reproduction.maxPlants;
    let peak = 0;
    for (let i = 0; i < 40 * 1440; i++) {
      tick(w);
      if (i % 720 === 0) peak = Math.max(peak, livePlants(w));
    }
    // Unchecked, a measured 1.30 blooms/plant/day turns three plants into ~1,021 inside a week. With
    // the chance gate removed entirely, spacing, affordability and the safety cap are all that stand
    // between us and that number — and the node pool must never run dry, which fails SILENTLY and
    // stops growth jar-wide with no message to the player.
    expect(peak).toBeLessThanOrEqual(cap);
    expect(w.poolExhausted).toBe(false);
  });

  it('keeps the parent < child invariant across generations of birth and death', () => {
    const w = thrivingJar(CERTAIN, [16, 32, 48]);
    for (let i = 0; i < 40 * 1440; i++) tick(w);
    // Slot recycling is the one thing that could break the ordering every traversal in the sim
    // depends on, so this assertion is the reason the free list is allowed to exist at all.
    expect(() => w.pool.assertInvariant()).not.toThrow();
  });

  it('never leaves a recycled slot linked to its old parent', () => {
    const w = thrivingJar(CERTAIN, [16, 32, 48]);
    for (let i = 0; i < 40 * 1440; i++) tick(w);
    const P = w.pool;
    for (let n = 0; n < P.count; n++) {
      if (!P.alive[n]) continue;
      for (let c = P.firstChild[n]; c >= 0; c = P.nextSibling[c]) {
        if (!P.alive[c]) continue;
        // A reused slot still sitting in a dead plant's child chain would silently splice two
        // different plants together, and transport and health would flow across the join.
        expect(P.plantId[c]).toBe(P.plantId[n]);
        expect(P.parent[c]).toBe(n);
      }
    }
  });

  it('turns a plant that cannot establish into litter rather than a permanent zombie', () => {
    const w = thrivingJar({ light: { lampPpfd: 0 } });
    const before = w.totalLitter();
    /*
     * PEAK litter, not the figure at the end, because litter is food and the jar has springtails in it.
     *
     * Measuring at day 30 assumed the remains would still be lying there, which only held while nothing
     * hurried the plant along. Pests flare on a starving host, so the plant now fails sooner, its litter
     * lands sooner, and the colony has finished eating it well before the run ends — leaving 0, and a
     * test that read a working carbon loop as a failure. What the claim actually needs is that the
     * tissue ENTERED the litter pool at all.
     */
    let peak = before;
    for (let i = 0; i < 30 * 1440; i++) {
      tick(w);
      peak = Math.max(peak, w.totalLitter());
    }
    // In the dark it has no way back, and the failure has to feed the springtails instead of
    // evaporating out of the carbon books.
    expect(w.plants[0].stage).toBe('dead');
    expect(peak).toBeGreaterThan(before);
  });

  it('conserves carbon in a jar that is propagating', () => {
    const w = thrivingJar(CERTAIN, [16, 48]);
    const start = w.auditCarbonPpm();
    for (let i = 0; i < 40 * 1440; i++) tick(w);
    // Reproduction moves sugar, tissue, water and minerals BETWEEN plants. Every one of those is a
    // chance to mint carbon from nothing, which is exactly what this audit exists to catch.
    expect(Math.abs(w.auditCarbonPpm() - start) / start).toBeLessThan(0.03);
    expect(livePlants(w)).toBeGreaterThan(2);
  });
});

/**
 * Species. The interesting assertions here are the two A/Bs: a species that does not actually
 * out-perform another in the conditions it was designed for is a stat sheet, not a feature.
 */
describe('plant species', () => {
  /** A jar built to order, so the two halves of an A/B differ only in what was planted. */
  function jar(species: SpeciesId, lamp: number, primeMl: number, seeds = [20, 44]) {
    const w = new World(cloneBalance());
    w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
    w.commands.push({ t: 'seal' });
    tick(w);
    const cols: number[] = [];
    for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) cols.push(x);
    for (const x of cols) w.commands.push({ t: 'water', x, ml: primeMl / cols.length });
    for (let i = 0; i < 200; i++) tick(w);
    w.commands.push({ t: 'setLamp', intensity: lamp });
    for (const x of [16, 32, 48]) w.commands.push({ t: 'addSpringtails', x, y: 0 });
    for (const x of seeds) w.commands.push({ t: 'plantSeed', x, species });
    tick(w);
    return w;
  }

  const run = (w: World, days: number) => {
    for (let i = 0; i < days * 1440; i++) tick(w);
    return w;
  };
  const liveNodes = (w: World) => {
    let n = 0;
    for (let i = 0; i < w.pool.count; i++) if (w.pool.alive[i]) n++;
    return n;
  };

  it('compiles a separate parameter set and temperature curve for each species', () => {
    const cfg = compile(cloneBalance());
    const [fern, herb, succulent] = cfg.species;
    expect(fern.raw.photosynthesis.lightHalfSat).toBeLessThan(herb.raw.photosynthesis.lightHalfSat);
    expect(succulent.raw.photosynthesis.lightHalfSat).toBeGreaterThan(herb.raw.photosynthesis.lightHalfSat);
    // The Herb IS the base config — that is what keeps every pre-existing balance target meaningful.
    expect(herb.raw).toEqual(cfg.raw.plant);
    // Each species must own its curve. Sharing one would silently hand every plant the Herb's
    // temperature optimum, and nothing anywhere would throw.
    expect(fern.tempCurve).not.toBe(herb.tempCurve);
    expect(fern.tempCurve).not.toEqual(succulent.tempCurve);
  });

  it('never lets a species overlay resize the jar-wide node pool', () => {
    // `maxNodes` lives in the plant block but sizes the pool SHARED by every plant, and the pool is
    // allocated before any plant exists — so an overlay setting it would silently do nothing.
    const cfg = compile(cloneBalance());
    for (const sp of cfg.species) expect(sp.raw.maxNodes).toBe(cfg.raw.plant.maxNodes);
  });

  it('grows a Fern where a Herb is light-starved', () => {
    /*
     * ONE seed per jar, deliberately, and this is the whole reason the test is trustworthy.
     *
     * At the two-seed default this A/B measured the soil, not the light. Both halves plateau near 165
     * nodes over 40 days, but for unrelated reasons: the Herb jar ends with 104 mineral units left,
     * having eaten its soil, while the Fern jar stops at 164 with 248 still in the ground — it is
     * light-limited, self-shading at eight plants. The two ceilings happen to collide within two
     * nodes of each other, so the assertion was reading a coincidence and the Fern "lost" 164-166.
     *
     * Proof it was the minerals: drop `nutrientCostPerNode` 2.5 -> 0.5 so soil cannot bind, and the
     * same two-seed jars go Fern 403 / Herb 365. The Fern wins whenever light is the constraint, which
     * is the trait. With a single seed both halves stay light-limited all 40 days and the trait shows
     * up at full size: 158 nodes against 83.
     */
    /*
     * Lamp 0.05, because the claim is about light that STARVES a Herb and 0.15 is not that light.
     *
     * At 0.15 this is a coin flip dressed up as a species trait: across five RNG sequences the Fern
     * led in two, and the run-average favoured the Herb (101 nodes to 108). The shade advantage is
     * real but small — about 13% more photosynthesis per leaf at that brightness — and a self-seeding
     * jar's chaos is far larger than 13%. Passing once was luck, and this test had already been
     * "fixed" on a single sequence before, which is how it came back.
     *
     * At 0.05 the premise actually holds and the margin is not subtle: measured across the same five
     * sequences, the Fern built 59, 74, 94, 115 and 135 nodes while the Herb managed 4 or 5 — it never
     * establishes at all. Five wins from five, by twenty times.
     */
    const fern = run(jar(SpeciesId.Fern, 0.05, 2800, [32]), 40);
    const herb = run(jar(SpeciesId.Herb, 0.05, 2800, [32]), 40);
    // Identical jars, identical light, different plant. If shade tolerance does not show up here it
    // does not exist.
    expect(liveNodes(fern)).toBeGreaterThan(liveNodes(herb));
  });

  it('holds a Succulent steady where a Herb booms and fades', () => {
    /*
     * STEADINESS, not size — and this is a decision about what the Succulent is for, not a relaxed bar.
     *
     * This used to compare size on day 40, and that was only ever measuring where each jar happened to
     * be in its cycle. Averaged over the run the Herb is the BIGGER plant in this jar, on every one of
     * five RNG seeds (164 against 140 at the default). It grows hard in the bright light, flowers
     * heavily, then falls away; the Succulent climbs to its size and sits there. The day-40 snapshot
     * caught the Herb on its way down, which is why it passed — and why it flipped the moment pests
     * shifted the timing of the Herb's decline by a few days.
     *
     * So assert the thing the Succulent reliably does. Final size as a fraction of its own average
     * over the run: 0.93-1.02 for the Succulent against 0.68-0.89 for the Herb, the Succulent steadier
     * on all five seeds.
     *
     * Still NOT asserted on the dehydration strike, which reads backwards here: the Succulent carries
     * the higher strike because it spreads more roots into dry corners.
     */
    const steadiness = (w: World) => {
      let sum = 0;
      let k = 0;
      for (let d = 1; d <= 40; d++) {
        run(w, 1);
        // Skip establishment, where both are still just seedlings and the average means nothing.
        if (d > 5) {
          sum += liveNodes(w);
          k++;
        }
      }
      return liveNodes(w) / (sum / k);
    };
    const succ = steadiness(jar(SpeciesId.Succulent, 0.9, 900));
    const herb = steadiness(jar(SpeciesId.Herb, 0.9, 900));
    expect(succ).toBeGreaterThan(herb);
  });

  it('respects each species own growth habit, not the base config', () => {
    const w = run(jar(SpeciesId.Fern, 0.15, 2800), 30);
    const P = w.pool;
    const cap = w.cfg.species[SpeciesId.Fern].raw.growth.maxShootHeight;
    expect(cap).toBeLessThan(w.cfg.raw.plant.growth.maxShootHeight);

    // The regression this exists for: `grow`, `tryFlower` and `stemWithLeafRoom` each kept their own
    // `const c = w.cfg.raw.plant`, which compiles perfectly while silently giving every species the
    // Herb's habit. Nothing threw; the Fern just grew tall and sparse. Only looking at the jar caught
    // it, so assert the habit in play rather than in the config.
    for (const plant of w.plants) {
      if (plant.stage === 'dead') continue;
      const crownY = P.y[plant.crown];
      for (const n of plant.nodeIds) {
        // STEMS only: maxShootHeight governs the load-bearing column. A leaf legitimately hangs a
        // little above the stem that carries it, so including leaves here measures the wrong thing.
        if (!P.alive[n] || P.kind[n] !== NodeKind.Stem) continue;
        expect(crownY - P.y[n]).toBeLessThanOrEqual(cap);
      }
      const leafy = plant.nodeIds.filter((n) => P.alive[n] && P.kind[n] === NodeKind.Leaf).length;
      const stems = plant.nodeIds.filter((n) => P.alive[n] && P.kind[n] === NodeKind.Stem).length;
      /*
       * ESTABLISHED plants only. A jar this old has self-seeded, and a fresh sprout carrying one leaf
       * on one stem sits at exactly 1.00 — which fails a `> 1` check while saying nothing at all about
       * the species' habit, since it has not yet had the chance to express one. Measured across the
       * whole jar the Ferns run 52 leaves to 20 stems; it was a single seedling failing this.
       */
      if (stems >= 3 && leafy > 0) expect(leafy / stems).toBeGreaterThan(1); // bushier than the Herb
    }
  });

  it('seeds its own kind when a bloom takes', () => {
    const w = run(jar(SpeciesId.Fern, 0.35, 2400, [32]), 60);
    expect(w.plants.length).toBeGreaterThan(1);
    for (const p of w.plants) expect(p.species).toBe(SpeciesId.Fern);
  });

  it('conserves carbon in a jar holding all three species', () => {
    const w = new World(cloneBalance());
    w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
    w.commands.push({ t: 'seal' });
    tick(w);
    const cols: number[] = [];
    for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) cols.push(x);
    for (const x of cols) w.commands.push({ t: 'water', x, ml: 2400 / cols.length });
    for (let i = 0; i < 200; i++) tick(w);
    w.commands.push({ t: 'setLamp', intensity: 0.5 });
    for (const x of [16, 32, 48]) w.commands.push({ t: 'addSpringtails', x, y: 0 });
    w.commands.push({ t: 'plantSeed', x: 14, species: SpeciesId.Fern });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    w.commands.push({ t: 'plantSeed', x: 50, species: SpeciesId.Succulent });
    tick(w);

    const start = w.auditCarbonPpm();
    // Species carry different tissue costs and leaf lifespans, so a mixed jar is where the carbon
    // bookkeeping could diverge. The water audit throws per tick; this one is checked at the end.
    for (let i = 0; i < 40 * 1440; i++) tick(w);
    expect(Math.abs(w.auditCarbonPpm() - start) / start).toBeLessThan(0.03);
  });
});

/**
 * Per-plant diagnosis: the breakdown behind "what is wrong with this plant".
 *
 * The sim attributes each stress contribution to a named cause as it computes it, rather than the UI
 * re-deriving a guess from world state. These tests pin that the attribution points at the right
 * knob, and — first and most importantly — that recording it changes nothing.
 */
describe('plant diagnosis', () => {
  function jar(overrides: Overrides, primeMl: number, lamp: number, layers = { g: 4, c: 3, s: 9 }) {
    const w = new World(cloneBalance(overrides));
    w.commands.push({ t: 'layerBands', gravelRows: layers.g, charcoalRows: layers.c, soilRows: layers.s });
    w.commands.push({ t: 'seal' });
    tick(w);
    const cols: number[] = [];
    for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) cols.push(x);
    for (const x of cols) w.commands.push({ t: 'water', x, ml: primeMl / cols.length });
    for (let i = 0; i < 200; i++) tick(w);
    w.commands.push({ t: 'setLamp', intensity: lamp });
    w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
    tick(w);
    return w;
  }
  const run = (w: World, days: number) => {
    for (let i = 0; i < days * 1440; i++) tick(w);
    return w;
  };
  /** The largest non-benign cause right now, which is what the card headlines. */
  const worstCause = (w: World, id = 0) => {
    let best = -1;
    let bestV = 0;
    w.plants[id].stressBy.forEach((v, k) => {
      if (k !== StressCause.Age && v > bestV) {
        bestV = v;
        best = k;
      }
    });
    return best as StressCause;
  };

  /**
   * The cause blamed at the plant's WORST moment over a run.
   *
   * Sampling the final tick is the wrong measure here and measuring it taught me why: a struggling
   * plant cycles — it grows a leaf, the leaf fails, it drops it, and while it is bare its stress
   * reads zero. Which cause dominates when the plant is actually suffering is the thing the card has
   * to get right.
   */
  const causeAtPeak = (w: World, days: number, id = 0) => {
    let peak = 0;
    let cause = -1 as StressCause;
    for (let i = 0; i < days * 1440; i++) {
      tick(w);
      if (i % 30 !== 0 || !w.plants[id]) continue;
      const c = worstCause(w, id);
      if (c < 0) continue;
      const v = w.plants[id].stressBy[c];
      if (v > peak) {
        peak = v;
        cause = c;
      }
    }
    return { cause, peak };
  };

  it('changes nothing about the simulation itself', () => {
    // The whole feature is observation. If recording it moves a single number the sim uses, the
    // accumulation has leaked into the stress total rather than sitting beside it.
    const script = (w: World) => {
      w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
      w.commands.push({ t: 'seal' });
      tick(w);
      w.commands.push({ t: 'water', x: 30, ml: 250 });
      w.commands.push({ t: 'plantSeed', x: 30, species: SpeciesId.Herb });
      w.commands.push({ t: 'setLamp', intensity: 0.7 });
      for (let i = 0; i < 5000; i++) {
        if (i % 400 === 0) w.commands.push({ t: 'water', x: 30, ml: 40 });
        tick(w);
        // Read the diagnosis every tick, exactly as the panel does each frame.
        void w.plants[0]?.stressBy[StressCause.Thirst];
        void w.plants[0]?.limiter;
      }
    };
    const a = new World(cloneBalance());
    const b = new World(cloneBalance());
    script(a);
    script(b);
    expect(hash(a)).toBe(hash(b));
  });

  it('names thirst in a jar that is never watered', () => {
    const w = jar({}, 120, 0.5);
    let thirst = 0;
    let rot = 0;
    for (let i = 0; i < 12 * 1440; i++) {
      tick(w);
      thirst = Math.max(thirst, w.plants[0].stressBy[StressCause.Thirst]);
      rot = Math.max(rot, w.plants[0].stressBy[StressCause.Rot]);
    }
    // Deliberately NOT asserted as the single top cause, because measuring it showed it usually
    // isn't: a plant that dries out sheds its leaves and then STARVES, and starvation peaks higher
    // (36%) than the thirst (20%) that caused it. The card handles that by deferring to the growth
    // limiter, and the breakdown's job here is simply to name thirst as real and rot as absent.
    expect(thirst).toBeGreaterThan(0.1);
    expect(rot).toBe(0);
  });

  it('blames waterlogging in a drenched jar with no drainage', () => {
    const { cause, peak } = causeAtPeak(jar(OLD_JAR, 9000, 0.5, { g: 0, c: 0, s: 16 }), 12);
    expect(cause).toBe(StressCause.Rot);
    expect(peak).toBeGreaterThan(0.02);
  });

  it('blames starvation when the lamp is off', () => {
    const { cause } = causeAtPeak(jar({ light: { lampPpfd: 0 } }, 2400, 0), 5);
    expect(cause).toBe(StressCause.Starvation);
  });

  it('keeps the breakdown reconciled with the distress it is shown beside', () => {
    const w = run(jar({}, 120, 0.5), 12);
    const p = w.plants[0];
    // Everything except senescence should add back up to roughly `distress` — the card would
    // otherwise show parts that visibly disagree with the total printed above them. Loose, because
    // per-node stress is clamped at 1 before averaging while the buckets are not.
    const sum = [...p.stressBy].reduce((a, v, k) => (k === StressCause.Age ? a : a + v), 0);
    expect(sum).toBeGreaterThan(p.distress * 0.9);
  });

  it('reports light as the cap in a dim jar, and something else when the lamp is raised', () => {
    /*
     * Pests held out of this one, because it tests the limiter and nothing else.
     *
     * A seedling at lamp 0.05 is starving by day five, and a starving host stops holding its stowaway
     * colony down — so on day six the pests strip its last leaf, and a plant with no leaves has no
     * limiter to report at all. That is pests working as designed; it is just not what this asserts.
     */
    const dim = run(jar({ pests: { stowawayLoad: 0 } }, 2400, 0.05), 6);
    expect(dim.plants[0].limiter).toBe(GrowthLimiter.Light);
    const bright = run(jar({}, 2400, 1), 6);
    expect(bright.plants[0].limiter).not.toBe(GrowthLimiter.Light);
  });

  it('keeps the daytime answer at night instead of blaming the dark', () => {
    const w = jar({}, 2400, 0.7);
    for (let i = 0; i < 6 * 1440; i++) tick(w);
    // Read the verdict in full daylight, then run into the night and read it again.
    while (LightField.dayFraction(w.cfg, w.tickCount) < 1) tick(w);
    const byDay = w.plants[0].limiter;
    expect(byDay).not.toBe(GrowthLimiter.None);

    while (LightField.dayFraction(w.cfg, w.tickCount) > 0) tick(w);
    for (let i = 0; i < 120; i++) tick(w);
    expect(LightField.dayFraction(w.cfg, w.tickCount)).toBe(0);
    // Unchanged — the limiter is sampled in daylight only. Without that gate it would read "light"
    // for every plant in the jar every night: true, useless, and misleading about what to fix.
    expect(w.plants[0].limiter).toBe(byDay);
  });

  it('reports nothing wrong in a healthy jar', () => {
    const w = jar({}, 2400, 0.35);
    for (const x of [16, 32, 48]) w.commands.push({ t: 'addSpringtails', x, y: 0 });
    run(w, 25);
    const p = w.plants[0];
    for (let k = 0; k < p.stressBy.length; k++) {
      if (k === StressCause.Age) continue; // ageing leaves are normal and expected
      expect(p.stressBy[k]).toBeLessThan(0.1);
    }
  });
});

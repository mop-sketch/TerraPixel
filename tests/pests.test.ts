// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { cloneBalance, type Overrides } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { NodeKind, StressCause } from '../src/sim/plant.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

/**
 * @param lidOpen Pests can only get into an OPEN jar, so every test that needs an outbreak opens it.
 *                Left shut by default, which is both the game's normal state and the thing several of
 *                these tests are checking keeps pests out.
 */
function jar(seeds = [32], overrides: Overrides = {}, lidOpen = false) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  if (lidOpen) w.commands.push({ t: 'setLid', open: true });
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

const days = (w: World, d: number) => {
  for (let i = 0; i < d * 1440; i++) tick(w);
};

/** Live leaves of one plant. */
const leavesOf = (w: World, plant: number) =>
  w.plants[plant].nodeIds.filter((n) => w.pool.alive[n] && w.pool.kind[n] === NodeKind.Leaf);

const maxLoad = (w: World, plant: number) => Math.max(0, ...leavesOf(w, plant).map((n) => w.pool.pests[n]));

/**
 * Luck pinned off: every seed carries pests, every plant has baseline hardiness, and a dormant colony
 * catches the moment its host would bear one.
 *
 * For tests about a RULE rather than about the dice. Outbreaks are rolled now, so a test that waits a
 * fixed day for a flare is really testing whether that seed got lucky; the randomness has its own
 * tests below.
 */
const PINNED: Overrides = { pests: { ignitionPerDay: 1000, vigourSpread: 0, stowawayChance: 1 } };

describe('pests', () => {
  it('ride in dormant on a seed the player plants, and stay unseen on a healthy host', () => {
    const w = jar();
    days(w, 10);
    const c = w.cfg.raw.pests;
    const loads = leavesOf(w, 0).map((n) => w.pool.pests[n]);

    // Present: the colony survived ten days of leaf turnover rather than dying with the first leaf.
    expect(loads.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    // Unseen: a healthy host holds every colony below what the player can see.
    expect(Math.max(...loads)).toBeLessThan(c.visibleAt);
    // Harmless: dormant pests cost the plant nothing, or every bought seed would carry a hidden tax.
    expect(w.plants[0].stressBy[StressCause.Pests]).toBe(0);
  });

  it('never ride in on a seed the jar made itself', () => {
    const w = jar([32], { plant: { reproduction: { seedChancePerBloom: 1 } } });
    let checked = false;
    for (let i = 0; i < 40 * 1440 && !checked; i++) {
      tick(w);
      for (const e of w.events) {
        if (e.t !== 'seeded') continue;
        // Checked on the tick it lands, before contact has had any chance to reach it.
        for (const n of w.plants[e.plant].nodeIds) expect(w.pool.pests[n]).toBe(0);
        checked = true;
      }
    }
    expect(checked).toBe(true);
  });

  it('flare once the host is struggling', () => {
    const w = jar([32], PINNED, true);
    days(w, 10);
    expect(maxLoad(w, 0)).toBeLessThan(w.cfg.raw.pests.visibleAt);

    // Darkness starves the plant, and a starving host stops holding its colonies down. Two days, not
    // one: the colony has to grow from dormant to visible, and starvation stress itself takes a while
    // to build — at one day it was caught mid-climb at 0.047 against a visible threshold of 0.12.
    w.commands.push({ t: 'setLamp', intensity: 0 });
    days(w, 2);
    expect(maxLoad(w, 0)).toBeGreaterThan(w.cfg.raw.pests.visibleAt);
  });

  it('die back on a host that is healthy, so fixing the plant is a cure too', () => {
    const w = jar();
    days(w, 10);
    for (const n of leavesOf(w, 0)) w.pool.pests[n] = 0.9;

    days(w, 3);
    // Every leaf back below visible, without a single prune. Setbacks are meant to be recoverable.
    expect(maxLoad(w, 0)).toBeLessThan(w.cfg.raw.pests.visibleAt);
  });

  it('cross only between leaves that touch', () => {
    const w = jar([12, 32, 52]);
    days(w, 3);
    const P = w.pool;
    // Start B and C clean, so anything they carry afterwards had to arrive by contact.
    for (const p of [1, 2]) for (const n of w.plants[p].nodeIds) P.pests[n] = 0;

    // Lean one of B's leaves into A's foliage, well inside the contact radius. C stays where it grew,
    // twenty columns from anything infested.
    const a = leavesOf(w, 0)[0];
    const b = leavesOf(w, 1)[0];
    P.x[b] = P.x[a] + 0.8;
    P.y[b] = P.y[a];

    for (let i = 0; i < 200; i++) tick(w);
    expect(P.pests[b]).toBeGreaterThan(0);
    for (const n of w.plants[2].nodeIds) expect(P.pests[n]).toBe(0);
  });

  it('go with the branch the player prunes', () => {
    const w = jar();
    days(w, 10);
    const P = w.pool;
    // A stem carrying leaves: prune it and everything hanging off it should come away clean.
    const stem = w.plants[0].nodeIds.find(
      (n) =>
        P.alive[n] &&
        P.kind[n] === NodeKind.Stem &&
        n !== w.plants[0].crown &&
        leavesOf(w, 0).some((l) => P.parent[l] === n),
    );
    expect(stem).toBeDefined();
    const doomed = leavesOf(w, 0).filter((l) => P.parent[l] === stem);
    for (const n of doomed) P.pests[n] = 0.9;

    w.commands.push({ t: 'prune', node: stem! });
    tick(w);
    for (const n of doomed) {
      expect(P.alive[n]).toBe(0);
      expect(P.pests[n]).toBe(0);
    }
  });

  it('overrun an old plant even in a healthy jar, while its seedlings stay clean', () => {
    // Resistance compressed from 40 days to 5 so this runs in seconds; the mechanism is the same.
    const w = jar(
      [32],
      { pests: { resistantDays: 5, resistanceFadeDays: 5 }, plant: { reproduction: { seedChancePerBloom: 1 } } },
      true,
    );
    /*
     * Run until it IS overrun rather than reading a fixed day. An old plant now gets ONE infestation:
     * come through it and it is immune for life, so a jar left running past the outbreak shows a clean
     * plant again — which says nothing about whether age made it vulnerable in the first place.
     */
    for (let i = 0; i < 20 * 1440 && maxLoad(w, 0) < w.cfg.raw.pests.visibleAt; i++) tick(w);
    const original = w.plants[0];

    // Age, not trouble: the host is fine by every other measure, and still overrun.
    expect(original.distress - original.stressBy[StressCause.Pests]).toBeLessThan(w.cfg.raw.pests.flareDistress);
    expect(maxLoad(w, 0)).toBeGreaterThan(w.cfg.raw.pests.visibleAt);

    // The promise the panel makes about removing an old plant: the jar's own seedlings carry nothing.
    const offspring = w.plants.filter((p) => p.id !== original.id && p.stage !== 'dead');
    expect(offspring.length).toBeGreaterThan(0);
    for (const p of offspring) for (const n of p.nodeIds) expect(w.pool.pests[n]).toBe(0);
  });

  it('announce a new outbreak once, so the game can react to it', () => {
    // The signal the UI pulls the clock to 16x on. It has to fire when an outbreak STARTS and then
    // stay quiet, or a jar with pests on it would drag the speed back every few ticks forever.
    const w = jar([32], { pests: { resistantDays: 3, resistanceFadeDays: 2 } }, true);
    let announced = 0;
    let firstAt = -1;
    for (let i = 0; i < 20 * 1440; i++) {
      tick(w);
      for (const e of w.events) {
        if (e.t === 'infested' && e.plant === 0) {
          announced++;
          if (firstAt < 0) firstAt = i;
        }
      }
      // Two more days of the same outbreak, then stop and check it said nothing further.
      if (firstAt >= 0 && i > firstAt + 2 * 1440) break;
    }
    expect(firstAt).toBeGreaterThan(0);
    expect(announced).toBe(1);
  });

  it('raise the jar-wide warning in a real outbreak', () => {
    const w = jar();
    days(w, 10);
    for (const n of leavesOf(w, 0)) w.pool.pests[n] = 0.9;

    let warned = false;
    for (let i = 0; i < 400 && !warned; i++) {
      tick(w);
      warned = w.events.some((e) => e.t === 'warning' && e.mode === 'pests');
    }
    expect(warned).toBe(true);
  });
});

describe('pests are rolled, not scheduled', () => {
  it('wait for a spark instead of flaring the moment conditions allow', () => {
    // Conditions ripe, ignition impossible: the colony must sit dormant rather than take off.
    const w = jar(
      [32],
      { pests: { resistantDays: 3, resistanceFadeDays: 2, ignitionPerDay: 0, stowawayChance: 1 } },
      true,
    );
    days(w, 20);
    expect(maxLoad(w, 0)).toBeLessThan(w.cfg.raw.pests.visibleAt);
  });

  it('give two identically grown jars different pest histories', () => {
    const firstOutbreak = (seed: number) => {
      const w = new World(cloneBalance({ seed, pests: { resistantDays: 3, resistanceFadeDays: 2 } }));
      w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
      w.commands.push({ t: 'seal' });
      w.commands.push({ t: 'setLid', open: true });
      tick(w);
      const cols: number[] = [];
      for (let x = 1; x <= w.grid.w - 2; x++) if (w.grid.surfaceOfColumn[x] >= 0) cols.push(x);
      for (const x of cols) w.commands.push({ t: 'water', x, ml: 2400 / cols.length });
      for (let i = 0; i < 200; i++) tick(w);
      w.commands.push({ t: 'setLamp', intensity: 0.35 });
      for (const x of [16, 32, 48]) w.commands.push({ t: 'addSpringtails', x, y: 0 });
      w.commands.push({ t: 'plantSeed', x: 32, species: SpeciesId.Herb });
      tick(w);
      for (let i = 0; i < 30 * 1440; i++) {
        tick(w);
        if (w.events.some((e) => e.t === 'infested')) return i;
      }
      return -1;
    };
    const a = firstOutbreak(cloneBalance().seed);
    const b = firstOutbreak(cloneBalance().seed + 1);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Same jar, same care, different luck — the whole point of rolling for it.
    expect(a).not.toBe(b);
  });

  it('do not put pests on every seed the player plants', () => {
    const w = jar([32], { pests: { stowawayChance: 0 } });
    days(w, 2);
    for (const n of leavesOf(w, 0)) expect(w.pool.pests[n]).toBe(0);
  });
});

describe('the lid is the way in', () => {
  /** Old enough to have lost its resistance, and carrying a colony: everything an outbreak needs. */
  const RIPE: Overrides = {
    pests: { resistantDays: 3, resistanceFadeDays: 2, stowawayChance: 1, ignitionPerDay: 1000 },
  };

  it('get in far more readily through an open lid than a shut one', () => {
    /*
     * A frequency, because that is what the rule now is: an open jar rolls at the full rate and a
     * sealed one at a small fraction of it, so neither outcome is certain in any single jar. Six jars
     * each, compressed so plants lose their resistance on day three and the roll is live almost at
     * once. Measured at ten jars each: sealed 2, open 9.
     *
     * Deliberately NOT an assertion that a sealed jar is safe. It is not; it is safER, and a player
     * who never opens the lid should still meet pests eventually.
     */
    const RIPE: Overrides = { pests: { resistantDays: 3, resistanceFadeDays: 2, stowawayChance: 1 } };
    const count = (lidOpen: boolean) => {
      let hit = 0;
      for (let k = 0; k < 6; k++) {
        const w = jar([32], { ...RIPE, seed: cloneBalance().seed + k }, lidOpen);
        for (let i = 0; i < 12 * 1440; i++) {
          tick(w);
          if (w.events.some((e) => e.t === 'infested')) {
            hit++;
            break;
          }
        }
      }
      return hit;
    };
    const sealed = count(false);
    const open = count(true);
    expect(open).toBeGreaterThanOrEqual(5);
    expect(sealed).toBeLessThanOrEqual(3);
    expect(open).toBeGreaterThan(sealed);
  });

  it('does not cure an outbreak already under way by closing the lid', () => {
    /*
     * Only the START is gated. If shutting the lid ended an infestation there would be nothing to
     * play — no pruning, no course, just a button.
     */
    const w = jar([32], RIPE, true);
    for (let i = 0; i < 20 * 1440 && maxLoad(w, 0) < w.cfg.raw.pests.visibleAt; i++) tick(w);
    expect(maxLoad(w, 0)).toBeGreaterThan(w.cfg.raw.pests.visibleAt);

    w.commands.push({ t: 'setLid', open: false });
    days(w, 2);
    expect(maxLoad(w, 0)).toBeGreaterThan(w.cfg.raw.pests.visibleAt);
  });
});

describe('pesticide', () => {
  /** A ten-day-old plant with every leaf heavily infested. */
  function infested() {
    const w = jar();
    days(w, 10);
    for (const n of leavesOf(w, 0)) w.pool.pests[n] = 0.8;
    return w;
  }
  const sprayed = (w: World, times: number) => {
    for (let k = 0; k < times; k++) w.commands.push({ t: 'spray', plant: 0 });
    tick(w);
  };

  it('kills most of the pests on every leaf of the plant', () => {
    const w = infested();
    sprayed(w, 1);
    const kill = w.cfg.raw.pesticide.killFraction;
    // The WHOLE plant: a plant spans six to ten columns, and every leaf of it has to be reached.
    for (const n of leavesOf(w, 0)) expect(w.pool.pests[n]).toBeLessThan(0.8 * (1 - kill) + 1e-6);
  });

  it('is harmless as a single dose', () => {
    const w = infested();
    sprayed(w, 1);
    for (let i = 0; i < 60; i++) tick(w);
    expect(w.plants[0].stressBy[StressCause.Pesticide]).toBe(0);
    expect(w.plants[0].stage).not.toBe('dead');
  });

  it('sickens a plant sprayed twice close together, as the warning before it kills', () => {
    const w = infested();
    sprayed(w, 2);
    for (let i = 0; i < 60; i++) tick(w);
    expect(w.plants[0].stressBy[StressCause.Pesticide]).toBeGreaterThan(0);
    expect(w.plants[0].stage).not.toBe('dead');
  });

  it('kills a plant sprayed three times close together, leaving its stem standing', () => {
    const w = infested();
    sprayed(w, 3);
    const P = w.pool;
    const plant = w.plants[0];
    expect(plant.stage).toBe('dead');
    const alive = plant.nodeIds.filter((n) => P.alive[n]);
    // Stems only: the same corpse a plant that died of natural causes leaves behind.
    expect(alive.length).toBeGreaterThan(0);
    for (const n of alive) expect(P.kind[n]).toBe(NodeKind.Stem);
    // The kill released its water and its tissue; ticking on proves the water books still balance,
    // because the per-tick conservation audit throws the moment they do not.
    days(w, 1);
  });

  it('only doses the plant it is aimed at', () => {
    const w = jar([12, 32, 52]);
    days(w, 5);
    for (let k = 0; k < 3; k++) w.commands.push({ t: 'spray', plant: 1 });
    tick(w);
    expect(w.plants[1].stage).toBe('dead');
    expect(w.plants[0].pesticide).toBe(0);
    expect(w.plants[2].pesticide).toBe(0);
  });

  it('wears off on its own', () => {
    const w = infested();
    sprayed(w, 2);
    days(w, 5);
    expect(w.plants[0].pesticide).toBe(0);
    expect(w.plants[0].stressBy[StressCause.Pesticide]).toBe(0);
  });
});

describe('pesticide course', () => {
  /*
   * An OLD plant, overrun by age: resistance compressed from 40 days to 3 so the tests stay fast. It
   * has to be old — a young healthy plant beats its own pests with no help, and a course on one would
   * prove nothing about whether immunity does anything.
   */
  const AGED: Overrides = { pests: { resistantDays: 3, resistanceFadeDays: 2 } };
  function overrun(pesticide: Overrides['pesticide'] = {}, pests: Overrides['pests'] = {}) {
    const w = jar([32], { pests: { ...AGED.pests, ...pests }, pesticide }, true);
    // Run until it IS overrun, rather than assuming a fixed day. An entrenched colony damages its host
    // until the canopy collapses and regrows, so on any given day the plant may be mid-cycle.
    for (let i = 0; i < 20 * 1440 && maxLoad(w, 0) < w.cfg.raw.pests.visibleAt; i++) tick(w);
    expect(maxLoad(w, 0)).toBeGreaterThan(w.cfg.raw.pests.visibleAt);
    return w;
  }
  const dose = (w: World) => {
    w.commands.push({ t: 'spray', plant: 0 });
    tick(w);
  };
  /** Three doses a little over a day apart — the quickest course that counts. */
  const course = (w: World) => {
    dose(w);
    days(w, 1.1);
    dose(w);
    days(w, 1.1);
    dose(w);
  };

  it('makes an overrun plant immune, where the same plant left alone stays overrun', () => {
    const treated = overrun();
    const control = overrun();
    course(treated);
    days(control, 2.2);
    expect(treated.plants[0].pestImmune).toBe(true);

    days(treated, 3);
    days(control, 3);
    expect(maxLoad(treated, 0)).toBeLessThan(treated.cfg.raw.pests.visibleAt);
    expect(maxLoad(control, 0)).toBeGreaterThan(control.cfg.raw.pests.visibleAt);
    // A course at the quickest spacing sickens the plant a little. It must never kill it.
    expect(treated.plants[0].stage).not.toBe('dead');
  });

  it('does not count a dose given less than a day after the last', () => {
    const w = overrun();
    dose(w);
    for (let i = 0; i < 120; i++) tick(w);
    dose(w);
    expect(w.plants[0].courseDoses).toBe(1);
  });

  it('says so when a dose lands too soon to count', () => {
    /*
     * The one way a player can follow the rule and still not finish: a dose inside the minimum gap
     * costs residue, kills pests, and buys no progress. Left silent it is indistinguishable from the
     * course being broken — which is exactly how "I did the minigame and it did not work" happens.
     */
    const w = overrun();
    dose(w);
    for (let i = 0; i < 120; i++) tick(w);
    w.commands.push({ t: 'spray', plant: 0 });
    tick(w);

    expect(w.events.some((e) => e.t === 'sprayTooSoon' && e.plant === 0)).toBe(true);
    expect(w.plants[0].courseDoses).toBe(1);
  });

  it('cannot start on a plant with no visible pests', () => {
    const w = jar();
    days(w, 10);
    expect(maxLoad(w, 0)).toBeLessThan(w.cfg.raw.pests.visibleAt);
    dose(w);
    expect(w.plants[0].courseDoses).toBe(0);
  });

  it('lapses when the doses are too far apart, and has to start again', () => {
    const w = overrun();
    dose(w);
    days(w, w.cfg.raw.pesticide.courseMaxGapDays + 1);
    // The old plant is overrun again by now, so this dose STARTS a fresh course rather than
    // continuing the lapsed one.
    dose(w);
    expect(w.plants[0].courseDoses).toBe(1);
  });

  it('leaves a survivor immune for good, with no dormant colony left to come back', () => {
    const w = overrun();
    course(w);
    days(w, 2);
    expect(w.plants[0].pestImmune).toBe(true);

    // Forty days is well past the old thirty-day immunity and its grace, and past anything the plant's
    // own resistance would have covered. Nothing may take hold again.
    days(w, 40);
    expect(maxLoad(w, 0)).toBe(0);
    expect(w.plants[0].pestImmune).toBe(true);
  });

  it('gives nothing for shrugging pests off without the course', () => {
    /*
     * Beating an infestation back is not the same as earning immunity.
     *
     * Granting it for any clearing — a prune, or a healthy plant holding its colony down — made the
     * course optional, and the course is the thing the player actually plays. So the plant here gets
     * clear of its pests on its own and stays exactly as catchable as it was.
     */
    const w = jar([32], PINNED);
    days(w, 10);
    for (const n of leavesOf(w, 0)) w.pool.pests[n] = 0.9;

    days(w, 4);
    expect(maxLoad(w, 0)).toBeLessThan(w.cfg.raw.pests.visibleAt);
    expect(w.plants[0].pestImmune).toBe(false);
  });
});

describe('pests and springtails', () => {
  const beneath = (w: World) => {
    const x = Math.round(w.pool.x[w.plants[0].crown] - 0.5);
    let pop = 0;
    for (let dx = -2; dx <= 2; dx++) {
      const s = w.grid.surfaceOfColumn[x + dx];
      if (s >= 0) pop += w.fauna.pop[s] + w.fauna.pop[s + w.grid.w];
    }
    return pop;
  };
  /** Hold the plant's pests high for `d` days, so it is predation being measured, not recovery. */
  const outbreak = (w: World, d: number, also?: World) => {
    for (let i = 0; i < d * 1440; i++) {
      for (const n of leavesOf(w, 0)) w.pool.pests[n] = 0.9;
      if (also) for (const n of leavesOf(also, 0)) also.pool.pests[n] = 0.9;
      tick(w);
      if (also) tick(also);
    }
  };

  it('eat the springtails beneath an outbreak', () => {
    /*
     * The SAME outbreak in both jars; only predation differs.
     *
     * Comparing an infested jar against a clean one measured two things at once and got the sign
     * wrong: pests strip leaves, fallen leaves are springtail food, and for the first day that windfall
     * outweighs the eating — the infested jar's colony was 33% bigger than the clean jar's while being
     * actively preyed on. Holding the outbreak fixed and turning predation off in the control isolates
     * the thing this test is named after.
     */
    const control = jar([32], { ...PINNED, pests: { ...PINNED.pests, predationPerMin: 0 } });
    const hit = jar([32], PINNED);
    days(control, 10);
    days(hit, 10);
    expect(beneath(hit)).toBe(beneath(control));

    outbreak(hit, 2, control);
    // Both jars carry the same litter from the same shed leaves, so the gap is what was eaten.
    expect(beneath(hit)).toBeLessThan(beneath(control) * 0.8);
  });

  it('never wipe them out, so they breed back once the pests are gone', () => {
    /*
     * Tested as recovery, not as a per-cell floor. A colony that predation has thinned behaves
     * differently afterwards — it moves, and a dormant one migrates whole — so comparing cells against
     * an untouched jar measures divergence, not the floor. What the floor is FOR is this: after an
     * outbreak the springtails are still there, and they come back.
     */
    const w = jar();
    days(w, 10);
    outbreak(w, 3);
    const low = w.fauna.total();
    expect(low).toBeGreaterThan(0);

    for (const n of w.plants[0].nodeIds) w.pool.pests[n] = 0;
    days(w, 5);
    expect(w.fauna.total()).toBeGreaterThan(low);
  });
});

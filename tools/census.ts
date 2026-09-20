// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Why does a jar settle at four or five plants?
 *
 * The balance matrix only reports the FINAL count, which cannot distinguish the several very different
 * stories that all end at "five plants":
 *
 *  - seeds never get dropped, because blooms are rare or the parent cannot afford one;
 *  - seeds are dropped but land nowhere, because every column within a parent's reach is too close to
 *    an existing crown;
 *  - seeds land and sprout, then starve in their parent's shade and are declared failed to establish;
 *  - the jar genuinely runs out of minerals and nothing more can be built.
 *
 * Each of those wants a different fix, and three of the four would be made WORSE by raising the caps.
 * So this walks a run day by day and reports which one is actually happening.
 *
 * Read-only: it drives the same tick as the game and never writes simulation state.
 *
 *   npx tsx tools/census.ts --scenario wild --days 80
 */

import { SCENARIOS, type Scenario } from './harness.js';
import { cloneBalance, type BalanceConfig, type DeepPartial } from '../src/sim/config/balance.js';
import { SPECIES, SpeciesId } from '../src/sim/config/species.js';
import { SUBSTRATES, type SubstrateId } from '../src/sim/config/content.js';
import type { Plant } from '../src/sim/plant.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

const LIMITER_NAME = ['none', 'light', 'air', 'water', 'warmth', 'store-full'];

/**
 * Mirrors `runScenario`'s setup so the numbers are comparable with the balance matrix.
 *
 * `overrides` is merged at the TOP level only, which is enough because no scenario sets a `plant` block
 * — they override `thermal` and `atmosphere`. Anything deeper would need a real deep merge.
 */
function build(sc: Scenario, overrides: DeepPartial<BalanceConfig> = {}): World {
  const balance = cloneBalance({ ...(sc.balance ?? {}), ...overrides });
  const world = new World(balance);
  world.auditEnabled = true;

  world.commands.push({
    t: 'layerBands',
    gravelRows: sc.layers.gravel,
    charcoalRows: sc.layers.charcoal,
    soilRows: sc.layers.soil,
  });
  world.commands.push({ t: 'setLamp', intensity: sc.lamp });
  world.commands.push({ t: 'setLid', open: sc.lidOpen });
  world.commands.push({ t: 'seal' });
  tick(world);

  const columns: number[] = [];
  for (let x = 1; x <= world.grid.w - 2; x++) {
    if (world.grid.surfaceOfColumn[x] >= 0) columns.push(x);
  }
  const perColumn = columns.length > 0 ? sc.primeMl / columns.length : 0;
  for (const x of columns) world.commands.push({ t: 'water', x, ml: perColumn });
  for (let i = 0; i < 200; i++) tick(world);

  if (sc.starterLitter) {
    for (const x of columns) {
      const surface = world.grid.surfaceOfColumn[x];
      if (surface >= 0) world.grid.organic[surface] += sc.starterLitter;
    }
  }
  for (const x of sc.springtails ?? []) {
    const surface = world.grid.surfaceOfColumn[x];
    if (surface >= 0) world.commands.push({ t: 'addSpringtails', x, y: world.grid.yOf(surface) });
  }
  for (const x of sc.moss ?? []) world.commands.push({ t: 'addMoss', x });
  for (const seed of sc.seeds) {
    const [x, species] = typeof seed === 'number' ? [seed, SpeciesId.Herb] : seed;
    world.commands.push({ t: 'plantSeed', x, species });
  }
  return world;
}

const living = (w: World): Plant[] => w.plants.filter((p) => p.stage !== 'dead');

/**
 * Where a seed COULD land right now, by the same rules `trySeedFrom` applies, split two ways.
 *
 * `anywhere` is every column that is rootable and far enough from every living crown — the ground the
 * jar has left. `reachable` narrows that to columns actually within some living parent's seeding range.
 * The gap between the two is the whole question: if there is open ground but nothing can reach it, the
 * jar is limited by REACH, and raising the plant cap or the fertility would change nothing at all.
 */
function seedRoom(w: World): { anywhere: number; reachable: number } {
  const g = w.grid;
  const alive = living(w);
  const crowns = alive.map((p) => w.pool.x[p.crown] - 0.5);

  let anywhere = 0;
  let reachable = 0;
  for (let x = 1; x <= g.w - 2; x++) {
    const surface = g.surfaceOfColumn[x];
    if (surface < 0) continue;
    if (!SUBSTRATES[g.substrate[surface] as SubstrateId].rootable) continue;

    // Spacing is read from the SEEDING plant's own species, so a column is open if any living plant
    // could legally seed it — which is the same question `trySeedFrom` asks per parent.
    let openForAny = false;
    let reachedByAny = false;
    for (const p of alive) {
      const r = w.cfg.species[p.species].raw.reproduction;
      if (crowns.some((ox) => Math.abs(ox - x) < r.seedMinSpacing)) continue;
      openForAny = true;
      const d = Math.abs((w.pool.x[p.crown] - 0.5) - x);
      if (d >= r.seedMinRange && d <= r.seedMaxRange) {
        reachedByAny = true;
        break;
      }
    }
    if (openForAny) anywhere++;
    if (reachedByAny) reachable++;
  }
  return { anywhere, reachable };
}

function run(sc: Scenario, days: number, overrides: DeepPartial<BalanceConfig> = {}): void {
  const w = build(sc, overrides);
  const cfg = w.cfg.raw.plant.reproduction;
  const ticksPerDay = w.cfg.raw.time.dayLengthSimMinutes / w.cfg.raw.time.simMinutesPerTick;
  const total = Math.round(days * ticksPerDay);

  let seeded = 0;
  let peak = 0;
  let capBlockedDays = 0;
  let noRoomDays = 0;
  // Rhizosphere priming, measured directly. Plant counts cannot attribute anything to exudate, because
  // the fertility and spacing changes landed in the same build and move the same number.
  let sproutSamples = 0;
  let sproutFauna = 0;
  let sproutOrganic = 0;
  let jarFaunaMean = 0;
  let jarSamples = 0;
  let seedlingDays = 0;
  // Seeding capacity measured PER PARENT, which is the question `trySeedFrom` actually asks. The
  // jar-wide "reachable" figure above cannot answer it: options are computed from one specific
  // blooming plant's position, so a jar can show a dozen reachable columns while every plant mature
  // enough to bloom is boxed into the middle with nowhere legal to put a seed.
  let parentDays = 0;
  let parentsWithRoom = 0;
  let parentsAffording = 0;
  let parentsReady = 0;

  console.log(`\n=== ${sc.name} — ${days} sim-days ===`);
  console.log(
    'day  live  peak  seeds  room(any/reach)  soilNut  litter  fauna  flowers  seedling limiters',
  );

  for (let t = 0; t < total; t++) {
    tick(w);
    for (const e of w.events) if (e.t === 'seeded') seeded++;

    if (t % ticksPerDay !== 0) continue;

    const alive = living(w);
    peak = Math.max(peak, alive.length);
    const room = seedRoom(w);
    if (alive.length >= cfg.maxPlants) capBlockedDays++;
    if (room.reachable === 0) noRoomDays++;

    let soilNut = 0;
    let litter = 0;
    for (const i of w.grid.activeCells) {
      soilNut += w.grid.nutrients[i];
      litter += w.grid.organic[i];
    }

    // What is holding back the plants that have NOT yet established — the ones whose fate decides
    // whether the jar fills in or stalls.
    const seedlings = alive.filter((p) => p.stage === 'seedling');
    seedlingDays += seedlings.length;
    // Springtails sitting IN seedling root cells, against the jar's average cell. If exudate works,
    // these two numbers separate; if sprouts are simply in busy parts of the jar, they will not.
    for (const p of seedlings) {
      for (const n of p.nodeIds) {
        if (!w.pool.alive[n] || w.pool.kind[n] !== 0) continue;
        const cell = w.grid.idx(w.pool.cellX[n], w.pool.cellY[n]);
        sproutFauna += w.fauna.pop[cell];
        sproutOrganic += w.grid.organic[cell];
        sproutSamples++;
      }
    }
    {
      let sum = 0;
      let cells = 0;
      for (const i of w.grid.activeCells) {
        sum += w.fauna.pop[i];
        cells++;
      }
      if (cells > 0) {
        jarFaunaMean += sum / cells;
        jarSamples++;
      }
    }

    // Every gate `plantSeed` and `trySeedFrom` impose, evaluated per living plant: somewhere legal to
    // put a seed, and the sugar, minerals and water to pay for one.
    for (const p of alive) {
      const sp = w.cfg.species[p.species].raw;
      const r = sp.reproduction;
      const px = Math.round(w.pool.x[p.crown] - 0.5);
      let opts = 0;
      for (const dir of [-1, 1]) {
        for (let d = r.seedMinRange; d <= r.seedMaxRange; d++) {
          const x = px + dir * d;
          if (x < 1 || x > w.grid.w - 2) continue;
          const surface = w.grid.surfaceOfColumn[x];
          if (surface < 0) continue;
          if (!SUBSTRATES[w.grid.substrate[surface] as SubstrateId].rootable) continue;
          if (alive.some((o) => Math.abs(w.pool.x[o.crown] - 0.5 - x) < r.seedMinSpacing)) continue;
          opts++;
        }
      }
      const canPay =
        w.pool.sugar[p.crown] >= sp.seedSugar + sp.growth.sugarCostPerNode * 3 &&
        p.nutrients >= sp.growth.nutrientCostPerNode * 4 &&
        p.waterMl >= sp.seedWaterMl;
      parentDays++;
      if (opts > 0) parentsWithRoom++;
      if (canPay) parentsAffording++;
      if (opts > 0 && canPay) parentsReady++;
    }
    const limiters = new Map<string, number>();
    let starved = 0;
    for (const p of seedlings) {
      const key = LIMITER_NAME[p.limiter] ?? String(p.limiter);
      limiters.set(key, (limiters.get(key) ?? 0) + 1);
      if (p.nutrientStarved) starved++;
    }
    const limiterText = seedlings.length
      ? [...limiters].map(([k, n]) => `${n}x${k}`).join(' ') + (starved ? ` (${starved} mineral-starved)` : '')
      : '—';

    const day = String(Math.round(t / ticksPerDay)).padStart(3);
    console.log(
      `${day}  ${String(alive.length).padStart(4)}  ${String(peak).padStart(4)}  ${String(seeded).padStart(5)}` +
        `  ${String(room.anywhere).padStart(6)}/${String(room.reachable).padEnd(6)}` +
        `  ${soilNut.toFixed(0).padStart(7)}  ${litter.toFixed(0).padStart(6)}` +
        `  ${w.faunaPopulation.toFixed(0).padStart(5)}` +
        `  ${String(w.plants.reduce((a, p) => a + p.flowers, 0)).padStart(7)}  ${limiterText}`,
    );
  }

  // --- how every plant that ever existed ended up
  const dead = w.plants.filter((p) => p.stage === 'dead');
  const failedToEstablish = dead.filter((p) => p.barrenMinutes >= cfg.failToEstablishMinutes);
  const collapsed = dead.filter((p) => p.barrenMinutes < cfg.failToEstablishMinutes);
  const alive = living(w);

  console.log(`\n  plants ever: ${w.plants.length}  (seeded by blooms: ${seeded})`);
  console.log(`  alive at end: ${alive.length}, peak simultaneous: ${peak}`);
  console.log(
    `  died: ${dead.length} — ${failedToEstablish.length} failed to establish ` +
      `(peak nodes ${failedToEstablish.map((p) => p.peakNodes).join(',') || '-'}), ` +
      `${collapsed.length} collapsed after establishing ` +
      `(peak nodes ${collapsed.map((p) => p.peakNodes).join(',') || '-'})`,
  );
  const per = (v: number) => (sproutSamples ? (v / sproutSamples).toFixed(2) : 'n/a');
  console.log(
    `  rhizosphere: ${sproutSamples} root-cell samples over ${seedlingDays} seedling-days — ` +
      `${per(sproutFauna)} springtails per seedling root cell vs ` +
      `${jarSamples ? (jarFaunaMean / jarSamples).toFixed(2) : 'n/a'} per average cell, ` +
      `${per(sproutOrganic)} organic pooled there`,
  );
  const pct = (v: number) => (parentDays ? ((v / parentDays) * 100).toFixed(0) + '%' : 'n/a');
  console.log(
    `  seeding gates, per plant-day (${parentDays} samples): somewhere legal to seed ${pct(parentsWithRoom)}, ` +
      `able to afford a seed ${pct(parentsAffording)}, BOTH ${pct(parentsReady)}`,
  );
  console.log(`  days at the ${cfg.maxPlants}-plant safety cap: ${capBlockedDays}`);
  console.log(`  days with NO reachable open column: ${noRoomDays}`);
  // Branching: a fork is a live stem carrying more than one live stem child. Reported because nothing
  // else in the project can see it — the renderer draws forks correctly and always could, so a jar with
  // branching switched off and one where the fork rule never fires look identical from outside.
  let forks = 0;
  let stems = 0;
  for (const p of alive) {
    for (const n of p.nodeIds) {
      if (!w.pool.alive[n] || (w.pool.kind[n] !== 1 && n !== p.crown)) continue;
      stems++;
      let kids = 0;
      for (let ch = w.pool.firstChild[n]; ch >= 0; ch = w.pool.nextSibling[ch]) {
        if (w.pool.alive[ch] && w.pool.kind[ch] === 1) kids++;
      }
      if (kids > 1) forks++;
    }
  }
  console.log(
    `  branching: ${forks} forks across ${stems} live stems, ` +
      `${alive.length ? (stems / alive.length).toFixed(1) : '0'} stems per plant`,
  );

  /*
   * Water actually reaching the leaves, bucketed by hops from the crown.
   *
   * This is the question branching raises and the reason the flag exists. Transport divides a node's
   * offer among its live children, so a fork splits the flow further — but branches are also SHORTER and
   * run in parallel from lower down, where a single chain funnels its whole canopy through one throat.
   * Which effect wins is not something to reason about: run it with `--branch off` and compare.
   *
   * `leafWaterNeed` is read from the base config, so in a mixed jar it is an approximation across
   * species. Fine for an A/B against itself; not a number to quote on its own.
   */
  const need = w.cfg.raw.plant.photosynthesis.leafWaterNeed;
  const buckets = [
    { label: 'near(<=3)', max: 3, sum: 0, n: 0 },
    { label: 'mid(4-6)', max: 6, sum: 0, n: 0 },
    { label: 'far(7+)', max: 999, sum: 0, n: 0 },
  ];
  let thirsty = 0;
  let leafCount = 0;
  for (const p of alive) {
    for (const n of p.nodeIds) {
      if (!w.pool.alive[n] || w.pool.kind[n] !== 2) continue;
      leafCount++;
      if (w.pool.water[n] < need) thirsty++;
      const bucket = buckets.find((b) => w.pool.depth[n] <= b.max)!;
      bucket.sum += w.pool.water[n];
      bucket.n++;
    }
  }
  console.log(
    `  leaf water: ${leafCount ? ((thirsty / leafCount) * 100).toFixed(0) : '0'}% below need (${need} mL) — ` +
      buckets.map((b) => `${b.label} ${b.n ? (b.sum / b.n).toFixed(2) : 'n/a'} (${b.n})`).join(', '),
  );

  const mix = SPECIES.map((sp) => `${alive.filter((p) => p.species === sp.id).length} ${sp.name}`).join(' / ');
  console.log(`  final mix: ${mix}`);
  console.log(`  final nodes: ${alive.reduce((a, p) => a + p.liveNodes, 0)}, carbon drift check via harness`);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const which = arg('scenario', 'wild');
const days = Number(arg('days', '80'));
const sc = SCENARIOS[which];
if (!sc) {
  console.error(`unknown scenario "${which}". known: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}
// `--branch off` disables forking, so the same jar can be run both ways and compared. Without it the
// only way to A/B branching would be editing the config between runs, which is exactly how a stale
// build gets measured and believed.
const branching = arg('branch', 'on') !== 'off';
run(sc, days, branching ? {} : { plant: { growth: { branchingEnabled: false } } });

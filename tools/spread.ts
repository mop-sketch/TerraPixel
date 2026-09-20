// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Is the jar LONELY? Not "how many plants", but "how much of the jar do they reach".
 *
 * A jar can hold its full plant cap and still read as empty, because a count says nothing about where
 * the plants are. Eight crowns bunched into the middle twenty columns leave both ends bare, and bare
 * ends are what make a terrarium feel unoccupied. So this reports the DISTRIBUTION:
 *
 *  - every crown column, in order;
 *  - the gaps between them, and the two edge gaps, which is where loneliness actually lives;
 *  - coverage: the share of rootable columns within `--reach` cells of some crown.
 *
 * Read-only. Drives the same tick as the game.
 *
 *   npx tsx tools/spread.ts --scenario wild --days 60
 */

import { SCENARIOS, type Scenario } from './harness.js';
import { cloneBalance, type BalanceConfig, type DeepPartial } from '../src/sim/config/balance.js';
import { SpeciesId } from '../src/sim/config/species.js';
import { SUBSTRATES, type SubstrateId } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';

function build(sc: Scenario, overrides: DeepPartial<BalanceConfig> = {}): World {
  const balance = cloneBalance({ ...(sc.balance ?? {}), ...overrides });
  const world = new World(balance);
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

/** Columns a plant could actually root in — the jar's usable floor, not its pixel width. */
function rootableColumns(w: World): number[] {
  const g = w.grid;
  const out: number[] = [];
  for (let x = 1; x <= g.w - 2; x++) {
    const s = g.surfaceOfColumn[x];
    if (s < 0) continue;
    if (!SUBSTRATES[g.substrate[s] as SubstrateId].rootable) continue;
    out.push(x);
  }
  return out;
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const scenarioName = arg('scenario', 'wild');
const days = Number(arg('days', '60'));
const reach = Number(arg('reach', '3'));
const sc = SCENARIOS[scenarioName];
if (!sc) {
  console.error(`unknown scenario ${scenarioName}; try: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(1);
}

const range = process.argv.indexOf('--range') >= 0 ? Number(arg('range', '10')) : undefined;
const overrides: DeepPartial<BalanceConfig> =
  range === undefined ? {} : { plant: { reproduction: { seedMaxRange: range } } };
if (range !== undefined) console.log(`override: seedMaxRange = ${range}`);

const w = build(sc, overrides);
const floor = rootableColumns(w);
const lo = floor[0];
const hi = floor[floor.length - 1];
console.log(`${scenarioName}: rootable floor is columns ${lo}..${hi} (${floor.length} wide)\n`);
console.log('day  plants  crowns                              edges     widest gap  coverage');

for (let day = 1; day <= days; day++) {
  for (let i = 0; i < 1440; i++) tick(w);
  if (day % 10 !== 0 && day !== days) continue;

  const crowns = w.plants
    .filter((p) => p.stage !== 'dead')
    .map((p) => Math.round(w.pool.x[p.crown] - 0.5))
    .sort((a, b) => a - b);

  let covered = 0;
  for (const x of floor) if (crowns.some((c) => Math.abs(c - x) <= reach)) covered++;

  let widest = 0;
  for (let i = 1; i < crowns.length; i++) widest = Math.max(widest, crowns[i] - crowns[i - 1]);
  const leftEdge = crowns.length ? crowns[0] - lo : floor.length;
  const rightEdge = crowns.length ? hi - crowns[crowns.length - 1] : floor.length;

  console.log(
    `${String(day).padStart(3)}  ${String(crowns.length).padStart(6)}  ` +
      `${crowns.join(',').padEnd(34)}  ${String(leftEdge).padStart(2)}/${String(rightEdge).padEnd(2)}  ` +
      `${String(widest).padStart(10)}  ${((covered / floor.length) * 100).toFixed(0).padStart(7)}%`,
  );
}

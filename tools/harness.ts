// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Headless balance harness.
 *
 * Tuning a closed-loop ecological simulation by watching it in real time is impractical: an in-game
 * day is 144 real seconds, and equilibrium takes many days to reveal itself. This runs the same sim
 * core under Node at whatever speed the CPU allows, so "unbalanceable" becomes a measurement — and,
 * in CI, a failing test — instead of a discovery three months from now.
 *
 * It exists only because src/sim imports no browser API.
 *
 *   npx tsx tools/harness.ts --days 30
 *   npx tsx tools/harness.ts --scenario hot-sealed --days 14 --csv out.csv
 *   npx tsx tools/harness.ts --sweep evapMlPerMinAtFullDrive=0.3,0.5,0.7
 */

import { writeFileSync } from 'node:fs';
import { cloneBalance, type BalanceConfig, type DeepPartial } from '../src/sim/config/balance.js';
import { humidity } from '../src/sim/atmosphere.js';
import { SPECIES, SpeciesId } from '../src/sim/config/species.js';
import { Substrate } from '../src/sim/config/content.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';
import type { FailureMode } from '../src/sim/events.js';

export interface Scenario {
  name: string;
  balance?: DeepPartial<BalanceConfig>;
  /** Layer depths in cells, applied during the build phase. */
  layers: { gravel: number; charcoal: number; soil: number };
  /**
   * Columns to plant. A bare number means the Herb — which is what keeps every scenario written
   * before species existed asserting exactly what it always asserted.
   */
  seeds: Array<number | [number, SpeciesId]>;
  /**
   * The seeds are a regular row meant as a DENSITY: as many plants for the air as the 64x32 jar had. A
   * bigger jar is filled with more of them, rather than the same plants spread thinner. Without this,
   * `overplanted` in the 80x40 jar was ten plants in 1.56x the air, which is not overplanted.
   */
  packed?: boolean;
  lamp: number;
  lidOpen: boolean;
  /**
   * The initial charge, spread evenly across every column.
   *
   * This is the number that actually matters in a SEALED jar, because water cycles rather than being
   * consumed: soil -> transpiration -> air -> glass -> bead -> soil. With the lid closed the system
   * loses nothing, so the jar's health is set by its total stock of water, not by a flow rate. Which
   * is exactly the real terrarium fantasy — water it properly once, then mostly leave it alone.
   */
  primeMl: number;
  /** Ongoing top-up. `wateringEvery: 0` means never water again after the prime. */
  wateringMl: number;
  wateringEvery: number;
  /** Columns to seed a springtail culture into. Empty means a jar with no decomposers at all. */
  springtails?: number[];
  /** Columns to plant a starter moss patch on. It spreads outward from there on its own. */
  moss?: number[];
  /** Litter to salt the substrate with at setup, so the decomposers have something to start on. */
  starterLitter?: number;
  /**
   * A pond, built the way a player builds one: dug a column at a time under columns `from`..`to`,
   * `depth` cells deep, lined with ONE Mud click, then filled with `fillMl` poured into the middle
   * after the jar is primed.
   */
  pond?: {
    from: number;
    to: number;
    depth: number;
    fillMl: number;
    /**
     * Leaf litter landing in the pond each day, per pond column: a plant shedding over it. Its carbon
     * is taken out of the air as it lands, so the carbon books still balance and the drift check stays
     * meaningful — a real leaf carries carbon the plant took from the air, too.
     */
    litterPerDay?: number;
    /** Columns to float lilies onto once the pond is filled. */
    lilies?: number[];
    /** Columns to put a snail culture into once the pond is filled. */
    snails?: number[];
    /** Columns to set hornwort into once the pond is filled. */
    hornwort?: number[];
  };
}

export const SCENARIOS: Record<string, Scenario> = {
  /**
   * The intended good build: deep drainage, charcoal, plenty of soil, a decomposer culture, charged
   * once and left alone. This is the configuration the whole game is balanced around.
   */
  'well-built': {
    name: 'well-built',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 0.6,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
  },
  /**
   * The reference jar with a pond dug between its two plants: the same build, the same charge, plus a
   * 9-column basin lined with one Mud click and filled. What the pond changes is the whole question,
   * so nothing else differs from `well-built`.
   */
  ponded: {
    name: 'ponded',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 0.6,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
    pond: { from: 28, to: 36, depth: 3, fillMl: 330 },
  },
  /** The same pond under a bright lamp, with leaves landing in it every day: the textbook bloom. */
  'green-water': {
    name: 'green-water',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 1.0,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
    pond: { from: 28, to: 36, depth: 3, fillMl: 330, litterPerDay: 0.5 },
  },
  /** The green-water pond with lilies floated onto it: the pads are the answer. */
  'lily-pond': {
    name: 'lily-pond',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 1.0,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
    pond: { from: 28, to: 36, depth: 3, fillMl: 330, litterPerDay: 0.5, lilies: [32] },
  },
  /** The ordinary pond, left alone apart from hornwort set into it: everyday upkeep. */
  'hornwort-pond': {
    name: 'hornwort-pond',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 0.6,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
    pond: { from: 28, to: 36, depth: 3, fillMl: 330, hornwort: [32] },
  },
  /** The green-water pond with a snail culture in it: the living answer. */
  'snail-pond': {
    name: 'snail-pond',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 1.0,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
    pond: { from: 28, to: 36, depth: 3, fillMl: 330, litterPerDay: 0.5, snails: [32] },
  },
  /** The same fed pond, but under a dim lamp. Shade is the lever: it should stay clear. */
  'shaded-pond': {
    name: 'shaded-pond',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 0.25,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
    pond: { from: 28, to: 36, depth: 3, fillMl: 330, litterPerDay: 0.5 },
  },
  /**
   * The same jar with no decomposers. The A/B that justifies the entire M7 milestone: if this does not
   * run its air down while `well-built` holds, the carbon loop is not doing anything.
   */
  'no-fauna': {
    name: 'no-fauna',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 0.6,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    starterLitter: 1.5,
  },
  /**
   * Sealed and hot: the condensation and evaporation pressure case. Deliberately hot but INSIDE the
   * plant's temperature tolerance — past about 33 C photosynthesis is flatly zero and the scenario
   * stops testing the water cycle and just tests starvation.
   */
  'hot-sealed': {
    name: 'hot-sealed',
    balance: { thermal: { lampDeltaC: 9 } },
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [32],
    lamp: 1,
    lidOpen: false,
    primeMl: 2600,
    wateringMl: 0,
    wateringEvery: 0,
  },
  /**
   * One plant, left completely alone, long enough for its blooms to seed the jar.
   *
   * The scenario that guards the propagation feature's whole risk profile. A mature plant blooms 1.30
   * times per sim-day, so an ungated version of this turns one plant into hundreds and exhausts the
   * shared node pool — which fails SILENTLY, stopping growth jar-wide. It must fill in and then
   * settle, held back by light, minerals and spacing rather than by the safety cap.
   */
  wild: {
    name: 'wild',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [32],
    lamp: 0.35,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
  },
  /**
   * A dim, damp jar. The Fern's habitat and the Herb's problem.
   *
   * Half of the species A/B: at lamp 0.15 the Herb's lightHalfSat of 90 leaves it barely fixing
   * carbon, while the Fern's 45 has it near full rate. If this does not beat a Herb in the same jar,
   * shade tolerance is a number that does nothing.
   */
  'fern-shade': {
    name: 'fern-shade',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [[20, SpeciesId.Fern], [44, SpeciesId.Fern]],
    lamp: 0.15,
    lidOpen: false,
    primeMl: 2800,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
  },
  /**
   * Bright and deliberately under-watered. The other half of the A/B: the Succulent drinks a third of
   * what the Herb does and carries a quarter of its dehydration stress, so it should hold where a Herb
   * on the same ration runs dry.
   */
  'succulent-dry': {
    name: 'succulent-dry',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [[20, SpeciesId.Succulent], [44, SpeciesId.Succulent]],
    lamp: 0.9,
    lidOpen: false,
    primeMl: 900,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
  },
  /**
   * All three in one middling jar — the conditions none of them love and none of them hate.
   *
   * The scenario that exists for the interactions rather than the plants: one species crowding the
   * others out, or the Succulent's long-lived leaves shedding so little litter that the decomposers
   * starve and take the whole jar's fertility down with them.
   */
  mixed: {
    name: 'mixed',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [[14, SpeciesId.Fern], [32, SpeciesId.Herb], [50, SpeciesId.Succulent]],
    lamp: 0.5,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
  },
  /** Barely watered at all. Should reach dehydration, and only dehydration. */
  'cold-dry': {
    name: 'cold-dry',
    balance: { thermal: { ambientC: 16 } },
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [32],
    lamp: 0.3,
    lidOpen: false,
    primeMl: 120,
    wateringMl: 0,
    wateringEvery: 0,
  },
  /** No drainage layer at all, and relentlessly over-watered. Should reach root rot. */
  'no-drainage': {
    name: 'no-drainage',
    layers: { gravel: 0, charcoal: 0, soil: 16 },
    seeds: [32],
    lamp: 0.6,
    lidOpen: false,
    // A sealed jar retains what it is given, so a single drenching is the whole mistake — no ongoing
    // over-watering is needed to keep the root zone waterlogged.
    primeMl: 9000,
    wateringMl: 0,
    wateringEvery: 0,
  },
  /**
   * Soaked, sealed and warm, with plenty of litter on the surface. The mold case: humidity parked
   * above the spawn threshold long enough for the dwell counter to fill, and something for the fungus
   * to actually eat once it takes hold.
   */
  swampy: {
    name: 'swampy',
    balance: { thermal: { lampDeltaC: 8 } },
    layers: { gravel: 1, charcoal: 0, soil: 15 },
    seeds: [32],
    lamp: 1,
    lidOpen: false,
    primeMl: 8200,
    wateringMl: 0,
    wateringEvery: 0,
    starterLitter: 6,
  },
  /**
   * Packed with plants and no decomposers at all. The CO2-stall case.
   *
   * Carbon conserves, so a sealed jar cannot lose CO2 — it can only park it somewhere. Seven plants
   * growing hard lock a large share of the jar's carbon into tissue, and every leaf they shed locks
   * more of it into litter that nothing is recycling. The air runs down not because the carbon left,
   * but because nobody is giving it back. Adding springtails is the fix, which is exactly the lesson.
   */
  overplanted: {
    name: 'overplanted',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [4, 10, 16, 22, 28, 34, 40, 46, 52, 58],
    packed: true,
    lamp: 0.8,
    lidOpen: false,
    primeMl: 3000,
    wateringMl: 0,
    wateringEvery: 0,
  },
  /**
   * A three-plant jar with moss cultivated across the surface.
   *
   * The A/B against `well-built`, which uses the same three plants without moss and slowly runs its
   * nutrients down. Moss is tuned for break-even, so this jar should hold its size where the bare one
   * declines — not grow without limit.
   */
  mossy: {
    name: 'mossy',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [16, 32, 48],
    lamp: 0.35,
    lidOpen: false,
    primeMl: 2400,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [16, 32, 48],
    moss: [10, 22, 34, 46, 58],
    starterLitter: 1.5,
  },
  /** The same overplanted jar WITH a decomposer culture — the A/B that proves the fix works. */
  /**
   * The jar left standing open, which is now the ONLY way pests get in.
   *
   * Watered daily, because an open jar loses its water to the room instead of cycling it — without a
   * top-up this would be a dehydration scenario wearing a pest scenario's name.
   */
  vented: {
    name: 'vented',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [20, 44],
    lamp: 0.6,
    lidOpen: true,
    primeMl: 2400,
    wateringMl: 260,
    wateringEvery: 1440,
    springtails: [16, 32, 48],
    starterLitter: 1.5,
  },
  'overplanted-fauna': {
    name: 'overplanted-fauna',
    layers: { gravel: 4, charcoal: 3, soil: 9 },
    seeds: [8, 16, 24, 32, 40, 48, 56],
    packed: true,
    lamp: 0.8,
    lidOpen: false,
    primeMl: 3000,
    wateringMl: 0,
    wateringEvery: 0,
    springtails: [12, 28, 44, 60],
    starterLitter: 1,
  },
};

export interface Sample {
  tick: number;
  day: number;
  tempC: number;
  rh: number;
  co2: number;
  o2: number;
  soilMl: number;
  sumpMl: number;
  liveNodes: number;
  leaves: number;
  roots: number;
  stress: number;
  /** Fraction of cells showing ANY mold. Good for the player; too blunt to measure suppression. */
  moldCoverage: number;
  /** Total mold across the jar. Distinguishes "a trace everywhere" from "saturated everywhere". */
  moldMass: number;
  litter: number;
  nutrients: number;
  fauna: number;
  charcoal: number;
  /** Flowers set across all plants — the jar's score, and the M9 win condition. */
  flowers: number;
  /** Total carbon in the jar, in ppm-equivalent. Should not drift in a sealed system. */
  carbon: number;
  /** Fraction of the exposed surface under moss, 0-1. */
  moss: number;
  /** Mean distress across plants: what is actually wrong, excluding ordinary ageing. */
  distress: number;
  /** Plants currently alive. Grows on its own once blooms start seeding. */
  plants: number;
  /** Living plants of each species, indexed by SpeciesId. Lets a mixed jar bound its composition. */
  bySpecies: number[];
  /** Fraction of live leaves VISIBLY infested — what the player sees and the pest warning reads. */
  pestCoverage: number;
  /** Total pest load across every leaf, dormant colonies included. Proves a colony is still there. */
  pestLoad: number;
  /** Free water standing in the jar: a pond, mostly. */
  pondMl: number;
  snails: number;
  /** 1 while the jar reads as fogged, else 0. Averaged over a run, the share of it spent fogged. */
  fogged: number;
  /** The greenest the standing water is anywhere, 0 to 1. */
  green: number;
}

export interface RunResult {
  scenario: string;
  ticks: number;
  samples: Sample[];
  /** Every mode seen at any point in the run. A brief transient during establishment counts here. */
  failures: FailureMode[];
  warnings: FailureMode[];
  /** Modes still tripped at the end. This is the one that says what state the jar settled into. */
  activeFailures: FailureMode[];
  died: boolean;
  /** Peak-to-peak humidity over the final quarter of the run: the oscillation detector. */
  rhSwingLate: number;
  finalNodes: number;
  /** True if the shared node pool ever ran out — a hard limit, not a balance outcome. */
  poolExhausted: boolean;
  error?: string;
}

/**
 * @param observe Called on the live world at every sample. For instruments that need to look at the
 *                jar itself rather than at the summary `Sample` — never used by the matrix.
 */
/**
 * A scenario is written for the 64x32 jar the game was first balanced in. This scales it to the jar
 * the balance actually has, so "the reference jar" stays the same jar, only bigger: layers by the jar's
 * height, water by its area, and every column position by its width.
 */
/**
 * A packed row of seeds refitted to a jar `width` columns wide and `sy` times as tall: the same first
 * column and the same margin at the far wall, and the spacing closed up by the jar's extra height, so
 * there are as many plants for the air as there were. Plants per unit of air is what a crowd draws the
 * CO2 down by, and early on, when it matters, a young plant is no bigger for the jar being taller.
 */
function packedRow(seeds: number[], width: number, sy: number): number[] {
  const every = Math.max(2, Math.round((seeds[1] - seeds[0]) / sy));
  const margin = 64 - seeds[seeds.length - 1];
  const out: number[] = [];
  for (let x = seeds[0]; x <= width - margin; x += every) out.push(x);
  return out;
}

export function fitToJar(sc: Scenario, grid: { interiorW: number; interiorH: number }): Scenario {
  const sx = grid.interiorW / 64;
  const sy = grid.interiorH / 32;
  if (sx === 1 && sy === 1) return sc;
  const col = (x: number): number => Math.max(1, Math.min(grid.interiorW, Math.round(x * sx)));
  return {
    ...sc,
    layers: {
      gravel: Math.round(sc.layers.gravel * sy),
      charcoal: Math.round(sc.layers.charcoal * sy),
      soil: Math.round(sc.layers.soil * sy),
    },
    primeMl: sc.primeMl * sx * sy,
    wateringMl: sc.wateringMl * sx * sy,
    seeds: sc.packed ? packedRow(sc.seeds as number[], grid.interiorW, sy) : sc.seeds.map((s) => (typeof s === 'number' ? col(s) : ([col(s[0]), s[1]] as [number, SpeciesId]))),
    springtails: sc.springtails?.map(col),
    moss: sc.moss?.map(col),
    pond: sc.pond && {
      ...sc.pond,
      from: col(sc.pond.from),
      to: col(sc.pond.to),
      fillMl: sc.pond.fillMl * sx * sy,
      lilies: sc.pond.lilies?.map(col),
      snails: sc.pond.snails?.map(col),
      hornwort: sc.pond.hornwort?.map(col),
    },
  };
}

export function runScenario(
  given: Scenario,
  simDays: number,
  sampleEvery = 60,
  observe?: (w: World, tick: number) => void,
): RunResult {
  const balance = cloneBalance(given.balance ?? {});
  const sc = fitToJar(given, balance.grid);
  const world = new World(balance);
  world.auditEnabled = true;

  world.commands.push({
    t: 'layerBands',
    gravelRows: sc.layers.gravel,
    charcoalRows: sc.layers.charcoal,
    soilRows: sc.layers.soil,
  });
  if (sc.pond) {
    /*
     * Dug and lined while the jar is still being BUILT, as a player would, and for a reason that
     * matters more than realism: a sealed jar left dry before its first watering loses most of the
     * nutrients in its rooting zone when that watering arrives. Ten ticks halves early growth; the
     * ~130 a dig takes cost the plants 85% of it. Digging after the seal made the pond look like it
     * stunted the jar, when it was only the wait. The same wait while building is harmless.
     */
    tick(world);
    while (world.substrateDirty) tick(world);
    digPond(world, sc.pond);
  }
  world.commands.push({ t: 'setLamp', intensity: sc.lamp });
  world.commands.push({ t: 'setLid', open: sc.lidOpen });
  world.commands.push({ t: 'seal' });
  tick(world); // drains the build commands and flips to tend

  // Charge the substrate evenly BEFORE planting, so no seed starts on a dry patch and the whole jar
  // begins from a comparable state across scenarios.
  const columns: number[] = [];
  for (let x = 1; x <= world.grid.w - 2; x++) {
    if (world.grid.surfaceOfColumn[x] >= 0) columns.push(x);
  }
  const perColumn = columns.length > 0 ? sc.primeMl / columns.length : 0;
  for (const x of columns) world.commands.push({ t: 'water', x, ml: perColumn });
  // Let the charge percolate and settle before anything is planted into it.
  for (let i = 0; i < 200; i++) tick(world);

  if (sc.pond && sc.pond.fillMl > 0) {
    const middle = Math.round((sc.pond.from + sc.pond.to) / 2);
    const pours = Math.ceil(sc.pond.fillMl / 30);
    for (let k = 0; k < pours; k++) {
      world.commands.push({ t: 'water', x: middle, ml: sc.pond.fillMl / pours, spread: 0 });
    }
    for (let i = 0; i < 60; i++) tick(world);
    for (const x of sc.pond.lilies ?? []) world.commands.push({ t: 'addLilies', x });
    for (const x of sc.pond.snails ?? []) world.commands.push({ t: 'addSnails', x });
    for (const x of sc.pond.hornwort ?? []) world.commands.push({ t: 'addHornwort', x });
  }

  // Salt the surface with leaf litter, so a decomposer culture has something to eat on arrival.
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

  const totalTicks = Math.round((simDays * balance.time.dayLengthSimMinutes) / balance.time.simMinutesPerTick);
  const samples: Sample[] = [];
  const failures = new Set<FailureMode>();
  const warnings = new Set<FailureMode>();
  let error: string | undefined;

  /**
   * Humidity min/max are tracked EVERY tick, not per sample.
   *
   * The condensation band produces a real cycle with a period of roughly an hour (slow rise from
   * evaporation, fast fall once the latch engages). Sampling every 60 ticks aliases against that
   * almost perfectly and reports a swing of 0.0 — which would hide genuine oscillation rather than
   * detect it. Peak-to-peak over the window is immune to the sampling rate.
   */
  let rhMinLate = Infinity;
  let rhMaxLate = -Infinity;
  const lateFrom = Math.floor(totalTicks * 0.75);

  for (let t = 0; t < totalTicks; t++) {
    const feed = sc.pond?.litterPerDay ?? 0;
    if (sc.pond && feed > 0 && t % balance.time.dayLengthSimMinutes === 0) {
      const units = balance.decay.co2PpmPerUnit;
      for (let x = sc.pond.from; x <= sc.pond.to; x++) {
        const floor = world.grid.surfaceOfColumn[x];
        if (floor < 0) continue;
        world.grid.organic[floor] += feed;
        world.atmo.co2Ppm = Math.max(0, world.atmo.co2Ppm - feed * units);
      }
    }
    if (sc.wateringEvery > 0 && t > 0 && t % sc.wateringEvery === 0) {
      for (const x of columns) world.commands.push({ t: 'water', x, ml: sc.wateringMl / columns.length });
    }
    try {
      tick(world);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      break;
    }
    for (const e of world.events) {
      if (e.t === 'failure') failures.add(e.mode);
      if (e.t === 'warning') warnings.add(e.mode);
    }
    if (t >= lateFrom) {
      const rh = humidity(world.cfg, world.atmo);
      if (rh < rhMinLate) rhMinLate = rh;
      if (rh > rhMaxLate) rhMaxLate = rh;
    }
    if (t % sampleEvery === 0) {
      samples.push(sample(world));
      observe?.(world, t);
    }
  }

  const rhSwingLate = Number.isFinite(rhMinLate) ? rhMaxLate - rhMinLate : 0;

  return {
    scenario: sc.name,
    ticks: world.tickCount,
    samples,
    failures: [...failures],
    warnings: [...warnings],
    activeFailures: (Object.keys(world.strikes) as FailureMode[]).filter((m) => world.strikes[m].triggered),
    died: world.plants.length > 0 && world.plants.every((p) => p.stage === 'dead'),
    rhSwingLate,
    finalNodes: liveNodes(world),
    poolExhausted: world.poolExhausted,
    error,
  };
}

function liveNodes(w: World): number {
  let n = 0;
  for (let i = 0; i < w.pool.count; i++) if (w.pool.alive[i]) n++;
  return n;
}

/**
 * Dig and line a basin exactly as a player does: a column at a time with a settle in between, so the
 * soil slumps to its own angle, then one Mud click at the rim. Direct paints for the dig, because a
 * command per cell would need a tick per cell anyway; the lining goes through the real command.
 */
function digPond(world: World, pond: NonNullable<Scenario['pond']>): void {
  const g = world.grid;
  const middle = Math.round((pond.from + pond.to) / 2);
  const base = g.yOf(g.surfaceOfColumn[middle]);
  for (let dy = 0; dy < pond.depth; dy++) {
    for (let x = pond.from; x <= pond.to; x++) {
      world.paint(x, base + dy, Substrate.Air);
      tick(world);
    }
  }
  for (let i = 0; i < 100; i++) tick(world);
  world.commands.push({ t: 'paint', x: middle, y: base, material: Substrate.Mud });
  tick(world);
  while (world.substrateDirty) tick(world);
}

function sample(w: World): Sample {
  const P = w.pool;
  let leaves = 0;
  let roots = 0;
  let live = 0;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n]) continue;
    live++;
    if (P.kind[n] === 2) leaves++;
    if (P.kind[n] === 0) roots++;
  }
  const living = w.plants.filter((p) => p.stage !== 'dead');
  let litter = 0;
  let nutrients = 0;
  for (const i of w.grid.activeCells) {
    litter += w.grid.organic[i];
    nutrients += w.grid.nutrients[i];
  }

  return {
    litter,
    nutrients,
    fauna: w.faunaPopulation,
    charcoal: w.charcoalCapacity(),
    flowers: w.plants.reduce((a, p) => a + p.flowers, 0),
    carbon: w.auditCarbonPpm(),
    moss: w.mossCover(),
    // LIVING plants only, for both of these. Dead entries are never spliced out of `w.plants` (node
    // `plantId` indexes straight into it), so averaging over the whole array would quietly dilute
    // distress with the frozen last reading of every plant that ever died.
    distress: living.length ? living.reduce((a, p) => a + p.distress, 0) / living.length : 0,
    plants: living.length,
    bySpecies: SPECIES.map((sp) => living.filter((p) => p.species === sp.id).length),
    pestCoverage: w.pestCoverage,
    pestLoad: (() => {
      let m = 0;
      for (let n = 0; n < P.count; n++) if (P.alive[n]) m += P.pests[n];
      return m;
    })(),
    pondMl: w.grid.standingMl(),
    fogged: w.atmo.fogged ? 1 : 0,
    green: w.pondGreenness(),
    snails: w.pond.snailCount(),
    tick: w.tickCount,
    day: w.simDay,
    tempC: w.atmo.tempC,
    rh: humidity(w.cfg, w.atmo),
    co2: w.atmo.co2Ppm,
    o2: w.atmo.o2Pct,
    soilMl: w.grid.totalWaterMl(),
    sumpMl: w.sumpMl,
    liveNodes: live,
    leaves,
    roots,
    stress: w.plants.length ? w.plants.reduce((a, p) => a + p.stress, 0) / w.plants.length : 0,
    moldCoverage: w.moldCoverage,
    moldMass: (() => {
      let m = 0;
      for (const i of w.grid.activeCells) m += w.grid.mold[i];
      return m;
    })(),
  };
}

// ---------------------------------------------------------------------------------------------
// Balance targets
// ---------------------------------------------------------------------------------------------

/**
 * What "balanced" actually means, stated as assertions rather than as a feeling.
 *
 * The point of writing these down is that balance stops being something you eyeball in a play session
 * and becomes something CI can fail on. Bounds are deliberately generous: they are there to catch a
 * system that has broken or drifted out of its intended role, not to pin numbers in place and make
 * every future tuning change a test failure.
 */
export interface BalanceTarget {
  scenario: string;
  days: number;
  /** Why this scenario exists — printed alongside a failure so the intent is never lost. */
  intent: string;
  expect: {
    /** Failure modes this jar MUST reach. The mistake it exists to demonstrate. */
    failures?: FailureMode[];
    /** Failure modes it must NOT reach, so each mistake stays individually diagnosable. */
    forbid?: FailureMode[];
    nodes?: [number, number];
    flowers?: [number, number];
    co2?: [number, number];
    litter?: [number, number];
    fauna?: [number, number];
    /** Surface moss coverage at the end of the run, 0-1. */
    moss?: [number, number];
    /** Final node count as a fraction of the run's PEAK — how well the jar held what it built. */
    retainedFraction?: number;
    /** Peak mold coverage over the run, as a fraction of the substrate. */
    moldPeak?: [number, number];
    /** Peak share of leaves VISIBLY infested with pests over the run. */
    pestPeak?: [number, number];
    /**
     * The stowaway colonies must still be alive at the end, dormant or not.
     *
     * The other half of `pestPeak: [0, 0]`. A jar that shows no pests because they all died out has
     * not held them down; it has simply lost them, and would never flare again when it went wrong.
     */
    pestsPersist?: boolean;
    maxDistress?: number;
    maxRhSwing?: number;
    /** Percent drift in total carbon. A sealed jar must not invent or destroy it. */
    maxCarbonDrift?: number;
    /** Living plants at the end of the run — the propagation band. */
    plants?: [number, number];
    /** Minimum living plants of EVERY species at the end. Guards against one crowding the rest out. */
    speciesFloor?: number;
    /** Free water left standing at the end of the run. */
    pondMl?: [number, number];
    /** Share of the run the jar spent fogged. */
    foggedFraction?: [number, number];
    /** The greenest the water got at any point in the run. */
    greenPeak?: [number, number];
    /** Snails alive at the end of the run. */
    snails?: [number, number];
  };
}

export const TARGETS: BalanceTarget[] = [
  {
    scenario: 'well-built',
    days: 40,
    intent: 'the reference jar: it should simply thrive, unattended, and bloom steadily',
    expect: {
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall', 'pests'],
      moldPeak: [0, 0],
      /*
       * Pests present, and never seen. A healthy host holds its stowaways at the dormant level, below
       * what the player can see, so this jar carries a colony for all 40 days without it showing once.
       * Both halves matter — see `pestsPersist`.
       */
      pestPeak: [0, 0],
      pestsPersist: true,
      nodes: [70, 345],
      flowers: [60, 400],
      co2: [300, 1800],
      /*
       * Widened from 250 after the jar was opened up, and this one IS a band whose premise expired
       * rather than a number that wanted fixing.
       *
       * Measured at 274 with the colony in rude health — 103 springtails, more than the 83 this jar
       * carried before — alongside 220 soil nutrients, no failure mode tripped at any point in 41
       * sim-days, and CO2 back at a comfortable 327. Consumption and leaf fall are near enough in
       * balance; the jar simply keeps a deeper litter horizon now it carries nine plants instead of the
       * three these bounds were written around, which is what a fuller planting looks like from the
       * soil up.
       *
       * Held below `no-fauna`'s floor of 300 on purpose, so the decomposers-versus-none contrast still
       * means something rather than the two bands blurring into each other.
       */
      litter: [0, 320],
      fauna: [10, 400],
      maxDistress: 0.15,
      /*
       * 35 -> 40, because this measures the DIURNAL cycle here, not instability.
       *
       * Raising the jar's carbon budget took the reference jar from 6 plants to 9, and the late-run RH
       * swing went 24.1 points to 35.2 with it. That looks alarming next to the 25-point line the
       * summary prints `OSCILLATING` at, so it was run down rather than waved through.
       *
       * It is not the condensation latch hunting. Sweeping `condensation.ratePctPerMin` across
       * 0.9 / 0.6 / 0.4 / 0.25 — a 3.6x change in how hard the latch pulls — moved the swing not at all,
       * 35.2 points at every setting. What does move it is plant count: more canopy transpires more
       * water into the same air, and air capacity doubles per 10 C, so the day/night temperature cycle
       * swings a wetter jar further. That is the model working, and a terrarium fogging and clearing
       * daily is a thing to watch rather than a fault.
       *
       * The ceiling stays low enough to catch a genuine latch oscillation, which would run far past 40.
       */
      maxRhSwing: 40,
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'ponded',
    days: 40,
    intent: 'the reference jar with a pond: more humid, and left alone it greens over',
    expect: {
      /*
       * A pond is a trade, not a hazard. Across five seeds it lifted mean humidity from 58.9% to 65.3%
       * and fogged the jar 2% of the time where the reference jar never fogged, with no failure mode
       * tripped in any of them and the plants inside the reference jar's own range.
       */
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall', 'pests'],
      nodes: [70, 345],
      flowers: [60, 400],
      /*
       * The guard for the design doc's trap #4: evaporation is the dangerous number, and set too high
       * it fogs every pond jar permanently, which turns mold from a hazard into a certainty. A quarter
       * of the run is far past anything measured and still well short of permanent.
       */
      foggedFraction: [0, 0.25],
      /*
       * GREEN, on purpose. An ordinary pond left to itself now greens over, fed by the damp ground that
       * seeps into it: measured green by day 6 and peaking at 52%. It used to peak at 10%, which made
       * algae something that only happened to a pond someone had deliberately neglected, and left
       * lilies and snails with nothing to do in an ordinary jar.
       */
      greenPeak: [0.3, 1],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'green-water',
    days: 40,
    intent: 'a bright pond fed leaves every day: the water turns green',
    expect: {
      greenPeak: [0.3, 1],
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall'],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'lily-pond',
    days: 40,
    intent: 'the green-water pond with lilies on it: the mat keeps the water clear',
    expect: {
      // Measured at 2% against the same pond's 40% without it.
      greenPeak: [0, 0.1],
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall'],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'hornwort-pond',
    days: 40,
    intent: 'an ordinary pond with hornwort in it: the fronds keep it clear where the bare one greens',
    expect: {
      /*
       * Never green water: under the 30% at which the water reads as green and the lesson calls it a
       * bloom. Measured at 20.5% against the same pond's 44% without hornwort. (The ceiling was 20%,
       * set by eye from an earlier 12%; counting only the dug hollow's water as the pond's, rather than
       * the flood above it too, made every pond read a little greener for the same algae.)
       */
      greenPeak: [0, 0.28],
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall'],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'snail-pond',
    days: 40,
    intent: 'the green-water pond with snails in it: they graze it clear and the colony lasts',
    expect: {
      greenPeak: [0, 0.1],
      // A colony that holds on, rather than one that ate everything and starved to nothing.
      snails: [1, 1000],
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall'],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'shaded-pond',
    days: 40,
    intent: 'the same fed pond under a dim lamp: shade keeps it clear',
    expect: {
      greenPeak: [0, 0.1],
      forbid: ['dehydration', 'rootRot', 'mold', 'co2Stall'],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'wild',
    days: 60,
    intent: 'one plant left alone seeds the jar and settles, rather than booming or dying out',
    expect: {
      forbid: ['dehydration', 'rootRot', 'mold'],
      // A band, not a number: below 2 the feature never fired, and anywhere near `maxPlants` (12)
      // means the emergent limits are not biting and only the safety cap is holding it back.
      //
      // Restored close to its original [2, 6] after the experiment it was widened for was abandoned. It
      // briefly read [4, 17] to fit a jar running loosened spacing, a 14-column seed throw and a cap of
      // 20 — none of which survive, and the comment was still citing that cap of 20 long after it went
      // back to 12. With branching a lone plant settles at 3, which is what this target always meant.
      plants: [2, 8],
      flowers: [40, 600],
      // Reproduction moves sugar, tissue, water and minerals between plants, so a sealed jar full of
      // self-sown seedlings is the hardest test the carbon audit gets.
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'fern-shade',
    days: 40,
    intent: 'a dim damp jar: the Fern should thrive in light that would starve a Herb',
    expect: {
      forbid: ['dehydration', 'rootRot'],
      // The Fern packs tighter than the others by design (seedMinSpacing 4 against the Herb's 5), so the
      // band is wide on purpose — but the ceiling has to stay below `maxPlants` (12), or a genuine
      // runaway that hits the safety cap would pass here on the cap's own say-so.
      //
      // Corrected from [4, 18], which was set against a cap of 20 and a spacing of 2. Both were reverted
      // and the bound was left behind: a ceiling of 18 under a cap of 12 could never fail at all.
      plants: [2, 11],
      nodes: [60, 405],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'succulent-dry',
    days: 40,
    intent: 'a bright sparse-water jar: the Succulent should hold where a Herb would dry out',
    expect: {
      forbid: ['rootRot'],
      // Re-banded from [2, 8] when spacing was loosened. The Succulent is still the most widely spaced
      // of the three (5 against the base 4), so it fills in more slowly than the others — but it does
      // now fill in. Ceiling held below maxPlants (20) so a runaway into the safety cap still fails.
      plants: [2, 14],
      nodes: [40, 220],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'mixed',
    days: 50,
    intent: 'all three together: the jar settles rather than one species crowding the rest out',
    expect: {
      forbid: ['dehydration', 'rootRot', 'mold'],
      // Every species still represented at the end. A band that allows zero would let this pass while
      // one plant quietly ate the jar, which is the single thing this scenario exists to catch.
      speciesFloor: 1,
      // Measured 15 at day 50 once spacing and reach were loosened, with all three species still
      // present. Ceiling held below maxPlants (20) for the same reason as the other two.
      plants: [5, 18],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'no-fauna',
    days: 40,
    intent: 'the same jar without decomposers: litter must visibly pile up and growth must suffer',
    expect: { litter: [300, 5000], fauna: [0, 0], maxCarbonDrift: 3 },
  },
  {
    scenario: 'mossy',
    days: 50,
    intent: 'a moss-cultivated jar holds what it grew, where the same jar bare slowly runs down',
    expect: {
      forbid: ['dehydration', 'rootRot', 'mold'],
      moss: [0.3, 1],
      /*
       * 0.9 -> 0.78, because this jar runs FIFTY days and the premise expired.
       *
       * It was written when nothing could take a mature jar's canopy away. Plants now lose their
       * resistance to pests at forty days, and a colony left alone entrenches and starts costing the
       * plant leaves — and every jar in this matrix is unattended by definition, so past day forty they
       * all pay it. Measured: 82% retained as shipped, 98% with pests off, 98% with pests on but
       * entrenchment disabled. The loss is entrenchment doing exactly what it was added to do.
       *
       * Still a real bar. The jar keeps four fifths of its peak and is still flowering hard (326 blooms
       * against a floor of 60), which is what "holds what it grew" has to mean now that neglect has a
       * price. `well-built` at 40 days still proves the untouched case, inside the resistant window.
       */
      retainedFraction: 0.78,
      flowers: [60, 600],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'cold-dry',
    days: 40,
    intent: 'never watered: dehydration and ONLY dehydration, and no reward for it',
    expect: {
      failures: ['dehydration'],
      forbid: ['rootRot', 'mold'],
      flowers: [0, 0],
      maxCarbonDrift: 3,
    },
  },
  {
    scenario: 'no-drainage',
    days: 40,
    intent: 'no gravel and drenched: the root zone waterlogs',
    expect: { failures: ['rootRot'], maxCarbonDrift: 3 },
  },
  {
    scenario: 'swampy',
    days: 40,
    intent: 'left fogged with litter on the surface: mold takes hold',
    /*
     * Rescaled with the metric, not relaxed. `moldCoverage` used to divide by every cell in the jar
     * while mold can only live on the litter-bearing surface row, so this jar — which exists to prove
     * mold can take a terrarium — peaked at 0.063 against a ceiling of 0.9 it could never approach.
     * Measured against the hostable row it reads a full 1.0, so the floor moves up to match.
     */
    expect: { forbid: ['dehydration'], moldPeak: [0.3, 1], maxCarbonDrift: 3 },
  },
  {
    scenario: 'well-built',
    days: 60,
    intent: 'the same reference jar, left longer: still thriving, with its stowaway colonies aboard',
    /*
     * No pest assertion here, because a sealed jar is now a matter of ODDS rather than a rule: the
     * lid multiplies the chance of an outbreak down, it does not remove it. Measured over sixty days
     * across ten seeds, 3 of 10 sealed jars met pests — and always late, on days 56, 59 and 60 —
     * against 10 of 10 for the `vented` jar from day 46. A single run cannot assert a frequency, so
     * that comparison lives in pests.test.ts where it can afford several jars.
     *
     * `pestsPersist` still holds and still matters: the dormant colonies are aboard the whole time,
     * so a quiet jar is quiet because nothing gave them their chance, not because they died out.
     */
    expect: { pestsPersist: true, maxCarbonDrift: 3 },
  },
  {
    scenario: 'overplanted',
    days: 40,
    intent: 'packed with plants and no recyclers: the air runs thin and litter accumulates',
    /*
     * No pests, and that is the point rather than an oversight: this jar is sealed. Starving plants
     * make a colony WORSE once it is going, but nothing can get going while the lid is shut — so a
     * crowd suffering every other way still never meets one. `vented` is where pests are proven.
     */
    /*
     * Pests: a small flare at most. The lid is shut, but a sealed jar still carries a small chance of
     * pests by design, and this jar is starved of CO2, which is exactly the stress that lets a
     * stowaway colony flare. On the 80x40 jar three of four seeds showed one, peaking at 1.6-2.0% of
     * leaves; the ceiling was zero, which only ever held by luck of the draw.
     */
    expect: { litter: [200, 5000], co2: [0, 930], pestPeak: [0, 0.05], maxCarbonDrift: 3 },
  },
  {
    scenario: 'vented',
    days: 60,
    intent: 'left standing open: the one way pests get in, and the price of venting',
    /*
     * The counterpart to the sealed jars above. Measured across three seeds, pests first showed on days
     * 46, 48 and 58 and peaked at 55%, 85% and 88% of leaves — so the floor is 0.2, well clear of any
     * one seed's luck while still failing loudly if the lid stops mattering.
     *
     * It must also still be a jar worth keeping: an open one loses its water to the room, so it is
     * watered daily, and it should go on flowering through the infestation rather than collapsing.
     */
    /*
     * No carbon check here, and that is not a relaxation: this jar is OPEN. It trades gas with the
     * room across the whole run — which is what venting is — so the closed-system conservation the
     * other scenarios assert has no meaning for it. Measured drift 34.5%, all of it through the lid.
     */
    expect: { pestPeak: [0.2, 1], flowers: [60, 600], plants: [2, 14] },
  },
  {
    scenario: 'overplanted-fauna',
    days: 40,
    intent: 'the same crowd WITH recyclers: more plant, more blooms, far less litter',
    expect: { litter: [0, 200], fauna: [10, 800], maxCarbonDrift: 3 },
  },
];

export interface TargetCheck {
  scenario: string;
  intent: string;
  failures: string[];
}

const inRange = (v: number, r: [number, number]) => v >= r[0] && v <= r[1];

/** Score one scenario against its target. Returns the list of broken expectations. */
export function checkTarget(t: BalanceTarget, r: RunResult): TargetCheck {
  const problems: string[] = [];
  const last = r.samples.at(-1);
  const first = r.samples[0];
  const e = t.expect;

  if (r.error) problems.push(`aborted: ${r.error}`);
  if (r.poolExhausted) problems.push('node pool exhausted');
  if (!last || !first) return { scenario: t.scenario, intent: t.intent, failures: ['no samples'] };

  for (const mode of e.failures ?? []) {
    if (!r.failures.includes(mode)) problems.push(`never reached ${mode}`);
  }
  for (const mode of e.forbid ?? []) {
    if (r.failures.includes(mode)) problems.push(`reached ${mode}, which it should not`);
  }
  const check = (name: string, v: number, r2?: [number, number]) => {
    if (r2 && !inRange(v, r2)) problems.push(`${name} ${v.toFixed(1)} outside ${r2[0]}..${r2[1]}`);
  };
  check('nodes', last.liveNodes, e.nodes);
  check('flowers', last.flowers, e.flowers);
  check('co2', last.co2, e.co2);
  check('litter', last.litter, e.litter);
  check('fauna', last.fauna, e.fauna);
  check('moss cover', last.moss, e.moss);
  check('plants', last.plants, e.plants);
  if (e.speciesFloor !== undefined) {
    last.bySpecies.forEach((n, id) => {
      if (n < e.speciesFloor!) problems.push(`${SPECIES[id].name} down to ${n}, wanted >=${e.speciesFloor}`);
    });
  }
  if (e.retainedFraction !== undefined) {
    // Compared against the run's own peak rather than a fixed number, so this asks "did the jar HOLD
    // what it built" independently of how big it happened to get.
    const peak = Math.max(...r.samples.map((s) => s.liveNodes));
    const retained = peak > 0 ? last.liveNodes / peak : 0;
    if (retained < e.retainedFraction) {
      problems.push(`retained only ${(retained * 100).toFixed(0)}% of peak ${peak}, wanted >=${(e.retainedFraction * 100).toFixed(0)}%`);
    }
  }
  if (e.moldPeak) {
    // Peak rather than final: mold blooms and crashes as it burns through its own fuel, so the end of
    // a run says nothing about whether an outbreak ever happened.
    check('peak mold', Math.max(...r.samples.map((s) => s.moldCoverage)), e.moldPeak);
  }
  if (e.pestPeak) check('peak pests', Math.max(...r.samples.map((s) => s.pestCoverage)), e.pestPeak);
  check('pond mL', last.pondMl, e.pondMl);
  if (e.greenPeak) check('peak green', Math.max(...r.samples.map((s) => s.green)), e.greenPeak);
  check('snails', last.snails, e.snails);
  if (e.foggedFraction) {
    check('fogged share', r.samples.reduce((a, s) => a + s.fogged, 0) / r.samples.length, e.foggedFraction);
  }
  if (e.pestsPersist && !(last.pestLoad > 0)) problems.push('the stowaway pest colonies died out entirely');

  if (e.maxDistress !== undefined && last.distress > e.maxDistress) {
    problems.push(`distress ${(last.distress * 100).toFixed(0)}% over ${(e.maxDistress * 100).toFixed(0)}%`);
  }
  if (e.maxRhSwing !== undefined && r.rhSwingLate > e.maxRhSwing) {
    problems.push(`humidity swing ${r.rhSwingLate.toFixed(1)} over ${e.maxRhSwing}`);
  }
  if (e.maxCarbonDrift !== undefined) {
    const drift = Math.abs(((last.carbon - first.carbon) / Math.max(1, first.carbon)) * 100);
    if (drift > e.maxCarbonDrift) problems.push(`carbon drift ${drift.toFixed(1)}% over ${e.maxCarbonDrift}%`);
  }

  return { scenario: t.scenario, intent: t.intent, failures: problems };
}

/** Run every target and report. Returns true if the whole matrix passed. */
export function runMatrix(log = true): boolean {
  let allPass = true;
  for (const t of TARGETS) {
    const sc = SCENARIOS[t.scenario];
    const result = checkTarget(t, runScenario(sc, t.days));
    const ok = result.failures.length === 0;
    allPass &&= ok;
    if (!log) continue;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.scenario.padEnd(20)} ${t.intent}`);
    for (const f of result.failures) console.log(`        ! ${f}`);
  }
  if (log) console.log(allPass ? '\nbalance matrix: all targets met' : '\nbalance matrix: FAILED');
  return allPass;
}

export function toCsv(r: RunResult): string {
  const head = 'tick,day,tempC,rh,co2,o2,soilMl,sumpMl,liveNodes,leaves,roots,stress,moldCoverage';
  const rows = r.samples.map((s) =>
    [s.tick, s.day, s.tempC, s.rh, s.co2, s.o2, s.soilMl, s.sumpMl, s.liveNodes, s.leaves, s.roots, s.stress, s.moldCoverage]
      .map((v) => (typeof v === 'number' ? v.toFixed(3) : v))
      .join(','),
  );
  return [head, ...rows].join('\n');
}

function report(r: RunResult): void {
  const last = r.samples.at(-1);
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`\n=== ${r.scenario} — ${r.ticks} ticks (${last?.day ?? 0} sim-days) ===`);
  if (r.error) {
    console.log(`  ABORTED: ${r.error}`);
    return;
  }
  if (last) {
    console.log(`  ${pad('equilibrium', 14)} ${last.tempC.toFixed(1)}°C  ${last.rh.toFixed(0)}% RH  ${last.co2.toFixed(0)} ppm CO2  ${last.o2.toFixed(1)}% O2`);
    console.log(`  ${pad('water', 14)} ${last.soilMl.toFixed(0)} mL in substrate, ${last.sumpMl.toFixed(0)} mL standing`);
    const mix = last.bySpecies.map((n, id) => `${n} ${SPECIES[id].name}`).join(' / ');
    console.log(`  ${pad('species', 14)} ${mix}`);
    console.log(`  ${pad('plants', 14)} ${last.plants} plants, ${last.liveNodes} nodes (${last.roots}R / ${last.leaves}L), distress ${(last.distress * 100).toFixed(0)}% (stress ${(last.stress * 100).toFixed(0)}%), ${last.flowers} flowers`);
    const first = r.samples[0];
    const drift = ((last.carbon - first.carbon) / Math.max(1, first.carbon)) * 100;
    console.log(`  ${pad('carbon', 14)} ${last.carbon.toFixed(0)} ppm-equiv, drift ${drift >= 0 ? '+' : ''}${drift.toFixed(1)}% ${Math.abs(drift) > 5 ? '<-- LEAKING' : ''}`);
    console.log(`  ${pad('ecology', 14)} ${last.fauna.toFixed(0)} springtails, ${last.litter.toFixed(1)} litter, ${last.nutrients.toFixed(0)} nutrients, moss ${(last.moss * 100).toFixed(0)}%`);
    console.log(`  ${pad('mold', 14)} ${(last.moldCoverage * 100).toFixed(1)}% of substrate, charcoal ${(last.charcoal * 100).toFixed(0)}% capacity`);
  }
  console.log(`  ${pad('RH swing (late)', 14)} ${r.rhSwingLate.toFixed(1)} points  ${r.rhSwingLate > 25 ? '<-- OSCILLATING' : ''}`);
  console.log(`  ${pad('seen (ever)', 14)} warn: ${r.warnings.join(', ') || 'none'} | fail: ${r.failures.join(', ') || 'none'}`);
  console.log(`  ${pad('still tripped', 14)} ${r.activeFailures.join(', ') || 'none'}`);
  console.log(`  ${pad('verdict', 14)} ${r.died ? 'DIED' : r.finalNodes > 3 ? 'alive and growing' : 'alive but stalled'}`);
  // A silently exhausted pool looks exactly like a plant choosing to stop growing, so it is called out
  // rather than left to be misread as a balance result.
  if (r.poolExhausted) console.log(`  ${pad('WARNING', 14)} node pool ran out — raise plant.maxNodes`);
}

// --- CLI -------------------------------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function main(): void {
  const days = Number(arg('days', '14'));
  const which = arg('scenario');
  const csv = arg('csv');
  const sweep = arg('sweep');

  // `--matrix` is the CI entry point: it scores every scenario against its stated intent and exits
  // non-zero if the balance has drifted out of shape.
  if (process.argv.includes('--matrix')) {
    process.exit(runMatrix() ? 0 : 1);
  }

  const list = which ? [SCENARIOS[which]] : Object.values(SCENARIOS);
  if (which && !SCENARIOS[which]) {
    console.error(`unknown scenario "${which}". known: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  if (sweep) {
    // --sweep key=a,b,c varies one atmosphere rate across a scenario, which is the common case
    // during a balance pass.
    const [key, values] = sweep.split('=');
    for (const v of values.split(',')) {
      const base = list[0];
      const sc: Scenario = {
        ...base,
        name: `${base.name} [${key}=${v}]`,
        balance: { ...(base.balance ?? {}), atmosphere: { [key]: Number(v) } as never },
      };
      report(runScenario(sc, days));
    }
    return;
  }

  const results = list.map((sc) => runScenario(sc, days));
  results.forEach(report);

  if (csv && results[0]) {
    writeFileSync(csv, toCsv(results[0]), 'utf8');
    console.log(`\nwrote ${csv}`);
  }

  const broke = results.filter((r) => r.error);
  if (broke.length > 0) process.exit(1);
}

// Only run the CLI when invoked directly, so tests can import the scenarios.
if (process.argv[1] && process.argv[1].includes('harness')) main();

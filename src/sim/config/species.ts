// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Plant species: overlays on the `plant` block of the balance config.
 *
 * SIMULATION PARAMETERS ONLY. Leaf colours and shapes live in src/theme.ts keyed by the same ids, so
 * a balance pass never has to read presentation and the renderer never has to read balance.
 *
 * Every knob a species needs already lives inside `BalanceConfig['plant']`, which is why a species is
 * a partial overlay rather than a new subsystem. `compile()` merges each overlay onto the base plant
 * block once and derives that species' own curves — see `CompiledSpecies` in balance.ts.
 *
 * The roster is built on ONE axis the player already has a dial for: dim and damp at one end, bright
 * and dry at the other, with the Herb in the middle. That is the whole design. A jar tuned for the
 * Fern is actively wrong for the Succulent, so lamp intensity stops having a single correct setting
 * and a mixed planting becomes a composition problem instead of a bigger monoculture.
 */

import type { BalanceConfig, DeepPartial } from './balance.js';

export const enum SpeciesId {
  Fern = 0,
  Herb = 1,
  Succulent = 2,
}

export interface SpeciesDef {
  readonly id: SpeciesId;
  readonly name: string;
  /** One line, player-facing: what this plant NEEDS, not what it looks like. */
  readonly need: string;
  readonly overlay: DeepPartial<BalanceConfig['plant']>;
}

export const SPECIES: readonly SpeciesDef[] = [
  {
    id: SpeciesId.Fern,
    name: 'Fern',
    need: 'Shade-loving and thirsty — keep the lamp low and the soil damp.',
    overlay: {
      photosynthesis: {
        // Half the Herb's half-saturation point: it reaches full rate in light that would leave the
        // Herb starving. The lower ceiling is the price — shade tolerance is not a free win.
        lightHalfSat: 45,
        maxPerLeafPerMin: 1.0,
        leafWaterNeed: 0.55,
        tempOptimalC: 21,
        tempToleranceC: 7,
      },
      uptake: { rootMlPerMin: 0.18 },
      health: {
        dehydrationStress: 0.85,
        // Wet feet are its natural habitat, so waterlogging bothers it far less than the others.
        rotStress: 0.3,
      },
      // Branches the most freely of the three, and it is the species that most needs to: capped at four
      // cells of height, a fern can only get bigger by getting wider.
      /*
       * Still the branchiest of the three, but capped at two forks per plant.
       *
       * The rate came down from 0.16 to 0.04 and the cap from 5 to 2, and the cap is the term doing the
       * work: trimming the rate alone moved a dim jar's node count the WRONG way, 266 to 269, because
       * these self-seeding jars are chaotic enough that a third off a probability is lost in the noise.
       * A hard ceiling on forks per plant is not.
       */
      growth: { maxShootHeight: 4, leavesPerStem: 3, branchChance: 0.04, maxBranchesPerPlant: 2 },
      /*
       * Still the tightest of the three, but 4 -> 5, so fern foliage stops growing into itself.
       *
       * At 4 a fern jar packed to gaps of 4 and 5 columns while a frond spans four to five, so a stand
       * of ferns read as one green mass rather than as plants. Measured on `fern-shade` over 40
       * sim-days, the neighbour gaps went 4,9,6,5,4,4,5,4,4,5 at spacing 4 to 9,6,9,9,7,6 at spacing 5 —
       * nothing below 6 survives, because the constraint cascades and the realised gaps land wider than
       * the floor itself.
       *
       * It costs the jar four of its eleven plants and 287 nodes -> 221. Deliberately stopped at 5
       * rather than 6: at 6 the outcome is indistinguishable (7 plants, 218 nodes) but the Fern would
       * pack exactly like the Herb and the Succulent, and being the one that crowds in is the whole
       * point of the species. 5 buys the separation and keeps the trait.
       *
       * The warning in the other direction still stands. Taking this to 2, and then to 3, both backfired
       * precisely where the Fern is supposed to win: in a dim jar the crowd shades itself, and the Fern
       * fell behind the Herb it exists to beat. Its packing advantage only pays where there is spare
       * light to pack into.
       */
      reproduction: { seedMinSpacing: 5 },
    },
  },
  {
    id: SpeciesId.Herb,
    name: 'Herb',
    need: 'Middling in everything — the forgiving one to learn a jar with.',
    // Deliberately empty. The Herb IS the base config, which is what keeps every pre-existing balance
    // target valid and meaningful: they were all tuned against this plant.
    overlay: {},
  },
  {
    id: SpeciesId.Succulent,
    name: 'Succulent',
    need: 'Wants bright light and dry soil — and rots if you keep it wet.',
    overlay: {
      photosynthesis: {
        lightHalfSat: 160,
        maxPerLeafPerMin: 1.1,
        leafWaterNeed: 0.18,
        tempOptimalC: 28,
        tempToleranceC: 11,
      },
      uptake: { rootMlPerMin: 0.07 },
      health: {
        dehydrationStress: 0.25,
        rotStress: 0.9,
        // Double-lifespan leaves, and this reaches well past the plant. Measured over 40 sim-days in
        // identical jars, against the Herb: litter 273 vs 444, springtails 19 vs 32 — it genuinely
        // starves its own decomposers, because litter is their only food.
        //
        // What it does NOT do is impoverish the jar, which is what we assumed before measuring: soil
        // nutrients came out HIGHER, at 105 against 86. Holding its leaves instead of rebuilding them
        // means it draws far less from the soil in the first place, so the fertility it never
        // recycles is fertility it also never spent. A slow, self-contained plant, not a parasite.
        leafLifespanMinutes: 11520,
      },
      // Expensive tissue expressed in MINERALS, never in sugar.
      //
      // `sugarCostPerNode` is carbon-bound: the closed-system identity
      // `sugarCostPerNode x co2PpmPerUnit == leafLitterMass x decay.co2PpmPerUnit` holds the loop
      // shut, and both terms on the right are jar-wide. Raising a species' sugar cost alone means its
      // nodes lock away more carbon than their litter ever gives back — measured at 6.2% drift in a
      // mixed jar, which is a leak, not a trait. Nutrients carry no such identity.
      growth: {
        maxShootHeight: 5,
        // A fat rosette rather than a tall column, and this is what makes a short plant viable at
        // all: measured at lamp 0.9 in a 700 mL jar, leavesPerStem 3 takes it from 56 nodes to 111,
        // while raising maxShootHeight from 5 to 8 changed nothing. It was leaf-limited, never
        // height-limited — so the squat silhouette costs it nothing.
        leavesPerStem: 3,
        nutrientCostPerNode: 3.5,
        // Branches least of the three. A succulent's whole silhouette is a fat rosette on a short stem,
        // and its tissue is expensive in minerals — a bramble of them would strip the soil.
        branchChance: 0.015,
        maxBranchesPerPlant: 2,
      },
      // The most widely spaced of the three — a fat rosette hoards its patch — and left there, since
      // loosening spacing turned out to cost more than it bought. A succulent jar fills in through the
      // longer seed throw instead.
      reproduction: { seedMinSpacing: 6 },
    },
  },
];

export const speciesName = (id: SpeciesId): string => SPECIES[id]?.name ?? 'Plant';

// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Substrate material definitions.
 *
 * Deliberately a plain record of objects rather than parallel arrays: there are five materials,
 * they are hot-read but never written, and this is the single home for all material tuning.
 * Flattening this into typed arrays would buy nothing and cost all of its clarity.
 */

export const Substrate = {
  Air: 0,
  Gravel: 1,
  Charcoal: 2,
  Soil: 3,
  Glass: 4,
} as const;

export type SubstrateId = (typeof Substrate)[keyof typeof Substrate];

export interface SubstrateProps {
  readonly name: string;
  /**
   * Total millilitres the cell can physically contain. Saturation 1.0 means waterlogged — no air
   * left in the pores, which is the root-rot condition.
   */
  readonly maxMl: number;
  /**
   * Millilitres held against gravity by capillary action. Water ABOVE this is mobile and percolates
   * downward; water below it stays put.
   *
   * Keeping these two numbers separate is what makes the drainage layer work at all. Collapse them
   * into one and no water is ever mobile, so nothing ever reaches the gravel and every over-watering
   * simply waterlogs the root zone instead.
   */
  readonly fieldCapacityMl: number;
  /** Fraction of the mobile surplus passed downward per tick. */
  readonly permeability: number;
  /** Lateral diffusion coefficient. 0 means water never moves sideways through it. */
  readonly lateral: number;
  /** May a root anchor here. */
  readonly rootable: boolean;
  /** Toxin neutralised per sim-minute (the charcoal layer's job). */
  readonly filters: number;
  /** Solid materials block light and cannot be excavated into by roots. */
  readonly solid: boolean;
  /** Does this material fall under gravity. Glass is structural; air is not a thing that falls. */
  readonly granular: boolean;
  /**
   * Tendency to slide down-diagonally when something blocks the cell directly below, as a per-tick
   * chance. This is the angle of repose expressed as a rate: high values slump into shallow, wide
   * piles; low values stack into steep, narrow ones.
   */
  readonly slide: number;
  /**
   * How strongly moisture resists that slide, 0-1. Damp soil clumps and holds a bank that the same
   * soil would not hold dry; gravel does not care how wet it is. This is what ties the new granular
   * behaviour to the water simulation rather than bolting it on beside it.
   */
  readonly cohesion: number;
}

export const SUBSTRATES: Readonly<Record<SubstrateId, SubstrateProps>> = {
  [Substrate.Air]: {
    name: 'air',
    maxMl: 0,
    fieldCapacityMl: 0,
    permeability: 1,
    lateral: 0,
    rootable: false,
    filters: 0,
    solid: false,
    granular: false,
    slide: 0,
    cohesion: 0,
  },
  [Substrate.Gravel]: {
    name: 'drainage gravel',
    // Holds a fair amount transiently but retains almost none of it. That gap between maxMl and
    // fieldCapacityMl is the whole mechanism of a drainage layer: it accepts surplus from above and
    // keeps it away from the root zone instead of holding it there.
    maxMl: 4,
    fieldCapacityMl: 0.3,
    permeability: 0.9,
    lateral: 0.35,
    rootable: false,
    filters: 0,
    solid: true,
    // Rounded and non-cohesive: it runs almost like a liquid and settles into the shallowest pile of
    // the three, which is why a poured drainage layer self-levels across the jar floor.
    granular: true,
    slide: 0.85,
    cohesion: 0,
  },
  [Substrate.Charcoal]: {
    name: 'activated charcoal',
    maxMl: 7,
    fieldCapacityMl: 4,
    permeability: 0.45,
    lateral: 0.18,
    rootable: false,
    filters: 0.06,
    solid: true,
    // Angular chunks that interlock: steeper piles than gravel, and only mildly stickier when wet.
    granular: true,
    slide: 0.55,
    cohesion: 0.25,
  },
  [Substrate.Soil]: {
    name: 'potting soil',
    // The scale reference for the whole sim: one soil cell holds 6 mL against gravity and can be
    // pushed to 10 mL before its pores are full (= waterlogged = root rot). The 25 mL watering can is
    // therefore a visible splash across a few cells, not an invisible drop in an ocean.
    maxMl: 10,
    fieldCapacityMl: 6,
    permeability: 0.35,
    lateral: 0.18,
    rootable: true,
    filters: 0,
    solid: true,
    // Cohesive. Dry soil crumbles into a slope; damp soil holds a near-vertical bank, so watering a
    // terrace before you plant into it is a real technique rather than a flavour detail.
    granular: true,
    slide: 0.4,
    cohesion: 0.9,
  },
  [Substrate.Glass]: {
    name: 'glass',
    // An impermeable sentinel. The padded border and jar silhouette are made of this, which is
    // why no water loop in the sim needs a bounds check.
    maxMl: 0,
    fieldCapacityMl: 0,
    permeability: 0,
    lateral: 0,
    rootable: false,
    filters: 0,
    solid: true,
    // Structural. The jar does not fall into itself.
    granular: false,
    slide: 0,
    cohesion: 0,
  },
};

/** Materials the player may place. Glass and Air are structural, not tools. */
export const PAINTABLE: readonly SubstrateId[] = [Substrate.Gravel, Substrate.Charcoal, Substrate.Soil];

// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Moss — the jar's ground cover, and the only thing in it that brings NEW fertility in from outside.
 *
 * Stored as a per-cell coverage float (0..1), exactly like mold, rather than as a node tree: moss is
 * a mat that creeps across a surface, not a structure with a trunk and leaves, so a field over the
 * grid is the shape that actually fits.
 *
 * It exists because a sealed jar's nutrient economy runs downhill. Decay only ever returns a fraction
 * of what growth consumes, so a planted jar slowly starves itself no matter how well it is tended.
 * Moss is the answer to that: many real mosses host nitrogen-fixing cyanobacteria, so pulling
 * fertility out of the air rather than the soil is honest biology rather than a fudge, and it gives
 * the player something to cultivate rather than merely a decline to slow down.
 *
 * Four jobs, in order of how much they matter:
 *  1. it fixes nutrients from the air, which is the whole point;
 *  2. it dies back into litter, feeding the springtails that feed everything else;
 *  3. it crowds out mold, which wants the same damp, lit surface;
 *  4. it shades the soil, so a mossy jar holds its water longer.
 */

import type { CompiledConfig } from './config/balance.js';
import type { SubstrateGrid } from './grid.js';
import type { LightField } from './light.js';
import type { AtmoDelta, Atmosphere } from './atmosphere.js';
import type { Rng } from './rng.js';

export class MossField {
  /** Coverage per cell, 0..1. Only ever nonzero on a column's exposed surface cell. */
  readonly cover: Float32Array;

  constructor(size: number) {
    this.cover = new Float32Array(size);
  }

  total(): number {
    let sum = 0;
    for (let i = 0; i < this.cover.length; i++) sum += this.cover[i];
    return sum;
  }

  /** Mean coverage across the exposed surface — what the UI reports and the player sees. */
  surfaceFraction(grid: SubstrateGrid): number {
    let covered = 0;
    let surfaces = 0;
    for (let x = 1; x <= grid.w - 2; x++) {
      const s = grid.surfaceOfColumn[x];
      if (s < 0) continue;
      surfaces++;
      covered += this.cover[s];
    }
    return surfaces > 0 ? covered / surfaces : 0;
  }

  seed(i: number, amount: number): void {
    this.cover[i] = Math.min(1, this.cover[i] + amount);
  }

  /**
   * Carbon locked up in living moss, in the ppm units the audit works in.
   *
   * Moss is biomass, so it has to appear in the closed-system carbon audit or growing a mat would
   * look exactly like carbon vanishing from the jar.
   */
  carbonPpm(cfg: CompiledConfig): number {
    return this.total() * carbonPerCover(cfg);
  }

  /**
   * One tick of moss life.
   *
   * Growth and die-back are both charged against the atmosphere through the SAME constant, derived
   * from `mossLitterPerCover`, so the two directions cancel exactly: a unit of coverage takes a fixed
   * amount of CO2 to build and returns precisely that much when it rots. Deriving both ends from one
   * number is what keeps the audit honest — the same trick that already ties a leaf's build cost to
   * the litter it leaves behind.
   */
  step(
    cfg: CompiledConfig,
    grid: SubstrateGrid,
    light: LightField,
    air: Atmosphere,
    delta: AtmoDelta,
    rng: Rng,
  ): void {
    const c = cfg.raw.moss;
    const dt = cfg.dt;
    const perCover = carbonPerCover(cfg);
    const maxN = cfg.raw.decay.maxNutrients;

    // Moss is a cool-climate organism: it thrives damp and shaded-to-bright, and sulks in heat. This
    // gives the lamp a second, opposing consideration — crank it for plant growth and the moss suffers.
    const heat = Math.max(0, (air.tempC - c.comfortTempC) / c.heatToleranceC);
    const tempFactor = Math.max(0, 1 - heat * heat);

    for (let x = 1; x <= grid.w - 2; x++) {
      const i = grid.surfaceOfColumn[x];
      if (i < 0) continue;

      const cover = this.cover[i];
      const wet = grid.wetness(i);
      const lit = light.value[i];

      // Two DIFFERENT conditions, and conflating them kills every mat in the jar.
      //
      // `productive` gates growth and fixation — both are powered by photosynthesis, so both stop in
      // the dark. `stressed` gates extra die-back, and darkness is emphatically NOT stress: night is
      // half of every day, and charging a stress penalty for it wipes out any mat within one night
      // no matter how well the jar is run. Only drought and heat actually hurt moss.
      const productive = wet >= c.minWetness && lit >= c.minLight && tempFactor > 0;
      const stressed = wet < c.minWetness || tempFactor <= 0;

      if (cover > 0) {
        // --- Fixation. The headline: fertility arriving from outside the soil.
        if (productive) {
          grid.nutrients[i] = Math.min(maxN, grid.nutrients[i] + c.fixationPerMin * cover * dt);
        }

        // --- Die-back into litter. Continuous, so moss keeps the decomposers fed rather than being
        // an inert green carpet, and so a mat has an upkeep cost rather than being permanent.
        const dieRate = stressed ? c.diebackPerMin + c.stressedDiebackPerMin : c.diebackPerMin;
        const died = Math.min(cover, dieRate * cover * dt);
        if (died > 0) {
          this.cover[i] = cover - died;
          grid.organic[i] += died * c.litterPerCover;
          // Carbon released here is reclaimed when that litter decays, via the normal decay path.
        }
      }

      // --- Growth, logistic toward full cover.
      if (productive && this.cover[i] > 0) {
        const room = 1 - this.cover[i];
        const grew = c.growthPerMin * this.cover[i] * room * tempFactor * dt;
        if (grew > 0) {
          this.cover[i] = Math.min(1, this.cover[i] + grew);
          // Building tissue takes carbon out of the air, exactly as leaf photosynthesis does.
          delta.co2Ppm -= grew * perCover;
          delta.o2Pct += grew * perCover * c.o2PerCarbonPpm;
        }
      }

      // --- Spread to an adjacent column's surface once this patch is established enough to throw off
      // spores. Creeping sideways along the surface is the behaviour that makes it feel alive.
      if (this.cover[i] >= c.spreadThreshold && productive && rng.chance(c.spreadPerMin * dt)) {
        const dir = rng.next() < 0.5 ? -1 : 1;
        const n = grid.surfaceOfColumn[x + dir];
        if (n >= 0 && this.cover[n] < c.spreadThreshold) {
          this.cover[n] = Math.min(1, this.cover[n] + c.spreadSeedAmount);
          delta.co2Ppm -= c.spreadSeedAmount * perCover;
          delta.o2Pct += c.spreadSeedAmount * perCover * c.o2PerCarbonPpm;
        }
      }
    }
  }
}

/**
 * CO2 (in ppm) locked into one unit of moss coverage.
 *
 * Derived from the litter that coverage becomes, times the carbon that litter carries — so growth and
 * decay are guaranteed to be exact inverses of each other no matter how either is tuned.
 */
export function carbonPerCover(cfg: CompiledConfig): number {
  return cfg.raw.moss.litterPerCover * cfg.raw.decay.co2PpmPerUnit;
}

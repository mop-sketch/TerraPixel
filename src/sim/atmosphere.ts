// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Global jar atmosphere.
 *
 * The important modelling decision here: the authoritative stored value is `airWaterMl`, and
 * relative humidity is DERIVED from it against a temperature-dependent capacity.
 *
 *   humidity% = airWaterMl / capacityMl(tempC) * 100
 *
 * That one choice buys three things at once:
 *  - Water conservation is exact by construction. There is no humidity->millilitre fudge factor to
 *    drift, so the closed-system audit can assert to 1e-3.
 *  - Warming the jar raises capacity, so RH falls WITHOUT any water moving — which is physically
 *    right and reads correctly to the player ("the lamp cleared the fog").
 *  - Cooling drives RH up and triggers condensation on its own, so the condensation loop has a real
 *    negative branch instead of depending purely on evaporation.
 */

import { airCapacityMl, type CompiledConfig } from './config/balance.js';
import { clamp } from './detmath.js';

export interface Atmosphere {
  /** Integrated with thermal inertia — never assigned directly. */
  tempC: number;
  /** Authoritative water content of the jar air, in millilitres. */
  airWaterMl: number;
  /** THE binding growth constraint. Sealed terrariums run out of CO2, not O2. */
  co2Ppm: number;
  /** Simulated and displayed, but gates springtail survival only. Plants never die of gas. */
  o2Pct: number;
  /** Free cells above the substrate. Fewer air cells amplify every gas swing. */
  airCells: number;
  /** Hysteresis latch, NOT a bare threshold test. See `stepCondensation`. */
  condensing: boolean;
  /**
   * Whether the jar is FOGGED, which is a lower bar than condensing.
   *
   * Two different things used to share one flag. Mold asks "has the air been muggy", which starts
   * well before water actually runs off the glass; condensation asks "is the air full", which is the
   * point where it rains. Tying both to the same latch meant the jar could not be humid without also
   * raining, and could not rain without that being the same moment mold was told it was damp.
   */
  fogged: boolean;
  /** Condensate held on the glass, awaiting a droplet heavy enough to run down. */
  glassWaterMl: number;
  lidOpen: boolean;
  lampIntensity: number;
}

/** Accumulator so every cell and node reads one frozen snapshot and writes here instead. */
export interface AtmoDelta {
  waterMl: number;
  co2Ppm: number;
  o2Pct: number;
}

export const newDelta = (): AtmoDelta => ({ waterMl: 0, co2Ppm: 0, o2Pct: 0 });

export function resetDelta(d: AtmoDelta): void {
  d.waterMl = 0;
  d.co2Ppm = 0;
  d.o2Pct = 0;
}

export function createAtmosphere(cfg: CompiledConfig, airCells: number): Atmosphere {
  const c = cfg.raw;
  const tempC = c.thermal.ambientC;
  return {
    tempC,
    // Start at a comfortable 60% RH rather than bone dry, so the first minute of play has signal.
    airWaterMl: airCapacityMl(cfg, tempC) * 0.6,
    co2Ppm: c.atmosphere.co2.startPpm,
    o2Pct: c.atmosphere.o2.startPct,
    airCells,
    condensing: false,
    fogged: false,
    glassWaterMl: 0,
    lidOpen: false,
    lampIntensity: 0.6,
  };
}

export function humidity(cfg: CompiledConfig, a: Atmosphere): number {
  const cap = airCapacityMl(cfg, a.tempC);
  return cap > 0 ? (a.airWaterMl / cap) * 100 : 0;
}

/**
 * Thermal mass. The cheapest and highest-value dampener in the whole design: the lamp becomes a
 * slow lever with a legible delay instead of a switch that whiplashes four coupled variables in a
 * single tick. Must run BEFORE evaporation, which depends on temperature.
 */
export function stepTemperature(cfg: CompiledConfig, a: Atmosphere): void {
  const t = cfg.raw.thermal;
  const target = t.ambientC + t.lampDeltaC * a.lampIntensity + (a.lidOpen ? t.lidOpenDeltaC : 0);
  a.tempC += (target - a.tempC) * (cfg.dt / t.tauSimMinutes);
}

/**
 * Latched condensation feeding a glass reservoir.
 *
 * A bare `if (humidity >= 85)` with instantaneous transfer produces a two-tick limit cycle: RH
 * ping-pongs 84.9 / 85.1 and the fog and droplets strobe. The 6-point band kills the oscillation,
 * and the discrete droplet quantum turns the visual into beads forming and running down the glass
 * rather than a flickering flag.
 *
 * Droplets are queued to land on a LATER tick. Crediting soil here would create a same-tick loop
 * (soil wets -> RH drops -> soil dries) and would also make the falling-droplet animation a lie.
 */
export function stepCondensation(
  cfg: CompiledConfig,
  a: Atmosphere,
  onDroplet: (ml: number) => void,
): void {
  const c = cfg.raw.atmosphere.condensation;
  const cap = airCapacityMl(cfg, a.tempC);
  const rh = humidity(cfg, a);

  // Muggy: what mold reads. Starts long before anything runs down the glass.
  if (!a.fogged && rh >= c.fogOnHumidity) a.fogged = true;
  if (a.fogged && rh <= c.fogOffHumidity) a.fogged = false;

  // Saturated: the air genuinely cannot hold more, and it begins to rain.
  if (!a.condensing && rh >= c.onHumidity) a.condensing = true;
  if (a.condensing && rh <= c.offHumidity) a.condensing = false;

  // Supersaturation is impossible: force out any excess above 100% RH regardless of the latch.
  const excess = a.airWaterMl - cap;
  if (excess > 0) {
    a.airWaterMl -= excess;
    a.glassWaterMl += excess;
  }

  if (a.condensing) {
    // PROPORTIONAL to how far humidity sits above the release threshold, rather than clamping straight
    // down to it. Clamping to the floor pins the gauge at exactly `offHumidity` for as long as a plant
    // is transpiring — a dead readout. Proportional removal instead settles wherever condensation
    // balances transpiration, so the number moves with what the jar is actually doing, and the latch
    // still rules out the per-tick flicker a bare threshold would produce.
    const over = Math.max(0, rh - c.offHumidity) / Math.max(1, c.onHumidity - c.offHumidity);
    const moved = Math.min((cap * c.ratePctPerMin * cfg.dt * over) / 100, a.airWaterMl);
    a.airWaterMl -= moved;
    a.glassWaterMl += moved;
  }

  // Beads only detach once they are heavy enough.
  while (a.glassWaterMl >= c.dropletMassMl) {
    a.glassWaterMl -= c.dropletMassMl;
    onDroplet(c.dropletMassMl);
  }
}

/**
 * Venting toward room conditions. The lid is one of only two player inputs (the other is the lamp);
 * humidity, CO2 and O2 are outputs the player diagnoses, not dials they set.
 */
export function stepVenting(cfg: CompiledConfig, a: Atmosphere): number {
  if (!a.lidOpen) return 0;
  const lid = cfg.raw.atmosphere.lid;
  const f = Math.min(1, lid.exchangeFractionPerMin * cfg.dt);
  const cap = airCapacityMl(cfg, a.tempC);
  const targetWater = (cap * lid.roomHumidity) / 100;
  // Returns the water that crossed the jar's boundary so the closed-system audit can account for
  // it. An open lid is the one sanctioned hole in the system, and it has to be an explicit one.
  const exchanged = (targetWater - a.airWaterMl) * f;
  a.airWaterMl += exchanged;
  a.co2Ppm += (lid.roomCo2Ppm - a.co2Ppm) * f;
  a.o2Pct += (lid.roomO2Pct - a.o2Pct) * f;
  return exchanged;
}

/**
 * The single commit point for every gas and humidity change in the tick.
 *
 * Gas deltas are scaled by how crowded the jar is: a jar packed with foliage has fewer free air
 * cells, so the same respiration swings the concentration further. This is what makes "too much
 * leaf mass" a real pressure rather than a cosmetic one.
 */
export function commitDelta(_cfg: CompiledConfig, a: Atmosphere, d: AtmoDelta, baseAirCells: number): void {
  const volumeFactor = baseAirCells / Math.max(1, a.airCells);
  a.airWaterMl = Math.max(0, a.airWaterMl + d.waterMl);
  a.co2Ppm = Math.max(0, a.co2Ppm + d.co2Ppm * volumeFactor);
  a.o2Pct = clamp(a.o2Pct + d.o2Pct * volumeFactor, 0, 100);
  resetDelta(d);
}

/** Human-readable diagnosis strings. The UI leads with these; raw numbers sit behind an overlay. */
export function describe(cfg: CompiledConfig, a: Atmosphere): { air: string; warmth: string } {
  const rh = humidity(cfg, a);
  const air =
    rh >= 92 ? 'dripping' : rh >= 86 ? 'muggy' : rh >= 65 ? 'humid' : rh >= 40 ? 'fresh' : 'arid';
  const warmth =
    a.tempC >= 32 ? 'sweltering' : a.tempC >= 27 ? 'warm' : a.tempC >= 19 ? 'mild' : a.tempC >= 14 ? 'cool' : 'cold';
  return { air, warmth };
}

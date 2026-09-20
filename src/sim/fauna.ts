// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Springtail colonies — the jar's decomposers, and the reason a sealed terrarium has a carbon cycle
 * at all rather than slowly suffocating its own plants.
 *
 * Stored as a per-cell POPULATION FLOAT, not as individual agents. A colony eats, breeds, respires and
 * dies as a continuous quantity; the renderer draws a handful of wandering sprites on top of it. That
 * is a rendering flourish — simulating three hundred individuals would buy nothing the float does not
 * already give, and would cost determinism, save size and clarity.
 *
 * Their mechanical job is threefold:
 *  - they turn leaf litter into plant-available nutrients, closing the fertility loop;
 *  - they exhale CO2, which is the binding constraint on plant growth in a sealed jar;
 *  - they graze mold, which is what turns a mold bloom into a boom-and-bust rather than a death spiral.
 */

import type { CompiledConfig } from './config/balance.js';
import type { SubstrateGrid } from './grid.js';
import type { AtmoDelta, Atmosphere } from './atmosphere.js';
import type { Rng } from './rng.js';

/** Food below this is float dust, not a meal worth staying for. */
const FOOD_EPSILON = 1e-3;

export class FaunaField {
  /** Springtails per cell. Float, not a count of agents. */
  readonly pop: Float32Array;
  private readonly next: Float32Array;

  constructor(size: number) {
    this.pop = new Float32Array(size);
    this.next = new Float32Array(size);
  }

  total(): number {
    let sum = 0;
    for (let i = 0; i < this.pop.length; i++) sum += this.pop[i];
    return sum;
  }

  /** Seed a culture into a cell. The player's one lever on the decomposer population. */
  seed(i: number, amount: number, cap: number): void {
    this.pop[i] = Math.min(cap, this.pop[i] + amount);
  }

  /**
   * One tick of colony life. Reads a frozen atmosphere snapshot and accumulates its gas exchange into
   * the shared delta, exactly as the plant phase does, so neither gets a turn-order advantage on the
   * scarce CO2 and O2 they are competing over.
   *
   * Runs AFTER mold growth in the tick, so the player watches fuzz appear and a swarm converge on it
   * within the same tick rather than chasing a stale world.
   */
  step(
    cfg: CompiledConfig,
    grid: SubstrateGrid,
    air: Atmosphere,
    delta: AtmoDelta,
    rng: Rng,
  ): void {
    const c = cfg.raw.fauna.springtail;
    const dt = cfg.dt;
    const yieldFrac = cfg.raw.fauna.springtail.assimilationYield;
    const maxN = cfg.raw.decay.maxNutrients;

    for (const i of grid.activeCells) {
      let pop = this.pop[i];
      if (pop <= 0) continue;

      // --- Feeding. Litter first, then mold: they prefer detritus and graze fungus opportunistically.
      const wantLitter = c.litterEatenPerMinPerPop * pop * dt;
      const ateLitter = Math.min(grid.organic[i], wantLitter);
      grid.organic[i] -= ateLitter;

      const wantMold = c.moldEatenPerMinPerPop * pop * dt;
      const ateMold = Math.min(grid.mold[i], wantMold);
      grid.mold[i] -= ateMold;

      const ate = ateLitter + ateMold;
      // Frass: what they process comes back out as plant-available nutrient, minus what they keep.
      grid.nutrients[i] = Math.min(maxN, grid.nutrients[i] + ate * yieldFrac);
      /*
       * Frass carries acids too, at a fraction of what raw decay leaves behind.
       *
       * Springtails used to be a perfectly CLEAN disposal route: they removed litter without producing
       * any toxin at all, so a jar with a healthy colony made almost none and its charcoal never loaded.
       * Measured over 120 sim-days, a tended jar sat at 0.01 toxin forever while the same jar without
       * fauna passed the 0.30 root-damage line on day 55 — which meant the entire toxin system, and the
       * charcoal maintenance built on it, could only ever matter to a player who had already failed at
       * the ecology.
       *
       * Decomposition leaves residue whoever does it. A good colony is still much cleaner than rot —
       * that is what the fraction is for — but it is no longer free.
       */
      grid.toxin[i] = Math.min(
        1,
        grid.toxin[i] + ate * cfg.raw.decay.toxinPerUnit * cfg.raw.decay.faunaToxinFraction,
      );

      // --- Respiration. This is the CO2 source the whole jar depends on, and it is tied to what they
      // actually ATE rather than to how many of them there are.
      //
      // That distinction is the difference between a carbon cycle and a carbon fountain: a
      // population-based rate lets a large colony exhale carbon it never consumed, so the jar invents
      // CO2 from nothing and the reading climbs without bound. Charging it against the litter — the
      // same per-unit yield plain microbial decay uses — closes the loop, because that carbon was
      // fixed from the air by the leaf this litter used to be.
      const decay = cfg.raw.decay;
      delta.co2Ppm += ate * decay.co2PpmPerUnit;
      delta.o2Pct -= ate * decay.o2PctPerUnit;

      // --- Population change. Carrying capacity is set by the food actually present, so a colony
      // crashes back on its own once it has eaten the pile that fed it. Predator-free boom and bust.
      const capacity = Math.min(
        c.popCapPerCell,
        (grid.organic[i] + grid.mold[i]) * c.carryingCapacityPerLitter,
      );
      if (pop < capacity) {
        pop += c.breedPerMin * pop * (1 - pop / Math.max(0.001, capacity)) * dt;
      } else {
        pop -= c.starveDeathPerMin * (pop - capacity) * dt;
      }

      // --- Mortality. Springtails are famously vulnerable to drying out, which ties the colony to the
      // same moisture the player is already managing for the plant; low oxygen is the one thing that
      // gas levels actually threaten, since plants never die of them.
      const desiccated = grid.wetness(i) < c.desiccationWetness;
      const anoxic = air.o2Pct < c.o2DeathBelowPct;
      if (desiccated) pop -= c.desiccationDeathPerMin * pop * dt;
      if (anoxic) pop -= c.o2DeathPerMin * pop * dt;

      if (desiccated || anoxic) {
        // These two kill outright, all the way to nothing.
        if (pop < 0.01) pop = 0;
      } else if (pop < c.dormantFloor) {
        // Starvation alone never wipes a colony out: it falls back to a dormant remnant of eggs in the
        // litter and waits. Breeding is proportional to population, so letting hunger reach zero would
        // make zero an absorbing state — one lean week and the jar's carbon loop is gone for good.
        //
        // The floor is applied only when neither killer is active. Applying it unconditionally would
        // reset the population every tick and make drought and suffocation survivable indefinitely,
        // quietly disarming both failure states.
        pop = c.dormantFloor;
      }

      this.pop[i] = Math.max(0, pop);
    }

    this.spread(cfg, grid, rng);
  }

  /**
   * Foraging. Colonies move toward food, and WANDER when there is none nearby.
   *
   * Three things here are load-bearing, and the previous version got all three wrong in a way that
   * silently bricked the whole decomposer loop:
   *
   * 1. A dormant colony must still be able to move. Gating movement on `pop >= 1` while the dormant
   *    floor sits at 0.25 means a starved colony is frozen in place FOREVER — which is exactly how a
   *    jar ends up reporting "litter piling up" and "springtails dormant" at the same time for weeks,
   *    with the food three cells away and the colony unable to reach it.
   *
   * 2. Moving only toward strictly-more-food means no exploration at all on flat ground. A colony
   *    surrounded by empty cells sees no gradient and never leaves, even though litter is reliably
   *    accumulating on the column surface just above it. Hence the wander fallback, biased upward:
   *    springtails live in the litter horizon, and in this sim litter always lands on the surface
   *    cell, so "drift toward the top of the substrate" is both honest and the thing that actually
   *    reunites a stranded colony with its food.
   *
   * 3. Dormant colonies must migrate WHOLE, not split. The dormant floor is applied per-cell in
   *    `step()`, so splitting a 0.25 colony re-floors the source to 0.25 AND floors the destination
   *    to 0.25 — population doubles on every hop and dormant springtails colonise the jar for free,
   *    making the Springtails tool pointless. Moving the entire population leaves the source at
   *    exactly 0, which `step()` skips, so nothing is invented.
   *
   * Double-buffered so the pass direction cannot bias which way a colony migrates across the jar.
   */
  private spread(cfg: CompiledConfig, grid: SubstrateGrid, rng: Rng): void {
    const c = cfg.raw.fauna.springtail;
    const chance = c.spreadPerMin * cfg.dt;
    this.next.set(this.pop);

    for (const i of grid.activeCells) {
      const pop = this.pop[i];
      if (pop <= 0 || !rng.chance(chance)) continue;

      const here = grid.organic[i] + grid.mold[i];
      const up = i - grid.w;
      const down = i + grid.w;
      const dir = [i - 1, i + 1, up, down];
      const stride = [-1, 1, -grid.w, grid.w];

      // Sniff along each axis out to the sense radius, taking the first step toward whichever
      // direction smells strongest. Dividing by distance means a nearer pile wins over a richer one
      // further off, so colonies converge on what they can actually reach.
      let best = -1;
      let bestScore = here;
      for (let d = 0; d < 4; d++) {
        const step = stride[d];
        const first = dir[d];
        if (grid.props(first).maxMl <= 0) continue;
        for (let r = 1; r <= c.senseRadius; r++) {
          const n = i + step * r;
          if (n < 0 || n >= this.pop.length) break;
          // Stop at the first thing we cannot walk through — no smelling through glass or thin air.
          if (grid.props(n).maxMl <= 0) break;
          const score = (grid.organic[n] + grid.mold[n]) / r;
          if (score > bestScore) {
            bestScore = score;
            best = first;
          }
        }
      }

      // Already sitting on food: stay and eat it. Wandering off a full larder because no NEIGHBOUR
      // happens to beat it is how a colony ends up permanently orbiting its own food supply without
      // ever settling on it.
      if (best < 0 && here > FOOD_EPSILON) continue;

      // Expanding toward a richer neighbour is a SPLIT; searching with nothing to eat is a whole-colony
      // MOVE. The distinction is what keeps the dormant floor honest: the floor is applied per cell, so
      // any colony that splits while starving gets both halves floored back up to 0.25 and the jar
      // quietly breeds springtails out of nothing. Only a colony that actually has food may divide.
      const expanding = best >= 0;

      // No gradient to follow and nothing here: wander, leaning toward the surface where litter lands.
      //
      // The weights matter more than they look. Litter only ever lands on a column's surface cell, so
      // a colony that drifts downward is drifting away from every future meal. Weighting up hardest
      // and down least gives a net climb — and crucially, ON the surface row "up" is open air and
      // therefore invalid, so without down being the lightest option a surface colony would sink into
      // the soil over time rather than patrolling the litter horizon where it belongs.
      if (best < 0) {
        const options: number[] = [];
        const push = (n: number, weight: number) => {
          if (grid.props(n).maxMl <= 0) return;
          for (let k = 0; k < weight; k++) options.push(n);
        };
        push(up, 4);
        push(i - 1, 3);
        push(i + 1, 3);
        push(down, 1);
        if (options.length === 0) continue;
        best = options[rng.int(options.length)];
      }

      const moving = expanding ? pop * 0.25 : pop;
      this.next[i] -= moving;
      this.next[best] = Math.min(c.popCapPerCell, this.next[best] + moving);
    }
    this.pop.set(this.next);
  }
}

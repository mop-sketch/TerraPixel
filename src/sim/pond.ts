// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Life in the pond: algae, what feeds it, and what it leaves behind.
 *
 * Kept PER COLUMN rather than per cell, and that is a deliberate simplification. Free water moves
 * every tick — it settles, levels, evaporates, overflows — so anything suspended in it would have to
 * be carried along by every one of those movements, per cell, or it would be left behind in the wrong
 * place. What is in a column's water is instead treated as dissolved through it, and neighbouring wet
 * columns mix. A pond is small and still enough that this reads correctly: blooms start where the
 * food lands, spread outward, and green the whole pond.
 *
 * Eight quantities, each per column:
 *   - `algae`: biomass, in the same units as leaf litter, so a unit of algae carries exactly the carbon
 *     a unit of litter does and the closed-system books need no new exchange rate.
 *   - `nutrients`: dissolved food. Arrives as litter rotting in the water and as floodwater running off
 *     the soil; leaves as algae growth.
 *   - `sour`: the acids a rotting bloom leaves in the water, in the soil's own toxin units. This is the
 *     harm: a pond full to its rim sours the soil of its banks.
 *   - `lilies`: water lilies, as cover of pads on the surface, 0 to 1. The pads lie ON the water, so
 *     they take the light, and the roots take the food, before the algae beneath them do, which is
 *     what makes them the first answer to green water.
 *   - `hornwort`: submerged fronds growing up from the floor, 0 to 1. It strips food out of the water
 *     more efficiently than algae, and holds them back besides; a bed of lily pads shades it as it shades
 *     the algae, so the two cures compete for the light.
 *   - `reeds`: a marginal plant standing up out of the water, 0 to 1. Only at a pond's EDGES: its two
 *     outermost columns, and the bank one column out on each side, drawing on the pond's water for
 *     food. It pumps that water up into the air.
 *   - `fish`: small pond fish. They eat algae and pick litter off the floor, and their waste feeds the
 *     water. A pond kept spotless starves them slowly; stale water or a dry pond kills them.
 *   - `snails`: the grazer, as a population. Like the springtails, they carry no carbon of their own:
 *     what they eat is breathed straight back out as CO2, which keeps the books closed without
 *     weighing a snail.
 *
 * The gas terms are honest but small. Algae fix CO2 as they grow and give it back as they respire and
 * rot, with oxygen moving the other way at the same per-unit rates litter uses — which in this jar
 * barely shifts oxygen at all. The harm is the sour water, not suffocation.
 */

import type { CompiledConfig } from './config/balance.js';
import type { SubstrateGrid } from './grid.js';
import type { AtmoDelta } from './atmosphere.js';

export class PondLife {
  readonly algae: Float64Array;
  readonly nutrients: Float64Array;
  readonly sour: Float64Array;
  readonly lilies: Float64Array;
  readonly snails: Float64Array;
  readonly hornwort: Float64Array;
  readonly fish: Float64Array;
  readonly reeds: Float64Array;
  /** Water standing in each column this tick, in mL. Refreshed by `step`, read by the renderer. */
  readonly water: Float64Array;
  /**
   * 1 where a column is POND: enough water, resting on a liner. Refreshed each step.
   *
   * Water flooding over ordinary soil is not pond. A pour of more than a second or so over a small pond
   * floods the jar, and when every wet column counted, the pond's plants, food and animals spread thin
   * across the whole flooded surface: its food fell to a fiftieth, and lilies and hornwort starved to
   * nothing within five days in every game where the watering can was held down a little too long.
   * (Before that, spreading needed only a trace of water in both columns, and fish swam out onto the
   * thin overflow film around a brimming pond and died when it dried: three were down to 0.7 in a day.)
   */
  private readonly lined: Uint8Array;
  /**
   * For each column, the pond column whose water its reeds live on, or -1 where reeds cannot grow.
   * A pond's two edge columns feed themselves; the bank column just outside each edge is fed by that
   * edge. Everywhere else is -1: reeds are a plant of the margins, never the middle of a pond or the
   * dry ground beyond its bank. Refreshed each step.
   */
  private readonly reedSpot: Int16Array;
  /** The topmost wet cell of each column this step, for light. */
  private readonly topCell: Int32Array;

  constructor(width: number) {
    this.algae = new Float64Array(width);
    this.nutrients = new Float64Array(width);
    this.sour = new Float64Array(width);
    this.lilies = new Float64Array(width);
    this.snails = new Float64Array(width);
    this.hornwort = new Float64Array(width);
    this.fish = new Float64Array(width);
    this.reeds = new Float64Array(width);
    this.water = new Float64Array(width);
    this.lined = new Uint8Array(width);
    this.reedSpot = new Int16Array(width).fill(-1);
    this.topCell = new Int32Array(width).fill(-1);
  }

  /** Can reeds grow in column `x`: a pond's edge, or the bank one column out? As of the last step. */
  canHoldReeds(x: number): boolean {
    return this.reedSpot[x] >= 0;
  }

  /** Is column `x` pond: enough water, resting on a liner? As of the last step. */
  isPond(x: number): boolean {
    return this.lined[x] === 1;
  }

  /**
   * How green a column's water is, 0 to 1, as a fraction of the densest bloom water can carry.
   *
   * Density rather than mass, because that is what the eye reads: the same few units of algae turn a
   * puddle opaque and barely tint a deep pond.
   */
  greenness(cfg: CompiledConfig, x: number): number {
    const cells = this.water[x] / cfg.raw.standing.cellMl;
    if (cells <= 1e-6) return 0;
    return Math.min(1, this.algae[x] / cells / cfg.raw.algae.densityCap);
  }

  /** The pond's living carbon, algae and lilies both, for the closed-system audit. */
  carbonPpm(cfg: CompiledConfig): number {
    const perCover = cfg.raw.lilies.massPerColumn;
    let m = 0;
    const perFrond = cfg.raw.hornwort.massPerColumn;
    const perReed = cfg.raw.reeds.massPerColumn;
    for (let x = 0; x < this.algae.length; x++) {
      m += this.algae[x] + this.lilies[x] * perCover + this.hornwort[x] * perFrond + this.reeds[x] * perReed;
    }
    return m * cfg.raw.decay.co2PpmPerUnit;
  }

  /**
   * How much of a column's open-water evaporation is cut by what lies on and in it: lily pads on the
   * surface, and a thick algal mat. Both, multiplied, so neither can take it past what the other left.
   */
  evaporationFactor(cfg: CompiledConfig, x: number): number {
    return (
      (1 - cfg.raw.lilies.evaporationShield * this.lilies[x]) *
      (1 - cfg.raw.algae.matShield * this.greenness(cfg, x)) *
      // Reeds work the other way: a bed draws the pond up through its stems into the air, and the pond
      // column that feeds the bank beside it carries that bank's reeds too.
      (1 + cfg.raw.reeds.transpiration * this.reedsFedBy(x))
    );
  }

  /** Reed cover living on pond column `x`'s water: its own, and the bank's beside it. */
  private reedsFedBy(x: number): number {
    let sum = 0;
    for (let j = x - 1; j <= x + 1; j++) if (j >= 0 && j < this.reeds.length && this.reedSpot[j] === x) sum += this.reeds[j];
    return sum;
  }

  /**
   * Plant reeds. At a pond's edge or on the bank one column out, there; anywhere in the middle of a
   * pond, at BOTH its edges, since the middle is somewhere reeds cannot grow and a click there means
   * "this pond". Returns the biomass added, charged to the air by the caller; zero off the pond.
   */
  plantReeds(cfg: CompiledConfig, x: number): number {
    if (this.canHoldReeds(x)) return this.plantReedsAt(cfg, x);
    if (!this.lined[x]) return 0;
    let from = x;
    let to = x;
    while (from - 1 >= 0 && this.lined[from - 1]) from--;
    while (to + 1 < this.lined.length && this.lined[to + 1]) to++;
    return this.plantReedsAt(cfg, from) + this.plantReedsAt(cfg, to);
  }

  private plantReedsAt(cfg: CompiledConfig, x: number): number {
    const before = this.reeds[x];
    this.reeds[x] = Math.min(1, before + cfg.raw.reeds.plantCover);
    return (this.reeds[x] - before) * cfg.raw.reeds.massPerColumn;
  }

  /**
   * Set hornwort into a column's water. Returns the biomass added, which the caller charges to the air.
   * Zero on a dry column: it is a water plant through and through.
   */
  plantHornwort(cfg: CompiledConfig, x: number): number {
    if (!this.isPond(x)) return 0;
    const before = this.hornwort[x];
    this.hornwort[x] = Math.min(1, before + cfg.raw.hornwort.plantCover);
    return (this.hornwort[x] - before) * cfg.raw.hornwort.massPerColumn;
  }

  /** Put a snail culture into a column's water. False on a dry column: they need a pond. */
  addSnails(cfg: CompiledConfig, x: number): boolean {
    if (!this.isPond(x)) return false;
    this.snails[x] = Math.min(cfg.raw.snails.popCapPerColumn, this.snails[x] + cfg.raw.snails.cultureSize);
    return true;
  }

  /** Put fish into a column's water. False on a dry column. */
  addFish(cfg: CompiledConfig, x: number): boolean {
    if (!this.isPond(x)) return false;
    this.fish[x] += cfg.raw.fish.cultureSize;
    return true;
  }

  /** Every fish in the jar. */
  fishCount(): number {
    let n = 0;
    for (let x = 0; x < this.fish.length; x++) n += this.fish[x];
    return n;
  }

  /** Every snail in the jar. */
  snailCount(): number {
    let n = 0;
    for (let x = 0; x < this.snails.length; x++) n += this.snails[x];
    return n;
  }

  /**
   * Float lilies onto a column's water. Returns the biomass added, which the caller charges to the
   * air: planting must not conjure carbon, any more than planting moss does. Zero on a dry column.
   */
  plantLilies(cfg: CompiledConfig, x: number): number {
    if (!this.isPond(x)) return 0;
    const before = this.lilies[x];
    this.lilies[x] = Math.min(1, before + cfg.raw.lilies.plantCover);
    return (this.lilies[x] - before) * cfg.raw.lilies.massPerColumn;
  }

  /**
   * Kill every plant in the pond that column `x` is part of: lilies, hornwort and algae across the
   * whole pond, edge to edge, and its reeds, the bank's included. Clicking a bank reed spot clears the
   * pond those reeds live on. Fish and snails are left alone.
   *
   * Nothing leaves the jar. The dead plants fall where they grew as litter, to rot like any other: the
   * pond's plants on its floor, bank reeds on the bank. That rot comes back as food in the water, so a
   * cleared pond is open to algae again, which is the price of clearing it. Algae killed all at once
   * also sour the water, exactly as a bloom dying back on its own does.
   *
   * Returns the pond's extent, or null when `x` is neither pond nor one of its reed spots.
   */
  clearPlants(cfg: CompiledConfig, g: SubstrateGrid, x: number): { from: number; to: number } | null {
    let at = x;
    if (!this.lined[at]) {
      at = this.reedSpot[x];
      if (at < 0 || !this.lined[at]) return null;
    }
    let from = at;
    let to = at;
    while (from - 1 >= 1 && this.lined[from - 1]) from--;
    while (to + 1 <= g.w - 2 && this.lined[to + 1]) to++;

    for (let j = Math.max(1, from - 1); j <= Math.min(g.w - 2, to + 1); j++) {
      const ground = g.surfaceOfColumn[j];
      if (ground < 0) continue;
      const inPond = j >= from && j <= to;
      const itsReeds = inPond || (this.reedSpot[j] >= from && this.reedSpot[j] <= to);
      let dead = 0;
      if (inPond) {
        dead += this.lilies[j] * cfg.raw.lilies.massPerColumn + this.hornwort[j] * cfg.raw.hornwort.massPerColumn;
        dead += this.algae[j];
        this.sour[j] += this.algae[j] * cfg.raw.algae.sourPerDeadUnit;
        this.lilies[j] = 0;
        this.hornwort[j] = 0;
        this.algae[j] = 0;
      }
      if (itsReeds) {
        dead += this.reeds[j] * cfg.raw.reeds.massPerColumn;
        this.reeds[j] = 0;
      }
      g.organic[ground] += dead;
    }
    return { from, to };
  }

  /**
   * One tick of pond life. Order matters and follows the food: what rots feeds the water, the water
   * feeds the algae, the algae die back, and the pond mixes what is left.
   *
   * @param lightAt light reaching a cell, in the lamp's PPFD units — the same field the plants read,
   *                so a pond under a canopy is shaded by it for free.
   */
  step(
    cfg: CompiledConfig,
    g: SubstrateGrid,
    co2Ppm: number,
    tempC: number,
    lightAt: (cell: number) => number,
    delta: AtmoDelta,
  ): void {
    const a = cfg.raw.algae;
    const d = cfg.raw.decay;
    const dt = cfg.dt;
    const cap = cfg.raw.standing.cellMl;

    // Decay is a warm process, here exactly as in the soil.
    const off = (tempC - d.optimalTempC) / d.tempToleranceC;
    const warmth = Math.max(0, 1 - off * off);

    for (let x = 1; x <= g.w - 2; x++) {
      /*
       * Measure this column's water and find its surface. What counts as the POND's water is only what
       * stands in the hollow the player dug: an overfilled pond floods the jar, and counting the flood
       * standing above it diluted the pond's food until its plants starved.
       */
      let ml = 0;
      let top = -1;
      for (let i = g.idx(x, 1); i < g.size - g.w; i += g.w) {
        const s = g.standing[i];
        if (s <= 0) continue;
        if (top < 0) top = i;
        if (g.dug[i]) ml += s;
      }
      this.water[x] = ml;
      this.topCell[x] = top;
      const floor = g.surfaceOfColumn[x];
      const onLiner = floor >= 0 && g.props(floor).solid && g.props(floor).maxMl <= 0;
      this.lined[x] = ml >= a.minWaterMl && onLiner ? 1 : 0;
      // Stale water clears slowly on its own once nothing keeps souring it, wet or dry.
      this.sour[x] = Math.max(0, this.sour[x] - this.sour[x] * a.sourDecayPerMin * dt);

      if (!this.lined[x]) {
        /*
         * Dry, or near enough. Algae stranded out of water die where they lie and become litter on the
         * pond floor, keeping their carbon; the dissolved food and the sourness stay behind in the mud,
         * to come back into the water when it does.
         */
        if (this.algae[x] > 0 && floor >= 0) {
          g.organic[floor] += this.algae[x];
          this.algae[x] = 0;
        }
        // Snails cannot live out of water at all. A pond left to dry out loses them, every one.
        this.snails[x] = 0;
        // Fish too, every one.
        this.fish[x] = 0;
        // Hornwort out of water dies where it lies.
        if (this.hornwort[x] > 0 && floor >= 0) {
          g.organic[floor] += this.hornwort[x] * cfg.raw.hornwort.massPerColumn;
          this.hornwort[x] = 0;
        }
        // Lily pads stranded on a dry floor dies the same way.
        if (this.lilies[x] > 0 && floor >= 0) {
          g.organic[floor] += this.lilies[x] * cfg.raw.lilies.massPerColumn;
          this.lilies[x] = 0;
        }
        continue;
      }
      const cells = ml / cap;

      // --- 1: litter rotting in the water. The stuck-litter gap: decay otherwise only runs in soil,
      // so a leaf that fell on a pond never broke down at all. Soil cells are left to soil decay.
      if (floor >= 0 && g.props(floor).maxMl <= 0 && g.organic[floor] > 0) {
        const broken = Math.min(g.organic[floor], a.pondDecayPerMin * g.organic[floor] * warmth * dt);
        g.organic[floor] -= broken;
        this.nutrients[x] += broken * d.nutrientYield;
        this.sour[x] += broken * d.toxinPerUnit;
        delta.co2Ppm += broken * d.co2PpmPerUnit;
        delta.o2Pct -= broken * d.o2PctPerUnit;
      }

      const surfaceLight = top >= 0 ? lightAt(top) : 0;

      // --- 2a: lilies, first. Their pads lie on top, so they have the light, and their roots take the
      // dissolved food before anything in the water beneath can.
      if (this.lilies[x] > 0) this.growLilies(cfg, g, x, floor, cells, surfaceLight, co2Ppm, delta);

      // What gets past a bed of lily pads is all the light anything under the surface has to work with.
      const underMat = surfaceLight * (1 - cfg.raw.lilies.algaeShade * this.lilies[x]);

      // --- 2b: hornwort, rooted below the mat but ahead of the algae for food.
      if (this.hornwort[x] > 0) this.growHornwort(cfg, g, x, floor, cells, underMat, co2Ppm, delta);

      // --- 2c: algae. Liebig's law, as the plants use: the scarcest of light, food and CO2 caps it.
      const light = underMat;
      const lightF = light / (light + a.lightHalfSat);
      const food = this.nutrients[x] / cells;
      const foodF = food / (food + a.nutrientHalfSat);
      const co2F = co2Ppm / (co2Ppm + a.co2HalfSatPpm);
      const limit = Math.min(lightF, foodF, co2F);
      // Spores are everywhere: a clean pond starts from a trace, never from nothing, so a pond that
      // CAN bloom always eventually does. The trace grows from real CO2 like any other growth.
      const seed = Math.max(this.algae[x], a.sporeDensity * cells);
      const room = Math.max(0, 1 - this.algae[x] / (a.densityCap * cells));
      // Hornwort gives off compounds that hold phytoplankton back, on top of taking their food.
      const held = 1 - cfg.raw.hornwort.algaeSuppression * this.hornwort[x];
      let grown = a.growthPerMin * seed * limit * room * held * dt;
      grown = Math.min(grown, this.nutrients[x] / a.nutrientPerUnit);
      if (grown > 0) {
        this.algae[x] += grown;
        this.nutrients[x] -= grown * a.nutrientPerUnit;
        delta.co2Ppm -= grown * d.co2PpmPerUnit;
        delta.o2Pct += grown * d.o2PctPerUnit;
      }

      // --- 3: respiration and die-off. Starved or dark algae die faster: that is the crash after a
      // bloom has eaten its food, and the slow fade of a pond moved into shade.
      if (this.algae[x] > 0) {
        const breathed = Math.min(this.algae[x], a.respirationPerMin * this.algae[x] * dt);
        this.algae[x] -= breathed;
        delta.co2Ppm += breathed * d.co2PpmPerUnit;
        delta.o2Pct -= breathed * d.o2PctPerUnit;

        // Hunger is food and CO2, not light. Algae in the dark stop growing and keep breathing; they do
        // not starve. Counting night as starvation made every pond die back faster than it could grow.
        const hunger = 1 - Math.min(foodF, co2F);
        const died = Math.min(this.algae[x], (a.deathPerMin + a.starveDeathPerMin * hunger) * this.algae[x] * dt);
        this.algae[x] -= died;
        // Dead algae sink and rot on the floor like any other litter, keeping their carbon and food.
        if (floor >= 0) g.organic[floor] += died;
        else this.algae[x] += died;
        /*
         * And a dying bloom sours the water as it goes, far harder than a leaf does. A mass of algae
         * rotting at once is what makes water stale; leaf litter alone never took a pond past a tenth
         * of the way to the line where roots take damage, even at the peak of a crash.
         */
        this.sour[x] += died * a.sourPerDeadUnit;
      }

    }

    this.stepReeds(cfg, g, co2Ppm, lightAt, delta);
    this.graze(cfg, g, delta);
    this.feedFish(cfg, g, delta);
    this.mix(g, a.mixPerMin * dt);
    this.spreadLilies(g, cfg.raw.lilies.spreadPerMin * dt);
    this.spread(g, this.snails, cfg.raw.snails.spreadPerMin * dt);
    this.spread(g, this.hornwort, cfg.raw.hornwort.spreadPerMin * dt);
    this.spread(g, this.fish, cfg.raw.fish.spreadPerMin * dt);
    this.spreadReeds(g, cfg.raw.reeds.spreadPerMin * dt);
    this.soakBanks(cfg, g);
  }

  /**
   * One tick of a column's lilies: growth on light, food and CO2, crowding as the bed closes, and
   * die-off that sinks to the floor as litter. Cover and biomass are the same thing at a fixed ratio,
   * so the carbon it fixes and gives back is exact.
   */
  private growLilies(
    cfg: CompiledConfig,
    g: SubstrateGrid,
    x: number,
    floor: number,
    cells: number,
    light: number,
    co2Ppm: number,
    delta: AtmoDelta,
  ): void {
    const k = cfg.raw.lilies;
    const d = cfg.raw.decay;
    const dt = cfg.dt;
    const cover = this.lilies[x];
    const lightF = light / (light + k.lightHalfSat);
    const food = this.nutrients[x] / cells;
    const foodF = food / (food + k.nutrientHalfSat);
    const co2F = co2Ppm / (co2Ppm + cfg.raw.algae.co2HalfSatPpm);

    let grownCover = k.growthPerMin * cover * (1 - cover) * Math.min(lightF, foodF, co2F) * dt;
    grownCover = Math.min(grownCover, this.nutrients[x] / (k.nutrientPerUnit * k.massPerColumn));
    if (grownCover > 0) {
      const mass = grownCover * k.massPerColumn;
      this.lilies[x] = cover + grownCover;
      this.nutrients[x] -= mass * k.nutrientPerUnit;
      delta.co2Ppm -= mass * d.co2PpmPerUnit;
      delta.o2Pct += mass * d.o2PctPerUnit;
    }

    /*
     * Hunger is FOOD alone. CO2 already slows its growth; counting it as starvation too meant a mat was
     * always treated as a quarter-starved, since jar CO2 never gets near its half-saturation, and died
     * back every night faster than the day could replace it. It levelled off at two-thirds cover and
     * let the easier algae grow in the gaps. Nor is the dark starvation: a mat at night simply rests.
     */
    const hunger = 1 - foodF;
    const died = Math.min(this.lilies[x], (k.deathPerMin + k.starveDeathPerMin * hunger) * this.lilies[x] * dt);
    if (died > 0 && floor >= 0) {
      this.lilies[x] -= died;
      g.organic[floor] += died * k.massPerColumn;
    }
  }

  /**
   * The snails, per column: eat, breed toward what the food will carry, and die of hunger or stale
   * water. The springtails' own pattern, moved into the pond, so a colony booms on a green pond and
   * thins once it has grazed it clean, keeping a dormant floor to come back from.
   */
  private graze(cfg: CompiledConfig, g: SubstrateGrid, delta: AtmoDelta): void {
    const k = cfg.raw.snails;
    const d = cfg.raw.decay;
    const dt = cfg.dt;
    const cap = cfg.raw.standing.cellMl;
    for (let x = 1; x <= g.w - 2; x++) {
      let pop = this.snails[x];
      if (pop <= 0 || !this.isPond(x)) continue;
      const floor = g.surfaceOfColumn[x];
      const onFloor = floor >= 0 && g.props(floor).maxMl <= 0 ? g.organic[floor] : 0;

      // Algae first; what is left of their appetite goes on the litter lying on the floor.
      const ateAlgae = Math.min(this.algae[x], k.algaeEatenPerMinPerPop * pop * dt);
      this.algae[x] -= ateAlgae;
      const ateLitter = Math.min(onFloor, k.litterEatenPerMinPerPop * pop * dt);
      if (ateLitter > 0) g.organic[floor] -= ateLitter;
      const ate = ateAlgae + ateLitter;
      // What they eat is breathed back out, and part of it comes back into the water as droppings.
      this.nutrients[x] += ate * k.assimilationYield;
      delta.co2Ppm += ate * d.co2PpmPerUnit;
      delta.o2Pct -= ate * d.o2PctPerUnit;

      // Food sets how many the column can carry: a green pond feeds a boom, a clean one a few.
      const capacity = Math.min(
        k.popCapPerColumn,
        Math.max(k.biofilmPerColumn, (this.algae[x] + onFloor) * k.carryingPerFood),
      );
      if (pop < capacity) pop += k.breedPerMin * pop * (1 - pop / Math.max(0.001, capacity)) * dt;
      else pop -= k.starveDeathPerMin * (pop - capacity) * dt;

      // Stale water kills them, past the floor: a bloom left to rot can wipe out its own cure. Graded
      // by how far past the line it is, so water just over it thins a colony rather than erasing it.
      const strength = this.sour[x] / (this.water[x] / cap);
      const poisoned = strength > k.sourDeathAbove;
      if (poisoned) {
        const severity = Math.min(1, (strength - k.sourDeathAbove) / 0.3);
        pop -= k.sourDeathPerMin * severity * pop * dt;
        if (pop < 0.01) pop = 0;
      } else if (pop < k.dormantFloor) {
        pop = Math.min(k.dormantFloor, this.snails[x]);
      }
      this.snails[x] = Math.max(0, pop);
    }
  }

  /**
   * One tick of a column's hornwort: growth on the light that reaches under any mat, food and CO2, with
   * crowding as the water fills with fronds; die-off sinks to the floor as litter. Cover and biomass at
   * a fixed ratio, as the lilies' are, so its carbon is exact.
   */
  private growHornwort(
    cfg: CompiledConfig,
    g: SubstrateGrid,
    x: number,
    floor: number,
    cells: number,
    light: number,
    co2Ppm: number,
    delta: AtmoDelta,
  ): void {
    const k = cfg.raw.hornwort;
    const d = cfg.raw.decay;
    const dt = cfg.dt;
    const cover = this.hornwort[x];
    const lightF = light / (light + k.lightHalfSat);
    const food = this.nutrients[x] / cells;
    const foodF = food / (food + k.nutrientHalfSat);
    const co2F = co2Ppm / (co2Ppm + cfg.raw.algae.co2HalfSatPpm);

    let grownCover = k.growthPerMin * cover * (1 - cover) * Math.min(lightF, foodF, co2F) * dt;
    grownCover = Math.min(grownCover, this.nutrients[x] / (k.nutrientPerUnit * k.massPerColumn));
    if (grownCover > 0) {
      const mass = grownCover * k.massPerColumn;
      this.hornwort[x] = cover + grownCover;
      this.nutrients[x] -= mass * k.nutrientPerUnit;
      delta.co2Ppm -= mass * d.co2PpmPerUnit;
      delta.o2Pct += mass * d.o2PctPerUnit;
    }

    // Hunger is food alone, as the lilies' is; the dark only stops it growing.
    const died = Math.min(this.hornwort[x], (k.deathPerMin + k.starveDeathPerMin * (1 - foodF)) * this.hornwort[x] * dt);
    if (died > 0 && floor >= 0) {
      this.hornwort[x] -= died;
      g.organic[floor] += died * k.massPerColumn;
    }
  }

  /**
   * The fish, per column: eat algae and pick litter off the floor, breed slowly while well fed and
   * under the stocking limit, and starve slowly when not. Their waste goes back into the water as food,
   * so fish are not only a check on algae: a crowded pond feeds its own bloom.
   */
  private feedFish(cfg: CompiledConfig, g: SubstrateGrid, delta: AtmoDelta): void {
    const k = cfg.raw.fish;
    const d = cfg.raw.decay;
    const dt = cfg.dt;
    const cap = cfg.raw.standing.cellMl;
    for (let x = 1; x <= g.w - 2; x++) {
      let pop = this.fish[x];
      if (pop <= 0 || !this.isPond(x)) continue;
      const cells = this.water[x] / cap;
      const floor = g.surfaceOfColumn[x];
      const onFloor = floor >= 0 && g.props(floor).maxMl <= 0 ? g.organic[floor] : 0;

      /*
       * Algae only as much as the water is visibly green. A fish grazes what it can see, and a plain
       * appetite made it graze the trace every pond starts from: no pond with fish in it ever greened
       * at all, so the fish were a switch that turned algae off. Litter they find either way.
       */
      const density = this.algae[x] / cells;
      const seen = (density * density) / (density * density + k.algaeHalfDensity * k.algaeHalfDensity);
      const wantAlgae = k.algaeEatenPerMinPerFish * pop * seen * dt;
      const ateAlgae = Math.min(this.algae[x], wantAlgae);
      this.algae[x] -= ateAlgae;
      // Whatever the algae did not fill of their appetite, they look for on the floor.
      const wantLitter = Math.min(k.litterEatenPerMinPerFish * pop * dt, Math.max(0, k.mealPerMinPerFish * pop * dt - ateAlgae));
      const ateLitter = Math.min(onFloor, wantLitter);
      if (ateLitter > 0) g.organic[floor] -= ateLitter;
      const ate = ateAlgae + ateLitter;
      this.nutrients[x] += ate * k.assimilationYield;
      delta.co2Ppm += ate * d.co2PpmPerUnit;
      delta.o2Pct -= ate * d.o2PctPerUnit;

      /*
       * How well fed, 0 to 1: what they found against ONE appetite, however it was filled, plus the
       * film of tiny life on every underwater surface, which feeds a few fish in any pond.
       *
       * The meal used to be algae appetite plus litter appetite together, so in a pond kept clear of
       * algae (the pond a player is being praised for) a fish with plenty of litter could reach 57% fed
       * at best, and starved at 43% of the full rate forever. And with no film, fish put into a fresh
       * pond starved from the first minute. Measured, three fish in a well-kept pond were down to under
       * two in twenty days: at 128x, well under a minute of play.
       */
      const meal = k.mealPerMinPerFish * pop * dt;
      const film = Math.min(1, (k.biofilmFishPerCell * cells) / Math.max(1e-9, pop));
      const fed = Math.min(1, ate / Math.max(1e-12, meal) + film);
      const limit = k.perCellOfWater * cells;
      if (fed > 0.5 && pop < limit) pop += k.breedPerMin * pop * fed * (1 - pop / limit) * dt;
      pop -= k.starveDeathPerMin * pop * (1 - fed) * dt;

      const strength = this.sour[x] / cells;
      if (strength > k.sourDeathAbove) {
        const severity = Math.min(1, (strength - k.sourDeathAbove) / 0.3);
        pop -= k.sourDeathPerMin * severity * pop * dt;
      }
      /*
       * Never rounded to zero here. Fish spread every tick in thin trickles into the columns around
       * them, and zeroing any column under a hundredth of a fish deleted those trickles as fast as they
       * arrived: three fish were gone inside a day in a pond with plenty of room, starving nobody.
       */
      this.fish[x] = Math.max(0, pop);
    }
  }

  /**
   * The reeds, as a pass of their own after the main loop, because where they may grow depends on the
   * shape of the whole pond: its two edge columns, and the bank one column out beyond each.
   *
   * Growth is on full light (they stand up out of the water, so nothing shades them), the food in the
   * pond water that feeds them, and CO2, slower in deep water because they are a plant of the margins.
   * Die-off falls as litter where they stand. Reeds anywhere they may not grow (a pond that has dried
   * up, or shrunk away from them) ride it out for a while and die back slowly, rather than all at once.
   */
  private stepReeds(
    cfg: CompiledConfig,
    g: SubstrateGrid,
    co2Ppm: number,
    lightAt: (cell: number) => number,
    delta: AtmoDelta,
  ): void {
    const k = cfg.raw.reeds;
    const d = cfg.raw.decay;
    const dt = cfg.dt;
    const cap = cfg.raw.standing.cellMl;

    // --- Where reeds may grow: each run of pond columns, its two edges, and one column out.
    this.reedSpot.fill(-1);
    let x = 1;
    while (x <= g.w - 2) {
      if (!this.lined[x]) {
        x++;
        continue;
      }
      const from = x;
      while (x <= g.w - 2 && this.lined[x]) x++;
      const to = x - 1;
      this.reedSpot[from] = from;
      this.reedSpot[to] = to;
      if (from - 1 >= 1 && !this.lined[from - 1] && g.surfaceOfColumn[from - 1] >= 0) this.reedSpot[from - 1] = from;
      if (to + 1 <= g.w - 2 && !this.lined[to + 1] && g.surfaceOfColumn[to + 1] >= 0) this.reedSpot[to + 1] = to;
    }

    for (let col = 1; col <= g.w - 2; col++) {
      const cover = this.reeds[col];
      if (cover <= 0) continue;
      const ground = g.surfaceOfColumn[col];
      const feed = this.reedSpot[col];
      if (feed < 0) {
        const died = Math.min(cover, k.dryDeathPerMin * cover * dt);
        this.reeds[col] -= died;
        if (ground >= 0) g.organic[ground] += died * k.massPerColumn;
        continue;
      }
      // In the pond, the light at its surface; on the bank, the light just above the ground.
      const lit = this.lined[col] ? this.topCell[col] : ground - g.w;
      const light = lit >= 0 ? lightAt(lit) : 0;
      const cells = Math.max(0.25, this.water[feed] / cap);
      const lightF = light / (light + k.lightHalfSat);
      const food = this.nutrients[feed] / cells;
      const foodF = food / (food + k.nutrientHalfSat);
      const co2F = co2Ppm / (co2Ppm + cfg.raw.algae.co2HalfSatPpm);
      // The shallows suit them; a bank column stands in no water at all, which suits them best.
      const depthF = this.lined[col] ? Math.min(1, k.shallowCells / cells) : 1;

      let grownCover = k.growthPerMin * cover * (1 - cover) * Math.min(lightF, foodF, co2F) * depthF * dt;
      grownCover = Math.min(grownCover, this.nutrients[feed] / (k.nutrientPerUnit * k.massPerColumn));
      if (grownCover > 0) {
        const mass = grownCover * k.massPerColumn;
        this.reeds[col] = cover + grownCover;
        this.nutrients[feed] -= mass * k.nutrientPerUnit;
        delta.co2Ppm -= mass * d.co2PpmPerUnit;
        delta.o2Pct += mass * d.o2PctPerUnit;
      }
      const died = Math.min(this.reeds[col], (k.deathPerMin + k.starveDeathPerMin * (1 - foodF)) * this.reeds[col] * dt);
      if (died > 0 && ground >= 0) {
        this.reeds[col] -= died;
        g.organic[ground] += died * k.massPerColumn;
      }
    }
  }

  /**
   * Reeds spread only between neighbouring columns they may grow in: from a pond's edge out onto its
   * bank and back, never along the pond into its middle. Cover moves from more to less, so the bed's
   * total, and its carbon, is conserved.
   */
  private spreadReeds(g: SubstrateGrid, share: number): void {
    for (let x = 1; x < g.w - 2; x++) {
      if (this.reedSpot[x] < 0 || this.reedSpot[x + 1] < 0) continue;
      const moved = (this.reeds[x] - this.reeds[x + 1]) * share;
      this.reeds[x] -= moved;
      this.reeds[x + 1] += moved;
    }
  }

  /** Something that moves along the wet columns, from more to less, conserving its total. */
  private spread(g: SubstrateGrid, field: Float64Array, share: number): void {
    for (let x = 1; x < g.w - 2; x++) {
      if (!this.lined[x] || !this.lined[x + 1]) continue;
      const moved = (field[x] - field[x + 1]) * share;
      field[x] -= moved;
      field[x + 1] += moved;
    }
  }

  /**
   * Lilies spread by runners along the floor into neighbouring pond columns, never over dry ground.
   * Cover moves from more to less, in proportion, so the bed's total — and its carbon — is conserved.
   */
  private spreadLilies(g: SubstrateGrid, share: number): void {
    for (let x = 1; x < g.w - 2; x++) {
      if (!this.lined[x] || !this.lined[x + 1]) continue;
      const diff = this.lilies[x] - this.lilies[x + 1];
      if (diff === 0) continue;
      const moved = diff * share;
      this.lilies[x] -= moved;
      this.lilies[x + 1] += moved;
    }
  }

  /**
   * Neighbouring wet columns share their algae, food and sourness toward the same concentration.
   *
   * A pond is one body of water, and without this a bloom would stay in the column the leaf fell into.
   * A dry column breaks the run, so two ponds never share anything across the ground between them.
   */
  private mix(g: SubstrateGrid, share: number): void {
    let x = 1;
    while (x <= g.w - 2) {
      if (!this.lined[x]) {
        x++;
        continue;
      }
      const from = x;
      while (x <= g.w - 2 && this.lined[x]) x++;
      const to = x - 1;
      if (to === from) continue;

      let total = 0;
      for (let i = from; i <= to; i++) total += this.water[i];
      for (const field of [this.algae, this.nutrients, this.sour]) {
        let sum = 0;
        for (let i = from; i <= to; i++) sum += field[i];
        for (let i = from; i <= to; i++) {
          const target = (sum * this.water[i]) / total;
          field[i] += (target - field[i]) * share;
        }
      }
    }
  }

  /**
   * A brimming stale pond sours its banks.
   *
   * A lined pond touches only mud, which nothing soaks into. It meets bare soil only when it is full
   * to its rim — level with the ground beside it, lapping at the edge of the liner — and then its
   * sourness goes into that ground, up to the water's own strength. In a jar kept normally a pond is
   * full, so a stale one sours its banks in ordinary play; one kept clear, or kept below its rim,
   * never does. (Requiring the water to stand strictly ABOVE the bank made the harm depend on a
   * hair's-breadth of overflow: a normally kept pond sits exactly at its rim and never qualified.)
   *
   * The banks are the first soil just outside the liner, not wherever an overflow film happens to
   * reach: a film levels right across the jar's surface, and souring every column it touched would
   * have made one green pond sour the whole jar.
   */
  private soakBanks(cfg: CompiledConfig, g: SubstrateGrid): void {
    const a = cfg.raw.algae;
    const cap = cfg.raw.standing.cellMl;
    const rate = Math.min(1, a.bankSourPerMin * cfg.dt);
    for (let x = 1; x <= g.w - 2; x++) {
      if (this.sour[x] <= 0 || this.water[x] < a.minWaterMl) continue;
      const floor = g.surfaceOfColumn[x];
      if (floor < 0 || g.props(floor).maxMl > 0) continue; // only a lined pond's own columns
      let top = -1;
      for (let i = g.idx(x, 1); i < g.size - g.w; i += g.w) {
        if (g.standing[i] > 0) {
          top = g.yOf(i);
          break;
        }
      }
      if (top < 0) continue;
      const strength = this.sour[x] / (this.water[x] / cap);
      for (const dir of [-1, 1]) {
        for (let step = 1; step <= a.bankReach; step++) {
          const b = x + dir * step;
          if (b < 1 || b > g.w - 2) break;
          const s = g.surfaceOfColumn[b];
          if (s < 0) break;
          if (g.props(s).maxMl <= 0) continue; // mud: the liner or the pond itself, keep looking
          // The first soil out. Full to its rim means the water reaches this ground's level.
          if (top <= g.yOf(s)) {
            const gap = strength - g.toxin[s];
            if (gap > 0) {
              const moved = Math.min(this.sour[x], gap * rate);
              g.toxin[s] = Math.min(1, g.toxin[s] + moved);
              this.sour[x] -= moved;
            }
          }
          break;
        }
      }
    }
  }
}

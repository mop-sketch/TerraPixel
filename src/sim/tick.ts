// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The tick pipeline.
 *
 * The ORDER here is the most load-bearing decision in the codebase, and every step of it is fixing a
 * specific, nameable bug. Read the comment above each phase before reordering anything.
 */

import { SUBSTRATES, type SubstrateId } from './config/content.js';
import { tempResponse, type CompiledSpecies } from './config/balance.js';
import { LightField } from './light.js';
import type { SpeciesId } from './config/species.js';
import {
  commitDelta,
  humidity,
  stepCondensation,
  stepTemperature,
  stepVenting,
} from './atmosphere.js';
import {
  bestRootCell,
  checkAnchor,
  GrowthLimiter,
  NodeKind,
  STRESS_CAUSE_COUNT,
  StressCause,
  type Plant,
} from './plant.js';
import { carbonPerCover as mossCarbonPerCover } from './moss.js';
import type { Command } from './commands.js';
import type { FailureMode } from './events.js';
import type { World } from './world.js';

export function tick(w: World): void {
  w.events.length = 0;
  w.co2Stalled = false;

  drainCommands(w); //      0  every geometry/tool edit lands here, once, at a defined point
  settleSubstrate(w); //    1  granular physics: material falls and slumps before anything reads it

  if (w.phase === 'build') {
    // The clock does not run until the jar is sealed — layout is a committed decision, not a live
    // experiment — but substrate still falls, so the player can pour a layer and watch it pile up.
    w.tickCount++;
    return;
  }

  drivers(w); //            2  temperature (with inertia) -> light field. Both feed phases 4 and 6.
  substrateWater(w); //     3  landed droplets -> percolate -> capillary diffusion
  resolveWaterDemand(w); // 4  evaporation and root uptake ARBITRATED against one snapshot
  commitAtmosphere(w); //   5  the single commit point for gas and humidity; condensation; droplets
  plantInternal(w); //      6  transport -> photosynthesis -> maintenance -> health -> growth meter
  surfaceEcology(w); //     7  mold first, THEN the decomposers that eat it (M7-M9)
  structuralCommit(w); //   8  branch / drop / sever, all stamped with spawnTick
  updateClimax(w); //     8b  has the jar finished? runs AFTER growth, on settled state
  strikesAndFailures(w); // 9  debounced counters with asymmetric recovery
  audit(w); //             10  dev-only closed-system assert

  w.tickCount++;
}

// ---------------------------------------------------------------------------------------------
// Phase 0 — commands
// ---------------------------------------------------------------------------------------------

function drainCommands(w: World): void {
  w.commands.drain(w.tickCount, (cmd) => applyCommand(w, cmd));
}

function applyCommand(w: World, cmd: Command): void {
  const g = w.grid;
  switch (cmd.t) {
    case 'paint': {
      // Any SEALED jar, the climax included — digging around live roots cuts them whatever
      // stage the jar has reached, and a finished jar must not quietly make painting free.
      if (w.phase !== 'build') damageRootsNear(w, cmd.x, cmd.y);
      w.paint(cmd.x, cmd.y, cmd.material);
      break;
    }
    case 'layerBands':
      w.applyLayerBands(cmd.gravelRows, cmd.charcoalRows, cmd.soilRows);
      break;
    case 'water': {
      // Water always enters at the top of a column and percolates from there. Pouring onto bare
      // glass or into open air is a no-op rather than a silent leak.
      pour(w, cmd.x, cmd.ml, cmd.spread ?? 0);
      break;
    }
    case 'plantSeed': {
      /*
       * The player's own seeds keep the same spacing the jar's blooms have to keep.
       *
       * This check was missing entirely. `trySeedFrom` has always honoured `seedMinSpacing`, so a jar
       * left to seed itself spaced itself properly, while a player could stack seeds in one column and
       * get a knot of plants strangling each other in the same light. Two rules for the same act, and
       * only one of them written down.
       *
       * Uses the SPECIES' own spacing, exactly as self-seeding does, so a Succulent still claims the
       * wider patch its rosette needs.
       */
      const spacing = w.cfg.species[cmd.species].raw.reproduction.seedMinSpacing;
      let crowded = false;
      for (const other of w.plants) {
        if (other.stage === 'dead') continue;
        if (Math.abs(w.pool.x[other.crown] - 0.5 - cmd.x) < spacing) {
          crowded = true;
          break;
        }
      }
      if (crowded) {
        w.events.push({ t: 'plantRefused', x: cmd.x, reason: 'crowded' });
        break;
      }
      if (plantSeed(w, cmd.x, cmd.species) < 0) {
        w.events.push({ t: 'plantRefused', x: cmd.x, reason: 'unrootable' });
      }
      break;
    }
    case 'addSpringtails': {
      // ALWAYS seed at the column's surface, never at the exact cell clicked.
      //
      // Springtails live in the litter horizon, and litter in this sim only ever lands on the surface
      // cell. Honouring a click a few rows down — which is the natural thing for a player to do, since
      // they are pointing at "the soil", not selecting a row — buried colonies below their own food
      // supply, where they starved to the dormant floor and sat there.
      const cell = g.surfaceOfColumn[cmd.x];
      if (cell < 0) break;
      const f = w.cfg.raw.fauna.springtail;
      w.fauna.seed(cell, f.cultureSize, f.popCapPerCell);
      w.events.push({ t: 'springtailsAdded', cell });
      break;
    }
    case 'addMoss': {
      // Moss is surface cover, so it always goes on the column's exposed top cell.
      const cell = g.surfaceOfColumn[cmd.x];
      if (cell < 0) break;
      const before = w.moss.cover[cell];
      w.moss.seed(cell, w.cfg.raw.moss.plantAmount);
      // Charge the new tissue to the air, so planting a patch cannot conjure carbon from nothing.
      const gained = w.moss.cover[cell] - before;
      if (gained > 0) {
        const perCover = mossCarbonPerCover(w.cfg);
        w.delta.co2Ppm -= gained * perCover;
        w.delta.o2Pct += gained * perCover * w.cfg.raw.moss.o2PerCarbonPpm;
      }
      w.events.push({ t: 'mossPlanted', cell });
      break;
    }
    case 'prune': {
      // Prunings fall to the substrate as litter, exactly as shed leaves do — that is the whole point
      // of pruning a terrarium rather than throwing the cuttings away.
      if (w.pool.alive[cmd.node]) {
        w.atmo.airWaterMl += w.pool.killSubtree(cmd.node, g, w.cfg.raw.decay.leafLitterMass);
      }
      break;
    }
    case 'spray': {
      const plant = w.plants[cmd.plant];
      if (plant && plant.stage !== 'dead') spray(w, plant);
      break;
    }
    case 'setLamp':
      w.atmo.lampIntensity = Math.max(0, Math.min(1, cmd.intensity));
      break;
    case 'setLid':
      w.atmo.lidOpen = cmd.open;
      break;
    case 'seal':
      w.seal();
      break;
  }
}

/**
 * Amending next to a root damages it. This is the cost that makes layout a decision the player lives
 * with rather than a two-click patch.
 *
 * It deliberately does NOT kill anything, even when painting a root's own cell. Whether a root dies is
 * decided in exactly one place — `checkAnchor` in phase 8 — which is what keeps the tiers coherent:
 * excavating to air kills, swapping in gravel or charcoal only starves.
 */
/**
 * Pour `ml` onto a column, optionally spread across `radius` columns each side like a watering can's
 * rose. The total is DIVIDED between the wetted columns, never multiplied.
 *
 * Two details here are load-bearing, and both exist to keep the closed-system water audit honest:
 *
 *  - Columns with no surface — outside the jar, or the sloped corners — are dropped from the
 *    normalisation entirely rather than just skipped. Skipping them would silently bin the share
 *    aimed at them, so the player would lose water for standing too close to the wall.
 *  - The last wetted column gets the exact remainder rather than its own rounded share, so the parts
 *    sum back to `ml` bit for bit. The per-tick conservation assert runs at 1e-9 relative tolerance
 *    and a kernel that does not quite sum to 1 would throw.
 */
function pour(w: World, x: number, ml: number, radius: number): void {
  const g = w.grid;

  // Triangular weights, widest in the middle: [1, 2, 3, 2, 1] at radius 2. Deliberately not a
  // Gaussian — Math.exp is implementation-defined, and the sim core keeps transcendentals out so
  // replays stay deterministic (see detmath.ts).
  const cells: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (let d = -radius; d <= radius; d++) {
    const surface = g.surfaceOfColumn[x + d];
    if (surface === undefined || surface < 0) continue;
    const weight = radius + 1 - Math.abs(d);
    cells.push(surface);
    weights.push(weight);
    total += weight;
  }
  if (total <= 0) return;

  w.totalWaterAddedMl += ml;
  let handed = 0;
  for (let k = 0; k < cells.length; k++) {
    const share = k === cells.length - 1 ? ml - handed : (ml * weights[k]) / total;
    handed += share;
    w.pendingSurfaceWater.push({ cell: cells[k], ml: share });
    w.events.push({ t: 'watered', cell: cells[k], ml: share });
  }
}

/** The compiled parameters a plant lives by. Every plant reads config through here, never raw.plant. */
function speciesOf(w: World, plant: Plant): CompiledSpecies {
  return w.cfg.species[plant.species];
}

/**
 * Species parameters for the plant that owns a node.
 *
 * The hot node loops iterate the pool rather than the plant list, so they cannot carry a plant in
 * scope. Two array indexes is cheap enough to do per node, and far less error-prone than trying to
 * group the sweeps by plant.
 */
function speciesOfNode(w: World, n: number): CompiledSpecies {
  return w.cfg.species[w.plants[w.pool.plantId[n]].species];
}

function damageRootsNear(w: World, x: number, y: number): void {
  const r = w.cfg.raw.tools.amendDamagesRootsWithin;
  const P = w.pool;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    if (Math.abs(P.cellX[n] - x) > r || Math.abs(P.cellY[n] - y) > r) continue;
    P.health[n] *= 0.5;
  }
}

/**
 * Create a plant at a column.
 *
 * With a `parent`, the seedling is grown INSIDE the sealed jar and the parent pays for all of it —
 * sugar, water and minerals. Without one it is the player's own seed, arriving from outside, and its
 * starting reserves are genuinely new material.
 *
 * That distinction is not bookkeeping pedantry: a seedling starts with sugar, three nodes of tissue,
 * water and a mineral reserve. Minting those inside a closed system would show up immediately as
 * carbon appearing from nowhere in `auditCarbonPpm` and as a water leak in the per-tick assert. The
 * cost doubles as a natural brake, since a struggling parent simply cannot afford to reproduce.
 */
/**
 * Pesticide on one whole plant: kills most of the pests on every leaf, and adds exactly one dose.
 *
 * Whole-plant, not a patch of columns. A plant spans six to ten columns, so a column-band spray only
 * ever covered part of one and delivered a fraction of a dose that depended on where the player
 * happened to click — which made "three sprays kill it" untrue in a way nobody could see coming. One
 * click, one plant, one dose keeps the rule the player is told exactly true.
 *
 * Lethal residue kills the plant here, at the moment it is crossed. Residue only ever rises through a
 * spray, so this is the one place it can happen, and handling it in the command phase keeps the kill
 * at the tick's single defined point for player-caused mutation.
 */
function spray(w: World, plant: Plant): void {
  const P = w.pool;
  const c = w.cfg.raw.pesticide;
  // Read BEFORE the kill: whether this plant visibly has pests is what lets a course start.
  const visibleAt = w.cfg.raw.pests.visibleAt;
  let infested = false;
  for (const n of plant.nodeIds) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
    if (P.pests[n] >= visibleAt) infested = true;
    P.pests[n] *= 1 - c.killFraction;
  }
  plant.pesticide += c.dosePerSpray;
  w.events.push({ t: 'sprayed', plant: plant.id });
  if (plant.pesticide >= c.lethalResidue) {
    poison(w, plant);
    return;
  }
  advanceCourse(w, plant, infested);
}

/**
 * Count a dose toward the plant's pesticide course, and immunise it when the course completes.
 *
 * Only the FIRST dose needs the plant to visibly have pests. The rest count regardless: the first
 * spray knocks the colony back below visible, and a course the player could only continue while the
 * pests were showing would stall exactly when it was working.
 *
 * A dose inside the minimum gap is not an error and still does its job — it kills pests and leaves
 * residue — it just does not advance the course. So the only way to finish sooner is to be patient,
 * and the only thing hurrying buys is poison.
 */
function advanceCourse(w: World, plant: Plant, infested: boolean): void {
  const P = w.pool;
  const c = w.cfg.raw.pesticide;
  const perDay = w.cfg.raw.time.dayLengthSimMinutes / w.cfg.dt;
  const since = w.tickCount - plant.courseLastTick;
  if (plant.pestImmune) return; // already through it; nothing left to build toward
  if (plant.courseDoses > 0 && since > c.courseMaxGapDays * perDay) plant.courseDoses = 0; // lapsed

  if (plant.courseDoses === 0) {
    if (!infested) return;
  } else if (since < c.courseMinGapDays * perDay) {
    // Too soon to count. Announced, because a dose that quietly does nothing is indistinguishable
    // from a broken tool — and the player has just paid residue for it.
    w.events.push({ t: 'sprayTooSoon', plant: plant.id });
    return;
  }
  plant.courseDoses++;
  plant.courseLastTick = w.tickCount;
  if (plant.courseDoses >= c.courseDoses) {
    /*
     * The course finished: the colony is wiped out and the plant is immune for the rest of its life.
     *
     * This is the ONLY way a plant becomes immune. Granting it for any clearing — a prune, or a
     * healthy plant shrugging the pests off — made the course optional, which is no good when the
     * course is the thing the player actually plays.
     */
    plant.courseDoses = 0;
    plant.pestImmune = true;
    plant.pestAwake = false;
    for (const n of plant.nodeIds) {
      if (P.alive[n] && P.kind[n] === NodeKind.Leaf) P.pests[n] = 0;
    }
    plant.pestReservoir = 0;
    w.events.push({ t: 'immunised', plant: plant.id });
  }
}

/**
 * A plant killed by pesticide.
 *
 * Leaves, flowers and roots die; the stems stay standing, which is exactly how a plant that died of
 * natural causes is left, so the jar shows a poisoned plant the same way and needs no second kind of
 * corpse. Everything that dies becomes litter where it fell, and its water goes back to the air, so
 * neither the carbon nor the water books move.
 */
function poison(w: World, plant: Plant): void {
  const P = w.pool;
  const g = w.grid;
  const litter = w.cfg.raw.decay.leafLitterMass;
  let stems = 0;
  for (const n of plant.nodeIds) {
    if (!P.alive[n]) continue;
    if (P.kind[n] === NodeKind.Stem) {
      stems++;
      continue;
    }
    const cell =
      P.kind[n] === NodeKind.Root
        ? g.idx(P.cellX[n], P.cellY[n])
        : g.surfaceOfColumn[Math.max(1, Math.min(g.w - 2, Math.round(P.x[n] - 0.5)))];
    if (cell >= 0) g.organic[cell] += litter;
    w.atmo.airWaterMl += P.release(n, g);
  }
  plant.leafCount = 0;
  plant.rootCount = 0;
  plant.liveNodes = stems;
  plant.stage = 'dead';
  w.events.push({ t: 'poisoned', plant: plant.id });
}

function plantSeed(w: World, x: number, species: SpeciesId, parent?: Plant): number {
  const g = w.grid;
  const surface = g.surfaceOfColumn[x];
  if (surface < 0) return -1;
  if (!SUBSTRATES[g.substrate[surface] as SubstrateId].rootable) return -1;
  const sy = g.yOf(surface);

  const c = w.cfg.species[species].raw;
  const startingSugar = c.seedSugar;
  const startingNutrients = c.growth.nutrientCostPerNode * 4;
  // Three nodes of tissue, priced the same way the carbon audit counts plant structure.
  const structureSugar = c.growth.sugarCostPerNode * 3;

  if (parent) {
    const P = w.pool;
    if (P.sugar[parent.crown] < startingSugar + structureSugar) return -1;
    if (parent.nutrients < startingNutrients) return -1;
    if (parent.waterMl < c.seedWaterMl) return -1;
    P.sugar[parent.crown] -= startingSugar + structureSugar;
    parent.nutrients -= startingNutrients;
    // Draw the seedling's water out of the parent's own tissue, crown first.
    let owed = c.seedWaterMl;
    for (const n of parent.nodeIds) {
      if (owed <= 0) break;
      if (!P.alive[n]) continue;
      const take = Math.min(P.water[n], owed);
      P.water[n] -= take;
      owed -= take;
    }
    parent.waterMl -= c.seedWaterMl - owed;
    // Anything the parent could not supply comes from the soil it is rooted in, so the books balance.
    if (owed > 0) g.removeAbove(surface, owed, 0);
  } else {
    // An outside seed brings its own water into the jar, so the audit baseline moves with it.
    w.totalWaterAddedMl += c.seedWaterMl;
  }

  const id = w.plants.length;
  // The crown sits at the soil line. Roots hang below it as children, shoots rise above as children,
  // so water flows root -> crown on the reverse sweep and crown -> leaf on the forward sweep.
  const crown = w.pool.spawn(NodeKind.Stem, id, -1, x + 0.5, sy, w.tickCount);
  if (crown < 0) return -1;
  w.pool.sugar[crown] = startingSugar;

  const root = w.pool.spawn(NodeKind.Root, id, crown, x + 0.5, sy + 0.5, w.tickCount);
  if (root < 0) return -1;
  w.pool.anchorRoot(root, g, x, sy);
  w.pool.water[root] = c.seedWaterMl;

  const leaf = w.pool.spawn(NodeKind.Leaf, id, crown, x + 0.5, sy - 1, w.tickCount, leafLifespan(w, species));
  if (leaf < 0) return -1;
  /*
   * Stowaways. A seed the PLAYER brings in usually carries a dormant colony — that is how pests get
   * into a sealed jar at all — but not always, so two jars planted the same way can differ from the
   * first day. A seed the jar made itself is always clean: its pests would have to walk across.
   */
  const pests = w.cfg.raw.pests;
  if (!parent && w.rng.next() < pests.stowawayChance) w.pool.pests[leaf] = pests.stowawayLoad;

  const plant: Plant = {
    id,
    species,
    crown,
    stage: 'seedling',
    nodeIds: [crown, root, leaf],
    rootCount: 1,
    leafCount: 1,
    liveNodes: 3,
    peakNodes: 3,
    waterMl: c.seedWaterMl,
    waterCapMl: c.transport.nodeCapacityMl * 3,
    // A seed carries just enough mineral reserve to establish before it has to find its own.
    nutrients: startingNutrients,
    stress: 0,
    distress: 0,
    co2Stalled: false,
    nutrientStarved: false,
    calmMinutes: 0,
    barrenMinutes: 0,
    flowers: 0,
    stressBy: new Float32Array(STRESS_CAUSE_COUNT),
    limiter: GrowthLimiter.None,
    pesticide: 0,
    courseDoses: 0,
    courseLastTick: 0,
    pestImmune: false,
    infestedMinutes: 0,
    pestReservoir: 0,
    /*
     * One-sided, 1 to 1 + spread: luck can only make a plant HARDIER than the baseline, never softer.
     *
     * Symmetric spread read better on paper and broke a promise in practice. A plant is meant to be
     * safe for its first forty days, and a 0.65 draw moved that to twenty-six — the reference jar
     * showed pests on day 34 of a run whose whole point is thriving untouched for forty.
     *
     * Drawn for EVERY plant, not only the ones carrying pests, so the sequence does not depend on
     * whether the stowaway roll above happened to land — which would make one plant's luck shift the
     * whole jar's random history.
     */
    pestVigour: 1 + w.rng.next() * pests.vigourSpread,
    pestAwake: false,
  };
  w.plants.push(plant);
  w.events.push({ t: 'nodeSpawned', node: crown, kind: NodeKind.Stem });
  if (parent) w.events.push({ t: 'seeded', plant: id, from: parent.id, x });
  return id;
}

/**
 * A bloom occasionally drops a seed onto open ground near its parent.
 *
 * Viability here means only "rootable soil, not already crowded" — deliberately NOT "well lit" or
 * "well fed". Whether the seedling survives is left to the simulation, because a sprout that yellows
 * and dies in its parent's shade shows the player that the jar is full far better than a seed that
 * silently never appears.
 */
function trySeedFrom(w: World, parent: Plant): void {
  // A finished jar keeps its blooms — they are most of what makes it worth looking at — but they stop
  // setting seed. A new crown is the one thing the climax genuinely must not allow.
  if (w.phase === 'climax') return;
  const r = speciesOf(w, parent).raw.reproduction;
  if (w.rng.next() >= r.seedChancePerBloom) return;

  let live = 0;
  for (const p of w.plants) if (p.stage !== 'dead') live++;
  if (live >= r.maxPlants) return;

  const g = w.grid;
  const origin = Math.max(1, Math.min(g.w - 2, Math.round(w.pool.x[parent.crown] - 0.5)));

  // Collect every viable column on both sides, then pick one at random, so a seed is equally likely
  // to land either way rather than always taking the first hit of a left-to-right scan.
  const options: number[] = [];
  for (const dir of [-1, 1]) {
    for (let d = r.seedMinRange; d <= r.seedMaxRange; d++) {
      const x = origin + dir * d;
      if (x < 1 || x > g.w - 2) continue;
      const surface = g.surfaceOfColumn[x];
      if (surface < 0) continue;
      if (!SUBSTRATES[g.substrate[surface] as SubstrateId].rootable) continue;
      let crowded = false;
      for (const other of w.plants) {
        if (other.stage === 'dead') continue;
        const ox = w.pool.x[other.crown] - 0.5;
        if (Math.abs(ox - x) < r.seedMinSpacing) { crowded = true; break; }
      }
      if (!crowded) options.push(x);
    }
  }
  if (options.length === 0) return;

  /*
   * A uniform pick, deliberately — biasing seeds toward open ground was tried here and rejected.
   *
   * It looks like the obvious cure for a jar that clumps in the middle, and it is not. Weighting the
   * choice by distance from every living crown barely moved the distribution (floor coverage 66% to
   * 73%) while taking the reference jar from 6 plants to 8, because a seed landing in open ground is
   * also a seed landing in FULL LIGHT: it establishes where a shaded one would have failed. That is
   * extra biomass rather than redistributed biomass, and this jar has no carbon spare for it — CO2 fell
   * from 315 ppm to 138 and the reference jar stalled outright.
   *
   * Spreading is `seedMinSpacing`'s job instead, because it moves the same plants apart rather than
   * adding more. See the note there.
   */
  plantSeed(w, options[Math.floor(w.rng.next() * options.length)], parent.species, parent);
}

// ---------------------------------------------------------------------------------------------
// Phase 1 — granular settling
// ---------------------------------------------------------------------------------------------

/**
 * Substrate falls and slumps BEFORE anything reads the jar's geometry. The light field, the surface
 * row each column exposes to the air, and the root-anchor check all depend on where the material
 * actually is; running them against last tick's shape would leave light falling on soil that has
 * already slid away and evaporation drawing from a cell that is now open air.
 *
 * Settling only runs while the substrate is `dirty` — set when the player paints, and cleared as
 * soon as a pass moves nothing. A jar at rest costs one flag check per tick, so the common case of
 * an established terrarium pays nothing for this.
 */
function settleSubstrate(w: World): void {
  if (!w.substrateDirty) return;
  if (!w.grid.settle(w.rng)) {
    w.substrateDirty = false;
    return;
  }
  // Something moved, so every cached view of the jar's shape is now stale.
  w.grid.reindex();
  w.atmo.airCells = w.countAirCells();
  w.events.push({ t: 'substrateSettled' });
}

// ---------------------------------------------------------------------------------------------
// Phase 2 — drivers
// ---------------------------------------------------------------------------------------------

/**
 * Temperature must settle BEFORE evaporation reads it, and the light field must exist before any
 * leaf photosynthesises. Both are cheap; both are ordering-critical.
 */
function drivers(w: World): void {
  stepTemperature(w.cfg, w.atmo);
  w.light.compute(w.cfg, w.pool, w.atmo.lampIntensity, w.tickCount);
}

// ---------------------------------------------------------------------------------------------
// Phase 3 — substrate water
// ---------------------------------------------------------------------------------------------

function substrateWater(w: World): void {
  const g = w.grid;

  // Droplets that finished falling are credited here, at a defined point, rather than mid-flight.
  for (const p of w.pendingSurfaceWater) {
    const overflow = g.add(p.cell, p.ml);
    // Anything that will not fit runs off into the drainage layer instead of vanishing.
    if (overflow > 0) spillDown(w, p.cell, overflow);
  }
  w.pendingSurfaceWater.length = 0;

  // Gravity first (surplus above field capacity moves down one cell), then capillary action in every
  // direction (potential below field capacity equalises). Two mechanisms, cleanly separated.
  g.percolate();
  g.diffuse(w.cfg);
  w.sumpMl = g.sumpMl();
}

/** Push overflow down the column until something has room. Keeps water strictly conserved. */
function spillDown(w: World, from: number, ml: number): void {
  const g = w.grid;
  let remaining = ml;
  let i = from;
  while (remaining > 0) {
    const below = i + g.w;
    if (below >= g.size || g.props(below).maxMl <= 0) break;
    remaining = g.add(below, remaining);
    i = below;
  }
  // If the whole column is saturated the excess stays in the top cell as standing water: the jar is
  // sealed, so it has nowhere else to go, and that is exactly the root-rot condition.
  if (remaining > 0) g.moisture[from] += remaining;
}

// ---------------------------------------------------------------------------------------------
// Phase 4 — arbitrated water demand
// ---------------------------------------------------------------------------------------------

/**
 * THE most important correction in this pipeline.
 *
 * A naive `water -> evaporate -> uptake` order lets the air skim every cell before the root ever
 * sees it. Under drought that structurally disadvantages the plant and produces the single worst
 * symptom a sim like this can have: "I watered it and it still died." Reordering cannot fix it —
 * whoever runs second is wrong. So both claimants state a demand against ONE frozen snapshot and the
 * cell scales them proportionally.
 *
 * Evaporation is also decoupled SPATIALLY: it only draws from an exposed front (full strength at the
 * surface, a quarter one cell down, nothing deeper). So roots at depth never compete with the air at
 * all, contention is a rare surface-root edge case, and the player learns something true — depth and
 * cover protect water.
 */
function resolveWaterDemand(w: World): void {
  const g = w.grid;
  const c = w.cfg.raw;
  const P = w.pool;
  const { rootDemand, cellScale } = w.scratch;

  // Frozen atmosphere snapshot: every cell this tick sees identical air.
  const tempC = w.atmo.tempC;
  const rh = humidity(w.cfg, w.atmo);
  const tempFactor = Math.max(0, (tempC - c.atmosphere.evapBaseTempC) / 10);

  // Transpiration pull: a plant whose tissue is already full stops drawing. Without this the roots
  // are a pump with no float valve and the plant silently drains the jar into itself.
  measurePlantWater(w);

  rootDemand.fill(0);
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    if (checkAnchor(P, n, g) !== 'ok') continue;
    const i = g.idx(P.cellX[n], P.cellY[n]);
    rootDemand[i] += rootDraw(w, n);
  }

  let evaporated = 0;
  let absorbDemand = 0;
  for (const i of g.activeCells) {
    const avail = Math.max(0, g.moisture[i] - c.water.wiltingPointMl);
    const dRoots = rootDemand[i];
    const dEvap = Math.max(0, moistureFlux(w, i, tempFactor, rh));
    const total = dRoots + dEvap;
    if (total <= 0 || avail <= 0) {
      cellScale[i] = 0;
    } else {
      const scale = total > avail ? avail / total : 1;
      cellScale[i] = scale;
      if (dEvap > 0) evaporated += g.removeAbove(i, dEvap * scale, c.water.wiltingPointMl);
    }
    absorbDemand += Math.max(0, -moistureFlux(w, i, tempFactor, rh));
  }
  w.delta.waterMl += evaporated;

  // The reverse direction: dry substrate pulls moisture back OUT of humid air.
  //
  // Without this the exchange is one-way and a sealed jar has no sink for water vapour at all, so
  // humidity climbs until condensation runs permanently and the gauge pins at the condensation floor
  // forever. With it, humidity settles at roughly the soil's own wetness — which makes the readout a
  // genuine diagnosis of the substrate, and turns condensation back into something the player CAUSES
  // by over-watering or overheating rather than a constant fact of life.
  if (absorbDemand > 0) {
    const budget = Math.max(0, w.atmo.airWaterMl * 0.5);
    const scale = absorbDemand > budget ? budget / absorbDemand : 1;
    let absorbed = 0;
    for (const i of g.activeCells) {
      const want = Math.max(0, -moistureFlux(w, i, tempFactor, rh)) * scale;
      if (want <= 0) continue;
      absorbed += want - g.add(i, want);
    }
    w.delta.waterMl -= absorbed;
  }

  // Second root pass applies the scaled uptake. Two passes over roots, not per-cell root lists.
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    const verdict = checkAnchor(P, n, g);
    if (verdict !== 'ok') {
      P.starve[n] = Math.min(65535, P.starve[n] + 1);
      continue;
    }
    const i = g.idx(P.cellX[n], P.cellY[n]);
    const want = rootDraw(w, n) * cellScale[i];
    // Floored at the wilting point: a root cannot dig into capillary-bound water, and cannot reach
    // past the share the arbitration above allotted it.
    const got = g.removeAbove(i, want, c.water.wiltingPointMl);
    P.water[n] += got;
    // Only count a root as starving if it ASKED and came back empty. A satiated plant asks for nothing
    // at night, and treating that as starvation would damage healthy roots every single night.
    if (want > 1e-6 && got <= 1e-6) P.starve[n] = Math.min(65535, P.starve[n] + 1);
    else if (got > 1e-6) P.starve[n] = 0;

    // Nutrients go to the plant's own mineral bank, NOT into its sugar. Conflating the two would let
    // a plant photosynthesise its way out of exhausted soil and make the whole decomposer loop
    // decorative.
    const plant = w.plants[P.plantId[n]];
    if (plant) {
      // Banked minerals are capped per node, for the same reason banked sugar is: a plant at its
      // structural maximum has nothing to spend them on. Uncapped, an established plant keeps drawing
      // long after it has stopped growing and becomes a mineral sink that strips the whole jar —
      // measurably so, with one mature plant sitting on 570 nutrients while self-sown seedlings a few
      // columns away were frozen at six nodes in soil reading 0.0. Leaving the surplus in the ground
      // is what lets anything else in the jar establish.
      const bank = Math.max(1, plant.liveNodes) * c.plant.uptake.maxStoredNutrientsPerNode;
      const room = Math.max(0, bank - plant.nutrients);
      const nut = Math.min(g.nutrients[i], room, c.plant.uptake.nutrientPerMin * P.health[n] * w.cfg.dt);
      g.nutrients[i] -= nut;
      plant.nutrients += nut;

      /*
       * ROOT EXUDATE — how a sprout buys itself a decomposer colony.
       *
       * A seedling leaks a trickle of sugar from its root tips into the cell it is anchored in. Nothing
       * new has to go looking for it: `FaunaField.spread` already walks colonies toward `organic + mold`
       * inside its sense radius, so exudate simply makes a sprout smell like food and the springtails
       * arrive on their own. What they leave behind is frass, deposited in that same cell — and the
       * uptake directly above reads minerals from exactly the cell the root sits in, so the nutrients
       * land somewhere the seedling can actually reach them.
       *
       * Attracting them WITHOUT feeding them would have been worse than doing nothing: frass is charged
       * against what a colony eats, so a swarm lured onto bare soil starves down to the dormant floor
       * and produces nothing at all.
       *
       * Only seedlings pay. An established plant already sheds litter of its own and has no need to
       * advertise, so charging it this would be a permanent tax on every mature plant in the jar.
       *
       * The price is what keeps the carbon books shut. Organic matter carries `decay.co2PpmPerUnit` of
       * carbon per unit and sugar carries `photosynthesis.co2PpmPerUnit`, so the conversion is DERIVED
       * from those two constants rather than written down a second time — a literal here would quietly
       * become a carbon leak the first time either one was retuned. Both are read from the BASE config
       * on purpose: carbon per unit is jar-wide and must never vary by species, which is the same
       * reasoning that keeps `sugarCostPerNode` out of the species overlays.
       */
      // Only ever out of genuine SURPLUS: a node's worth of sugar banked, over and above the trickle.
      //
      // A ten-percent-of-store cap alone did not express that, because the absolute rate dominates until
      // the store is nearly empty — so a doomed seedling went on advertising the whole way down. In a
      // jar left in total darkness that brought its death forward far enough to give the springtails
      // extra days to clear the litter it left, and a jar that is supposed to be fed by its own failures
      // had bare ground 30 sim-days later. A sprout with nothing spare now simply stops calling.
      const sproutAge = (w.tickCount - P.spawnTick[plant.crown]) * w.cfg.dt;
      /*
       * `liveNodes > 3` is the load-bearing condition, and it is what makes this honest.
       *
       * Exudate is SURPLUS photosynthate. A plant that has not managed to build a single node beyond the
       * three it was sown with has no surplus to leak, and a jar with the lamp at zero is exactly that
       * case — it cannot fix carbon at all, so every drop it leaked would be carbon it never earned.
       *
       * It is also the whole fix for a test that caught this: a plant left in the dark is supposed to
       * die and feed the jar with its own litter, and a sprout that advertised the entire way down
       * instead grew the colony that then cleared every scrap of that litter. Sugar thresholds could not
       * express it, because a seed is sown holding 60 and stays labelled a seedling forever when it
       * cannot grow. "Has it actually got going" is the question that was always being asked.
       */
      if (
        plant.stage === 'seedling' &&
        plant.liveNodes > 3 &&
        sproutAge < c.plant.uptake.seedlingExudateMinutes &&
        P.sugar[plant.crown] > c.plant.growth.sugarCostPerNode
      ) {
        const spend = Math.min(
          P.sugar[plant.crown] * 0.1,
          c.plant.uptake.seedlingExudateSugarPerMin * w.cfg.dt,
        );
        P.sugar[plant.crown] -= spend;
        g.organic[i] += (spend * c.plant.photosynthesis.co2PpmPerUnit) / c.decay.co2PpmPerUnit;
      }
    }
  }
}

/**
 * Signed moisture exchange between one substrate cell and the jar air, in millilitres this tick.
 * Positive is evaporation (soil -> air), negative is absorption (air -> soil).
 *
 * The driver is the gap between the air's humidity and the humidity the soil itself can support,
 * taken as its wetness — moisture measured against what the material HOLDS, so soil at field capacity
 * supports a saturated air space. Making this a signed gradient rather than a one-way rate is what
 * gives the jar an equilibrium humidity instead of an inevitable climb to permanent condensation.
 *
 * Only the exposed front participates: full strength at the surface, a quarter one cell down, nothing
 * deeper. That spatially decouples the air from roots at depth, so competition between the air and
 * the roots is a rare surface-root edge case rather than the norm — and it teaches the player
 * something true, which is that depth and cover protect water.
 */
function moistureFlux(w: World, i: number, tempFactor: number, airRh: number): number {
  if (tempFactor <= 0) return 0;
  const ex = exposure(w, i);
  if (ex <= 0) return 0;
  const soilRh = 100 * w.grid.wetness(i);
  const gradient = (soilRh - airRh) / 100;
  return w.cfg.raw.atmosphere.evapMlPerMinAtFullDrive * tempFactor * ex * gradient * w.cfg.dt;
}

/**
 * Refresh each plant's live water and the capacity of its tissue. Both are read by `rootDraw` in the
 * same phase, so they have to be computed before either demand pass runs.
 */
function measurePlantWater(w: World): void {
  const P = w.pool;
  for (const plant of w.plants) {
    const perNode = speciesOf(w, plant).raw.transport.nodeCapacityMl;
    let ml = 0;
    let live = 0;
    for (const n of plant.nodeIds) {
      if (!P.alive[n]) continue;
      ml += P.water[n];
      live++;
    }
    plant.waterMl = ml;
    plant.waterCapMl = Math.max(perNode, live * perNode);
  }
}

/**
 * How much one root asks for this tick. Scaled by health and by how empty the plant's tissue is, so
 * a wilting plant pulls hard and a turgid one idles. This is the whole feedback loop that keeps
 * uptake honest.
 */
function rootDraw(w: World, n: number): number {
  const P = w.pool;
  const plant = w.plants[P.plantId[n]];
  if (!plant) return 0;
  const c = speciesOf(w, plant).raw.uptake;
  const fill = plant.waterCapMl > 0 ? plant.waterMl / plant.waterCapMl : 1;
  const thirst = Math.max(0, 1 - fill);
  return c.rootMlPerMin * P.health[n] * thirst * w.cfg.dt;
}

/** Evaporation exposure by depth below the column's surface cell, reduced by any moss mat above. */
function exposure(w: World, i: number): number {
  const g = w.grid;
  const x = g.xOf(i);
  const surface = g.surfaceOfColumn[x];
  if (surface < 0) return 0;
  const depth = g.yOf(i) - g.yOf(surface);
  const table = w.cfg.raw.water.evapExposureByDepth;
  const base = depth >= 0 && depth < table.length ? table[depth] : 0;
  if (base <= 0) return 0;
  // A moss mat shades the soil it grows on, so a mossy jar holds its water noticeably longer — which
  // is a direct answer to the dehydration failure that catches most new players.
  const shade = 1 - w.cfg.raw.moss.evaporationShield * w.moss.cover[surface];
  return base * shade;
}

// ---------------------------------------------------------------------------------------------
// Phase 5 — atmosphere commit
// ---------------------------------------------------------------------------------------------

function commitAtmosphere(w: World): void {
  const a = w.atmo;
  a.airCells = w.countAirCells();
  commitDelta(w.cfg, a, w.delta, w.baseAirCells);
  // An open lid is the one sanctioned hole in the closed system, so the audit baseline moves with it.
  w.totalWaterAddedMl += stepVenting(w.cfg, a);

  stepCondensation(w.cfg, a, (ml) => {
    // Beads land on a LATER tick. Crediting the soil here would make a same-tick loop (soil wets ->
    // RH drops -> soil dries) AND make the falling-droplet animation a lie. The delay is diegetic:
    // the player watches the water fall.
    //
    // Landing column is spread across the whole width with a bias toward the side walls. In a 2D
    // cross-section the front and back panes fog over the full width too, and confining every bead
    // to the two edge columns would slowly soak the rim and desiccate the middle of the jar.
    const wall = w.rng.next() < 0.35;
    const x = wall
      ? w.rng.next() < 0.5
        ? 1
        : w.grid.w - 2
      : 1 + w.rng.int(w.grid.w - 2);
    w.droplets.push({ x, y: 1, ml, remaining: w.cfg.raw.atmosphere.condensation.dropletFallTicks });
    w.events.push({ t: 'droplet', x, ml });
  });

  for (let k = w.droplets.length - 1; k >= 0; k--) {
    const d = w.droplets[k];
    d.remaining--;
    if (d.remaining > 0) continue;
    const surface = w.grid.surfaceOfColumn[d.x];
    w.droplets.splice(k, 1);
    if (surface < 0) {
      // Nothing to land on: the bead returns to the air rather than disappearing.
      w.atmo.airWaterMl += d.ml;
      continue;
    }
    w.pendingSurfaceWater.push({ cell: surface, ml: d.ml });
    w.events.push({ t: 'dropletLanded', cell: surface, ml: d.ml });
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 6 — plant internals
// ---------------------------------------------------------------------------------------------

function plantInternal(w: World): void {
  const P = w.pool;
  const g = w.grid;
  const a = w.atmo;
  const co2 = a.co2Ppm; // snapshot: every leaf competes against the same air
  const born = w.tickCount;
  // Parallel to w.plants, so the node sweeps below can reach a species with one index. Temperature
  // response is per species too — each has its own optimum and tolerance.
  const sp = w.plants.map((plant) => w.cfg.species[plant.species]);
  const tempF = sp.map((s) => tempResponse(w.cfg, s, a.tempC));

  // --- Reverse sweep (child before parent): roots push water up to the crown, every node pushes
  // sugar up to the crown. One pass, because `parent < child` is guaranteed.
  for (let n = P.count - 1; n >= 0; n--) {
    if (!P.alive[n] || P.spawnTick[n] === born) continue;
    const p = P.parent[n];
    if (p < 0) continue;
    if (P.kind[n] === NodeKind.Root) {
      P.water[p] += P.water[n];
      P.water[n] = 0;
    }
    if (P.sugar[n] > 0 && P.kind[n] !== NodeKind.Root) {
      P.sugar[p] += P.sugar[n];
      P.sugar[n] = 0;
    }
  }

  // --- Forward sweep (parent before child): water flows out toward the leaves, losing a little at
  // every segment. Live and single-buffered on purpose: double-buffering would cost one tick of lag
  // PER SEGMENT, making a tall plant unplayably sluggish. The compounding loss is what makes height
  // genuinely expensive and pruning a decision with a payoff.
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.spawnTick[n] === born) continue;
    if (P.water[n] <= 0) continue;
    const tr = sp[P.plantId[n]].raw.transport;
    let kids = 0;
    for (let ch = P.firstChild[n]; ch >= 0; ch = P.nextSibling[ch]) {
      if (P.alive[ch] && P.kind[ch] !== NodeKind.Root) kids++;
    }
    if (kids === 0) continue;
    // Efficiency throttles THROUGHPUT, it does not destroy water. Every millilitre that leaves a
    // parent reaches its child; what shrinks with each hop is the RATE, compounding as
    // (share x efficiency)^depth. That preserves the design intent — height is expensive, a long
    // stem starves its own tip, pruning pays — without opening a leak.
    //
    // Venting the difference to the air instead (the obvious reading of "transport loss") drains the
    // plant continuously, night included, and empties the root zone faster than diffusion refills it.
    // Water only leaves the plant through photosynthesis below, which is light-gated, as it should be.
    const offer = (P.water[n] * tr.sharePerTick * tr.efficiencyPerSegment) / kids;
    for (let ch = P.firstChild[n]; ch >= 0; ch = P.nextSibling[ch]) {
      if (!P.alive[ch] || P.kind[ch] === NodeKind.Root) continue;
      // A node's tissue has a finite volume, so it cannot be handed more than it can hold. Without
      // this cap the tips accumulate water without bound and the whole plant becomes a water sink.
      const room = Math.max(0, tr.nodeCapacityMl - P.water[ch]);
      const sent = Math.min(offer, room);
      if (sent <= 0) continue;
      P.water[n] -= sent;
      P.water[ch] += sent;
    }
  }

  // --- Photosynthesis, measured then applied, so scarce CO2 is shared proportionally rather than
  // going to whichever leaf happens to sit earliest in the pool.
  const { leafRate } = w.scratch;

  /**
   * SOURCE-SINK FEEDBACK. A plant whose sugar store is full downregulates photosynthesis instead of
   * fixing carbon it will only throw away.
   *
   * Without this, a mature plant at its structural maximum keeps pulling CO2 out of the air forever
   * and the surplus sugar is silently clamped off — carbon vanishing from a sealed system. Every jar
   * then drifts into a CO2 stall no matter how well it is run, which is exactly what the harness was
   * reporting. Real plants do this too, for the same reason.
   */
  const sinkOf = (plant: Plant): number => {
    const perNode = w.cfg.species[plant.species].raw.maintenance.maxStoredSugarPerNode;
    const ceiling = Math.max(1, plant.liveNodes * perNode);
    return Math.max(0, Math.min(1, 1 - P.sugar[plant.crown] / ceiling));
  };
  const sink: number[] = w.plants.map(sinkOf);

  /**
   * Which input is capping each plant's photosynthesis, tallied across its leaves.
   *
   * Sampled in FULL daylight only. At night light is zero and would trivially win for every plant in
   * the jar, so the readout would say "not enough light" at exactly the moment a player pauses to
   * read it — true, useless, and actively misleading about what to fix.
   *
   * The threshold is above zero rather than at it because dawn and dusk poison the answer just as
   * effectively: during the twilight ramp there genuinely is very little light, so the last sample
   * before nightfall would always be "light" no matter how well lit the jar is at midday.
   */
  const daylight = LightField.dayFraction(w.cfg, w.tickCount) > 0.5;
  const limiterTally = daylight ? w.plants.map(() => new Int32Array(6)) : null;

  let co2Need = 0;
  for (let n = 0; n < P.count; n++) {
    leafRate[n] = 0;
    if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf || P.spawnTick[n] === born) continue;
    const demand = sink[P.plantId[n]] ?? 1;
    if (demand <= 0) continue;
    const ps = sp[P.plantId[n]].raw.photosynthesis;
    const L = w.light.atNode(P, n);
    // Liebig's law of the minimum: the SCARCEST input caps output. This one line is what makes the
    // player's mental model work, because there is always exactly ONE thing to fix.
    const lightF = L / (L + ps.lightHalfSat);
    const co2F = co2 / (co2 + ps.co2HalfSatPpm);
    const waterF = Math.min(1, P.water[n] / ps.leafWaterNeed);
    const warmthF = tempF[P.plantId[n]];
    const rate = ps.maxPerLeafPerMin * P.health[n] * warmthF * demand * Math.min(lightF, co2F, waterF) * w.cfg.dt;
    if (limiterTally) {
      // The five multiplicative terms, ranked. `demand` winning is not a problem at all — it means
      // the store is full and the plant has downregulated on purpose.
      const worst = Math.min(lightF, co2F, waterF, warmthF, demand);
      const which =
        worst === demand
          ? GrowthLimiter.StoreFull
          : worst === lightF
            ? GrowthLimiter.Light
            : worst === co2F
              ? GrowthLimiter.Air
              : worst === waterF
                ? GrowthLimiter.Water
                : GrowthLimiter.Warmth;
      limiterTally[P.plantId[n]][which]++;
    }
    if (rate <= 0) continue;
    leafRate[n] = rate;
    co2Need += rate * ps.co2PpmPerUnit;
  }
  if (limiterTally) {
    w.plants.forEach((plant, id) => {
      const tally = limiterTally[id];
      let best = GrowthLimiter.None;
      let bestN = 0;
      for (let k = 1; k < tally.length; k++) {
        if (tally[k] > bestN) {
          bestN = tally[k];
          best = k as GrowthLimiter;
        }
      }
      // A leafless plant tallies nothing, and `None` is the honest answer there: it has no
      // photosynthesis to be limiting.
      plant.limiter = best;
    });
  }

  // Never drive CO2 below the stall floor in a single tick; the stall is a soft brake, not a cliff.
  const co2Budget = Math.max(0, co2 - w.cfg.raw.atmosphere.co2.stallBelowPpm * 0.5);
  const co2Scale = co2Need > co2Budget && co2Need > 0 ? co2Budget / co2Need : 1;

  const stalled = co2 < w.cfg.raw.atmosphere.co2.stallBelowPpm;
  w.co2Stalled = stalled;
  for (let n = 0; n < P.count; n++) {
    const rate = leafRate[n] * co2Scale;
    if (rate <= 0) continue;
    const spn = sp[P.plantId[n]];
    const ps = spn.raw.photosynthesis;
    const used = Math.min(P.water[n], rate * ps.waterPerUnit);
    P.water[n] -= used;
    // Water fixed into sugar leaves the liquid pool; transpiration accounts for the rest.
    w.delta.waterMl += used;
    P.sugar[n] += rate;
    w.delta.co2Ppm -= rate * ps.co2PpmPerUnit;
    w.delta.o2Pct += rate * ps.o2PctPerUnit;
    // CO2 STALL, not death: the meter freezes and the plant waits. Legible and fixable.
    if (!stalled) P.growth[n] += rate * spn.raw.growth.meterPerSugar;
  }

  // --- Maintenance, health and the growth gate, per plant.
  for (const plant of w.plants) {
    if (plant.stage === 'dead') continue;
    const c = speciesOf(w, plant).raw;
    const ps = c.photosynthesis;
    const heat = tempF[plant.id];
    let live = 0;
    let roots = 0;
    let leaves = 0;
    let healthyRoots = 0;
    let stressSum = 0;
    let stressed = 0;

    for (const n of plant.nodeIds) {
      if (!P.alive[n]) continue;
      live++;
      if (P.kind[n] === NodeKind.Root) {
        roots++;
        // "Healthy" for the emergency-recovery check below: anchored in soil it can actually draw
        // from, and not currently going without water. A root sitting in gravel or in dry soil
        // should not quietly heal the plant — the player still has to fix that first.
        if (checkAnchor(P, n, g) === 'ok' && P.starve[n] === 0) healthyRoots++;
      }
      if (P.kind[n] === NodeKind.Leaf) leaves++;
    }
    plant.rootCount = roots;
    plant.leafCount = leaves;
    plant.liveNodes = live;
    if (live > plant.peakNodes) plant.peakNodes = live;
    plant.co2Stalled = stalled;

    // Every node pays rent every tick, including at night. This is what bounds plant size by
    // throughput and turns over-growth into a genuine failure mode rather than a runaway.
    const crown = plant.crown;
    // Respire only what the plant ACTUALLY has to burn.
    //
    // Charging the full bill and then clamping the balance at the starvation floor invents sugar out
    // of nothing every tick a plant is in deficit — and since respiration releases CO2, that invented
    // sugar becomes invented carbon. In a crowded jar where several plants sit at the floor, the air
    // then climbs steadily with no source anyone can point to.
    const want = c.maintenance.sugarPerNodePerMin * live * w.cfg.dt;
    const canPay = Math.max(0, P.sugar[crown] - c.maintenance.starvationDebt);
    const respired = Math.min(want, canPay);
    P.sugar[crown] -= respired;

    // Respiration is the return half of the carbon loop: it gives back CO2 and consumes O2.
    w.delta.co2Ppm += respired * c.maintenance.co2PpmPerRespiredSugar;
    w.delta.o2Pct -= respired * c.maintenance.o2PctPerRespiredSugar;

    // EMERGENCY RECOVERY. Only leaves photosynthesize, so a plant that loses its last leaf while
    // sitting at the starvation floor has no income and can never earn back the sugar a new leaf
    // costs — a permanent dead end no amount of watering afterward can fix, which contradicts the
    // entire point of the resprout mechanic below. Healthy roots trickle in a minimal emergency
    // photosynthesis instead, gated on the player having actually fixed the water problem (see
    // `healthyRoots` above), so the failure stays real but stops being unrecoverable.
    //
    // Drawn from the air via the same CO2/O2 exchange as ordinary photosynthesis, not invented —
    // sugar carries carbon in the closed-system audit, and free sugar would be exactly the leak that
    // audit exists to catch.
    if (leaves === 0 && healthyRoots > 0) {
      const gain = healthyRoots * c.maintenance.emergencyRecoveryPerHealthyRootPerMin * w.cfg.dt;
      P.sugar[crown] += gain;
      w.delta.co2Ppm -= gain * ps.co2PpmPerUnit;
      w.delta.o2Pct += gain * ps.o2PctPerUnit;
    }

    const sugarCeiling = live * c.maintenance.maxStoredSugarPerNode;
    if (P.sugar[crown] > sugarCeiling) P.sugar[crown] = sugarCeiling;
    // Starvation stress scales with how deep the debt runs. A flat penalty the moment sugar dips below
    // zero slams every node at once, which turns one lean night into a plant-wide health collapse.
    const starveStress =
      P.sugar[crown] < 0
        ? Math.min(1, P.sugar[crown] / c.maintenance.starvationDebt) * c.health.starvationStress
        : 0;

    // Pesticide residue wears off steadily, and only the part above the safe level does any harm —
    // so one spray is free, and the warning a player gets is the plant yellowing, not a sudden death.
    const pz = w.cfg.raw.pesticide;
    plant.pesticide = Math.max(0, plant.pesticide - (pz.decayPerDay / w.cfg.raw.time.dayLengthSimMinutes) * w.cfg.dt);
    const poisoned =
      Math.max(0, Math.min(1, (plant.pesticide - pz.safeResidue) / (pz.lethalResidue - pz.safeResidue))) *
      pz.maxStress;

    let distressSum = 0;
    // Diagnosis, not simulation. Every `stress +=` below is mirrored into a named bucket so the game
    // can tell the player WHICH problem this plant has; nothing in the tick ever reads these back.
    const by = plant.stressBy;
    by.fill(0);
    for (const n of plant.nodeIds) {
      if (!P.alive[n] || P.spawnTick[n] === born) continue;
      let stress = 0;
      let ageing = 0;
      const h = c.health;
      /** Charge a stress contribution to both the total and its cause. */
      const hurt = (cause: StressCause, amount: number): void => {
        stress += amount;
        by[cause] += amount;
      };

      if (P.kind[n] === NodeKind.Leaf || P.kind[n] === NodeKind.Flower) {
        const deficit = 1 - Math.min(1, P.water[n] / ps.leafWaterNeed);
        hurt(StressCause.Thirst, deficit * h.dehydrationStress);
        hurt(StressCause.Heat, (1 - heat) * h.heatStress);
        // Old age. A leaf past its lifespan yellows and eventually falls even in a perfect jar, which
        // is what keeps litter arriving for the decomposers to work on. Blooms fade the same way.
        const age = (w.tickCount - P.spawnTick[n]) * w.cfg.dt;
        const span =
          P.lifespan[n] ||
          (P.kind[n] === NodeKind.Flower ? c.growth.flowerLifespanMinutes : h.leafLifespanMinutes);
        if (age > span) {
          // Tracked separately: old age costs the leaf its health, but it is not a fault in the jar.
          ageing = Math.min(1, (age - span) / span) * h.senescenceStress;
          hurt(StressCause.Age, ageing);
        }
        // Sap-suckers. Additive like everything else, which is the point: a colony is survivable on
        // its own and becomes the thing that tips an already-struggling leaf over.
        //
        // Only the load ABOVE the dormant level hurts. A dormant colony is a stowaway, not a problem:
        // charging for it would levy a small permanent tax on every plant the player ever bought, and
        // quietly hold back flowering in a jar with nothing wrong in it.
        const pc = w.cfg.raw.pests;
        const active = P.pests[n] - pc.dormantCap;
        // Scaled by entrenchment: the same colony costs the plant more the longer it has been left.
        if (active > 0) {
          const dug = 1 + pc.entrenchedDamage * entrenchmentOf(w, plant);
          hurt(StressCause.Pests, (active / (1 - pc.dormantCap)) * pc.damage * dug);
        }
      }
      if (P.kind[n] === NodeKind.Root) {
        const i = g.idx(P.cellX[n], P.cellY[n]);
        if (g.saturation(i) > w.cfg.raw.water.rootRotSaturation) hurt(StressCause.Rot, h.rotStress);
        // Scaled by how long it has gone without a drink, so a single thin tick is not a crisis.
        if (P.starve[n] > 0) {
          const want = Math.min(1, P.starve[n] / c.uptake.starveTicksBeforeReanchor);
          hurt(StressCause.Thirst, want * h.dehydrationStress);
        }
        // Decay byproducts the charcoal failed to catch. Scaled above a tolerance, so a trace is
        // harmless and only a genuinely sour root zone bites.
        const dcy = w.cfg.raw.decay;
        if (g.toxin[i] > dcy.rootToxinTolerance) {
          hurt(StressCause.Toxins, (g.toxin[i] - dcy.rootToxinTolerance) * dcy.rootToxinDamage);
        }
        // Mold only bites once it has genuinely colonised the cell: fuzz on the surface is cosmetic
        // pressure, and the player gets to see it well before it costs them anything.
        const mold = w.cfg.raw.mold;
        if (g.mold[i] > mold.damageThreshold) {
          hurt(StressCause.Mold, (g.mold[i] - mold.damageThreshold) * mold.damagePerMin * 20);
        }
      }
      hurt(StressCause.Starvation, starveStress);
      if (poisoned > 0) hurt(StressCause.Pesticide, poisoned);

      /*
       * A finished jar eases its plants, and that is what greens their leaves.
       *
       * Leaf colour comes straight from node health, so relieving stress here does the colouring for
       * free and keeps the picture honest: the leaves are greener because the plants genuinely are
       * better off, not because a different palette was swapped in for the ending.
       *
       * Ageing is subtracted out and added back, so senescence is untouched. Old leaves must still
       * yellow and drop in a finished jar — they are what keeps litter arriving for the decomposers,
       * and a climax that froze that would quietly stop the carbon loop it depends on.
       */
      if (w.phase === 'climax') stress = ageing + (stress - ageing) * w.cfg.raw.climax.settledStress;
      stress = Math.min(1, stress);
      stressSum += stress;
      distressSum += Math.min(1, Math.max(0, stress - ageing));
      stressed++;

      // Health EASES toward its target and never snaps. Damage is faster than recovery, but both
      // take 10-20 ticks — which is the player's window to notice and act, and the reason a rescue
      // reads as a rescue.
      const target = 1 - stress;
      const ease = target < P.health[n] ? h.damageEase : h.recoveryEase;
      P.health[n] += (target - P.health[n]) * ease;
      P.health[n] = Math.max(0, Math.min(1, P.health[n]));
    }

    plant.stress = stressed > 0 ? stressSum / stressed : 0;
    plant.distress = stressed > 0 ? distressSum / stressed : 0;
    // Same divisor as the totals above, so a cause reads on the same scale as the distress figure
    // it is being shown beside and the parts visibly add up to the whole.
    if (stressed > 0) for (let k = 0; k < by.length; k++) by[k] /= stressed;
    else by.fill(0);
    // The calm counter drains three times as fast as it fills, so flowering rewards a jar that has
    // genuinely been left in balance rather than one that touched the right numbers briefly. It reads
    // DISTRESS, not stress: a plant should not be denied flowering for the crime of having old leaves.
    if (plant.distress <= c.growth.flowerMaxStress) plant.calmMinutes += w.cfg.dt;
    else plant.calmMinutes = Math.max(0, plant.calmMinutes - w.cfg.dt * 3);
    if (plant.stage === 'seedling' && live >= 5) plant.stage = 'vegetative';

    // A seedling that cannot establish has a very specific signature, and it is NOT "no leaves": the
    // emergency trickle lets it sprout a leaf, starve, drop it, and sprout another one, forever. It
    // is alive by every local measure while never getting anywhere, and left alone it sits at three
    // nodes for the rest of the session holding pool slots.
    //
    // So the test is a STALL, not a wound: still seedling-sized, never past its own high-water mark,
    // and never out of sugar debt. Like the calm counter this drains faster than it fills, so a
    // seedling that is merely slow keeps resetting its clock while one that is genuinely stuck does
    // not. Deliberately scoped to seedlings — a mature plant collapsing to two nodes is the rescue
    // case, and killing that off would take away the best comeback in the game.
    const stalledSeedling = live <= plant.peakNodes && P.sugar[plant.crown] <= 0;
    if (plant.stage === 'seedling' && stalledSeedling) plant.barrenMinutes += w.cfg.dt;
    else plant.barrenMinutes = Math.max(0, plant.barrenMinutes - w.cfg.dt * 3);

    if (leaves === 0 && roots === 0) plant.stage = 'dead';
    else if (plant.barrenMinutes >= c.reproduction.failToEstablishMinutes) {
      // Everything the plant was made of becomes litter on the surface it grew from, so a failed
      // seedling feeds the springtails instead of evaporating out of the carbon books.
      w.atmo.airWaterMl += P.retirePlant(plant.nodeIds, g, w.cfg.raw.decay.leafLitterMass);
      plant.liveNodes = 0;
      plant.rootCount = 0;
      plant.leafCount = 0;
      plant.stage = 'dead';
    }
    // "Dying" means something is wrong, not that the plant has old leaves on it.
    else if (plant.distress > 0.6) plant.stage = 'dying';
    else if (plant.stage === 'dying') plant.stage = 'vegetative';
    else if (plant.flowers > 0 && plant.stage === 'vegetative') plant.stage = 'flowering';
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 7 — surface ecology (mold before fauna; both land in M7-M9)
// ---------------------------------------------------------------------------------------------

/**
 * Mold grows and spreads BEFORE the springtails that eat it, so the player watches fuzz appear and a
 * swarm converge on it within one tick. The reverse order gives the decomposers a stale world and
 * makes mold flicker on and off without the cleanup ever being visible.
 */
function surfaceEcology(w: World): void {
  // Moss runs FIRST because mold reads its coverage to work out how much of the damp surface is
  // already taken. Running it after would have mold competing against last tick's mat.
  w.moss.step(w.cfg, w.grid, w.light, w.atmo, w.delta, w.rng);
  stepMold(w);
  decayLitter(w);
  w.fauna.step(w.cfg, w.grid, w.atmo, w.delta, w.rng);
  w.faunaPopulation = w.fauna.total();
  filterToxins(w);
  stepPests(w);
}

/**
 * Sap-sucking pests: each colony grows toward what its host will bear, and crosses wherever foliage
 * touches.
 *
 * The host decides the ceiling. A healthy plant holds its colonies down to `dormantCap`, which is
 * below `visibleAt` — the stowaways every bought seed carries are there, and unseen. Once the host is
 * struggling the ceiling climbs toward a full infestation, so pests arrive as a CONSEQUENCE of a jar
 * going wrong rather than as a dice roll, which is what makes them fair.
 *
 * The ceiling reads the host's distress with the pests' own share taken OUT. Left in, a colony would
 * raise the distress that raises its own ceiling, and every infestation would run away no matter what
 * the player fixed.
 *
 * Deliberately draws nothing from the RNG. Spread is a deterministic flow between touching leaves, so
 * adding pests does not shift the random sequence every other system in the jar depends on.
 */
function stepPests(w: World): void {
  const c = w.cfg.raw.pests;
  if (w.tickCount % c.stepEveryTicks !== 0) return;
  const P = w.pool;
  const g = w.grid;
  const dt = w.cfg.dt * c.stepEveryTicks;
  const { pestHead: head, pestNext: next, pestInflow: inflow } = w.scratch;
  const cellOf = (n: number): number => {
    const x = Math.max(0, Math.min(g.w - 1, Math.floor(P.x[n])));
    const y = Math.max(0, Math.min(g.h - 1, Math.floor(P.y[n])));
    return g.idx(x, y);
  };

  // --- Bucket every live leaf by cell, so "who is touching whom" costs a neighbourhood, not all pairs.
  head.fill(-1);
  let any = false;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
    const cell = cellOf(n);
    next[n] = head[cell];
    head[cell] = n;
    inflow[n] = 0;
    if (P.pests[n] > 0) any = true;
  }
  // A plant whose canopy collapsed has no infested leaf but DOES have a colony waiting in its
  // reservoir, and that reservoir reseeds below. Leaving it out of this early-out is what stopped a
  // waiting colony from ever coming back: the step returned before it could.
  if (!any && !w.plants.some((p) => p.stage !== 'dead' && p.pestReservoir > 0)) {
    w.pestCoverage = 0;
    return;
  }

  // --- Spread. Accumulated into `inflow` and applied afterwards, so visiting order cannot matter.
  const reach = Math.ceil(c.contactRadius);
  const r2 = c.contactRadius * c.contactRadius;
  for (let a = 0; a < P.count; a++) {
    if (!P.alive[a] || P.kind[a] !== NodeKind.Leaf || P.pests[a] <= 0) continue;
    const from = w.plants[P.plantId[a]];
    const give =
      c.spreadPerMin * P.pests[a] * dt * (1 + (from ? c.entrenchedSpread * entrenchmentOf(w, from) : 0));
    const ax = Math.floor(P.x[a]);
    const ay = Math.floor(P.y[a]);
    for (let dy = -reach; dy <= reach; dy++) {
      const y = ay + dy;
      if (y < 0 || y >= g.h) continue;
      for (let dx = -reach; dx <= reach; dx++) {
        const x = ax + dx;
        if (x < 0 || x >= g.w) continue;
        for (let b = head[g.idx(x, y)]; b >= 0; b = next[b]) {
          if (b === a) continue;
          const ddx = P.x[b] - P.x[a];
          const ddy = P.y[b] - P.y[a];
          if (ddx * ddx + ddy * ddy <= r2) inflow[b] += give;
        }
      }
    }
  }

  // --- Growth toward each host's ceiling.
  let leaves = 0;
  let visible = 0;
  for (const plant of w.plants) {
    if (plant.stage === 'dead') continue;
    /*
     * The spark.
     *
     * `pestCeiling` reports the dormant cap for a sleeping colony, so the question "would this host
     * bear an outbreak" has to be asked with the plant temporarily treated as awake. One roll per step
     * while the answer is yes: a geometric wait, which is what makes the timing differ between jars and
     * between one immunity lapsing and the next.
     */
    /*
     * An open lid is how pests USUALLY get in, but a shut one is not a wall.
     *
     * Venting — the answer to fog, heat and stale air — carries the real risk, at `ignitionPerDay`. A
     * sealed jar still rolls, at a small fraction of it, so keeping the lid on is the safe way to keep
     * a terrarium rather than a guarantee about it.
     *
     * Only the START is affected either way. An outbreak already under way carries on after the lid is
     * shut, or closing it would be an instant cure and there would be nothing to play.
     */
    if (!plant.pestAwake) {
      plant.pestAwake = true;
      const couldBear = pestCeiling(w, plant) > c.visibleAt;
      plant.pestAwake = false;
      const rate = c.ignitionPerDay * (w.atmo.lidOpen ? 1 : c.sealedIgnitionFactor);
      if (couldBear && w.rng.next() < rate * (dt / w.cfg.raw.time.dayLengthSimMinutes)) {
        plant.pestAwake = true;
      }
    }
    // AFTER the spark, so a colony that catches this step grows this step rather than next.
    const cap = pestCeiling(w, plant);

    /*
     * A colony waiting out a lost canopy. It reseeds the first leaves to come back — at the dormant
     * level, so the plant is not instantly overrun again, but with something there to grow from.
     */
    if (plant.pestReservoir > 0) {
      const fresh: number[] = [];
      for (const n of plant.nodeIds) {
        if (P.alive[n] && P.kind[n] === NodeKind.Leaf && P.pests[n] <= 0) fresh.push(n);
      }
      if (fresh.length > 0) {
        for (const n of fresh) P.pests[n] = c.dormantCap;
        plant.pestReservoir = 0;
      } else {
        plant.pestReservoir = Math.max(
          0,
          plant.pestReservoir - dt / (c.reservoirDays * w.cfg.raw.time.dayLengthSimMinutes),
        );
      }
    }

    let seen = false;
    for (const n of plant.nodeIds) {
      if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
      leaves++;
      /*
       * Arrivals can colonise a leaf UP TO its host's ceiling, never past it.
       *
       * This is what makes the ceiling a ceiling. Adding spread on top unconditionally let a canopy
       * infest itself: a leaf sits within reach of about ten of its own plant's others, so it took in
       * roughly five times what the decline term could remove, and a perfectly healthy jar went 100%
       * infested in two days. Spread decides WHERE pests get to; the host still decides how many.
       */
      let load = P.pests[n];
      if (inflow[n] > 0 && load < cap) load = Math.min(cap, load + inflow[n]);
      if (load < 1e-4) {
        // Float dust, not a colony. Zeroing it keeps a clean leaf genuinely clean.
        load = 0;
      } else if (load < cap) {
        // Logistic, clamped so a large step can never overshoot the ceiling it is approaching.
        load = Math.min(cap, load + c.growthPerMin * load * (1 - load / cap) * dt);
      } else {
        // Relaxation rather than the logistic term above: with a dormant ceiling the logistic decline
        // is steep enough to overshoot straight through zero in one step.
        load += (cap - load) * Math.min(1, c.declinePerMin * dt);
      }
      P.pests[n] = Math.min(1, load);
      if (P.pests[n] >= c.visibleAt) {
        visible++;
        seen = true;
      }
    }
    /*
     * A NEW outbreak, announced once.
     *
     * The test is that the counter had run all the way back to zero, so a colony that dips out of sight
     * for a step and returns is the same outbreak and says nothing. Emitted before the counter moves,
     * because moving it is what destroys the evidence.
     */
    if (seen && plant.infestedMinutes === 0) w.events.push({ t: 'infested', plant: plant.id });
    /*
     * Back to sleep, needing a fresh spark before it can take off again.
     *
     * The test is that the HOST has stopped allowing an outbreak — immunity, or a plant in good enough
     * condition to hold its colony at the dormant level — and that the colony has actually fallen back
     * to it. Testing "not currently visible" instead put a colony straight back to sleep on the step it
     * caught, since it takes a day to grow from dormant to visible: nothing ever ignited at all.
     */
    if (plant.pestAwake && cap <= c.dormantCap + 1e-6 && !seen) plant.pestAwake = false;
    // Counted per PLANT and only while its pests are actually showing, so knocking a colony out of
    // sight — by pruning, by spraying, or by the host recovering — starts the clock running back.
    plant.infestedMinutes = Math.max(
      0,
      plant.infestedMinutes + (seen ? dt : -dt * c.entrenchRelapseFactor),
    );
  }
  w.pestCoverage = leaves > 0 ? visible / leaves : 0;

  preyOnSpringtails(w, dt);
}

/**
 * Pests hunt the springtails in the soil beneath the plants they infest.
 *
 * Only ACTIVE pests hunt — the load above the dormant level. A healthy jar's stowaways are there but
 * eat nothing, so predation arrives exactly when an outbreak does, and an outbreak costs the jar its
 * decomposers on top of its leaves. That is the compounding the hazard design wants: litter piles up,
 * nutrients stop cycling, and the plants the pests are already weakening start to starve as well.
 *
 * Never below the springtails' dormant floor, for the same reason starvation stops there. A colony at
 * zero can never breed back, so letting predation reach it would turn a recoverable outbreak into the
 * permanent loss of the jar's carbon loop. Clear the pests, and the springtails recover on their own.
 */
/**
 * Pests crawling off a leaf that is about to fall, onto the rest of their plant.
 *
 * Only on a NATURAL drop. Pruning goes through `killSubtree` and never comes past here, so cutting an
 * infested branch still takes its colony out of the jar — which is what keeps pruning a cure while
 * neglect is not.
 *
 * Without it, a colony that damaged its host badly enough to shed leaves died with the leaves it had
 * killed, and the plant regrew clean with nothing left to recolonise it. Ignoring pests long enough
 * cured them, which is the opposite of what leaving a problem alone should do.
 *
 * Shared out across the plant's other live leaves, which is both what sap-suckers do and what keeps
 * the colony from concentrating into one leaf and dropping that one next.
 */
function migratePests(w: World, leaf: number): void {
  const P = w.pool;
  const moving = P.pests[leaf] * w.cfg.raw.pests.migrateOnDropFraction;
  if (moving <= 0) return;
  const plant = w.plants[P.plantId[leaf]];
  if (!plant) return;
  const hosts: number[] = [];
  for (const n of plant.nodeIds) {
    if (n !== leaf && P.alive[n] && P.kind[n] === NodeKind.Leaf) hosts.push(n);
  }
  if (hosts.length === 0) {
    // The last leaf. The colony has nowhere to sit, so it waits for the canopy to come back.
    plant.pestReservoir += moving;
    return;
  }
  /*
   * Arrivals fill a leaf UP TO what the host will bear and never pull it down — the same rule spread
   * follows, and for the same reason.
   *
   * Capping with a bare `min` was catastrophic rather than merely wrong: one leaf falling off a healthy
   * plant clamped every other leaf on it to the dormant level, so a jar-wide outbreak vanished in under
   * an hour the moment a single leaf dropped. A ceiling limits what a colony can GROW to; it is not a
   * value to be assigned to whatever is already there.
   */
  const ceiling = pestCeiling(w, plant);
  const each = moving / hosts.length;
  for (const n of hosts) {
    if (P.pests[n] < ceiling) P.pests[n] = Math.min(ceiling, P.pests[n] + each);
  }
}

/**
 * The most this plant's leaves will carry: dormant on a healthy young host, up toward a full
 * infestation on one that is struggling, old, or has had a colony on it long enough for it to dig in.
 *
 * Everything is derived HERE, from the plant itself, so no two callers can disagree about what a plant
 * will bear. Migration used to call this without the host's condition and so clamped arriving pests to
 * the dormant level even on a starving plant — which did not move a colony, it deleted it.
 *
 * A completed pesticide course overrides everything and holds the ceiling at DORMANT rather than zero.
 * Zero would leave no colony to come back when the immunity ends, and a colony that can never return is
 * not immunity running out, it is a permanent cure.
 *
 * The entrenched floor is SQUARED so it stays out of the way early. A linear ramp crossed `visibleAt`
 * after about twenty hours, which is faster than a healthy host can push a colony out of sight (~1.1
 * days) — so any infestation at all became permanent and "fix the plant and it recovers" stopped being
 * true the moment pests appeared. Squared, the floor is still under a fortieth of the way at a day,
 * and the race goes the right way: catch it promptly and the plant shakes it off; leave it and the
 * colony stops caring how healthy the plant is.
 */
function pestCeiling(w: World, plant: Plant): number {
  const c = w.cfg.raw.pests;
  // Nothing at all, not even a dormant colony: a plant that has come through an infestation is done
  // with them. Whatever load it still carries relaxes to zero and no arrival can seat itself.
  if (plant.pestImmune) return 0;
  // Conditions can be perfect and the colony still not have caught. Until it does, it sits dormant.
  if (!plant.pestAwake) return c.dormantCap;
  // The host's own trouble, with the pests' own share taken out: a colony must never raise the
  // distress that raises its own ceiling.
  const own = Math.max(0, plant.distress - plant.stressBy[StressCause.Pests]);
  const flare = Math.max(0, Math.min(1, (own - c.flareDistress * plant.pestVigour) / c.flareSpan));
  /*
   * Age. Only ever matters to a plant already CARRYING a colony — the logistic term grows nothing from
   * zero — so it is the player's own plants that age into trouble, never the jar's clean seedlings.
   */
  const ageDays =
    ((w.tickCount - w.pool.spawnTick[plant.crown]) * w.cfg.dt) / w.cfg.raw.time.dayLengthSimMinutes;
  const aged =
    Math.max(0, Math.min(1, (ageDays - c.resistantDays * plant.pestVigour) / c.resistanceFadeDays)) *
    c.agedCap;
  const dug = entrenchmentOf(w, plant);
  return c.dormantCap + (1 - c.dormantCap) * Math.max(flare, aged, dug * dug * c.entrenchedCap);
}

/** How dug-in this plant's colony is, 0 to 1. Shared by the ceiling, the damage and the spread. */
export function entrenchmentOf(w: World, plant: Plant): number {
  const c = w.cfg.raw.pests;
  const full = c.entrenchDays * w.cfg.raw.time.dayLengthSimMinutes;
  return Math.max(0, Math.min(1, plant.infestedMinutes / Math.max(1, full)));
}

function preyOnSpringtails(w: World, dt: number): void {
  const c = w.cfg.raw.pests;
  const P = w.pool;
  const g = w.grid;
  const col = w.scratch.pestColumn;
  col.fill(0);
  let any = false;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Leaf) continue;
    const active = P.pests[n] - c.dormantCap;
    if (active <= 0) continue;
    col[Math.max(0, Math.min(g.w - 1, Math.floor(P.x[n])))] += active;
    any = true;
  }
  if (!any) return;

  const floor = w.cfg.raw.fauna.springtail.dormantFloor;
  for (let x = 0; x < g.w; x++) {
    if (col[x] <= 0) continue;
    const surface = g.surfaceOfColumn[x];
    if (surface < 0) continue;
    const eaten = Math.min(1, c.predationPerMin * col[x] * dt);
    // The litter horizon: the surface cell, where springtails feed, and the one below it.
    for (const i of [surface, surface + g.w]) {
      if (i >= g.size) continue;
      const pop = w.fauna.pop[i];
      if (pop <= floor) continue;
      w.fauna.pop[i] = Math.max(floor, pop * (1 - eaten));
    }
  }
}

/**
 * Mold growth and spread.
 *
 * Three dampeners keep this from being the runaway it naturally wants to be:
 *  - it EATS litter as it grows, so a bloom exhausts its own food and crashes;
 *  - it needs a sustained dwell above both humidity and wetness thresholds, so a brief spike after a
 *    watering cannot start an outbreak;
 *  - unsaturated charcoal suppresses spawning jar-wide, which gives that layer a visible job and the
 *    player a specific thing to replace.
 *
 * Runs BEFORE the springtails, so the fuzz appearing and the swarm arriving to graze it resolve in the
 * same tick and read left-to-right.
 */
function stepMold(w: World): void {
  const g = w.grid;
  const c = w.cfg.raw.mold;
  const dt = w.cfg.dt;
  // "Mold weather" is the condensation latch itself, not a humidity number.
  //
  // Once condensation engages it actively holds humidity down near its release threshold, so any
  // threshold set above the band is unreachable and any threshold set inside it is a magic number
  // sitting one point away from doing nothing. The latch says precisely the thing that matters, in the
  // same terms the player sees on the glass: the jar has been fogging.
  const fogged = w.atmo.fogged;

  // A single global dwell counter: humidity is a jar-wide quantity, so "has it been muggy long enough"
  // has one answer for the whole terrarium. It drains at twice the rate it fills, so airing the jar
  // out buys back the clock quickly.
  if (fogged) w.moldDwell = Math.min(c.dwellMinutes, w.moldDwell + dt);
  else w.moldDwell = Math.max(0, w.moldDwell - dt * 2);
  const spawning = w.moldDwell >= c.dwellMinutes;

  // Charcoal only suppresses while it still has capacity to adsorb. As it loads up with toxins it
  // stops protecting the jar, which is the feedback channel the layer was missing.
  const suppression = c.charcoalSuppression * w.charcoalCapacity();
  const growth = c.growthPerMin * dt * (1 - suppression);

  let covered = 0;
  for (const i of g.activeCells) {
    const wet = g.wetness(i);
    let m = g.mold[i];

    // Moss holds the same damp, lit surface mold wants, so a mat crowds it out. This is the second
    // reason to cultivate moss, and the one the player actually sees happen.
    const mossHere = 1 - w.cfg.raw.moss.moldSuppression * w.moss.cover[i];

    if (m > 0 || (spawning && wet >= c.spawnWetness && g.organic[i] >= c.requiresOrganic)) {
      if (wet >= c.spawnWetness * 0.85 && g.organic[i] > 0 && growth > 0) {
        // Growth is capped by the litter available to fuel it — the self-limiting term.
        const want = growth * mossHere * (1 - m);
        const fuel = Math.min(g.organic[i], want * c.organicPerGrowth);
        const grew = fuel / c.organicPerGrowth;
        g.organic[i] -= fuel;
        m = Math.min(1, m + grew);
      }
    }

    // Drying out is the counter the player controls directly, by venting the lid or warming the jar.
    if (!fogged || wet < c.spawnWetness * 0.8) {
      m = Math.max(0, m - c.diebackPerMin * dt);
    }

    // A moss mat physically occupies the surface, so it caps how far mold can take the cell rather
    // than merely slowing it down. Without a ceiling, a permanently fogged jar saturates every cell
    // eventually no matter how much moss is there — suppression that only scales the rate buys time
    // and nothing else, which is not what "crowds it out" should mean.
    const ceiling = 1 - w.cfg.raw.moss.moldSuppression * w.moss.cover[i];
    if (m > ceiling) m = Math.max(ceiling, m - c.diebackPerMin * dt);

    g.mold[i] = m;
    if (m > 0.01) covered++;
  }

  // Spread to wet neighbours that have something to eat.
  if (spawning) {
    const chance = c.spreadPerMin * dt * (1 - suppression);
    for (const i of g.activeCells) {
      if (g.mold[i] < 0.3 || !w.rng.chance(chance)) continue;
      for (const n of [i - 1, i + 1, i - g.w, i + g.w]) {
        if (g.props(n).maxMl <= 0) continue;
        if (g.organic[n] < c.requiresOrganic || g.wetness(n) < c.spawnWetness * 0.85) continue;
        // A well-covered neighbour resists colonisation outright.
        if (w.moss.cover[n] >= 0.5) continue;
        g.mold[n] = Math.max(g.mold[n], 0.05);
      }
    }
  }

  /*
   * Measured against the cells mold could actually TAKE, not against every cell in the jar.
   *
   * Mold needs litter, and litter only ever lands on a column's exposed surface — so it is confined to
   * that one row. Dividing by every active cell, gravel and buried soil included, meant a completely
   * overrun jar read about 6%: `swampy`, which exists to prove mold can take a terrarium, topped out at
   * 6.3%. A player watching a quarter of their surface go furry saw "mold 1.5%" and reasonably
   * concluded nothing was happening.
   *
   * Against the hostable row the same jar reads near 100%, which is what it looks like.
   */
  let hostable = 0;
  for (let x = 1; x <= g.w - 2; x++) if (g.surfaceOfColumn[x] >= 0) hostable++;
  w.moldCoverage = hostable > 0 ? Math.min(1, covered / hostable) : 0;
}

/**
 * Litter breaks down on its own, slowly, by microbial action — the floor under whatever the
 * springtails do on top of it, so a jar with no fauna still cycles, just far worse.
 *
 * Nutrients come back at well under 100%. That deficit is the single most important number in the
 * game's economy: a perfectly conserved loop settles into a screensaver, whereas a slow drain means
 * every jar runs downhill and every player action is a top-up against that clock.
 */
function decayLitter(w: World): void {
  const g = w.grid;
  const c = w.cfg.raw.decay;
  const dt = w.cfg.dt;

  // Decay is a warm, damp process. Cold or bone-dry substrate preserves litter rather than cycling it.
  const off = (w.atmo.tempC - c.optimalTempC) / c.tempToleranceC;
  const tempF = Math.max(0, 1 - off * off);
  if (tempF <= 0) return;

  for (const i of g.activeCells) {
    const litter = g.organic[i];
    if (litter <= 0) continue;
    const broken = Math.min(litter, c.baseRatePerMin * litter * tempF * g.wetness(i) * dt);
    if (broken <= 0) continue;

    g.organic[i] -= broken;
    g.nutrients[i] = Math.min(c.maxNutrients, g.nutrients[i] + broken * c.nutrientYield);
    g.toxin[i] = Math.min(1, g.toxin[i] + broken * c.toxinPerUnit);
    w.delta.co2Ppm += broken * c.co2PpmPerUnit;
    w.delta.o2Pct -= broken * c.o2PctPerUnit;
  }
}

/**
 * Activated charcoal neutralises the toxins decay leaves behind, in its own cell and its immediate
 * neighbours. This is the layer finally doing the job it was placed for: without it, a jar that
 * cycles enough litter poisons its own root zone.
 */
function filterToxins(w: World): void {
  const g = w.grid;
  const dt = w.cfg.dt;

  /*
   * The band is ONE reservoir, and its strength is the figure the player is shown.
   *
   * Scaling each cell by its OWN load looks more precise and is worse in every way that matters. The
   * top row of a band sits against the soil and does nearly all the adsorbing, so it saturates long
   * before the rows beneath it have taken anything: measured with a per-cell limit, soil toxin spiked
   * to 0.52 while the gauge still read 95%, because the mean was being held up by two clean rows doing
   * nothing. The number on screen said the layer was fine while the only part of it that was working
   * was dead.
   *
   * Driving the rate from the band average instead makes the gauge and the behaviour the same thing:
   * a layer filters at full strength until the band as a whole fills, then fades. The player can
   * believe the readout.
   */
  const bt = w.cfg.raw.decay.charcoalBreakthrough;
  /*
   * Full strength until BREAKTHROUGH, then a fast fade. Not a straight proportion.
   *
   * Scaling the rate by remaining capacity directly is the obvious reading and it produces a filter
   * that can never actually be spent: as the load builds the pull weakens, so less binds, so the load
   * builds slower still. Measured, it simply asymptotes — capacity parked between 68% and 85% forever
   * and toxin settled at a fixed level. That is an equilibrium, not the drift this is for.
   *
   * Real activated carbon holds its efficiency until its surface is nearly used and then breaks
   * through quickly, which is also the behaviour that makes a good game object: a layer you can rely
   * on, that then visibly starts failing and wants replacing.
   */
  const room = Math.min(1, w.charcoalCapacity() / bt);
  if (room <= 0) return;

  for (const i of g.filterCells) {
    const rate = g.props(i).filters;

    /*
     * Charcoal ADSORBS the toxin it pulls. It does not destroy it.
     *
     * This used to subtract from every filtering cell and its neighbours and simply drop the result on
     * the floor, so nothing ever accumulated and the layer lasted forever: measured at a flat 100.0%
     * capacity after 120 sim-days in a jar buried under 2,800 units of litter. That made
     * `World.charcoalCapacity()` a gauge that could not move — and because `stepMold` scales its
     * suppression by that same figure, it silently pinned mold suppression at its maximum too. One
     * self-scrub disabled two systems at once.
     *
     * The REACH is deliberately unchanged from that version, including scrubbing its own cell and
     * reaching every neighbour. An earlier attempt made charcoal skip other charcoal, on the theory
     * that a band should not pass its load along — and it gutted the layer, because in a three-row band
     * most cells have nothing but charcoal around them. Filtering collapsed to the topmost row and soil
     * toxin went from 0.13 to 1.00, well past the 0.3 that damages roots. A charcoal layer has to keep
     * working properly while it has capacity; the change here is that it runs OUT, not that it is weak.
     */
    const pull = rate * dt * room;

    let drawn = Math.min(g.toxin[i], pull);
    g.toxin[i] -= drawn;
    for (const n of [i - 1, i + 1, i - g.w, i + g.w]) {
      if (g.props(n).maxMl <= 0) continue;
      const took = Math.min(g.toxin[n], pull * 0.5);
      g.toxin[n] -= took;
      drawn += took;
    }
    // Bound, not destroyed. This is what eventually spends the layer.
    g.charcoalLoad[i] += drawn;
  }

  /*
   * The band passes its load inward, so the WHOLE layer is used rather than just the face of it.
   *
   * Only the top row of a band ever touches soil, so without this it is the only row that ever binds
   * anything: it saturates, the rows beneath it stay pristine, and the band's capacity parks at
   * 1 - 1/rows forever. Measured on a standard three-row layer it stuck at exactly 69%, which made
   * breakthrough unreachable and the whole maintenance loop impossible to complete.
   *
   * Equalising between neighbouring charcoal is the same thing a real filter bed does as its face
   * loads: what the front can no longer hold moves deeper, and the bed is consumed front to back.
   */
  const share = w.cfg.raw.decay.charcoalShareFraction * dt;
  if (share <= 0) return;
  for (const i of g.filterCells) {
    for (const n of [i + 1, i + g.w]) {
      if (g.props(n).filters <= 0) continue;
      const diff = g.charcoalLoad[i] - g.charcoalLoad[n];
      const move = diff * share * 0.5;
      g.charcoalLoad[i] -= move;
      g.charcoalLoad[n] += move;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 8b — the climax
// ---------------------------------------------------------------------------------------------

/**
 * The jar's ending: it has stopped getting bigger.
 *
 * The obvious test — "CO2 has stalled and every column is taken" — was built first and measured, and
 * it does not fire on a healthy jar. Both halves fail for their own reason. CO2 settles around 820 ppm
 * against a 200 ppm stall floor, because `atmosphere.co2.startPpm` is deliberately generous enough that
 * a well-tended jar never suffocates. And seven seedable columns remain open forever: the jar is not
 * short of ground, it is short of BLOOMS that can afford a seed, so the room simply goes unused.
 *
 * Yet the jar is unmistakably finished — measured on the reference jar, plants plateau at 7 and live
 * nodes at roughly 174 from day 30, and sit there unchanged for seventy sim-days more. So the honest
 * signal is neither of the proxies. It is the plateau itself, which this measures directly: the jar is
 * still growing while it keeps setting new size records, and finished once it stops.
 *
 * `growthMargin` is what makes that robust. A settled jar's node count breathes by several percent
 * forever as leaves senesce and are replaced (170..177 across those seventy days), so a record has to
 * be beaten by a real margin, not by noise. Plant count is tested separately and without a margin,
 * because one new crown is a genuine event that should always restart the clock even though three
 * fresh nodes are lost inside the node-count noise.
 */
function updateClimax(w: World): void {
  // Sampled on the hour: the quantity changes on the timescale of a plant growing, and the verdict
  // has to hold for sim-DAYS before it means anything.
  if (w.tickCount % 60 !== 0) return;
  const c = w.cfg.raw.climax;
  const dt = 60 * w.cfg.dt;
  const day = w.cfg.raw.time.dayLengthSimMinutes;

  let nodes = 0;
  let plants = 0;
  for (const p of w.plants) {
    if (p.stage === 'dead') continue;
    plants++;
    nodes += p.liveNodes;
  }

  /*
   * A jar that has never bloomed cannot be finished, however still it has gone.
   *
   * The plateau test alone cannot tell "grown as far as this jar ever will" from "never got going at
   * all": a jar too dim to build anything sits just as motionless as one that filled its space, and
   * would otherwise be handed the same ending. Flowering is the sim's own marker of a plant that had
   * surplus to spend, so requiring one is what makes the climax an achievement rather than a timeout.
   *
   * Checked before the counter moves, so a barren jar never even accumulates toward it.
   */
  if (!w.everBloomed) {
    w.climaxHold = 0;
    return;
  }

  const grew = nodes > w.climaxBestNodes * (1 + c.growthMargin) || plants > w.climaxBestPlants;
  if (nodes > w.climaxBestNodes) w.climaxBestNodes = nodes;
  if (plants > w.climaxBestPlants) w.climaxBestPlants = plants;

  if (w.phase === 'climax') {
    /*
     * Release watches for the jar being CUT BACK, not for it growing.
     *
     * Growing is impossible in here by construction — the climax caps every plant at its own peak — so
     * a release that waited for new growth would be a deadlock, and was one until it was run. Shrinking
     * past `releaseCut` of the recorded peak is something only pruning does, which makes it exactly the
     * player action this is supposed to answer.
     */
    const cutBack = nodes < w.climaxBestNodes * (1 - c.releaseCut);
    w.climaxRelease = cutBack ? w.climaxRelease + dt : 0;
    if (w.climaxRelease >= c.releaseDays * day) {
      w.phase = 'tend';
      w.climaxHold = 0;
      w.climaxRelease = 0;
      // The record resets to what is actually standing, or the jar would have to regrow all the way
      // back to its old peak before it could ever finish again.
      w.climaxBestNodes = nodes;
      w.climaxBestPlants = plants;
      w.events.push({ t: 'climaxEnded' });
    }
    return;
  }

  w.climaxHold = grew ? 0 : w.climaxHold + dt;
  if (w.climaxHold >= c.holdDays * day) {
    w.phase = 'climax';
    w.climaxRelease = 0;
    w.events.push({ t: 'climaxReached' });
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 8 — structural commit
// ---------------------------------------------------------------------------------------------

/**
 * Topology changes only here. A leaf appended during phase 5's sweep would be visited by that same
 * loop and bank a full tick of photosynthesis at age zero; and any structural edit mid-sweep risks
 * iterating a tree that no longer matches the indices already read.
 */
function structuralCommit(w: World): void {
  const P = w.pool;
  const g = w.grid;

  // Roots whose cell was dug out or repainted. Tiered: air kills, gravel/charcoal only starves.
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    const verdict = checkAnchor(P, n, g);
    if (verdict === 'exposed') {
      w.atmo.airWaterMl += P.killSubtree(n, g, w.cfg.raw.decay.leafLitterMass);
      w.events.push({ t: 'rootSevered', node: n, reason: 'exposed' });
      continue;
    }
    const spn = speciesOfNode(w, n);
    if (verdict === 'barren' && P.starve[n] >= spn.raw.uptake.starveTicksBeforeReanchor) {
      if (w.rng.chance(spn.chance.reanchor)) {
        const spot = bestRootCell(w.cfg, g, P.cellX[n], P.cellY[n], false);
        if (spot) {
          P.anchorRoot(n, g, spot.x, spot.y);
          P.starve[n] = 0;
          w.events.push({ t: 'rootReanchored', node: n });
        }
      }
    }
  }

  // Leaf and flower drop. The node's water returns to the air rather than vanishing from the closed
  // system, and its tissue lands as litter.
  //
  // Flowers fade too. Without that they accumulate as permanent nodes and a well-run jar ends up
  // carrying more blooms than leaves — the score should be the number of times it flowered, not a
  // pile of them stuck to the plant forever.
  /*
   * A root killed by sour soil or mold now actually DIES, instead of lingering at zero.
   *
   * Only leaves and flowers were ever shed, so a root damaged to nothing stayed a live node forever:
   * contributing no uptake, holding its cell, and costing the plant nothing it could notice. Measured
   * under sustained maximum toxin, mean root health fell from 0.997 to 0.068 — every root effectively
   * dead — and the node count barely moved. That is why the hazards had no teeth.
   *
   * Killing the subtree is deliberate and matches how severing already works: what a dead root fed
   * cannot survive it either. The mass returns as litter, so the loss re-enters the jar's loop.
   */
  const rootDieAt = w.cfg.raw.plant.health.rootDieAt;
  const tox = w.cfg.raw.decay.rootToxinTolerance;
  const moldHurts = w.cfg.raw.mold.damageThreshold;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    if (P.health[n] >= rootDieAt) continue;
    /*
     * The GROUND has to be hostile, not merely the root unwell.
     *
     * Health alone is not enough to kill a root, and the difference is a design pillar rather than a
     * nicety: a plant that dried out loses its leaves and runs its roots down to nothing too, and if
     * those roots die it can never drink again once the player waters it. That is precisely the
     * permanent dead end the emergency-sugar trickle exists to prevent, and killing on health alone
     * reintroduced it — `recovers a leafless, sugar-starved plant` failed the moment it went in.
     *
     * Sour soil and mold are different: the cell itself is the problem, watering does not fix it, and
     * a root left in it should be lost.
     *
     * So the hazard has to be lethal ON ITS OWN, not merely present. Stress is additive, and a root
     * that is drowning already carries most of a full load from rot — so "some toxin here" was enough
     * to finish it and have the death attributed to sourness. A jar flooded during a rescue killed its
     * roots at soil barely a fifth of the way past harmless. Measuring the hazard alone keeps the two
     * apart: poisoned ground kills, and neglect plus a trace of sourness does not.
     */
    const i = g.idx(P.cellX[n], P.cellY[n]);
    const bySoil = Math.max(0, g.toxin[i] - tox) * w.cfg.raw.decay.rootToxinDamage;
    const byMold = Math.max(0, g.mold[i] - moldHurts) * w.cfg.raw.mold.damagePerMin * 20;
    if (Math.max(bySoil, byMold) < 1 - rootDieAt) continue;
    w.atmo.airWaterMl += P.killSubtree(n, g, w.cfg.raw.decay.leafLitterMass);
    w.events.push({ t: 'rootSevered', node: n, reason: 'sickened' });
  }

  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n]) continue;
    if (P.kind[n] !== NodeKind.Leaf && P.kind[n] !== NodeKind.Flower) continue;
    if (P.health[n] >= speciesOfNode(w, n).raw.health.dropAt) continue;
    const x = Math.round(P.x[n] - 0.5);
    const surface = g.surfaceOfColumn[x];
    migratePests(w, n);
    w.atmo.airWaterMl += P.release(n, g);
    if (surface >= 0) {
      // Litter: the springtails' food supply, mold's fuel, and the only route by which nutrients
      // locked into biomass ever return to the soil.
      g.organic[surface] += w.cfg.raw.decay.leafLitterMass;
      w.events.push({ t: 'leafDropped', node: n, cell: surface });
    }
  }

  // Growth. The meter says WHERE, the crown's sugar says WHETHER.
  for (const plant of w.plants) {
    if (plant.stage === 'dead') continue;
    const c = speciesOf(w, plant).raw;
    // EXPANDING past the plant's high-water mark demands a night's rent banked on top of the node's
    // own price. REPLACING what it has already lost does not: the structure is already built and paid
    // for, and charging expansion rates to repair a thinning canopy is how a healthy plant starves.
    const replacing = plant.liveNodes < plant.peakNodes;
    const reserve = replacing
      ? 0
      : plant.liveNodes * c.maintenance.sugarPerNodePerMin * c.growth.reserveMinutes;
    const priceOfGrowth = c.growth.sugarCostPerNode + reserve;

    // RESPROUTING, checked BEFORE the "too sick to expand" guards below, because this is recovery
    // rather than expansion. The growth meter lives only on leaves, so a plant that sheds its last
    // leaf has no node left that could ever trigger growth: it would sit on a pile of stored sugar and
    // die with no route back, which is the exact opposite of the legible-recovery promise.
    if (plant.leafCount === 0) {
      if (plant.rootCount > 0 && P.sugar[plant.crown] >= c.growth.sugarCostPerNode && growLeaf(w, plant)) {
        P.sugar[plant.crown] -= c.growth.sugarCostPerNode;
        w.events.push({ t: 'resprouted', plant: plant.id });
      }
      continue;
    }

    if (plant.stage === 'dying') continue;

    /*
     * A finished jar stops EXPANDING. It does not stop living.
     *
     * The first cut of this simply skipped growth in the climax, and that was wrong in a way only
     * running it showed: leaves still age out and drop, so a jar that was supposed to look overgrown
     * slowly went bald behind the rule meant to preserve it. A plant may therefore still rebuild to
     * the size it has already reached — replacing what it sheds — and only net expansion is barred.
     *
     * Everything upstream (water, air, temperature, litter, the springtails) keeps running exactly as
     * before, so the conservation audits stay intact and the meters sit safe because nothing is
     * drawing them down, not because anything is held there.
     */
    if (w.phase === 'climax' && plant.liveNodes >= plant.peakNodes) continue;

    // FLOWERING — the win condition, checked before ordinary growth so a settled plant spends its
    // surplus on a bud rather than on yet another leaf.
    if (tryFlower(w, plant)) continue;

    if (w.co2Stalled) continue;

    // Nutrients are the second currency, and running out of them is its own diagnosis: a plant sitting
    // in bright light with a full sugar store and nothing to build with needs litter recycled, not
    // more light or water.
    if (plant.nutrients < c.growth.nutrientCostPerNode) {
      plant.nutrientStarved = true;
      continue;
    }
    plant.nutrientStarved = false;

    // Snapshot the id list: `grow` appends to it, and a node born this tick must not also grow.
    for (const n of [...plant.nodeIds]) {
      if (!P.alive[n] || P.growth[n] < 1) continue;
      if (P.sugar[plant.crown] < priceOfGrowth) break;
      if (plant.nutrients < c.growth.nutrientCostPerNode) break;
      // The meter is only spent if the growth actually happened. Clearing it unconditionally would
      // leave the plant stalled with a full meter and no explanation the player could see.
      if (!grow(w, plant)) continue;
      P.growth[n] = 0;
      P.sugar[plant.crown] -= c.growth.sugarCostPerNode;
      plant.nutrients -= c.growth.nutrientCostPerNode;
    }
  }
}

/**
 * Sink priority. A plant short of roots invests below ground; otherwise it reaches for light.
 * Two ratios produce readable emergent behaviour with no scripted growth stages.
 */
function grow(w: World, plant: Plant): boolean {
  const P = w.pool;
  const c = speciesOf(w, plant).raw;
  const g = w.grid;
  const ratio = plant.rootCount / Math.max(1, plant.leafCount);

  // Sink priority is roots -> LEAVES -> height, and the middle term is the one that matters most.
  // Leaves are the plant's entire income; a policy that buys height first builds a bare stem column,
  // runs out of sugar, and then starves with a single leaf and no way to pay for another.
  const stems = stemCount(w, plant);
  /*
   * Quota scales with EVERY stem, branches included. Capping it was tried, and was strictly worse.
   *
   * The idea was that branching should change shape without adding canopy, so quota was capped at what
   * an unbranched plant of the same height could carry. Measured, that inverts the economics. An
   * unbranched Herb already reaches the stem ceiling, so the cap handed a branched plant the same leaf
   * quota while it went on paying for the extra stems — and stems are permanent structural nodes with a
   * build cost in sugar and minerals and maintenance forever, where leaves are the only income. Every
   * branch became pure overhead: more carbon locked into wood, none of it earning.
   *
   * In the reference jar the cap took CO2 from 301 ppm to 150 and turned a warning into a hard stall,
   * while node count rose from 150 to 225. Branching has to pay for itself in leaves or not happen.
   */
  const wantsLeaves = plant.leafCount < stems * c.growth.leavesPerStem;

  if (ratio < c.growth.targetRootRatio) {
    const anchor = deepestRoot(w, plant);
    if (anchor < 0) return false;
    if (P.cellY[anchor] - g.yOf(g.surfaceOfColumn[P.cellX[anchor]]) >= c.growth.maxRootDepth) return false;
    const spot = bestRootCell(w.cfg, g, P.cellX[anchor], P.cellY[anchor], true);
    if (!spot) return false;
    const n = P.spawn(NodeKind.Root, plant.id, anchor, spot.x + 0.5, spot.y + 0.5, w.tickCount);
    if (n < 0) {
      w.poolExhausted = true;
      return false;
    }
    P.anchorRoot(n, g, spot.x, spot.y);
    plant.nodeIds.push(n);
    w.events.push({ t: 'nodeSpawned', node: n, kind: NodeKind.Root });
    return true;
  }

  // --- Shoot growth. The stem is a load-bearing column; leaves are terminal and hang off it.
  //
  // Hanging a leaf on the HIGHEST stem with room means new leaves reach the light and shade the older
  // ones below, which is what gives the light field and pruning something to actually decide.
  if (wantsLeaves && growLeaf(w, plant)) return true;

  const tip = highestStem(w, plant);
  if (tip < 0) return false;

  /*
   * A fork spends this step sideways instead of upward: the same spawn, onto a different parent.
   *
   * Tried BEFORE the height test rather than inside it, and that ordering is the point. A plant at its
   * ceiling currently falls through to `growLeaf`, and once every stem is at its leaf quota it stalls
   * with a full growth meter and nowhere to put it. That is exactly the plant that should be throwing a
   * side branch — and in this jar the top rows are unreachable anyway, so width is the only way left to
   * get bigger.
   */
  const fork = branchHost(w, plant, tip);
  const canRise =
    P.y[plant.crown] - P.y[tip] < c.growth.maxShootHeight && P.y[tip] - 1 >= 1.5;
  const host = fork >= 0 ? fork : canRise ? tip : -1;
  if (host >= 0) {
    // PHOTOTROPISM. The new segment goes to whichever of straight-up, up-left or up-right is
    // brightest. This is what finally makes the light field pay for itself: a plant under its own
    // canopy leans out from under it, two plants competing lean apart, and pruning the shaded side
    // visibly changes where the thing grows next.
    const ty = P.y[host] - 1;
    // Sample the openings, then pick at random among any that are within a few percent of the best. An
    // exact-maximum rule sends the stem dead straight up whenever the light is even — which is most of
    // the time in an unshaded jar — and the plant grows as a rigid column. The tolerance keeps
    // phototropism meaningful where light actually differs, and lets the stem wander where it does not,
    // which is both what real stems do and what reads as a plant rather than a mast.
    //
    // A FORK MAY NOT GO STRAIGHT UP. Its host already carries a stem child one row above, so offset 0
    // would spawn the branch on top of the sibling it is branching beside — two nodes at one position,
    // invisible to the eye and counted twice by the light field. That is the same defect that made every
    // third leaf on a stem invisible; it is not being repeated here.
    let bestLight = -1;
    const lights: number[] = [];
    const offsets = fork >= 0 ? [-1, 1] : [0, -1, 1];
    for (const dx of offsets) {
      const light = w.light.at(Math.round(P.x[host] + dx - 0.5), Math.round(ty - 0.5));
      lights.push(light);
      if (light > bestLight) bestLight = light;
    }
    const contenders = offsets.filter((_, k) => lights[k] >= bestLight * 0.97);
    const bestX = P.x[host] + contenders[w.rng.int(contenders.length)];
    const stem = P.spawn(NodeKind.Stem, plant.id, host, bestX, ty, w.tickCount);
    if (stem < 0) {
      w.poolExhausted = true;
      return false;
    }
    plant.nodeIds.push(stem);
    w.events.push({ t: 'nodeSpawned', node: stem, kind: NodeKind.Stem });
    return true;
  }

  // At full height, fill out rather than deadlock with a full meter and no explanation.
  return growLeaf(w, plant);
}

function growLeaf(w: World, plant: Plant): boolean {
  const P = w.pool;
  const host = stemWithLeafRoom(w, plant);
  if (host < 0) return false;

  // Reuse the slot of a leaf that already fell from this stem before appending a new one. Leaf
  // turnover is by far the largest source of churn in the pool, and without reuse it fills with
  // tombstones within a few sim-weeks and growth stops dead.
  const recycled = P.findDeadLeaf(host);
  if (recycled >= 0) {
    P.reviveLeaf(recycled, w.tickCount, leafLifespan(w, plant.species));
    w.events.push({ t: 'nodeSpawned', node: recycled, kind: NodeKind.Leaf });
    return true;
  }

  /*
   * Alternate sides, and step each PAIR further down the stem.
   *
   * The pair term is a bug fix, not a flourish. Position used to depend on parity alone, so the third
   * leaf on a stem was spawned at exactly the coordinates of the first — invisible underneath it, and
   * counted twice by the light field, which then shaded that cell at 0.72 squared. Both species
   * deliberately tuned to be bushier (`leavesPerStem: 3` for the Fern and the Succulent) were therefore
   * paying for a leaf that could never be seen and made its own neighbour dimmer.
   *
   * Half a cell per pair keeps every leaf inside its host's own span — stem nodes sit one cell apart —
   * while giving each one a cell of its own to photosynthesise in.
   */
  const nth = leafCountOf(w, host);
  const side = nth % 2 === 0 ? -1.05 : 1.05;
  const droop = 0.22 * (nth % 2 === 0 ? 1 : -1) + Math.floor(nth / 2) * 0.5;
  const leaf = P.spawn(
    NodeKind.Leaf,
    plant.id,
    host,
    P.x[host] + side,
    P.y[host] + droop,
    w.tickCount,
    leafLifespan(w, plant.species),
  );
  if (leaf < 0) {
    w.poolExhausted = true;
    return false;
  }
  plant.nodeIds.push(leaf);
  w.events.push({ t: 'nodeSpawned', node: leaf, kind: NodeKind.Leaf });
  return true;
}

/**
 * Set a flower, if the plant has earned one.
 *
 * Every condition here is about SUSTAINED balance rather than a threshold touched once: size, health,
 * a stocked larder of both currencies, and a stretch of calm that drains three times faster than it
 * fills. A jar can be nursed through a crisis and survive; it only blooms if it was actually left in
 * good order, which is the distinction between merely not dying and playing well.
 */
function tryFlower(w: World, plant: Plant): boolean {
  const P = w.pool;
  const c = speciesOf(w, plant).raw.growth;
  if (plant.liveNodes < c.flowerRequiresNodes) return false;
  if (plant.calmMinutes < c.flowerCalmMinutes) return false;
  if (plant.nutrients < c.flowerNutrientCost) return false;
  if (P.sugar[plant.crown] < c.flowerSugarCost) return false;

  // Buds form at the top of the plant, where the light is.
  const host = highestStem(w, plant);
  if (host < 0 || P.health[host] < c.flowerRequiresHealthAbove) return false;
  if (leafCountOf(w, host) === 0) return false; // a bare tip has nothing to support a bloom

  const flower = P.spawn(
    NodeKind.Flower,
    plant.id,
    host,
    P.x[host],
    P.y[host] - 0.4,
    w.tickCount,
    c.flowerLifespanMinutes * w.rng.range(0.75, 1.25),
  );
  if (flower < 0) {
    w.poolExhausted = true;
    return false;
  }
  plant.nodeIds.push(flower);
  P.sugar[plant.crown] -= c.flowerSugarCost;
  plant.nutrients -= c.flowerNutrientCost;

  // A bloom costs far more sugar than it lays down as tissue. Everything above the structural price of
  // a node is metabolic — burned to build the thing — so it is RESPIRED rather than quietly deleted.
  // Left unaccounted it is a carbon leak that scales with how well the player is doing, which is the
  // worst possible place to hide one.
  const burned = Math.max(0, c.flowerSugarCost - c.sugarCostPerNode);
  const maint = speciesOf(w, plant).raw.maintenance;
  w.delta.co2Ppm += burned * maint.co2PpmPerRespiredSugar;
  w.delta.o2Pct -= burned * maint.o2PctPerRespiredSugar;
  plant.flowers++;
  plant.calmMinutes = 0;
  plant.stage = 'flowering';
  // Latched for the climax: a jar has to have actually bloomed before it can be called finished.
  w.everBloomed = true;
  w.events.push({ t: 'flowered', node: flower });
  trySeedFrom(w, plant);
  return true;
}

/** A leaf's own lifespan, jittered +/-35% so a canopy ages out gradually instead of all at once. */
function leafLifespan(w: World, species: SpeciesId): number {
  return w.cfg.species[species].raw.health.leafLifespanMinutes * w.rng.range(0.65, 1.35);
}

function stemCount(w: World, plant: Plant): number {
  const P = w.pool;
  let n = 0;
  for (const id of plant.nodeIds) {
    if (P.alive[id] && (P.kind[id] === NodeKind.Stem || id === plant.crown)) n++;
  }
  return Math.max(1, n);
}

/**
 * A stem worth forking from, or -1 to just extend the leader.
 *
 * Real branching is a second leader breaking out of an established stem, so the candidate must ALREADY
 * carry a stem child — otherwise this would only ever resume a dead-end, which is the plant growing
 * normally with extra steps. It must also not be the leading tip itself, or a "fork" is indistinguishable
 * from rising, and it must sit below the top so the new branch has headroom inside the height cap.
 *
 * Among the candidates the brightest wins, using the same light field the phototropic step samples: a
 * plant breaks out where the light is, which is what makes a branched silhouette look deliberate rather
 * than random.
 */
function branchHost(w: World, plant: Plant, tip: number): number {
  const P = w.pool;
  const c = speciesOf(w, plant).raw.growth;
  if (!c.branchingEnabled) return -1;
  if (plant.liveNodes < c.branchMinNodes) return -1;
  if (w.rng.next() >= c.branchChance) return -1;

  // Count existing forks: any live stem carrying more than one live stem child.
  let forks = 0;
  for (const n of plant.nodeIds) {
    if (!P.alive[n] || (P.kind[n] !== NodeKind.Stem && n !== plant.crown)) continue;
    let kids = 0;
    for (let ch = P.firstChild[n]; ch >= 0; ch = P.nextSibling[ch]) {
      if (P.alive[ch] && P.kind[ch] === NodeKind.Stem) kids++;
    }
    if (kids > 1) forks++;
  }
  if (forks >= c.maxBranchesPerPlant) return -1;

  let best = -1;
  let bestLight = -1;
  for (const n of plant.nodeIds) {
    if (!P.alive[n] || (P.kind[n] !== NodeKind.Stem && n !== plant.crown)) continue;
    if (n === tip) continue;
    // Must already carry a stem child, and must have room to rise within the absolute height cap.
    let carries = false;
    for (let ch = P.firstChild[n]; ch >= 0; ch = P.nextSibling[ch]) {
      if (P.alive[ch] && P.kind[ch] === NodeKind.Stem) {
        carries = true;
        break;
      }
    }
    if (!carries) continue;
    if (P.y[plant.crown] - P.y[n] >= c.maxShootHeight) continue;
    if (P.y[n] - 1 < 1.5) continue;
    const light = w.light.at(Math.round(P.x[n] - 0.5), Math.round(P.y[n] - 1.5));
    if (light > bestLight) {
      bestLight = light;
      best = n;
    }
  }
  return best;
}

/** Topmost live STEM. Leaves are never growth tips — a leaf cannot carry the column above it. */
function highestStem(w: World, plant: Plant): number {
  const P = w.pool;
  let best = P.alive[plant.crown] ? plant.crown : -1;
  let bestY = best >= 0 ? P.y[best] : Infinity;
  for (const n of plant.nodeIds) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Stem) continue;
    if (P.y[n] < bestY) {
      bestY = P.y[n];
      best = n;
    }
  }
  return best;
}

function leafCountOf(w: World, stem: number): number {
  const P = w.pool;
  let n = 0;
  for (let c = P.firstChild[stem]; c >= 0; c = P.nextSibling[c]) {
    if (P.alive[c] && P.kind[c] === NodeKind.Leaf) n++;
  }
  return n;
}

/** Highest stem still under its leaf quota, so the canopy fills from the top down. */
function stemWithLeafRoom(w: World, plant: Plant): number {
  const P = w.pool;
  const quota = speciesOf(w, plant).raw.growth.leavesPerStem;
  let best = -1;
  let bestY = Infinity;
  for (const n of plant.nodeIds) {
    if (!P.alive[n]) continue;
    if (P.kind[n] !== NodeKind.Stem && n !== plant.crown) continue;
    if (leafCountOf(w, n) >= quota) continue;
    if (P.y[n] < bestY) {
      bestY = P.y[n];
      best = n;
    }
  }
  return best;
}

function deepestRoot(w: World, plant: Plant): number {
  const P = w.pool;
  let best = -1;
  let bestY = -1;
  for (const n of plant.nodeIds) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    if (P.cellY[n] > bestY) {
      bestY = P.cellY[n];
      best = n;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Phase 9 — failure strikes
// ---------------------------------------------------------------------------------------------

function strikesAndFailures(w: World): void {
  const g = w.grid;
  const P = w.pool;
  const c = w.cfg.raw;

  let dehydrated = false;
  let rotting = false;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    const i = g.idx(P.cellX[n], P.cellY[n]);
    if (g.moisture[i] <= c.water.wiltingPointMl) dehydrated = true;
    if (g.saturation(i) > c.water.rootRotSaturation) rotting = true;
  }

  step(w, 'dehydration', dehydrated);
  step(w, 'rootRot', rotting);
  step(w, 'co2Stall', w.co2Stalled);
  // Low O2 harms FAUNA only — plants never die of gas. With no fauna in the jar there is nothing for
  // it to harm, so warning the player about it would be noise they cannot act on.
  step(w, 'faunaO2', w.faunaPopulation > 0 && w.atmo.o2Pct < c.atmosphere.o2.faunaDeathBelowPct);
  // Mold is judged on how much of the ROOT ZONE it has taken, not on jar-wide fuzz: a film on bare
  // soil in the corner is not the thing that kills a plant, and warning about it would be noise.
  let moldedRoots = 0;
  let roots = 0;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.kind[n] !== NodeKind.Root) continue;
    roots++;
    if (g.mold[g.idx(P.cellX[n], P.cellY[n])] > c.mold.damageThreshold) moldedRoots++;
  }
  step(w, 'mold', roots > 0 && moldedRoots / roots > 0.25);
  // An outbreak, not a colony: a leaf or two with pests is something to prune, a fifth of the canopy
  // is a jar-wide problem worth an alarm.
  step(w, 'pests', w.pestCoverage > c.pests.outbreakFraction);

  for (const plant of w.plants) {
    if (plant.stage !== 'dead') continue;
    if (!w.events.some((e) => e.t === 'plantDied' && e.plant === plant.id)) {
      w.events.push({ t: 'plantDied', plant: plant.id });
    }
  }
}

function step(w: World, mode: FailureMode, bad: boolean): void {
  const f = w.cfg.raw.failure;
  const s = w.strikes[mode];
  const limit = f.triggerTicks[mode];

  s.value = bad
    ? Math.min(limit, s.value + f.strikeAccruePerTick)
    : Math.max(0, s.value - f.strikeRecoverPerTick);

  const warnAt = limit * f.warnAtFraction;
  if (!s.warned && s.value >= warnAt) {
    s.warned = true;
    w.events.push({ t: 'warning', mode });
  } else if (s.warned && s.value < warnAt * 0.5) {
    s.warned = false;
    w.events.push({ t: 'warningCleared', mode });
  }
  if (!s.triggered && s.value >= limit) {
    s.triggered = true;
    w.events.push({ t: 'failure', mode });
  } else if (s.triggered && s.value < limit * 0.5) {
    s.triggered = false;
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 10 — closed-system audit
// ---------------------------------------------------------------------------------------------

/**
 * A sealed jar is a closed system, so water is a conserved quantity. Asserting that every tick in dev
 * builds catches an entire class of bug the moment it is introduced, and makes conservation a design
 * pillar rather than an aspiration — "you left the lid off" only means something if the rest is sealed.
 */
/**
 * Tolerance is relative but very tight: moisture is Float64, so accumulated drift over a long run is
 * around 1e-12 of the total. 1e-9 leaves ample headroom for rounding while still catching a leak
 * orders of magnitude smaller than a single condensation bead.
 */
const AUDIT_RELATIVE = 1e-9;
const AUDIT_FLOOR = 1e-6;

function audit(w: World): void {
  if (!w.auditEnabled) return;
  const have = w.auditWaterMl();
  const want = w.totalWaterAddedMl;
  const tolerance = Math.max(AUDIT_FLOOR, Math.abs(want) * AUDIT_RELATIVE);
  if (Math.abs(have - want) > tolerance) {
    throw new Error(
      `water conservation broken at tick ${w.tickCount}: have ${have.toFixed(4)} mL, expected ${want.toFixed(4)} mL`,
    );
  }
}

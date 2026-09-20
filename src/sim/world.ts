// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The world container: everything the tick reads and writes, and nothing else.
 *
 * Construction takes an INJECTED config so tests and parameter sweeps can hold two differently-tuned
 * worlds side by side. No module under src/sim imports the default balance object.
 */

import { compile, airCapacityMl, type BalanceConfig, type CompiledConfig } from './config/balance.js';
import { Substrate, SUBSTRATES, type SubstrateId } from './config/content.js';
import { SubstrateGrid } from './grid.js';
import { NodePool, type Plant } from './plant.js';
import { LightField } from './light.js';
import { FaunaField } from './fauna.js';
import { MossField } from './moss.js';
import { createAtmosphere, newDelta, type Atmosphere, type AtmoDelta } from './atmosphere.js';
import { CommandQueue } from './commands.js';
import { Rng } from './rng.js';
import type { Droplet, FailureMode, SimEvent } from './events.js';

/**
 * 'climax' is an end STATE, not an end of simulation. Water, air, temperature and the soil fauna all
 * keep running; only new growth stops. See `updateClimax` in tick.ts.
 */
export type Phase = 'build' | 'tend' | 'climax';

/**
 * A debounced failure counter. Instantaneous checks misfire on transient spikes, and a separate
 * looser threshold for the warning would eventually disagree with the failure — so the warning is
 * driven by the SAME counter. Recovery is deliberately faster than accrual, so a player who reacts
 * is rewarded immediately.
 */
export interface Strike {
  value: number;
  warned: boolean;
  triggered: boolean;
}

export class World {
  readonly cfg: CompiledConfig;
  readonly grid: SubstrateGrid;
  readonly pool: NodePool;
  readonly light: LightField;
  readonly fauna: FaunaField;
  readonly moss: MossField;
  readonly atmo: Atmosphere;
  readonly delta: AtmoDelta = newDelta();
  readonly commands = new CommandQueue();
  readonly rng: Rng;
  readonly plants: Plant[] = [];
  readonly events: SimEvent[] = [];

  /** Droplets in flight. Condensate lands on a LATER tick, which makes the animation honest. */
  readonly droplets: Droplet[] = [];
  /** Water waiting to be credited to the soil at the top of the next water phase. */
  readonly pendingSurfaceWater: Array<{ cell: number; ml: number }> = [];

  readonly strikes: Record<FailureMode, Strike> = {
    dehydration: { value: 0, warned: false, triggered: false },
    rootRot: { value: 0, warned: false, triggered: false },
    mold: { value: 0, warned: false, triggered: false },
    co2Stall: { value: 0, warned: false, triggered: false },
    faunaO2: { value: 0, warned: false, triggered: false },
    pests: { value: 0, warned: false, triggered: false },
  };

  /**
   * Scratch buffers, allocated once and reused. They live on the World rather than at module scope
   * so two differently-tuned worlds can run side by side in the same process — which is the entire
   * point of injecting the config.
   */
  readonly scratch: {
    /** Root water demand accumulated per cell, so arbitration is one pass over cells. */
    rootDemand: Float32Array;
    /** Fraction of each cell's demand that could actually be met this tick. */
    cellScale: Float32Array;
    /** Per-leaf photosynthesis rate, held between the measure pass and the apply pass. */
    leafRate: Float32Array;
    /**
     * Pest contact lookup: the first leaf in each grid cell, and each leaf's next in the same cell.
     * A spatial hash rather than all-pairs, which would be quadratic in leaves on every pest step.
     */
    pestHead: Int32Array;
    pestNext: Int32Array;
    /**
     * Pests arriving at each leaf this step. Spread is accumulated here and applied AFTER the whole
     * sweep, so the outcome cannot depend on which leaf happened to be visited first.
     */
    pestInflow: Float32Array;
    /** Active pest load per column: how hard the pests above are hunting the springtails below. */
    pestColumn: Float32Array;
  };

  tickCount = 0;
  phase: Phase = 'build';
  /** Free air cells at seal time. Gas swings scale against this, so crowding tightens the air. */
  baseAirCells = 1;
  /** Water poured in by the player, tracked so the conservation audit knows the expected total. */
  totalWaterAddedMl = 0;
  sumpMl = 0;
  /** Set during the plant phase whenever CO2 sits below the stall threshold. */
  co2Stalled = false;
  /**
   * Whether ANY plant in this jar has ever flowered.
   *
   * Latched, never cleared: it is a record of what the jar has done, not of what it is doing. The
   * climax requires it, so a jar that merely stopped growing — because it was too dim, too dry, or
   * planted badly — cannot be mistaken for one that finished.
   */
  everBloomed = false;
  /** Sim-minutes since the jar last grew meaningfully. Counts toward `climax.holdDays`. */
  climaxHold = 0;
  /** Sim-minutes of renewed growth while in the climax, gating release back to tending. */
  climaxRelease = 0;
  /** Largest the jar has ever been, in live nodes and in plants — the record growth must beat. */
  climaxBestNodes = 0;
  climaxBestPlants = 0;
  /** Total springtail population across the jar. Gates the fauna-suffocation failure. */
  faunaPopulation = 0;
  /** Sim-minutes humidity has held above the mold threshold. A spike must not start an outbreak. */
  moldDwell = 0;
  /** Fraction of substrate showing mold, surfaced to the player and to the failure counter. */
  moldCoverage = 0;
  /** Fraction of live leaves VISIBLY infested. Surfaced to the player and to the pest counter. */
  pestCoverage = 0;
  /**
   * Set whenever substrate is placed or removed. The settling pass runs only while this is true and
   * clears it as soon as a pass moves nothing, so a jar at rest pays nothing for granular physics.
   */
  substrateDirty = true;
  /**
   * Set if the node pool ever ran out. A silent `spawn` failure looks exactly like a plant that has
   * chosen to stop growing, so this makes the difference visible to the harness and the debug overlay
   * instead of leaving it to be misdiagnosed as a balance problem.
   */
  poolExhausted = false;
  /**
   * The per-tick closed-system water assert. On in dev and in every test; the harness turns it on
   * too, since a balance sweep that silently leaks water is worse than one that crashes.
   */
  auditEnabled = true;

  constructor(balance: BalanceConfig, seed = balance.seed) {
    this.cfg = compile(balance);
    this.rng = new Rng(seed);
    this.grid = new SubstrateGrid(balance.grid.interiorW, balance.grid.interiorH);
    this.grid.bakeJarSilhouette(balance.grid.cornerRadius);
    this.pool = new NodePool(balance.plant.maxNodes);
    this.light = new LightField(this.grid);
    this.fauna = new FaunaField(this.grid.size);
    this.moss = new MossField(this.grid.size);
    this.baseAirCells = this.countAirCells();
    this.atmo = createAtmosphere(this.cfg, this.baseAirCells);
    this.scratch = {
      rootDemand: new Float32Array(this.grid.size),
      cellScale: new Float32Array(this.grid.size),
      leafRate: new Float32Array(balance.plant.maxNodes),
      pestHead: new Int32Array(this.grid.size),
      pestNext: new Int32Array(balance.plant.maxNodes),
      pestInflow: new Float32Array(balance.plant.maxNodes),
      pestColumn: new Float32Array(this.grid.w),
    };
    this.totalWaterAddedMl = this.initialWaterMl();
  }

  countAirCells(): number {
    let n = 0;
    for (let i = 0; i < this.grid.size; i++) {
      if (this.grid.substrate[i] === Substrate.Air) n++;
    }
    return Math.max(1, n);
  }

  /** Sim-minutes elapsed, which is what the player's day counter is built from. */
  get simMinutes(): number {
    return this.tickCount * this.cfg.dt;
  }

  get simDay(): number {
    return Math.floor(this.simMinutes / this.cfg.raw.time.dayLengthSimMinutes) + 1;
  }

  /**
   * Total water in the closed system, in millilitres. The dev audit asserts this equals
   * `totalWaterAddedMl` every tick — which catches an entire class of bug the moment it appears, and
   * enforces conservation as a design pillar rather than an aspiration.
   */
  auditWaterMl(): number {
    let inFlight = 0;
    for (const d of this.droplets) inFlight += d.ml;
    let pending = 0;
    for (const p of this.pendingSurfaceWater) pending += p.ml;
    return (
      this.grid.totalWaterMl() +
      this.atmo.airWaterMl +
      this.atmo.glassWaterMl +
      inFlight +
      pending +
      this.pool.totalWaterMl() +
      // Water the plant phase released as transpiration after phase 4's commit point already ran. It
      // is real water in transit, not a leak, and it joins the air on the next tick.
      this.delta.waterMl
    );
  }

  /** Starting humidity is water too: the audit baseline has to include it. */
  initialWaterMl(): number {
    return airCapacityMl(this.cfg, this.cfg.raw.thermal.ambientC) * 0.6;
  }

  /**
   * How much filtering capacity the charcoal layer has left, 0-1.
   *
   * Charcoal loads up with the toxins it adsorbs, and a saturated layer stops protecting the jar. That
   * gives the player a visible meter, a readable warning, and one specific action to take — replace the
   * charcoal — instead of a layer whose only description is flavour text.
   */
  /**
   * Total carbon in the jar, expressed in the ppm units the air is measured in.
   *
   * The sibling of the water audit, and it exists for the same reason: a sealed jar cannot gain or
   * lose carbon, it can only move it between the air, living tissue, stored sugar, and leaf litter.
   * Any sustained drift in this number is a leak in the loop — carbon being invented or destroyed —
   * and no amount of tuning elsewhere can compensate for one.
   *
   * Reported rather than asserted per-tick, because carbon has legitimate rounding paths (the sugar
   * ceiling, the starvation floor) that water does not. The harness watches its drift.
   */
  auditCarbonPpm(): number {
    const c = this.cfg.raw;
    const perSugar = c.plant.photosynthesis.co2PpmPerUnit;

    let sugar = 0;
    let structure = 0;
    for (let n = 0; n < this.pool.count; n++) {
      if (!this.pool.alive[n]) continue;
      sugar += this.pool.sugar[n];
      structure += c.plant.growth.sugarCostPerNode;
    }
    let litter = 0;
    for (const i of this.grid.activeCells) litter += this.grid.organic[i];

    return (
      this.atmo.co2Ppm +
      sugar * perSugar +
      structure * perSugar +
      litter * c.decay.co2PpmPerUnit +
      // Moss is living biomass too. Omitting it would make every mat the player grows look exactly
      // like carbon leaking out of a sealed jar.
      this.moss.carbonPpm(this.cfg)
    );
  }

  /** Fraction of the exposed substrate surface under moss, 0-1. */
  mossCover(): number {
    return this.moss.surfaceFraction(this.grid);
  }

  /** Total leaf litter sitting in the jar — the decomposers' food supply, and mold's. */
  totalLitter(): number {
    let sum = 0;
    for (const i of this.grid.activeCells) sum += this.grid.organic[i];
    return sum;
  }

  charcoalCapacity(): number {
    const g = this.grid;
    // Scans the charcoal index, not every active cell: this is called once per tick from the toxin
    // filter, and at 32x that is 320 full-jar scans a second for a tenth of the jar's cells.
    const cap = this.cfg.raw.decay.charcoalToxinCapacity;
    let cells = 0;
    let loadSum = 0;
    for (const i of g.filterCells) {
      cells++;
      loadSum += Math.min(1, g.charcoalLoad[i] / cap);
    }
    if (cells === 0) return 0;
    return Math.max(0, 1 - loadSum / cells);
  }

  /**
   * Whether any charcoal exists at all, distinct from `charcoalCapacity()` reading 0.
   *
   * `charcoalCapacity()` also returns 0 for a jar that has never had charcoal placed in it, because
   * "no cells to average" and "every cell fully loaded" collapse to the same number. Left alone, the
   * panel reads that as "spent" — a fresh, empty jar looking like its (nonexistent) charcoal is
   * already used up. The UI needs this flag to tell the two states apart.
   */
  hasCharcoal(): boolean {
    for (const i of this.grid.activeCells) {
      if (this.grid.substrate[i] === Substrate.Charcoal) return true;
    }
    return false;
  }

  /**
   * Apply clean layer bands from the jar floor upward. The "just give me a working jar" button, and
   * the thing the substrate tools are a finer-grained version of.
   */
  applyLayerBands(gravelRows: number, charcoalRows: number, soilRows: number): void {
    const g = this.grid;
    for (let x = 1; x <= g.w - 2; x++) {
      let placed = 0;
      for (let y = g.h - 2; y >= 1; y--) {
        const i = g.idx(x, y);
        if (g.substrate[i] === Substrate.Glass) continue;
        let material: SubstrateId | null = null;
        if (placed < gravelRows) material = Substrate.Gravel;
        else if (placed < gravelRows + charcoalRows) material = Substrate.Charcoal;
        else if (placed < gravelRows + charcoalRows + soilRows) material = Substrate.Soil;
        if (material === null) break;
        this.place(i, material);
        placed++;
      }
    }
    g.reindex();
    this.atmo.airCells = this.countAirCells();
    if (this.phase === 'build') this.baseAirCells = this.atmo.airCells;
  }

  /**
   * Paint a single cell. In tend mode this is an AMENDMENT: it dumps the cell's water and damages
   * nearby roots, so layout is a decision the player lives with rather than a two-click patch.
   */
  paint(x: number, y: number, material: SubstrateId): void {
    const g = this.grid;
    if (!g.isInterior(x, y)) return;
    const i = g.idx(x, y);
    if (g.substrate[i] === Substrate.Glass) return;
    /*
     * Painting a material onto itself is normally a no-op — except on SPENT charcoal, where it is the
     * whole maintenance action.
     *
     * Charcoal now fills up with the toxin it adsorbs, and replacing a spent layer is what the player
     * is supposed to do about it. With a blanket same-material guard that was impossible: repainting
     * charcoal over charcoal returned here and changed nothing, so a spent layer could only be renewed
     * by painting soil over it first and charcoal back after. Measured on a jar at 0% capacity,
     * repainting all 192 cells left it at 0%.
     *
     * It still costs exactly what any other amendment costs — spilt water and damaged roots nearby —
     * so renewing a layer remains a real decision rather than a free reset.
     */
    const renewingFilter = g.substrate[i] === material && g.charcoalLoad[i] > 0;
    if (g.substrate[i] === material && !renewingFilter) return;

    // Sealed is sealed: amending a finished jar spills its water the same as any other.
    if (this.phase !== 'build') {
      const lost = g.moisture[i] * this.cfg.raw.tools.amendWaterLossFraction;
      g.moisture[i] -= lost;
      this.totalWaterAddedMl -= lost; // water leaves the closed system with the spoil
    }

    this.place(i, material);
    // A cell that can no longer hold water must not keep any.
    const maxMl = SUBSTRATES[material].maxMl;
    if (maxMl <= 0) {
      this.totalWaterAddedMl -= g.moisture[i];
      g.moisture[i] = 0;
    } else if (g.moisture[i] > maxMl) {
      this.totalWaterAddedMl -= g.moisture[i] - maxMl;
      g.moisture[i] = maxMl;
    }
    g.reindex();
    this.atmo.airCells = this.countAirCells();
    if (this.phase === 'build') this.baseAirCells = this.atmo.airCells;
  }

  /**
   * Set a cell's material and whatever comes with it. Fresh potting soil arrives fertile; every other
   * material arrives inert, which is what makes the soil band the thing worth placing well.
   */
  private place(i: number, material: SubstrateId): void {
    this.grid.substrate[i] = material;
    this.grid.nutrients[i] =
      material === Substrate.Soil ? this.cfg.raw.water.soilStartingNutrients : 0;
    /*
     * Fresh material arrives CLEAN, which is what makes replacing a spent charcoal layer mean
     * anything.
     *
     * Charcoal now holds the toxin it adsorbs rather than destroying it, so a spent cell is one that
     * is full. Without clearing here, painting new charcoal over it would produce a cell that is
     * still full — the maintenance action would look like it worked and do nothing at all.
     */
    this.grid.toxin[i] = 0;
    this.grid.charcoalLoad[i] = 0;
    // Anything newly placed — or newly unsupported because its neighbour was dug out — has to fall.
    this.substrateDirty = true;
  }

  seal(): void {
    if (this.phase !== 'build') return;
    this.phase = 'tend';
    this.baseAirCells = this.countAirCells();
    this.atmo.airCells = this.baseAirCells;
    this.events.push({ t: 'sealed' });
  }
}

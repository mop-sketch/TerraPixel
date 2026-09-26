// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The tunable surface. This is the ONLY file tuned during a balance pass.
 *
 * Two rules that make the headless harness useful:
 *  - Every rate is expressed PER SIM-MINUTE. `compile()` converts to per-tick. Changing the tick
 *    rate therefore cannot silently rebalance the game.
 *  - The config is INJECTED (`new World(cfg, seed)`), never imported by a logic file, so tests and
 *    parameter sweeps can hold two differently-tuned sims side by side.
 *
 * Presentation values (colours, particle counts, easing) live in src/theme.ts, never here.
 */

import { expNeg, pow2, rateToChance } from '../detmath.js';
import { PAINTABLE, SUBSTRATES } from './content.js';
import { SPECIES, SpeciesId } from './species.js';

export interface BalanceConfig {
  version: number;
  seed: number;

  time: {
    ticksPerSecond: number;
    simMinutesPerTick: number;
    dayLengthSimMinutes: number;
    dayStartMinute: number;
    dayEndMinute: number;
    /** Minutes of dawn/dusk ramp on each end of the lit window. */
    twilightMinutes: number;
    /**
     * Minute-of-day the clock starts at. Starting at midnight means a fresh seedling spends its
     * first six hours in the dark, paying maintenance with no photosynthesis — it starves before
     * dawn and the player never sees it grow at all.
     */
    startMinute: number;
  };

  grid: {
    interiorW: number;
    interiorH: number;
    /** Radius in cells of the rounded jar shoulders/base, baked into the silhouette. */
    cornerRadius: number;
  };

  water: {
    /** Water below this is capillary-bound: unavailable to roots AND to the air. */
    wiltingPointMl: number;
    /**
     * Nutrients (0-10) that fresh potting soil is placed with.
     *
     * Growth spends these permanently and only decomposition returns them, at well under 100%
     * efficiency — so the jar always runs slowly downhill and every player action is a top-up against
     * that clock. A conserved loop produces a screensaver; a slow drain produces a game.
     */
    soilStartingNutrients: number;
    diffusionCoefficient: number;
    diffusionSubsteps: number;
    rootRotSaturation: number;
    /** Evaporation exposure by depth below the surface: index 0 is the surface cell itself. */
    evapExposureByDepth: number[];
  };

  thermal: {
    ambientC: number;
    lampDeltaC: number;
    lidOpenDeltaC: number;
    /** Thermal mass. Larger = the lamp is a slower, more legible lever. */
    tauSimMinutes: number;
  };

  atmosphere: {
    /**
     * Millilitres of water the jar's air holds at 100% RH at 20 C, doubling per +10 C.
     * A gameplay-scaled figure, not a physical one: real 2 L of air holds ~0.03 mL, which would
     * make humidity a meaningless reservoir that saturates on the first tick.
     */
    airCapacityMlAt20C: number;
    capacityDoublingPerDegC: number;
    /** Base evaporation from a fully exposed, fully saturated cell into bone-dry air. */
    evapMlPerMinAtFullDrive: number;
    /** Evaporation scales with (T - this) / 10, floored at zero. */
    evapBaseTempC: number;
    condensation: {
      /** RH at which the jar reads as FOGGED — the damp mold needs. Well below condensation. */
      fogOnHumidity: number;
      fogOffHumidity: number;
      /** RH at which the air is full enough to actually rain. */
      onHumidity: number;
      offHumidity: number;
      ratePctPerMin: number;
      dropletMassMl: number;
      dropletFallTicks: number;
    };
    lid: {
      exchangeFractionPerMin: number;
      roomHumidity: number;
      roomCo2Ppm: number;
      roomO2Pct: number;
    };
    co2: { startPpm: number; stallBelowPpm: number };
    o2: { startPct: number; faunaDeathBelowPct: number };
  };

  light: {
    lampPpfd: number;
    attenuationPerLeafAbove: number;
    nightPpfd: number;
  };

  plant: {
    seedWaterMl: number;
    seedSugar: number;
    maxNodes: number;

    photosynthesis: {
      maxPerLeafPerMin: number;
      lightHalfSat: number;
      co2HalfSatPpm: number;
      tempOptimalC: number;
      tempToleranceC: number;
      leafWaterNeed: number;
      waterPerUnit: number;
      co2PpmPerUnit: number;
      o2PctPerUnit: number;
    };

    transport: {
      /** Fraction of a node's water offered to its children each tick. */
      sharePerTick: number;
      /** Compounds with height, so tall growth is genuinely expensive and pruning pays. */
      efficiencyPerSegment: number;
      /**
       * Millilitres one node's tissue can hold.
       *
       * This is the back-pressure on root uptake, and without it the plant is a pump with no float
       * valve: roots draw at full rate forever, and a mature plant quietly drains litres of water out
       * of the soil into its own tissue while the jar dies of drought around it.
       */
      nodeCapacityMl: number;
    };

    uptake: {
      rootMlPerMin: number;
      nutrientPerMin: number;
      /**
       * Sugar a SEEDLING's roots leak into the cell they are anchored in per sim-minute, as root
       * exudate. A sprout's advertisement to the decomposers.
       *
       * Springtails already forage toward `organic + mold`, so a seedling that leaks a little carbon
       * into its own root cell draws a colony to itself without any new foraging rule, and the frass
       * they leave behind lands in precisely the cell its roots draw minerals from.
       *
       * Set to 0 to switch rhizosphere priming off entirely, and seedlings go back to establishing on
       * the jar's ambient fertility alone.
       */
      seedlingExudateSugarPerMin: number;
      /**
       * How long a sprout keeps advertising, in sim-minutes from the moment it is sown.
       *
       * A WINDOW rather than a sugar threshold, because `'seedling'` is not a phase a doomed plant ever
       * leaves: a plant graduates at five live nodes, so one that cannot grow stays a seedling for the
       * rest of its life. Gating on stored sugar does not save it either — a seed is sown with 60, far
       * above any sensible floor — so a sprout in a dark jar would exude continuously for sim-weeks,
       * feeding a colony that then strips the jar of every scrap of litter.
       *
       * Establishment is a window. After it closes the plant is either away, or it is not.
       */
      seedlingExudateMinutes: number;
      /**
       * Ceiling on banked mineral nutrients, per live node — the mineral counterpart to
       * `maintenance.maxStoredSugarPerNode`, and for the same reason.
       *
       * Without it a mature plant keeps drawing minerals long after it has stopped growing and
       * becomes a sink that strips the jar bare, which is invisible while the player plants by hand
       * and fatal once blooms start seeding: every seedling lands in soil its parent has already
       * emptied. The surplus belongs in the ground, where the rest of the jar can reach it.
       */
      maxStoredNutrientsPerNode: number;
      rootsPerCellMax: number;
      reanchorEveryTicks: number;
      starveTicksBeforeReanchor: number;
    };

    maintenance: {
      sugarPerNodePerMin: number;
      /** Sugar debt this deep starts damaging health. */
      starvationDebt: number;
      /**
       * Sugar trickled in per healthy, hydrated root per sim-minute, but ONLY while the plant has
       * zero leaves — a minimal emergency photosynthesis from whatever green stem tissue remains,
       * gated on the roots actually being healthy again (anchored in rootable soil, not currently
       * starved for water) so the player still has to fix the water problem before recovery starts.
       *
       * Without this, a leafless plant is a permanent dead end. Only leaves normally photosynthesize,
       * so a plant that loses its last leaf while sitting at the starvation floor has no way to ever
       * earn the sugar a new leaf costs — the resprout mechanic exists specifically to prevent a
       * zombie plant, but checks a sugar balance that nothing can ever raise.
       *
       * Drawn from the atmosphere via the SAME CO2/O2 exchange as ordinary photosynthesis
       * (`photosynthesis.co2PpmPerUnit`), not invented — sugar carries carbon in the closed-system
       * audit, and free sugar would be exactly the kind of leak that audit exists to catch.
       */
      emergencyRecoveryPerHealthyRootPerMin: number;
      /**
       * CO2 released per unit of sugar respired, closing part of the carbon loop: photosynthesis
       * fixes carbon into biomass and respiration gives some back. The remainder stays locked in
       * tissue, which is why a growing jar still runs its air down over days.
       */
      co2PpmPerRespiredSugar: number;
      o2PctPerRespiredSugar: number;
      /**
       * Ceiling on banked sugar, per live node. A plant at its structural maximum has nowhere to spend
       * income, and without a cap the store climbs forever into a meaningless number. Flowering is the
       * real sink for a surplus this size, which is why it is the eventual win condition.
       */
      maxStoredSugarPerNode: number;
    };

    /**
     * Stress contributions, each a FRACTION of full stress at full severity rather than a per-minute
     * rate. Health then eases toward `1 - stress`, so these are directly readable as "how bad can this
     * one problem make a node feel": no single term should reach 1.0 alone, or one bad afternoon
     * becomes unrecoverable.
     */
    health: {
      dehydrationStress: number;
      heatStress: number;
      rotStress: number;
      starvationStress: number;
      /** Health eases toward its target; damage is faster than recovery, but both are visible. */
      damageEase: number;
      recoveryEase: number;
      yellowAt: number;
      brownAt: number;
      dropAt: number;
      /**
       * Health below which a ROOT finally gives up, distinct from `dropAt` for leaves.
       *
       * Lower, because a root should be the most stubborn thing on the plant: a shaded leaf is cheap
       * to shed and regrow, whereas losing a root costs the plant everything anchored below it.
       */
      rootDieAt: number;
      /**
       * Sim-minutes a leaf lives before age alone starts costing it health.
       *
       * Senescence is what gives the jar a litter FLUX rather than a one-off pile. Without old leaves
       * continually dropping there is nothing for decomposers to eat, the colony starves, and the
       * carbon and fertility loops both have a source but no supply.
       */
      leafLifespanMinutes: number;
      /** Stress an infinitely old leaf carries. Reached asymptotically past its lifespan. */
      senescenceStress: number;
    };

    growth: {
      sugarCostPerNode: number;
      /**
       * Mineral nutrients a new node costs, on top of its sugar. This is what couples plant growth to
       * the decomposer loop: light alone cannot build tissue, so exhausted soil stops a plant even in
       * perfect light, and the fix is litter and the springtails that recycle it.
       */
      nutrientCostPerNode: number;
      meterPerSugar: number;
      /**
       * Sim-minutes of maintenance the plant must have banked, on top of a node's build cost, before
       * it is allowed to grow.
       *
       * This is the dampener on growth overshoot. Gating on the build cost alone lets the plant add
       * nodes until maintenance exceeds income, then starve — and because starvation damages every
       * node at once, it sheds leaves, loses income, and spirals. Set this to at least the length of
       * the night, so a plant only expands when it can also pay the rent until morning.
       */
      reserveMinutes: number;
      /** Below this root:shoot ratio the plant invests in roots instead of shoots. */
      targetRootRatio: number;
      /**
       * Whether a stem may fork, putting a second stem child on a node that already carries one.
       *
       * This flag sat in the config for a long time defaulted to `false` and READ BY NOTHING — every
       * plant was a single chain because `grow` always attached to `highestStem`, which then became the
       * new highest stem. Turning it on now actually branches.
       */
      branchingEnabled: boolean;
      /**
       * Chance per growth event that a plant forks instead of extending its leading stem.
       *
       * Branching is the highest-leverage thing in this block for how full a jar looks: leaf capacity is
       * `stems x leavesPerStem`, so a fork MULTIPLIES the quota rather than adding to it. That is also
       * why it wants a low rate — every fork permanently doubles a subtree's future leaf demand.
       */
      branchChance: number;
      /** Live nodes a plant needs before it may fork. Keeps seedlings to a single leader. */
      branchMinNodes: number;
      /** Hard cap on forks per plant, so a jar cannot fill with one-segment stubs. */
      maxBranchesPerPlant: number;
      maxRootDepth: number;
      /**
       * Cells the stem may rise above the crown. Capping this matters more than it looks: an
       * uncapped stem grows a single tall straw to the jar lid, and water cannot traverse that many
       * segments fast enough to keep the tip alive.
       */
      maxShootHeight: number;
      /** Leaves that may hang off one stem node. Leaves are terminal, never load-bearing. */
      leavesPerStem: number;
      /**
       * Flowering is the win condition, and it is deliberately gated on SUSTAINED good conditions
       * rather than on a number going up. A plant flowers when it is big enough, healthy enough, and
       * has been unstressed for long enough — which means the player has to hold a balance, not hit a
       * threshold once. That is the difference between a goal and a score.
       */
      flowerRequiresNodes: number;
      flowerRequiresHealthAbove: number;
      /** Consecutive sim-minutes below the stress ceiling before a bud will set. */
      flowerCalmMinutes: number;
      flowerMaxStress: number;
      flowerSugarCost: number;
      flowerNutrientCost: number;
      /** How long a bloom lasts before it fades and drops. Keeps the score a tally, not a pile. */
      flowerLifespanMinutes: number;
    };

    /**
     * Self-seeding from blooms.
     *
     * Every number here exists to hold back an exponential. A mature plant blooms 1.30 times per
     * sim-day, so if every bloom took, three plants would be over a thousand inside a week — against a
     * jar whose node pool caps near thirteen and whose nutrient economy only truly sustains two or
     * three. The gating is the feature.
     */
    reproduction: {
      /** Chance a given bloom drops a viable seed at all. The primary brake. */
      seedChancePerBloom: number;
      /** Columns a seed must keep from any living crown — roots spread about this far. */
      seedMinSpacing: number;
      /** How far from the parent a seed may land: near it, but clear of its own canopy shade. */
      seedMinRange: number;
      seedMaxRange: number;
      /** Safety ceiling on living plants. Competition should bite well before this ever applies. */
      maxPlants: number;
      /** Sim-minutes a stalled seedling is given to get going before it is declared dead. */
      failToEstablishMinutes: number;
    };
  };

  /**
   * Litter breakdown. This is the slow, irreversible leak that keeps a sealed jar from settling into
   * a screensaver: growth locks nutrients into biomass, and decay only ever hands back a fraction.
   */
  decay: {
    /**
     * Fraction of standing litter broken down per sim-minute by ordinary microbial action.
     *
     * Deliberately tiny. Leaf litter in the real world persists for weeks, and it has to persist here
     * too: it is the decomposers' entire food supply, and a decay rate fast enough to clear a leaf in
     * an afternoon starves the colony before it can establish.
     */
    baseRatePerMin: number;
    /** Litter units a dropped leaf contributes. The jar's only input to the detritus economy. */
    leafLitterMass: number;
    /** Decay is a wet, warm process — it stalls in cold or bone-dry substrate. */
    optimalTempC: number;
    tempToleranceC: number;
    /** Nutrients returned per unit of litter. Deliberately well under 1: the jar runs downhill. */
    nutrientYield: number;
    /** Toxin produced per unit of litter broken down. The charcoal layer's reason to exist. */
    toxinPerUnit: number;
    /**
     * Share of that toxin produced when SPRINGTAILS do the processing instead of raw decay.
     *
     * Well below 1: a working colony is genuinely cleaner than rot, and should stay the right answer.
     * Above 0 because it has to be — at zero, fauna were a perfectly clean disposal route and a tended
     * jar produced almost no toxin at all, which left the charcoal permanently fresh and the whole
     * toxin system invisible to any player who had not already failed at the ecology.
     */
    faunaToxinFraction: number;
    /**
     * CO2 released per unit of litter broken down, whether by plain microbial decay or by springtails
     * grazing it — they are respiring the same carbon, so they pay the same rate.
     *
     * This has to be set against what it COST the plant to build the tissue in the first place
     * (`sugarCostPerNode` x `photosynthesis.co2PpmPerUnit`, spread over `leafLitterMass` units), or
     * the loop does not conserve carbon and the jar's CO2 drifts without bound in one direction.
     */
    co2PpmPerUnit: number;
    o2PctPerUnit: number;
    /** Ceiling on a cell's nutrient store, matching the 0-10 scale the soil is described in. */
    maxNutrients: number;
    /**
     * Toxin one charcoal cell can hold before it is spent and stops filtering.
     *
     * The layer's LIFESPAN, and the whole reason the jar eventually asks for maintenance.
     *
     * Measured on a mossy, planted, springtailed jar: the layer breaks through around day 72, and the
     * same jar still reads 74% capacity with no mold at all on day 40. That 40-day figure is the
     * constraint, not a nicety — `well-built` must thrive unattended inside the window the balance
     * matrix measures, and it forbids ANY mold, so a layer that spent sooner would fail the reference
     * jar. A bare jar runs far longer still, because it makes less litter to break down.
     */
    charcoalToxinCapacity: number;
    /**
     * Remaining capacity below which the layer starts losing effectiveness, 0-1.
     *
     * Above this it filters at full strength. The point of the knee is that a charcoal layer should be
     * something the player can rely on and then watch fail, rather than something that fades from the
     * first day and never quite runs out.
     */
    charcoalBreakthrough: number;
    /** How fast a charcoal band evens its load out per sim-minute, so the whole layer gets used. */
    charcoalShareFraction: number;
    /** Toxin above this starts damaging roots anchored in the cell. */
    rootToxinTolerance: number;
    rootToxinDamage: number;
  };

  fauna: {
    springtail: {
      /** Population a single cell can support per unit of litter sitting in it. */
      carryingCapacityPerLitter: number;
      /** Hard ceiling per cell, so a litter pile cannot spawn an unbounded swarm. */
      popCapPerCell: number;
      litterEatenPerMinPerPop: number;
      moldEatenPerMinPerPop: number;
      /** Fraction of what they eat that returns to the soil as plant-available nutrient. */
      assimilationYield: number;
      breedPerMin: number;
      starveDeathPerMin: number;
      /** Substrate drier than this wetness desiccates them. */
      desiccationWetness: number;
      desiccationDeathPerMin: number;
      /** They suffocate below this, which is the one thing low O2 actually threatens. */
      o2DeathBelowPct: number;
      o2DeathPerMin: number;
      /**
       * Population a starving colony falls back to rather than dying out entirely — springtails leave
       * resistant eggs in the litter, and a colony that has ever lived in a cell can come back.
       *
       * Without this, breeding being proportional to population makes zero an absorbing state: one bad
       * week wipes the decomposers out permanently, and the jar can never recover its carbon loop no
       * matter how much litter piles up afterwards. Desiccation and suffocation still kill outright,
       * so the two failure states that are supposed to be lethal still are.
       */
      dormantFloor: number;
      /** How many arrive when the player seeds a culture into a cell. */
      cultureSize: number;
      /** Chance per sim-minute that a crowded cell pushes population into a neighbour. */
      spreadPerMin: number;
      /**
       * How many cells away a colony can smell food along each axis.
       *
       * Checking only the four touching cells means a colony two cells from a litter pile has no
       * gradient to follow at all and has to stumble onto it by random walk, which in a jar of a
       * thousand cells can take forever. A short sense radius is what turns "wanders aimlessly" into
       * "converges on the pile", and it is how springtails actually find food — by following a
       * chemical gradient, not by luck.
       */
      senseRadius: number;
    };
  };

  /**
   * Moss — ground cover, and the jar's only source of NEW fertility.
   *
   * Tuned for break-even, deliberately: a jar whose surface is well covered roughly holds its
   * nutrient level, while a bare jar still runs slowly downhill. Sustainability is meant to be an
   * achievable goal you cultivate, not something that either happens automatically or never happens.
   */
  moss: {
    /** Nutrients pulled from the air per unit coverage per sim-minute. The headline number. */
    fixationPerMin: number;
    growthPerMin: number;
    /** Fraction of coverage shed as litter each sim-minute, keeping the decomposers fed. */
    diebackPerMin: number;
    /** Extra die-back while conditions are wrong — how a mat recedes when neglected. */
    stressedDiebackPerMin: number;
    /** Litter units one unit of coverage becomes. Also sets moss's carbon content — see moss.ts. */
    litterPerCover: number;
    /** O2 released per ppm of CO2 fixed, matching how the plant photosynthesis pair is scaled. */
    o2PerCarbonPpm: number;
    minWetness: number;
    minLight: number;
    /** Above this temperature moss starts to suffer; heatToleranceC sets how fast. */
    comfortTempC: number;
    heatToleranceC: number;
    /** Coverage a patch needs before it can seed a neighbouring column. */
    spreadThreshold: number;
    spreadPerMin: number;
    spreadSeedAmount: number;
    /** Coverage the player's Moss tool places in one click. */
    plantAmount: number;
    /** How much a full mat suppresses mold in its own cell, 0-1. */
    moldSuppression: number;
    /** How much a full mat cuts evaporation from the cell it covers, 0-1. */
    evaporationShield: number;
  };

  /**
   * Mold. The design rule that makes this balanceable at all: mold must EAT something. Driven by
   * moisture and humidity alone it is monotone — it only ever grows — and the player experiences
   * "mold appeared, then everything died" with no lever to pull. Feeding it on litter, and letting
   * springtails graze it, turns a bloom into a boom-and-bust with two visible counters.
   */
  /**
   * Free water: water standing in the open rather than held in a material's pores.
   *
   * See `SubstrateGrid.flowStanding`. This is what makes a drainage layer visibly fill, and what a
   * pond will be built from.
   */
  standing: {
    /** Millilitres a cell holds when completely full of water. */
    cellMl: number;
    /** Millilitres per sim-minute that standing water soaks into the material beneath it. */
    soakMlPerMin: number;
    /**
     * Rounds of settle-then-level per tick. Each round flattens every row outright, so this is not how
     * far water spreads (a whole basin levels in one) but how many times a pour can spill over a ledge
     * and be re-settled before the tick ends.
     */
    levelPasses: number;
    /**
     * Open water's evaporation, as a multiple of soil's `atmosphere.evapMlPerMinAtFullDrive`.
     *
     * At 1 it evaporates exactly as a fully exposed, fully saturated soil cell does, which is honest:
     * the difference is not the rate but that open water STAYS saturated. Soil dries at its surface
     * and slows down; a pond never does, until it is gone.
     */
    evapFactor: number;
    /**
     * Share of a surface cell's water above field capacity that runs off toward a pond, per sim-minute.
     * Only ever applies when a lined pond lies downhill within `runoffReach`; a jar without one is
     * untouched.
     */
    runoffPerMin: number;
    /** How many columns runoff can travel along the surface to reach a pond: its catchment. */
    runoffReach: number;
    /**
     * Share of a catchment surface cell's water between `seepFromFraction` of field capacity and field
     * capacity itself that drains toward the pond, per sim-minute. Far slower than runoff: this is damp
     * ground giving up water to the lowest point, not a flood running off it.
     */
    seepPerMin: number;
    /**
     * The dampness, as a fraction of field capacity, below which ground keeps its water. Set well
     * below the ~55% a normally kept jar's surface sits at, so an ordinary jar feeds its pond and a
     * slightly dry one still partly does, and above what a jar that is drying out holds, so a dry
     * jar's pond gives instead of takes.
     */
    seepFromFraction: number;
  };

  /**
   * Algae in a pond. See src/sim/pond.ts. Quantities are per column; "per cell" means per 12 mL of
   * water, the scale the soil's own toxin and nutrients are measured on.
   */
  algae: {
    /** Less water than this in a column is not a pond, and anything living in it dies back. */
    minWaterMl: number;
    /** Biomass added per unit of biomass per sim-minute, at full light, food and CO2. */
    growthPerMin: number;
    /** Light (lamp PPFD units) at which growth runs at half speed. */
    lightHalfSat: number;
    /** Dissolved nutrients per cell of water at which growth runs at half speed. */
    nutrientHalfSat: number;
    co2HalfSatPpm: number;
    /** The trace every pond carries, per cell of water: blooms start from this, never from nothing. */
    sporeDensity: number;
    /** The densest bloom water can hold, in biomass per cell of water. */
    densityCap: number;
    /** Nutrients spent per unit of biomass grown. */
    nutrientPerUnit: number;
    respirationPerMin: number;
    deathPerMin: number;
    /** Extra die-off, scaled by how short of light, food or CO2 the algae are: the crash. */
    starveDeathPerMin: number;
    /** How fast litter rots under water. Far faster than in soil: a submerged leaf softens in days. */
    pondDecayPerMin: number;
    /** How fast stale water clears on its own once nothing keeps souring it. */
    sourDecayPerMin: number;
    /** Share of the difference between neighbouring wet columns that mixes per sim-minute. */
    mixPerMin: number;
    /** How fast a brimming stale pond passes its sourness into the soil of its banks. */
    bankSourPerMin: number;
    /** How far out from a pond's column its banks are looked for, past the liner. */
    bankReach: number;
    /** Sourness a unit of dying algae leaves in the water. Far more than a leaf's: a rotting bloom. */
    sourPerDeadUnit: number;
    /** Evaporation cut at full greenness: a thick mat covers the surface. */
    matShield: number;
    /** Share of the soil's dissolved nutrients a flood carries with it into the pond. */
    runoffNutrientShare: number;
    /** The same, for the slow seep of damp ground: far less, but it never stops. */
    seepNutrientShare: number;
    /** Greenness at which the water reads as green: the warning and the lesson. */
    visibleGreenness: number;
  };

  /**
   * Water lilies: pads lying on the surface of a pond, rooted in its floor. See src/sim/pond.ts. Cover
   * is per column, 0 to 1: how much of that column's surface the pads cover.
   */
  lilies: {
    /** Cover one click of the tool adds to the column clicked. */
    plantCover: number;
    /** Cover added per unit of cover per sim-minute, at full light, food and CO2, before crowding. */
    growthPerMin: number;
    lightHalfSat: number;
    /** Dissolved nutrients per cell of water at which growth runs at half speed. */
    nutrientHalfSat: number;
    /** Biomass, in litter units, a fully covered column carries: its carbon and its food. */
    massPerColumn: number;
    /** Nutrients spent per unit of biomass grown. */
    nutrientPerUnit: number;
    deathPerMin: number;
    /** Extra die-off scaled by how short of food or CO2 it is. */
    starveDeathPerMin: number;
    /** Share of the difference in cover between neighbouring wet columns that spreads per sim-minute. */
    spreadPerMin: number;
    /** Share of the light a full mat takes before it reaches the algae in the water beneath. */
    algaeShade: number;
    /** Evaporation cut at full cover: pads lying on the water. */
    evaporationShield: number;
  };

  /**
   * Ramshorn snails: the pond's grazer, on the springtail pattern. See src/sim/pond.ts. Population is
   * per column.
   */
  snails: {
    /** Snails one click of the tool adds. */
    cultureSize: number;
    /** Most snails a column of pond can hold, however much food it has. */
    popCapPerColumn: number;
    /** Algae biomass one snail eats per sim-minute. */
    algaeEatenPerMinPerPop: number;
    /** Litter on the pond floor one snail eats per sim-minute, once the algae are scarce. */
    litterEatenPerMinPerPop: number;
    /** Snails a unit of food can support. Food sets the ceiling, so a colony crashes once it has cleaned up. */
    carryingPerFood: number;
    /**
     * Snails a column can carry on nothing but the film that grows on every underwater surface. A pond
     * with no algae and no litter is not a pond with no food at all.
     */
    biofilmPerColumn: number;
    breedPerMin: number;
    starveDeathPerMin: number;
    /** A colony thinned by hunger keeps this many per column, so it recovers when food comes back. */
    dormantFloor: number;
    /** Share of what they eat that goes back into the water as nutrients: their droppings. */
    assimilationYield: number;
    /** Water staler than this, per cell of water, starts killing them. */
    sourDeathAbove: number;
    sourDeathPerMin: number;
    /** Share of the difference between neighbouring wet columns that crawls across per sim-minute. */
    spreadPerMin: number;
  };

  /**
   * Hornwort: a submerged plant, growing up from the pond floor. See src/sim/pond.ts. Cover is per
   * column, 0 to 1: how much of that column's water the fronds fill.
   */
  hornwort: {
    /** Cover one click of the tool adds to the column clicked. */
    plantCover: number;
    growthPerMin: number;
    lightHalfSat: number;
    /** Low: it strips food out of the water far more efficiently than algae can, which is its point. */
    nutrientHalfSat: number;
    /** Biomass, in litter units, a column full of fronds carries. */
    massPerColumn: number;
    nutrientPerUnit: number;
    deathPerMin: number;
    starveDeathPerMin: number;
    /** Share of the difference in cover between neighbouring wet columns that spreads per sim-minute. */
    spreadPerMin: number;
    /** Algae growth cut at full cover: the compounds hornwort gives off hold phytoplankton back. */
    algaeSuppression: number;
  };

  /**
   * Fish: small pond fish, the one creature in the jar you can watch go about its day. See
   * src/sim/pond.ts. Population is per column, spreading fast, because they swim the whole pond.
   */
  fish: {
    /** Fish one click of the tool adds. */
    cultureSize: number;
    /** Stocking limit: fish per cell of water. A pond carries as many as its volume can, no more. */
    perCellOfWater: number;
    /** Algae one fish eats per sim-minute. */
    algaeEatenPerMinPerFish: number;
    /** Litter off the pond floor one fish picks at per sim-minute. */
    litterEatenPerMinPerFish: number;
    /** Algae per cell of water at which fish graze it at half their best: they eat what they can see. */
    algaeHalfDensity: number;
    /** One fish's whole appetite per sim-minute, filled by algae first and then litter. */
    mealPerMinPerFish: number;
    /**
     * Fish a cell of water feeds on its own, on the film of tiny life on every underwater surface. A
     * pond with no algae and no litter is not a pond with nothing in it for a fish.
     */
    biofilmFishPerCell: number;
    /** Breeding, only when well fed and only up to the stocking limit. Slow: this is not a hatchery. */
    breedPerMin: number;
    /**
     * Death when they cannot find enough to eat. Slow: a fish goes a fortnight on very little, so a pond
     * kept spotless by lilies or hornwort starves its fish gradually, not overnight.
     */
    starveDeathPerMin: number;
    /** Share of what they eat that goes back into the water as nutrients: their waste. */
    assimilationYield: number;
    sourDeathAbove: number;
    sourDeathPerMin: number;
    /** Share of the difference between neighbouring wet columns that swims across per sim-minute. */
    spreadPerMin: number;
  };

  /**
   * Reeds: a marginal plant, rooted in the pond floor with its stems standing up out of the water. See
   * src/sim/pond.ts. Cover is per column, 0 to 1.
   */
  reeds: {
    /** Cover one click of the tool adds to the column clicked. */
    plantCover: number;
    growthPerMin: number;
    lightHalfSat: number;
    nutrientHalfSat: number;
    /** Biomass, in litter units, a column of full reedbed carries. More than any other pond plant. */
    massPerColumn: number;
    nutrientPerUnit: number;
    deathPerMin: number;
    starveDeathPerMin: number;
    /** Die-back per sim-minute once the pond has dried: slow, because reeds ride out a dry spell. */
    dryDeathPerMin: number;
    /** Share of the difference in cover between neighbouring pond columns that spreads per minute. */
    spreadPerMin: number;
    /** Water depth, in cells, they grow best in. Deeper than this they grow slower: they are marginal. */
    shallowCells: number;
    /**
     * Extra evaporation at full cover, as a multiple of the open water's own: a reedbed pumps pond
     * water up through its stems into the air.
     */
    transpiration: number;
  };

  mold: {
    /**
     * Substrate wetness a cell needs before spores take hold. The jar-wide half of the condition is
     * the condensation latch rather than a humidity number — see `stepMold`.
     */
    spawnWetness: number;
    /** Consecutive sim-minutes the conditions must hold. A brief spike must not start an outbreak. */
    dwellMinutes: number;
    /** Litter present in a cell before it can host mold at all. */
    requiresOrganic: number;
    growthPerMin: number;
    /** Litter consumed per unit of mold grown — the self-limiting term. */
    organicPerGrowth: number;
    spreadPerMin: number;
    /** Mold dies back when the air dries out, which is what makes venting the lid a real answer. */
    diebackPerMin: number;
    /** Unsaturated charcoal suppresses spawning jar-wide by up to this fraction. */
    charcoalSuppression: number;
    /** Coverage on a root's own cell before it takes damage. Soil fuzz below this is cosmetic. */
    damageThreshold: number;
    damagePerMin: number;
  };

  /**
   * Sap-sucking pests. See `stepPests`.
   *
   * They arrive dormant on every seed the PLAYER plants, sit invisibly at `dormantCap` on a healthy
   * host, and boom once the host is struggling. They pass between plants only where foliage actually
   * touches, so good spacing is a defence and crowding is the risk. Pruning removes them.
   */
  pests: {
    /** Load a stowaway colony arrives with, on the first leaf of a player-planted seed. */
    stowawayLoad: number;
    /** What a HEALTHY leaf holds its pests down to. Below `visibleAt`, so a dormant colony is unseen. */
    dormantCap: number;
    /** Host distress, excluding the pests' own, at which the host stops holding them down. */
    flareDistress: number;
    /** Distress above `flareDistress` over which the carrying capacity climbs from dormant to 1. */
    flareSpan: number;
    /**
     * Plant age, in sim-days, before it starts losing the ability to hold its colonies down.
     *
     * This is what makes pests part of EVERY jar rather than only a broken one. A healthy plant carries
     * no distress at all, so a stress trigger alone left a well-kept jar pest-free forever.
     */
    resistantDays: number;
    /** Days over which that resistance fades out entirely once it starts. */
    resistanceFadeDays: number;
    /** How far toward a full infestation age ALONE can take a plant. Stress can still take it further. */
    agedCap: number;
    /** Logistic growth rate of a colony below its carrying capacity. */
    growthPerMin: number;
    /** How fast a colony above its capacity dies back, once the host recovers. */
    declinePerMin: number;
    /** Load passed to each touching leaf, per unit of source load. */
    spreadPerMin: number;
    /** Leaf-node distance, in cells, that counts as touching. Blades reach ~1 cell, so 2 is contact. */
    contactRadius: number;
    /** Stress a fully infested leaf takes. Additive with everything else the leaf is suffering. */
    damage: number;
    /** Load at which a colony becomes visible, and counts toward the pest warning. */
    visibleAt: number;
    /** Fraction of live leaves visibly infested before the jar-wide pest counter starts climbing. */
    outbreakFraction: number;
    /** Pests are slow; stepping them every tick buys nothing and costs a spatial hash per tick. */
    stepEveryTicks: number;
    /**
     * Springtails eaten per minute, per unit of ACTIVE pest load in the column above them, as a
     * fraction of the colony. Dormant colonies hunt nothing.
     */
    predationPerMin: number;
    /** Sim-days a plant must stay visibly infested for its colony to become fully entrenched. */
    entrenchDays: number;
    /** How much faster entrenchment drains than it builds, once the pests are out of sight. */
    entrenchRelapseFactor: number;
    /** Carrying capacity an ENTRENCHED colony holds on its own, whatever the host's condition. */
    entrenchedCap: number;
    /** Extra damage a fully entrenched colony does, as a multiple of the ordinary figure. */
    entrenchedDamage: number;
    /** Extra spread a fully entrenched colony pushes, as a multiple of the ordinary rate. */
    entrenchedSpread: number;
    /**
     * Share of a colony that crawls to the rest of the plant when its leaf falls NATURALLY.
     *
     * Pruning is unaffected, and that difference is the point — see `migratePests`.
     */
    migrateOnDropFraction: number;
    /** Sim-days a colony with no leaves left to live on survives before it is gone for good. */
    reservoirDays: number;
    /** Chance that a seed the PLAYER plants carries a stowaway colony at all. */
    stowawayChance: number;
    /** How much hardier than the baseline luck can make a plant, as a fraction. Never softer. */
    vigourSpread: number;
    /**
     * Chance per sim-day that a dormant colony catches, once its host's condition would let it.
     *
     * The flare is a ROLL, not a threshold crossing, which is what keeps two identical jars from
     * running identical outbreaks — and what stops pests returning the instant an immunity lapses.
     */
    ignitionPerDay: number;
    /**
     * What that chance is multiplied by while the lid is SHUT.
     *
     * Not zero: a sealed jar is the safe way to keep one, not a guarantee. Small enough that a closed
     * jar mostly stays clean for a long time, large enough that it is a real risk rather than a
     * technicality.
     */
    sealedIgnitionFactor: number;
  };

  /**
   * The pesticide spray. A dose kills most of the pests it reaches and leaves residue in every plant
   * it touches; the residue wears off, and too much of it at once poisons and then kills the plant.
   */
  pesticide: {
    /** Fraction of the pests on a sprayed leaf that one dose kills. */
    killFraction: number;
    /** Residue a plant takes from one spray that covers all of its leaves. */
    dosePerSpray: number;
    /** Residue a plant carries with no harm at all. */
    safeResidue: number;
    /** Residue that kills the plant outright. */
    lethalResidue: number;
    /** Stress at the moment residue reaches lethal — the warning a player gets before the kill. */
    maxStress: number;
    /** Residue that wears off per sim-day. */
    decayPerDay: number;
    /** Doses in a completed course. */
    courseDoses: number;
    /** A dose sooner than this after the last counted one adds residue but does not count. */
    courseMinGapDays: number;
    /** Wait longer than this between doses and the course lapses and has to start again. */
    courseMaxGapDays: number;
  };

  /**
   * The climax: the state a finished jar settles into.
   *
   * A terrarium that has genuinely filled its space stops being a garden you tend and becomes a thing
   * you keep. This is that moment made explicit, rather than the jar simply going quiet.
   */
  climax: {
    /**
     * Sim-days the jar must go without growing before the climax begins.
     *
     * Long on purpose. Finishing a terrarium should be an achievement you kept a jar for, not
     * something that happens while you are still learning it — and at 20 days no BALANCE SCENARIO ever
     * reaches it, since those run 30 to 40 days. That matters: the matrix is there to measure a jar
     * growing, and a jar that has stopped growing inside the measurement window is measuring the
     * ending instead.
     *
     * Measured climax day at this setting, in the 80x40 jar: well-built 42, mixed 72, fern-shade 67,
     * wild 38. (The 64x32 jar, before the window: 54, 49, 79, 41.)
     */
    holdDays: number;
    /** Sim-days the jar must stay cut back before it releases, so it cannot flicker. */
    releaseDays: number;
    /**
     * Fraction of its peak size the jar must LOSE before the climax releases.
     *
     * Release cannot watch for renewed growth, which is the obvious test and a deadlock: the climax
     * forbids expansion, so a jar inside it can never set a new record and would never get out. What
     * it can do is get smaller, and only the player makes that happen — so being cut back IS the
     * release signal, and this is how hard you have to prune to mean it.
     */
    releaseCut: number;
    /**
     * How much the jar must grow over the last `holdDays` to count as still growing, as a fraction.
     *
     * Measured across the whole WINDOW, not hour to hour, and that difference is everything. Tested
     * hour to hour, as it first was, a relative margin was a disaster: a dim jar growing slowly adds a
     * couple of nodes a week and never beats its record by three percent in any one hour, so it was
     * declared finished while still filling (`fern-shade` climaxed on day 12 holding two plants). Over
     * twenty days those same couple of nodes a week are a good tenth of a young jar, so it keeps growing
     * and runs to day 67 and nine plants.
     *
     * It was zero for a while, which is "any new record at all restarts the clock", and that held in
     * the 64x32 jar because its plants reached a hard ceiling and stopped. In the 80x40 jar they never
     * quite do: there is room to creep, a node every five days or so (216 to 236 over a hundred days,
     * about 2% per window), and each creep was a new record. `well-built` took 121 days to finish. At
     * 3% that creep counts as finished and real growth still does not: 42 days.
     */
    growthMargin: number;
    /**
     * Fraction of its normal stress a plant still carries once the jar has finished, 0-1.
     *
     * The climax is the jar at equilibrium — nothing competing, nothing being outgrown — so its plants
     * are not fighting anything and settle into their best condition. Because leaf colour is drawn
     * straight from node health, easing stress here IS the greening: no separate "climax palette" is
     * needed, and the picture cannot drift out of step with what the plants are actually doing. It is
     * a real benefit too, since health scales photosynthesis and uptake.
     *
     * Senescence is excluded from the relief where this is applied — old leaves must still age out, or
     * a finished jar would stop feeding its own litter loop.
     */
    settledStress: number;
  };

  failure: {
    strikeAccruePerTick: number;
    strikeRecoverPerTick: number;
    warnAtFraction: number;
    triggerTicks: {
      dehydration: number;
      rootRot: number;
      mold: number;
      co2Stall: number;
      faunaO2: number;
      pests: number;
    };
  };

  tools: {
    /** A single click's splash. */
    wateringCanMl: number;
    /** Continuous pour rate while the Water tool is held down over a column. */
    wateringStreamMlPerSec: number;
    /**
     * The watering can's rose: columns each side of the cursor that also get wetted.
     *
     * Splits the same millilitres wider rather than pouring more of them. Without it the stream is a
     * needle, and charging a jar means dragging it across every one of ~58 columns individually.
     */
    wateringSpreadColumns: number;
    /** Amending a wet cell in tend mode dumps this fraction of its water. */
    amendWaterLossFraction: number;
    amendDamagesRootsWithin: number;
  };
}

/**
 * The standard layers for a jar `interiorH` rows tall: gravel, charcoal and soil in the 4 : 3 : 9 that
 * the game was balanced on at 32 rows, scaled to the jar's height so a taller jar is filled to the same
 * proportion rather than left with a deep empty headspace.
 */
export function standardLayers(interiorH: number): { gravelRows: number; charcoalRows: number; soilRows: number } {
  const f = interiorH / 32;
  return { gravelRows: Math.round(4 * f), charcoalRows: Math.round(3 * f), soilRows: Math.round(9 * f) };
}

export const DEFAULT_BALANCE: BalanceConfig = {
  version: 1,
  seed: 12345,

  time: {
    ticksPerSecond: 10,
    simMinutesPerTick: 1,
    dayLengthSimMinutes: 1440,
    dayStartMinute: 360,
    dayEndMinute: 1200,
    twilightMinutes: 120,
    startMinute: 480, // 8am: the jar opens in full morning light
  },

  /*
   * 80x40, up from 64x32: a quarter more room each way, for ponds and planting. Measured before the
   * change: the sim still runs at 2.3x what 128x needs, and the reference jar scaled up by area grew as
   * well as it did at the old size. The corner radius scales with it, so the jar keeps its shape.
   */
  grid: { interiorW: 80, interiorH: 40, cornerRadius: 6 },

  water: {
    wiltingPointMl: 0.8,
    // Fresh potting soil is fertile but finite. Low enough that a maturing plant genuinely draws it
    // down and has to start living off recycled litter, which is what gives the decomposers a job the
    // player can feel rather than one that only shows up in a debug readout.
    soilStartingNutrients: 2.5,
    diffusionCoefficient: 0.18,
    diffusionSubsteps: 2,
    rootRotSaturation: 0.92,
    evapExposureByDepth: [1, 0.25],
  },

  thermal: { ambientC: 21, lampDeltaC: 9, lidOpenDeltaC: -1.5, tauSimMinutes: 45 },

  atmosphere: {
    // Sized against the evaporation FLUX, not against the jar's total water. If the air's capacity is
    // small relative to what a tick can evaporate, it saturates immediately and humidity pegs at the
    // condensation floor forever — a dead gauge. At 300 mL the air takes a few sim-hours to load,
    // which puts humidity on its own ~10-minute timescale, separate from temperature's ~45.
    airCapacityMlAt20C: 300,
    capacityDoublingPerDegC: 10,
    evapMlPerMinAtFullDrive: 0.035,
    evapBaseTempC: 12,
    condensation: {
      /*
       * Fogging and condensing are deliberately far apart.
       *
       * They were one latch at 86/80, which forced the jar to rain the moment it became muggy — and
       * pinned humidity at 86% forever, because the thing that made it damp was also the thing that
       * immediately dried it. Splitting them lets a jar sit genuinely humid, growing mold, without
       * water running off the glass, and keeps real condensation for the point where the air is full.
       */
      fogOnHumidity: 80,
      fogOffHumidity: 74,
      onHumidity: 95,
      offHumidity: 89,
      ratePctPerMin: 0.9,
      dropletMassMl: 0.6,
      dropletFallTicks: 6,
    },
    /*
     * `roomCo2Ppm` is 1400, NOT the 420 ppm of real room air, and the fiction is deliberate.
     *
     * It has to match `co2.startPpm`, because that is the jar's design point — the carbon level a
     * sealed jar is built to run on. Leaving it at a realistic 420 made venting actively harmful once
     * the budget was raised: opening the lid on a healthy 1400 ppm jar DRAINED it toward 420 and
     * permanently shrank what the jar could support. The player's one immediate remedy for stale air
     * was quietly impoverishing them.
     *
     * At 1400 the lid does what the advice in the UI says it does: it restores the jar. That makes it a
     * strong fix — a stalled jar goes straight back to full — and venting still costs humidity, warmth
     * and whatever the fauna make of the change, so it is not free.
     *
     * The house rule for this kind of number is already set by `airCapacityMlAt20C` above, which is
     * likewise a gameplay-scaled figure rather than a physical one.
     */
    lid: { exchangeFractionPerMin: 0.25, roomHumidity: 45, roomCo2Ppm: 1400, roomO2Pct: 20.9 },
    /*
     * `startPpm` 900 -> 1400: the jar is sealed with a richer atmosphere so it can carry more plant.
     *
     * This is the knob that actually governs how many plants a jar supports, and it took a while to
     * find because the symptom pointed elsewhere. A sealed jar is a closed carbon loop, so standing
     * biomass and atmospheric CO2 are drawn from the same pool and compete directly: every node built
     * is carbon taken out of the air. The reference jar sat at 6 plants and 315 ppm against this
     * 200 ppm stall floor, which meant a seventh plant was paid for out of the atmosphere and the jar
     * stalled. No amount of seeding, spacing or fertility tuning could get past that — the jar was not
     * short of room or minerals, it was short of carbon.
     *
     * Measured on the reference jar over 40 sim-days: 6 plants and 193 nodes -> 9 plants and 335 nodes,
     * with equilibrium CO2 landing at 357 ppm, comfortably clear of the floor.
     *
     * It saturates, and not far above this. At 1700 and 2200 ppm the jar still finishes at the same
     * plant count, because light and floor space take over as the binding constraints — the extra
     * carbon just sits in the air. 1400 is therefore near the top of the useful range, not a midpoint.
     *
     * Two knock-on effects, both real and both handled rather than tuned away:
     *  - `overplanted` no longer ran thin, since 600 ppm is not a thin atmosphere in a 1400 ppm jar.
     *    Its seed list was made genuinely denser (7 plants -> 10) and its CO2 ceiling rescaled by the
     *    same ratio as the budget, so the scenario tests the same criterion it always did.
     *  - The reference jar's humidity swing grew with the canopy. See `maxRhSwing` in the harness.
     */
    co2: { startPpm: 1400, stallBelowPpm: 200 },
    o2: { startPct: 21, faunaDeathBelowPct: 14 },
  },

  light: { lampPpfd: 220, attenuationPerLeafAbove: 0.72, nightPpfd: 0 },

  plant: {
    // Enough reserve to cross one night as a seedling, since a seedling cannot bank much.
    seedWaterMl: 0.3,
    seedSugar: 60,
    /**
     * Capacity of the node pool, shared by EVERY plant in the jar — not a per-plant limit.
     *
     * Needs real headroom: a jar with seven plants, each cycling leaves through senescence, chews
     * through slots steadily. Leaf slots are recycled, but stems and roots are not, and running out
     * looks exactly like a plant that has decided to stop growing. `World.poolExhausted` flags it if
     * it ever happens, because that failure is otherwise indistinguishable from a balance problem.
     */
    // Headroom for a self-seeding jar. Slots are reclaimed when a whole plant dies, but there is
    // always churn in flight between a death and the next reuse, so the ceiling needs slack.
    maxNodes: 1600,

    photosynthesis: {
      maxPerLeafPerMin: 1.4,
      lightHalfSat: 90,
      co2HalfSatPpm: 350,
      tempOptimalC: 24,
      tempToleranceC: 9,
      // Set against what a leaf can actually be supplied through the stem, so water is a soft
      // limiter rather than a hard ceiling that pins photosynthesis near zero forever.
      leafWaterNeed: 0.35,
      waterPerUnit: 0.07,
      /*
       * Sized so that the carbon locked into a jar-full of biomass and undecomposed litter is a
       * meaningful fraction of the carbon in the air.
       *
       * This is what makes the decomposers matter. Carbon now conserves across the whole loop, so a
       * sealed jar cannot lose CO2 — it can only park it in tissue and in leaf litter. Set this too low
       * and a plant could never draw the air down no matter how overplanted the jar was, and the gas
       * failure state would be unreachable; set it here and a jar that grows hard while nothing
       * recycles its litter genuinely runs its own air out.
       */
      co2PpmPerUnit: 0.09,
      // Stoichiometric with the CO2 figure: photosynthesis swaps roughly one CO2 for one O2, and
      // 0.03 ppm is 0.000003 percent by volume. Getting this ratio wrong by orders of magnitude (an
      // easy slip, since one term is ppm and the other is a percentage) inflates O2 to 40%+ over a few
      // sim-weeks. Correctly coupled, O2 barely budges — which is the real behaviour of a sealed jar,
      // and the reason CO2 is the binding constraint and O2 gates fauna only.
      o2PctPerUnit: 0.000003,
    },

    // A node's throughput to its children is capacity x share x efficiency. That product has to exceed
    // what the whole canopy above it transpires, or the stem is a straw too narrow to feed its own
    // leaves and the plant sheds them from the tip inward no matter how wet the soil is.
    transport: { sharePerTick: 0.9, efficiencyPerSegment: 0.97, nodeCapacityMl: 1.5 },

    uptake: {
      // Must comfortably exceed what the canopy transpires at the root:leaf ratio the plant targets,
      // or the plant sits permanently in deficit and every jar dies of drought regardless of watering.
      rootMlPerMin: 0.14,
      nutrientPerMin: 0.05,
      /*
       * About 5.8 sugar per sim-day at full trickle, which converts to roughly 1.2 units of organic —
       * comparable to a third of a dropped leaf, but arriving steadily underneath the sprout instead of
       * on the surface. Enough to register within the colony's sense radius without making a seedling a
       * richer meal than the litter horizon itself, which would pull the decomposers off the litter the
       * whole jar depends on them recycling.
       */
      /*
       * A quarter of the 0.004 first tried, after A/B-ing it against 0.
       *
       * At 0.004 this alone broke two plant behaviour tests, and switching it off fixed both: a jar left
       * in darkness ended with bare ground where a failed plant should have fed the springtails, and a
       * Fern canopy thinned to exactly as many leaves as stems. The mechanism is the feature working too
       * hard — exudate feeds and concentrates a colony, and a colony that well fed clears litter faster
       * than the jar produces it.
       *
       * The same A/B cleared exudate of the third failure. With it off, the Fern fell FURTHER behind the
       * Herb in a dim jar (151 v 195, against 143 v 167 with it on), so rhizosphere priming helps the
       * shade species rather than hurting it, and that failure belongs to the density changes instead.
       */
      seedlingExudateSugarPerMin: 0.002,
      // One sim-day, halved along with the rate. Together they cap the whole performance at ~2.9 sugar,
      // roughly 0.6 units of organic — a fifth of a single dropped leaf, arriving under the sprout
      // rather than on the surface. Deliberately small: the point is to be worth walking to, not to
      // out-feed the litter horizon the whole jar depends on the decomposers recycling.
      seedlingExudateMinutes: 1440,
      // Enough banked to build well over a node's worth (nutrientCostPerNode is 2.5) and ride out a
      // lean patch, without letting one plant hold the jar's entire mineral budget hostage.
      maxStoredNutrientsPerNode: 4,
      rootsPerCellMax: 3,
      reanchorEveryTicks: 30,
      starveTicksBeforeReanchor: 20,
    },

    // Rent must be payable: a mature plant's night-time maintenance has to fit inside the sugar its
    // leaves banked during the day, or every jar dies of starvation regardless of player skill.
    maintenance: {
      sugarPerNodePerMin: 0.02,
      starvationDebt: -6,
      // Closes a typical -6 -> +14 (sugarCostPerNode) gap in roughly 2-3 sim-hours with two or three
      // healthy roots — clearly not instant, but reachable within one play session once the player
      // has actually fixed the watering problem that caused the collapse.
      emergencyRecoveryPerHealthyRootPerMin: 0.06,
      // Matched to `photosynthesis.co2PpmPerUnit`: respiration gives back exactly what fixation took.
      co2PpmPerRespiredSugar: 0.09,
      o2PctPerRespiredSugar: 0.000003,
      maxStoredSugarPerNode: 30,
    },

    health: {
      dehydrationStress: 0.6,
      heatStress: 0.5,
      rotStress: 0.5,
      starvationStress: 0.4,
      damageEase: 0.05,
      recoveryEase: 0.02,
      yellowAt: 0.66,
      brownAt: 0.33,
      dropAt: 0.1,
      rootDieAt: 0.03,
      // About four sim-days. Long enough that a leaf pays back its build cost many times over, short
      // enough that a mature plant is visibly shedding and renewing itself.
      leafLifespanMinutes: 5760,
      senescenceStress: 0.9,
    },

    growth: {
      sugarCostPerNode: 14,
      nutrientCostPerNode: 2.5,
      meterPerSugar: 0.05,
      // The night is 1440 - 840 = 600 sim-minutes long.
      reserveMinutes: 620,
      targetRootRatio: 0.8,
      branchingEnabled: true,
      /*
       * About one fork in twelve growth events, past eight nodes, up to three per plant.
       *
       * Deliberately sparse. A fork is not one extra node — it opens a whole second column of leaf slots
       * that the plant then has to feed, and every leaf above a fork draws through the same joint as its
       * sibling branch. Three branches on a plant that has already built eight nodes reads as a shrub;
       * a fork every other step reads as a bramble and starves its own tips.
       */
      /*
       * Cut from 0.08 after measuring what branching costs a jar that is already balanced on a knife.
       *
       * At 0.08 a mature plant carried 8.5 stems against an unbranched 6.5 — a 31% increase — and the
       * reference jar's standing litter went from 274 to 484, a 77% rise, because every extra stem
       * carries leaves and leaves senesce and are rebuilt forever. Soil nutrients fell 220 -> 84 and the
       * springtail colony crashed from 103 to 34.
       *
       * Branching is worth having for the silhouette, so the rate is set where the jar barely notices it
       * rather than where it reshapes every plant.
       */
      branchChance: 0.03,
      branchMinNodes: 8,
      maxBranchesPerPlant: 3,
      maxRootDepth: 12,
      maxShootHeight: 10,
      leavesPerStem: 2,
      flowerRequiresNodes: 30,
      flowerRequiresHealthAbove: 0.8,
      // Half a sim-day of calm. Long enough that it reads as "the jar is settled", short enough that a
      // player who gets it right sees the payoff in one session.
      flowerCalmMinutes: 720,
      flowerMaxStress: 0.15,
      flowerSugarCost: 40,
      flowerNutrientCost: 6,
      flowerLifespanMinutes: 2880,
    },

    reproduction: {
      // ~1 in 14 blooms. At 1.30 blooms per plant per sim-day that is a new plant roughly every
      // 11 sim-days per parent — an event you notice, rather than a metronome.
      seedChancePerBloom: 0.07,
      /*
       * Spacing and reach were both measured before they were loosened, and both were binding.
       *
       * The `mixed` jar spent 35 of 60 sim-days holding open ground it could not REACH — five viable
       * columns, not one of them inside any parent's throw. Widening the throw alone would only have
       * moved seeds further into the same crowded middle, and tightening the spacing alone would have
       * opened ground that still nothing could get to, so the two only work together.
       *
       * Left at 5 in the end, and the detour is worth recording. Compressing it to 3 filled the jar
       * handsomely and then billed for it: plants packed close enough to shade one another, so the Fern
       * stopped out-performing the Herb in the very dim jar that exists to prove shade tolerance (158
       * nodes against 188), canopies thinned to fewer leaves than stems, and the reference jar overgrew
       * its own air. Backing off to 4 did not recover it — the Fern got WORSE, 122 against 160.
       *
       * That is the lesson: in a light-limited jar, density is not a free dial. Total biomass is capped
       * by the light arriving, so packing more plants under it makes each of them smaller and the jar no
       * richer, and it penalises the tightest-packing species hardest — which is exactly the one whose
       * whole identity is thriving in shade.
       *
       * So the extra plants come from REACH, from the safety cap, and from recycling instead. Those add
       * plants where there is light going spare, rather than subdividing light that is already spoken
       * for.
       */
      /*
       * 5 -> 6, so two neighbouring plants' leaves stop touching.
       *
       * A plant's foliage spans roughly four to five columns, so at 5 the closest pairs sat exactly
       * canopy-to-canopy. Measured on the reference jar, the gaps between neighbours ran
       * 6,6,6,8,5,5,8,5 — the three fives are the ones that read as one clump rather than two plants.
       * At 6 the tightest gap is 6 and the jar is legible as individual plants.
       *
       * This is NOT a gentle dial, which is the thing to know before touching it again. Raising the
       * floor by one does not widen each gap by one; it evicts whole plants and the survivors' gaps
       * balloon to fill the space. 5 -> 6 costs two of nine plants and takes floor coverage 84% -> 72%.
       * 7 costs four of nine and collapses coverage to 55%, which is the sparse, lonely jar this whole
       * line of work existed to fix. 6 is the point where foliage separates and the jar still reads as
       * populated; 7 is past it.
       *
       * The old warning below about compressing this to 3 or 4 still stands, and for the same reason
       * in the other direction: packing plants close enough to shade one another is a real cost.
       *
       * Note this is the BASE, which is the Herb. The Fern keeps its own tighter 4 and the Succulent
       * its wider 6, so the species' packing habits still differ — see species.ts.
       */
      seedMinSpacing: 6,
      seedMinRange: 3,
      /*
       * 10 -> 13, so a seed can actually reach the ground the jar has going spare.
       *
       * This is the one change from the spread work that survived, and it is deliberately modest. The
       * note below is right that a longer throw CHASING COUNT is self-defeating, and nothing here
       * contradicts it: reach only matters once there is carbon to support whatever lands. With that in
       * place a 13-column throw is what lets the reference jar seed out to columns 8 and 57 instead of
       * stopping at 12 and 51, which is the difference between a jar that fills and one that huddles.
       *
       * Measured floor coverage — the share of rootable columns within 3 of some crown — 66% -> 84%.
       */
      seedMaxRange: 13,
      /*
       * Both of these were pushed up (to 14 and 20) chasing more plants, and both are back where they
       * started, because the goal was wrong rather than the numbers.
       *
       * A jar receives a fixed amount of light, and total leaf is bounded by what arrives. Adding plants
       * does not add light — it divides the same light more ways, so each plant ends up smaller and the
       * jar looks no fuller. Measured end to end: a jar that went from 6 plants to 12 finished with
       * essentially the same standing biomass, while the extra crowding cost the Fern the one thing that
       * makes it a Fern, out-growing a Herb in shade.
       *
       * A LUSHER jar therefore comes from bigger plants, deeper moss and fuller canopies, not from more
       * crowns. Those levers spend light better instead of splitting it finer.
       */
      maxPlants: 12,
      failToEstablishMinutes: 2880,
    },
  },

  decay: {
    /*
     * Deliberately slow — slower than is strictly realistic.
     *
     * In real soil, microbes do most of the decomposing and springtails mainly speed them up by
     * fragmenting litter. Modelled that way the fauna become a rounding error: a jar without them
     * performs within a couple of percent of one with them, and the player has no reason to care. So
     * background decay is set to a trickle and the springtails are made the primary recycler. That is
     * a game-design choice rather than a soil-science one, and it is the difference between the
     * decomposers being a mechanic and being decoration.
     */
    baseRatePerMin: 0.000012,
    leafLitterMass: 3,
    optimalTempC: 24,
    tempToleranceC: 14,
    // 55%: the other 45% is the permanent drain that gives the jar an arrow of time.
    nutrientYield: 0.55,
    toxinPerUnit: 0.05,
    faunaToxinFraction: 0.03,
    // 14 sugar per node x 0.09 ppm per sugar, spread over 3 litter units = 0.42. Carbon in, carbon out.
    co2PpmPerUnit: 0.42,
    o2PctPerUnit: 0.000014,
    maxNutrients: 10,
    charcoalToxinCapacity: 0.11,
    charcoalBreakthrough: 0.35,
    charcoalShareFraction: 0.05,
    rootToxinTolerance: 0.3,
    /*
     * 0.35 -> 1.3, so soured ground can actually kill a root.
     *
     * Stress sets a health FLOOR — health eases toward `1 - stress` — and a leaf or root is only shed
     * below `dropAt`, which is 0.1. At 0.35 the worst possible soil produced 0.245 stress and parked a
     * root at 75% health forever. Measured: forty sim-days with every cell at MAXIMUM toxin cost the
     * jar less than forty days of nothing being wrong at all, and killed nothing.
     *
     * At 2 the curve reads: 0.5 toxin leaves a root at 60% health, 0.65 at a third, and 0.8 or worse
     * kills it. 1.3 was tried first and was not enough — the very worst soil the sim can produce
     * landed at 0.91 stress, leaving roots alive at 9% health forever, so a jar with no charcoal and
     * no decomposers sat at 0.97 toxin and lost nothing at all.
     *
     * The 0.30 tolerance is untouched, so ordinary soil is still completely harmless. A well-tended
     * jar measures around 0.05 and is unaffected by any of this.
     */
    rootToxinDamage: 2,
  },

  fauna: {
    springtail: {
      carryingCapacityPerLitter: 5,
      popCapPerCell: 40,
      /*
       * Left at 0.0004. Raising it to 0.0006 was tried and measurably BACKFIRED — recorded here so the
       * same reasoning does not get retried: the reference jar went from 217 nodes at 244 ppm CO2 to
       * 310 nodes at 100 ppm, and stalled harder than before.
       *
       * The motivation was sound as far as it went. CO2 is charged against what a colony EATS, not
       * against `assimilationYield`, so faster consumption really does put more carbon back into the
       * air. What it misses is where that carbon then goes: faster litter processing also returns more
       * MINERALS, minerals were the growth limiter, and the larger canopy promptly re-fixed the released
       * CO2 and more besides.
       *
       * The general lesson for this jar: carbon is conserved, so any change that feeds growth moves
       * carbon out of the air and into tissue on balance. Air CO2 cannot be raised by making the
       * decomposers better at their job — only by having less standing plant, or more carbon to begin
       * with.
       */
      litterEatenPerMinPerPop: 0.0004,
      moldEatenPerMinPerPop: 0.0003,
      /*
       * Raised from 0.75, and this is the one number that decides how many plants a jar can carry.
       *
       * Measured: soil minerals fall from 1440 to 45 over 80 sim-days, and reproduction then stops
       * because a parent cannot afford a seed's mineral dowry — not because of spacing, not shade, and
       * not seedlings dying, of which there were none. The jar simply spends its fertility, largely on
       * blooms, and never gets enough of it back.
       *
       * The extra recycling goes HERE rather than into `decay.nutrientYield` on purpose. Frass is the
       * return path the player can actually cultivate, so a tended colony is what lifts the ceiling,
       * while a jar with no springtails in it still runs down at the old rate and keeps its arrow of
       * time.
       */
      assimilationYield: 0.9,
      // Slow enough that the colony tracks its food supply rather than overshooting it and crashing to
      // near-extinction every few days. The boom-and-bust is the intended shape; the amplitude is not.
      breedPerMin: 0.0015,
      starveDeathPerMin: 0.004,
      desiccationWetness: 0.18,
      desiccationDeathPerMin: 0.05,
      o2DeathBelowPct: 14,
      o2DeathPerMin: 0.08,
      dormantFloor: 0.25,
      cultureSize: 12,
      spreadPerMin: 0.05,
      senseRadius: 4,
    },
  },

  moss: {
    // Tuned against the measured deficit: a 3-plant jar drew soil nutrients from ~1,390 down to ~70
    // across 50 sim-days. Full cover over ~60 surface cells needs to offset roughly that much.
    fixationPerMin: 0.00035,
    growthPerMin: 0.0022,
    diebackPerMin: 0.00035,
    stressedDiebackPerMin: 0.004,
    litterPerCover: 1.2,
    o2PerCarbonPpm: 0.0000333,
    minWetness: 0.35,
    minLight: 25,
    comfortTempC: 24,
    heatToleranceC: 9,
    spreadThreshold: 0.35,
    spreadPerMin: 0.004,
    spreadSeedAmount: 0.12,
    plantAmount: 0.3,
    moldSuppression: 0.85,
    evaporationShield: 0.6,
  },

  /*
   * A full cell of water holds 12 mL against soil's 10, because soil is mostly solid — swapping soil
   * for water gains a little capacity rather than losing it.
   *
   * Soaking is deliberately slower than a tick: water poured onto dry ground should be seen to sit
   * there for a moment and sink in, not teleport into the pores.
   */
  standing: {
    cellMl: 12,
    soakMlPerMin: 0.6,
    levelPasses: 4,
    /*
     * A GAMEPLAY-SCALED figure, like the air's capacity. At soil's own rate a full 9-column pond was
     * gone in about four days: soil has a brake, because its surface dries and slows down, and open
     * water has none, so it just keeps giving until it is empty. At 0.08 the same pond lasts about a
     * month while still lifting the jar's mean humidity by around ten points.
     */
    evapFactor: 0.08,
    runoffPerMin: 0.1,
    runoffReach: 8,
    /*
     * Tuned so a pond's level READS the jar. Over 60 days in the reference jar with a pond: charged at
     * 2,400 mL it stayed full throughout; at 1,900 it settled around two-thirds; at 1,400 it gave all
     * of its water to the soil by day 20. At 0.45 the threshold sat exactly on the 1,900 jar's damp
     * ground, so a jar only a fifth drier than normal lost its pond outright, a switch rather than a
     * gauge.
     */
    seepPerMin: 0.004,
    seepFromFraction: 0.35,
  },

  algae: {
    minWaterMl: 2,
    growthPerMin: 0.006,
    /*
     * The lamp is the lever. At 130 a pond under a dim lamp still cannot out-grow its own respiration
     * and stays clear however much food it gets, while an ordinary one greens over by itself in about
     * two weeks: measured, 34% by day 15 with nobody feeding it. At 200 an ordinary pond barely tinted
     * (10%), which made algae something that only happened to a deliberately neglected pond.
     */
    lightHalfSat: 130,
    nutrientHalfSat: 0.1,
    co2HalfSatPpm: 350,
    sporeDensity: 0.005,
    densityCap: 1.5,
    nutrientPerUnit: 0.55,
    respirationPerMin: 0.0004,
    deathPerMin: 0.0003,
    starveDeathPerMin: 0.0006,
    pondDecayPerMin: 0.0006,
    sourDecayPerMin: 0.0002,
    mixPerMin: 0.1,
    bankSourPerMin: 0.002,
    bankReach: 3,
    sourPerDeadUnit: 0.25,
    matShield: 0.5,
    runoffNutrientShare: 0.5,
    seepNutrientShare: 0.2,
    visibleGreenness: 0.3,
  },

  lilies: {
    plantCover: 0.25,
    growthPerMin: 0.004,
    lightHalfSat: 80,
    nutrientHalfSat: 0.05,
    massPerColumn: 1.5,
    nutrientPerUnit: 0.55,
    // Low: a bed that is fed does not thin by itself. At 0.0002, with CO2 counted as hunger, it levelled
    // off at two-thirds cover and the easier algae grew in the gaps.
    deathPerMin: 0.0001,
    starveDeathPerMin: 0.0008,
    spreadPerMin: 0.004,
    /*
     * Most of it, but not all: a bed is pads with gaps between, and a pond under a full one is dim
     * rather than dark. That is what makes lilies an ANSWER to algae rather than a switch that turns
     * the water off.
     */
    algaeShade: 0.9,
    evaporationShield: 0.6,
  },

  snails: {
    cultureSize: 6,
    popCapPerColumn: 12,
    // Paced so a colony put into green water takes days to clear it, building up as it goes. At 0.0006
    // with faster breeding, a 31%-green pond was clear inside a single day: a switch, not a colony.
    algaeEatenPerMinPerPop: 0.00025,
    litterEatenPerMinPerPop: 0.0001,
    carryingPerFood: 6,
    // With 9 columns, a pond carries about 7 on its own: a culture of 6 put into a clean pond holds.
    biofilmPerColumn: 0.8,
    breedPerMin: 0.0008,
    /*
     * Slow: ramshorn snails go weeks on very little. At 0.0008 a culture put into a clean pond halved
     * inside twelve hours, which with the shells drawn per column looked like every one dying at once.
     */
    starveDeathPerMin: 0.00008,
    dormantFloor: 0.3,
    assimilationYield: 0.55,
    /*
     * High enough that ordinary green water is safe for them, which is the whole point of adding them.
     * At 0.35, a heavily fed pond was already 0.41 stale by the time it LOOKED green, so snails put in
     * to cure it died within a day, every one: doing the right thing, and watching it vanish. The rule
     * is for a pond left to rot, not for a green one.
     */
    sourDeathAbove: 0.6,
    sourDeathPerMin: 0.003,
    spreadPerMin: 0.01,
  },

  hornwort: {
    plantCover: 0.2,
    growthPerMin: 0.003,
    lightHalfSat: 90,
    nutrientHalfSat: 0.03,
    massPerColumn: 2,
    nutrientPerUnit: 0.55,
    deathPerMin: 0.0001,
    starveDeathPerMin: 0.0006,
    spreadPerMin: 0.0015,
    algaeSuppression: 0.4,
  },

  fish: {
    cultureSize: 3,
    // A 9-column, 3-deep pond is about 25 cells of water: stocked full at three fish.
    perCellOfWater: 0.12,
    // A check on algae, not a steriliser: at 0.0015 even half a fish kept a bright, fed pond at 0%.
    algaeEatenPerMinPerFish: 0.0003,
    litterEatenPerMinPerFish: 0.0004,
    algaeHalfDensity: 0.3,
    mealPerMinPerFish: 0.0004,
    // A 9-column, 3-deep pond is about 25 cells: two fish live on the film alone, three need a little more.
    biofilmFishPerCell: 0.08,
    breedPerMin: 0.00008,
    starveDeathPerMin: 0.00006,
    assimilationYield: 0.6,
    sourDeathAbove: 0.45,
    sourDeathPerMin: 0.003,
    spreadPerMin: 0.1,
  },

  reeds: {
    plantCover: 0.2,
    growthPerMin: 0.002,
    lightHalfSat: 80,
    nutrientHalfSat: 0.04,
    massPerColumn: 3,
    nutrientPerUnit: 0.55,
    deathPerMin: 0.00005,
    starveDeathPerMin: 0.0004,
    // About a fortnight to die out entirely once the pond has gone: reeds ride out a dry spell.
    dryDeathPerMin: 0.00015,
    spreadPerMin: 0.0008,
    shallowCells: 1.5,
    transpiration: 1.6,
  },

  mold: {
    spawnWetness: 0.85,
    dwellMinutes: 180,
    requiresOrganic: 0.8,
    growthPerMin: 0.01,
    organicPerGrowth: 0.6,
    spreadPerMin: 0.004,
    diebackPerMin: 0.02,
    charcoalSuppression: 0.6,
    damageThreshold: 0.35,
    /*
     * 0.02 -> 0.07, for the same reason as `rootToxinDamage` above: at 0.02 a root sitting in a cell
     * completely overrun by mold held 74% health indefinitely and never died. At 0.07 a fully
     * colonised cell is lethal, while the 0.35 `damageThreshold` keeps surface fuzz cosmetic.
     */
    damagePerMin: 0.07,
  },

  /*
   * Tuned against measured distress, not guessed.
   *
   * Across 60 sim-days a healthy jar's plants carry essentially no distress once ageing is excluded —
   * `well-built`, `wild` and `mossy` all sit at p99 below 0.02 — while a crowded one spends a fifth of
   * its time above 0.4, almost all of it starvation. A flare threshold of 0.1 therefore separates
   * "fine" from "struggling" cleanly, and leaves a well-kept jar's colonies dormant indefinitely.
   *
   * `contactRadius` is 2 because that is where blades visibly touch: leaf nodes sit at the attach point
   * and each blade reaches about a cell out. Measured, a well-spaced jar keeps different plants' leaves
   * 2.95 cells apart or more — pests never cross — while `overplanted` gets them within 0.6.
   *
   * `growthPerMin` takes a colony from dormant to heavy in about a day and a half: slow enough to catch
   * at 1x, fast enough that ignoring it has a cost.
   */
  pests: {
    stowawayLoad: 0.04,
    dormantCap: 0.04,
    flareDistress: 0.1,
    flareSpan: 0.3,
    /*
     * 40 days, matching the charcoal: a good jar is safe for the whole of the matrix's 40-day window,
     * then starts to need its keeper. Measured, a healthy jar's first plants are all still alive at day
     * 100, so this lands well inside their lives rather than after them.
     *
     * `agedCap` stops short of 1 on purpose. Age alone produces a plant that is visibly, harmfully
     * infested; only age AND trouble together overrun it completely.
     */
    resistantDays: 40,
    resistanceFadeDays: 30,
    agedCap: 0.7,
    growthPerMin: 0.0021,
    declinePerMin: 0.0015,
    spreadPerMin: 0.0008,
    contactRadius: 2,
    damage: 0.5,
    visibleAt: 0.12,
    outbreakFraction: 0.2,
    stepEveryTicks: 10,
    /*
     * Measured against the litter windfall, which is the thing predation has to beat.
     *
     * An outbreak strips leaves, and fallen leaves are springtail food — so at the first rate tried,
     * 0.00012, a jar held in a three-day outbreak ended with MORE springtails than the same outbreak
     * with no predation at all. Against that control: x3 leaves 43% of the colony, x6 17%, x10 8%. x3 is
     * an outbreak that clearly costs the jar its decomposers without erasing them; the dormant floor in
     * `preyOnSpringtails` is what lets them breed back once the pests are gone.
     */
    predationPerMin: 0.00036,
    /*
     * Escalation, because an infestation that is merely ignored used to plateau.
     *
     * Left alone, a colony grew to whatever its host would bear and sat there — steady, survivable, and
     * no worse on day thirty than on day three. Entrenchment makes the cost of ignoring it compound:
     * six days in, it holds itself up regardless of the host's condition, hurts more than twice as much
     * per pest, and pushes three times as hard into whatever it is touching.
     *
     * `entrenchedCap` is the one that changes the game. Below it, fixing the plant's real problem was
     * always a cure in itself; above it the colony no longer cares, and the player has to actually
     * remove it — prune it out, or run the pesticide course. Draining three times faster than it fills
     * is what keeps both of those honest cures rather than token ones.
     */
    entrenchDays: 6,
    entrenchRelapseFactor: 3,
    entrenchedCap: 0.85,
    entrenchedDamage: 1.2,
    entrenchedSpread: 2,
    /*
     * Without this, ignoring an infestation cured it.
     *
     * Entrenched pests damage leaves until they drop, and a dropped leaf takes its colony with it.
     * Measured on an overrun plant: by day 10 it was shedding its whole canopy, by day 11 every
     * infested leaf was gone, and the clean leaves it regrew could never be recolonised — there was
     * nothing left to recolonise them from. The plant cured itself by being neglected, which is
     * exactly backwards.
     */
    migrateOnDropFraction: 0.5,
    /*
     * Three days, which is what makes neglect actually compound.
     *
     * Migrating pests leaf-to-leaf was not enough on its own: an entrenched colony damages the canopy
     * until it collapses, and when the last infested leaf fell there was nothing alive left to crawl
     * onto — so the colony died with the canopy it had killed and the plant regrew clean. The reservoir
     * carries it across that gap and reseeds the new leaves.
     *
     * Deliberately NOT fed by pruning, which goes through `killSubtree` and never reaches
     * `migratePests`. Cut the infested growth out and the colony is gone; let it fall on its own and it
     * is waiting for the replacement.
     */
    reservoirDays: 3,
    /*
     * The random half of the system, added because everything above is a threshold: cross it and the
     * outbreak starts, on the same day, in every jar, every time — including the moment an immunity ran
     * out, which made a cured plant relapse on a stopwatch.
     *
     * `ignitionPerDay` 0.35 means a vulnerable plant waits about three days on average before its
     * colony catches, but the draw is geometric: sometimes within hours, occasionally a week or more.
     * Combined with `vigourSpread`, which gives every plant its own resistance, two jars grown the same
     * way no longer have the same pest history.
     */
    stowawayChance: 0.75,
    vigourSpread: 0.35,
    ignitionPerDay: 0.35,
    sealedIgnitionFactor: 0.06,
  },

  /*
   * One spray is free, two close together hurt, three kill.
   *
   * `safeResidue` equals a single full dose, so the first spray on a plant never harms it. A second
   * within the day puts it at ~2.0 — stress 0.5, yellowing and leaf drop, which is the warning. A third
   * crosses 2.6 and kills it. At 0.5 a day, a single dose is gone in two days, so a player who sprays
   * and then waits can keep spraying indefinitely; one who sprays a chronically infested plant every
   * day or so slowly accumulates it, which is what keeps removing an old plant the lasting cure.
   */
  pesticide: {
    killFraction: 0.85,
    dosePerSpray: 1,
    safeResidue: 1,
    lethalResidue: 2.6,
    maxStress: 0.8,
    decayPerDay: 0.5,
    /*
     * The course is what makes pests stoppable. A single spray kills most of a colony, but an old or
     * struggling host regrows it in about a day, so spraying alone only ever bought time.
     *
     * The minimum gap is set so the course and the residue rules pull against each other on purpose. A
     * dose every day builds residue to about 2.0, which mildly sickens the plant; a dose every two days
     * never takes it past 1.0 and costs it nothing. Rushing is allowed, and it has a price.
     *
     * There is no duration to tune here any more. A finished course wipes the colony out, and a plant
     * that comes through an infestation is immune for the rest of its life — see `pestImmune`.
     */
    courseDoses: 3,
    courseMinGapDays: 1,
    courseMaxGapDays: 4,
  },

  /*
   * Eight days full-and-stalled to begin, two days clear to release.
   *
   * The entry hold is long on purpose. "Full" and "stalled" both wobble tick to tick — a leaf drops, a
   * column frees, CO2 crosses the floor at dusk and back at dawn — so a short hold would flip the jar
   * in and out of its own ending. Eight sim-days is longer than any transient the jar produces.
   *
   * Release is asymmetric and much shorter because it answers a player ACTION. Someone who prunes a
   * plant to reopen the jar should see it reopen, not wait a week wondering whether it worked.
   */
  climax: { holdDays: 20, releaseDays: 2, growthMargin: 0.03, releaseCut: 0.2, settledStress: 0.3 },

  failure: {
    strikeAccruePerTick: 1,
    strikeRecoverPerTick: 2,
    warnAtFraction: 0.4,
    triggerTicks: { dehydration: 400, rootRot: 600, mold: 500, co2Stall: 300, faunaO2: 300, pests: 600 },
  },

  // Holding the can for one second pours a bit more than a single click's splash — enough that
  // holding down feels meaningfully faster than repeated clicking, without letting a few seconds
  // of holding flood a column past what a player would expect from "pouring".
  tools: {
    wateringCanMl: 25,
    // A jar holds ~2400 mL at field capacity, so this is ~10 seconds of dragging to charge one. At
    // 40 it was 60 seconds, which made the game's primary verb a chore.
    //
    // Fast enough that a one-second stationary hold pushes the centre column past field capacity
    // (measured: ~82 mL against a ~67 mL hold). The surplus percolates on down the column rather
    // than being lost, and only a sustained pour in one spot puts standing water in the sump — so
    // overdoing it stays legible and recoverable instead of silent.
    wateringStreamMlPerSec: 240,
    wateringSpreadColumns: 2,
    amendWaterLossFraction: 1,
    amendDamagesRootsWithin: 1,
  },
};

/** Derived, frozen, per-tick values. Logic reads this — never the raw config. */
/**
 * One species' plant parameters, with everything derived FROM those parameters derived per species.
 *
 * That last part is the whole reason this type exists. `tempCurve` and `chance.reanchor` both used to
 * sit once on `CompiledConfig`, and both are computed from plant config — so leaving them global
 * would have handed every species the Herb's temperature response and reanchor rate. Nothing would
 * throw; two of the differences between species would simply not exist.
 */
export interface CompiledSpecies {
  readonly id: SpeciesId;
  readonly name: string;
  readonly need: string;
  /** The base plant block with this species' overlay merged in. */
  readonly raw: BalanceConfig['plant'];
  readonly tempCurve: Float32Array;
  readonly chance: { readonly reanchor: number };
}

export interface CompiledConfig {
  readonly raw: BalanceConfig;
  /** Indexed by SpeciesId. Every plant reads its parameters through here, never from `raw.plant`. */
  readonly species: readonly CompiledSpecies[];
  /** Sim-minutes advanced per tick. Every "PerMin" rate is multiplied by this. */
  readonly dt: number;
  readonly ticksPerSimDay: number;
  /** Air water capacity in mL, sampled over [0, 50] C. */
  readonly capacityCurve: Float32Array;
  /** Daylight fraction 0..1 by minute-of-day. One entry per sim-minute. */
  readonly dayCurve: Float32Array;
  readonly curveLoC: number;
  readonly curveHiC: number;
}

class ConfigError extends Error {}

function validate(c: BalanceConfig): void {
  const bad = (msg: string) => {
    throw new ConfigError(`balance config: ${msg}`);
  };
  // A 4-neighbour explicit diffusion stencil is unconditionally unstable past 0.25 and produces
  // checkerboard oscillation. Sub-step instead of raising it.
  if (c.water.diffusionCoefficient > 0.25) bad(`diffusionCoefficient ${c.water.diffusionCoefficient} > 0.25 (unstable)`);
  if (c.water.diffusionSubsteps < 1) bad('diffusionSubsteps must be >= 1');
  if (c.atmosphere.condensation.onHumidity <= c.atmosphere.condensation.offHumidity)
    bad('condensation.onHumidity must exceed offHumidity (hysteresis band)');
  if (c.plant.transport.efficiencyPerSegment > 1) bad('transport.efficiencyPerSegment must be <= 1');
  if (c.failure.warnAtFraction >= 1) bad('failure.warnAtFraction must be < 1');
  if (c.failure.strikeRecoverPerTick <= 0) bad('strikeRecoverPerTick must be > 0 or failures never clear');
  if (c.time.dayEndMinute <= c.time.dayStartMinute) bad('dayEndMinute must exceed dayStartMinute');
  // The wilting point must sit below the capacity of every rootable material, or roots in that
  // material could never draw at all.
  for (const id of PAINTABLE) {
    const p = SUBSTRATES[id];
    if (p.rootable && c.water.wiltingPointMl >= p.fieldCapacityMl)
      bad(`wiltingPointMl ${c.water.wiltingPointMl} >= ${p.name} fieldCapacityMl ${p.fieldCapacityMl}`);
  }
  if (c.plant.uptake.rootsPerCellMax < 1) bad('rootsPerCellMax must be >= 1');
  // `maxNodes` sits in the plant block but is the capacity of the pool SHARED by every plant in the
  // jar, not a per-plant limit. A species overlaying it would look like it was resizing an array
  // that has already been allocated, and would silently do nothing.
  for (const def of SPECIES) {
    if ((def.overlay as { maxNodes?: number }).maxNodes !== undefined)
      bad(`species "${def.name}" overlays maxNodes, which is a jar-wide pool size, not a plant trait`);
  }
  if (c.grid.cornerRadius * 2 >= Math.min(c.grid.interiorW, c.grid.interiorH))
    bad('cornerRadius is too large for the interior dimensions');
}

export function compile(given: BalanceConfig): CompiledConfig {
  validate(given);
  const raw = scaleGasToJar(given);

  const dt = raw.time.simMinutesPerTick;
  const N = 128;
  const loC = 0;
  const hiC = 50;

  const capacityCurve = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const T = loC + ((hiC - loC) * i) / (N - 1);
    capacityCurve[i] =
      raw.atmosphere.airCapacityMlAt20C * pow2((T - 20) / raw.atmosphere.capacityDoublingPerDegC);
  }

  // Each species gets the base plant block with its overlay merged in, and then EVERY value derived
  // from plant config derived again from that merged block — see CompiledSpecies for why.
  const species = SPECIES.map((def) => {
    const plant = mergeDeep(structuredClone(raw.plant), def.overlay);

    // Photosynthetic temperature response: an inverted parabola clipped at zero. Pure multiplication,
    // so this could be evaluated inline — it lives in a LUT anyway so that swapping in a fancier
    // curve later cannot accidentally reintroduce a transcendental into the hot path.
    const tempCurve = new Float32Array(N);
    const { tempOptimalC, tempToleranceC } = plant.photosynthesis;
    for (let i = 0; i < N; i++) {
      const T = loC + ((hiC - loC) * i) / (N - 1);
      const off = (T - tempOptimalC) / tempToleranceC;
      tempCurve[i] = Math.max(0, 1 - off * off);
    }

    return Object.freeze({
      id: def.id,
      name: def.name,
      need: def.need,
      raw: plant,
      tempCurve,
      chance: Object.freeze({ reanchor: rateToChance(1 / plant.uptake.reanchorEveryTicks, dt) }),
    });
  });

  // Daylight: a trapezoid with linear twilight ramps. No sine, so it is exactly reproducible.
  const { dayLengthSimMinutes: len, dayStartMinute: s, dayEndMinute: e, twilightMinutes: tw } = raw.time;
  const dayCurve = new Float32Array(len);
  for (let m = 0; m < len; m++) {
    let v = 0;
    if (m >= s && m <= e) {
      const intoDawn = m - s;
      const intoDusk = e - m;
      v = Math.min(1, Math.min(intoDawn, intoDusk) / Math.max(1, tw));
    }
    dayCurve[m] = Math.max(0, v);
  }

  return Object.freeze({
    raw,
    species: Object.freeze(species),
    dt,
    ticksPerSimDay: Math.round(len / dt),
    capacityCurve,
    dayCurve,
    curveLoC: loC,
    curveHiC: hiC,
  });
}

/**
 * The jar every gas rate in this file was balanced in. A different jar holds a different volume of air.
 */
export const REFERENCE_JAR = { interiorW: 64, interiorH: 32 } as const;

/**
 * The balance with every gas exchange rate scaled to this jar's volume of air.
 *
 * The rates say how far a unit of growth or decay moves the air's CO2 (in ppm) and O2 (in percent).
 * That depends on how much air there is: a unit of sugar fixed out of a jar half the size moves its CO2
 * twice as far. They were balanced in the 64x32 jar, and held fixed when the jar grew to 80x40, so the
 * bigger jar's air behaved as if it were no bigger. Room for 1.56x the plants, drawing on the same
 * air: settled CO2 fell from ~820 ppm to ~650 and kept falling, the starved plants crept up by a node
 * at a time instead of levelling off, and every creep restarted the climax clock. The reference jar
 * reached its climax on day 60; the 80x40 one took 130.
 *
 * Every rate is scaled by the same factor, fixation and release alike, so the carbon loop still closes
 * exactly (see the `sugarCostPerNode` note in species.ts) and the audit needs nothing new. A starting
 * CO2 in ppm is a concentration and already means the same in any jar, as does moss's O2 per ppm.
 *
 * Works on a copy: `main.ts` hands in the shared defaults, and a scaled config must never be scaled again.
 */
function scaleGasToJar(given: BalanceConfig): BalanceConfig {
  const air = (REFERENCE_JAR.interiorW * REFERENCE_JAR.interiorH) / (given.grid.interiorW * given.grid.interiorH);
  if (air === 1) return given;
  const raw = structuredClone(given);
  const ps = raw.plant.photosynthesis;
  ps.co2PpmPerUnit *= air;
  ps.o2PctPerUnit *= air;
  const rs = raw.plant.maintenance;
  rs.co2PpmPerRespiredSugar *= air;
  rs.o2PctPerRespiredSugar *= air;
  raw.decay.co2PpmPerUnit *= air;
  raw.decay.o2PctPerUnit *= air;
  return raw;
}

/** Deep-clone the defaults so a caller can mutate a copy without touching the shared object. */
export function cloneBalance(overrides: DeepPartial<BalanceConfig> = {}): BalanceConfig {
  return mergeDeep(structuredClone(DEFAULT_BALANCE), overrides);
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function mergeDeep<T>(base: T, patch: DeepPartial<T>): T {
  for (const k of Object.keys(patch) as (keyof T)[]) {
    const v = patch[k];
    if (v === undefined) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      mergeDeep(base[k] as object, v as DeepPartial<object>);
    } else {
      base[k] = v as T[keyof T];
    }
  }
  return base;
}

/** Exported for the conservation audit, which needs to know how much water the air is holding. */
export const airCapacityMl = (cfg: CompiledConfig, tempC: number) =>
  sample(cfg.capacityCurve, cfg.curveLoC, cfg.curveHiC, tempC);

/** Photosynthetic temperature response for ONE species — each has its own optimum and tolerance. */
export const tempResponse = (cfg: CompiledConfig, sp: CompiledSpecies, tempC: number) =>
  sample(sp.tempCurve, cfg.curveLoC, cfg.curveHiC, tempC);

function sample(lut: Float32Array, lo: number, hi: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo))) * (lut.length - 1);
  const i = Math.floor(t);
  if (i >= lut.length - 1) return lut[lut.length - 1];
  const f = t - i;
  return lut[i] + (lut[i + 1] - lut[i]) * f;
}

// Re-exported so callers do not need to reach into detmath for the common case.
export { expNeg };

/**
 * A partial balance patch, as tests and harness scenarios write them.
 *
 * Always annotate override parameters with this rather than leaving them inferred as `{}`: an
 * untyped parameter accepts any object, so a misspelled key (`lampMaxLux` for `lampPpfd`) merges
 * into nothing, the config keeps its default, and the test quietly asserts against a jar it never
 * actually configured.
 */
export type Overrides = DeepPartial<BalanceConfig>;

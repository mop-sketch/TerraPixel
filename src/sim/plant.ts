// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Plant node trees, stored as one flat pool.
 *
 * THE LOAD-BEARING INVARIANT: nodes are only ever APPENDED, so `parent[n] < n` always holds.
 * Therefore a single forward sweep over the pool is a root-to-tip traversal (water transport) and a
 * single reverse sweep is tip-to-root (sugar return, subtree aggregation). No recursion, no sorting,
 * no explicit stack, anywhere.
 *
 * This is also why dead nodes are TOMBSTONED (`alive[n] = 0`) and never swap-removed: a swap-remove
 * would silently reparent every cached parent index in the pool and re-point every root's anchor.
 * At ~160 nodes per plant there is nothing to gain by compacting.
 *
 * `firstChild` / `nextSibling` are stored alongside `parent` because parent-only cannot walk
 * downward without an O(N) scan per node, which makes "give resources to my children" and "kill this
 * subtree" O(N^2).
 */

import { Substrate, SUBSTRATES, type SubstrateId } from './config/content.js';
import type { SubstrateGrid } from './grid.js';
import type { SpeciesId } from './config/species.js';
import type { CompiledConfig } from './config/balance.js';

export const NodeKind = { Root: 0, Stem: 1, Leaf: 2, Flower: 3 } as const;
export type NodeKindId = (typeof NodeKind)[keyof typeof NodeKind];

export type PlantStage = 'seed' | 'seedling' | 'vegetative' | 'flowering' | 'dying' | 'dead';

/**
 * Named reasons a plant is in poor condition.
 *
 * The sim has always computed these — each has its own knob in `plant.health` — and then thrown the
 * attribution away by summing them into one float. Keeping the breakdown is what lets the game
 * answer "what is wrong with THIS plant" instead of showing a percentage and leaving the player to
 * guess. Purely observational: nothing in the tick reads these back.
 */
export const enum StressCause {
  Thirst = 0,
  Heat = 1,
  Rot = 2,
  Toxins = 3,
  Mold = 4,
  Starvation = 5,
  /** Senescence. A real loss of condition, but NOT a fault in the jar — see `distress`. */
  Age = 6,
  /** Sap-sucking pests feeding on the leaves. See `stepPests`. */
  Pests = 7,
  /** Pesticide residue past what the plant can take. See the `spray` command. */
  Pesticide = 8,
}
export const STRESS_CAUSE_COUNT = 9;

/**
 * Which input is currently capping photosynthesis — Liebig's law of the minimum, which the
 * photosynthesis loop already applies and then discards.
 *
 * This answers a different question from stress: a plant can be in perfect health and still not
 * growing, and "why won't it grow" is the question players actually ask.
 */
export const enum GrowthLimiter {
  /** Not sampled — the plant has no leaves, or it is night and every plant is trivially dark. */
  None = 0,
  Light = 1,
  Air = 2,
  Water = 3,
  Warmth = 4,
  /** Nothing is wrong: its sugar store is full and it has downregulated on purpose. */
  StoreFull = 5,
}

export interface Plant {
  id: number;
  /** Which species' parameters this plant lives by. Set at seeding and never changes. */
  species: SpeciesId;
  /** Node id of the base. Every node in this plant walks up to here. */
  crown: number;
  stage: PlantStage;
  nodeIds: number[];
  rootCount: number;
  leafCount: number;
  /** Total live nodes. Sets both the maintenance bill and the reserve the growth gate demands. */
  liveNodes: number;
  /**
   * The largest this plant has ever been. Growth back up to this mark is REPLACEMENT and is cheap;
   * growth beyond it is EXPANSION and has to pay the full reserve.
   *
   * Without the distinction, the anti-overshoot reserve also blocks a mature plant from replacing
   * leaves lost to old age: the canopy thins, income falls, the reserve becomes even less affordable,
   * and the plant starves to a bare stem in a jar that is otherwise perfectly healthy.
   */
  peakNodes: number;
  /** Live water held in tissue, and what the tissue can hold. Their ratio throttles root uptake. */
  waterMl: number;
  waterCapMl: number;
  /**
   * Mineral nutrients drawn from the soil and banked for building new tissue. Kept separate from
   * sugar because they come from a different place and run out on a different clock: sugar is made
   * from light, nutrients can only be mined from the substrate or recycled by decomposers.
   */
  nutrients: number;
  /** Mean stress across live nodes, including ordinary ageing. Drives health. */
  stress: number;
  /**
   * Mean stress EXCLUDING senescence — the part of the plant's discomfort a player could actually do
   * something about.
   *
   * A mature canopy always contains leaves dying of old age, so raw stress never returns to zero even
   * in a flawless jar. Reporting that as the plant's condition reads as a permanent unexplained
   * problem, and gating flowering on it would punish a jar for the one thing it is supposed to do.
   */
  distress: number;
  /** Set while CO2 is below the stall threshold: growth freezes but nothing dies. */
  co2Stalled: boolean;
  /** Set while the mineral bank is empty: same freeze, different cause and different fix. */
  nutrientStarved: boolean;
  /** Consecutive sim-minutes this plant has spent below the flowering stress ceiling. */
  calmMinutes: number;
  /** Sim-minutes a seedling has been stalled — in sugar debt and not growing. Counts toward death. */
  barrenMinutes: number;
  /** Flowers set so far. The jar's score, and the reason to hold a balance rather than survive one. */
  flowers: number;
  /**
   * Mean stress contributed by each `StressCause`, on the same scale as `stress` and `distress` so
   * the parts are directly comparable to the whole.
   *
   * Allocated once per plant and written in place — this is filled from the hottest loop in the sim,
   * and a fresh array per tick would be the only allocation in it.
   */
  stressBy: Float32Array;
  /** What is currently capping this plant's photosynthesis. Sampled in daylight only. */
  limiter: GrowthLimiter;
  /**
   * Pesticide residue carried by the plant, in doses. Builds with each spray that reaches it and wears
   * off on its own. Past `pesticide.safeResidue` it poisons the plant; at `lethalResidue` it kills it.
   */
  pesticide: number;
  /**
   * Doses counted toward a pesticide COURSE so far, 0 until one is started. A course is started by
   * spraying a plant that visibly has pests, and completing it makes the plant immune for a while.
   */
  courseDoses: number;
  /** Tick of the last dose that counted toward the course. */
  courseLastTick: number;
  /**
   * This plant has been through a full pesticide course and cannot be infested again, ever.
   *
   * Earned only that way. Pruning the pests off, or a healthy plant holding them down by itself, both
   * clear an infestation without earning anything, and it can always come back. Deliberately silent:
   * nothing in the jar or the panel announces it.
   */
  pestImmune: boolean;
  /**
   * Sim-minutes this plant has spent VISIBLY infested, drained faster than it fills once the pests are
   * knocked back. Drives entrenchment: how dug-in the colony has become, and therefore how much it
   * hurts, how hard it spreads, and whether the plant can shake it off at all. See `stepPests`.
   */
  infestedMinutes: number;
  /**
   * Pests with nowhere to sit: what a colony has left when the last infested leaf falls and the plant
   * has no other leaf to take them. Reseeds the canopy as it regrows, and drains away if it does not.
   */
  pestReservoir: number;
  /**
   * This plant's own hardiness against pests, around 1. Scales both the age at which it stops
   * resisting and the trouble it takes to make it vulnerable, so no two plants in a jar run to the
   * same schedule.
   */
  pestVigour: number;
  /**
   * Whether this plant's colony is actively growing. A dormant colony needs a random spark before it
   * takes off, even once conditions allow — see `stepPests`. Cleared again when it is suppressed.
   */
  pestAwake: boolean;
}

export class NodePool {
  count = 0;

  readonly kind: Uint8Array;
  readonly plantId: Int16Array;
  readonly parent: Int16Array;
  readonly firstChild: Int16Array;
  readonly nextSibling: Int16Array;
  readonly depth: Uint8Array;

  /** Continuous grid-space position, so art can bend and sway without moving the sim. */
  readonly x: Float32Array;
  readonly y: Float32Array;

  /**
   * Root anchor stored as COORDINATES, not a cached cell index. Same cost to read, but it survives
   * any future grid resize or soil-settling feature that would silently corrupt a cached index.
   */
  readonly cellX: Uint8Array;
  readonly cellY: Uint8Array;

  /**
   * Float64 to match `SubstrateGrid.moisture`. Water crosses between the grid and these nodes every
   * tick, and mixing Float32 with Float64 rounds on every transfer — enough drift to make the
   * closed-system audit unable to distinguish rounding from a real leak.
   */
  readonly water: Float64Array;
  /** Float32 is fine here: sugar is not part of the conserved-water audit. */
  readonly sugar: Float32Array;
  readonly health: Float32Array;
  readonly growth: Float32Array;
  readonly alive: Uint8Array;
  /** Ticks a root has spent unable to draw, before it tries to re-anchor. */
  readonly starve: Uint16Array;
  /** Nodes are skipped on the tick they are born, so a new leaf cannot bank a free tick. */
  readonly spawnTick: Uint32Array;
  /**
   * Sim-minutes this particular leaf lives before age starts costing it health, jittered per node.
   *
   * The jitter is load-bearing, not flavour. A plant's first flush of leaves is all created within a
   * few hundred ticks of each other, so a single shared lifespan makes the entire canopy age out on
   * the same tick — the plant loses every leaf simultaneously, has no income to grow a replacement,
   * and dies in a jar that is otherwise perfectly healthy.
   */
  readonly lifespan: Float32Array;
  /**
   * Sap-sucking pest load on this node, 0-1. Leaves only; zero everywhere else.
   *
   * Stored on the NODE rather than the plant so that every way a leaf leaves the jar takes its pests
   * with it for free — pruning (`killSubtree`), shedding and whole-plant death all go through
   * `release`, which clears it. That is what makes the prune tool the cure without any pest-specific
   * code in the prune path at all.
   */
  readonly pests: Float32Array;

  constructor(capacity: number) {
    this.kind = new Uint8Array(capacity);
    this.plantId = new Int16Array(capacity).fill(-1);
    this.parent = new Int16Array(capacity).fill(-1);
    this.firstChild = new Int16Array(capacity).fill(-1);
    this.nextSibling = new Int16Array(capacity).fill(-1);
    this.depth = new Uint8Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.cellX = new Uint8Array(capacity);
    this.cellY = new Uint8Array(capacity);
    this.water = new Float64Array(capacity);
    this.sugar = new Float32Array(capacity);
    this.health = new Float32Array(capacity);
    this.growth = new Float32Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.starve = new Uint16Array(capacity);
    this.spawnTick = new Uint32Array(capacity);
    this.lifespan = new Float32Array(capacity);
    this.pests = new Float32Array(capacity);
  }

  /**
   * Slots freed by whole-plant death, available for reuse.
   *
   * Kept sorted ascending so `takeSlot` can return the lowest safe index and the pool stays compact.
   * Populated ONLY when an entire plant dies — never by ordinary leaf drop, because dropped leaves
   * stay linked to their parent on purpose so `findDeadLeaf`/`reviveLeaf` can reuse them in place.
   * Cross-plant reuse is only safe for nodes that have been fully unlinked.
   */
  private readonly freeSlots: number[] = [];

  get capacity(): number {
    return this.kind.length;
  }

  /** How many slots are currently reclaimable — surfaced for tests and the debug overlay. */
  get freeSlotCount(): number {
    return this.freeSlots.length;
  }

  /**
   * Take a slot for a new node: a reclaimed one where that is safe, otherwise a fresh append.
   *
   * A reclaimed slot is only usable if its index is GREATER than the parent's, because the entire
   * traversal strategy rests on `parent < child` — one forward sweep is root-to-tip and one reverse
   * sweep is tip-to-root, with no recursion anywhere. Handing a node a slot below its own parent
   * would quietly invert that and make water flow the wrong way through the plant.
   */
  private takeSlot(parent: number): number {
    for (let k = 0; k < this.freeSlots.length; k++) {
      const slot = this.freeSlots[k];
      if (slot > parent) {
        this.freeSlots.splice(k, 1);
        return slot;
      }
    }
    if (this.count >= this.capacity) return -1;
    return this.count++;
  }

  /** Take a node slot. Returns -1 when the pool is full, which callers must treat as "refund". */
  spawn(
    kind: NodeKindId,
    plantId: number,
    parent: number,
    x: number,
    y: number,
    tick: number,
    lifespan = 0,
  ): number {
    const n = this.takeSlot(parent);
    if (n < 0) return -1;
    this.kind[n] = kind;
    this.plantId[n] = plantId;
    this.parent[n] = parent;
    this.firstChild[n] = -1;
    this.nextSibling[n] = -1;
    this.depth[n] = parent >= 0 ? this.depth[parent] + 1 : 0;
    this.x[n] = x;
    this.y[n] = y;
    this.cellX[n] = 0;
    this.cellY[n] = 0;
    this.water[n] = 0;
    this.sugar[n] = 0;
    this.health[n] = 1;
    this.growth[n] = 0;
    this.alive[n] = 1;
    this.starve[n] = 0;
    this.spawnTick[n] = tick;
    this.lifespan[n] = lifespan;
    // A reclaimed slot must not inherit the colony of whatever leaf held it before.
    this.pests[n] = 0;

    if (parent >= 0) {
      // Append to the end of the sibling list so draw order matches growth order.
      let c = this.firstChild[parent];
      if (c < 0) {
        this.firstChild[parent] = n;
      } else {
        while (this.nextSibling[c] >= 0) c = this.nextSibling[c];
        this.nextSibling[c] = n;
      }
    }
    return n;
  }

  /**
   * Kill one node and everything hanging off it. Relies on `parent < child` to stay O(N).
   * Returns the millilitres of water the dead nodes were holding: the caller MUST put it somewhere
   * (normally back into the jar air), or the closed-system audit will catch the leak.
   */
  killSubtree(n: number, grid: SubstrateGrid, litterPerNode = 0): number {
    let freedMl = 0;
    const doomed = new Set<number>([n]);
    for (let i = n; i < this.count; i++) {
      if (!this.alive[i]) continue;
      if (i !== n && !doomed.has(this.parent[i])) continue;
      doomed.add(i);
      const isRoot = this.kind[i] === NodeKind.Root;
      const cell = isRoot
        ? grid.idx(this.cellX[i], this.cellY[i])
        : grid.surfaceOfColumn[Math.max(1, Math.min(grid.w - 2, Math.round(this.x[i] - 0.5)))];
      freedMl += this.release(i, grid);
      // Dead tissue becomes litter, wherever it died. Letting nodes simply vanish would delete the
      // carbon and the nutrients that went into building them, which shows up as a steady unexplained
      // drain on the jar's whole economy.
      if (litterPerNode > 0 && cell >= 0) grid.organic[cell] += litterPerNode;
    }
    return freedMl;
  }

  /**
   * Tombstone a single node, giving back whatever it held. Returns its water in millilitres, which
   * the caller is responsible for re-homing.
   */
  release(n: number, grid: SubstrateGrid): number {
    if (!this.alive[n]) return 0;
    this.alive[n] = 0;
    // Pests go wherever the leaf goes. This single line is the whole of pruning's effect on them.
    this.pests[n] = 0;
    if (this.kind[n] === NodeKind.Root) {
      const i = grid.idx(this.cellX[n], this.cellY[n]);
      if (grid.rootCount[i] > 0) grid.rootCount[i]--;
    }
    const ml = this.water[n];
    this.water[n] = 0;
    return ml;
  }

  /**
   * Retire an entire plant and hand every one of its slots back for reuse.
   *
   * Each node is UNLINKED from its parent's child chain before being freed, and that step is the whole
   * reason this is safe. A freed slot will be handed to some other plant's node; if the old parent's
   * `firstChild`/`nextSibling` chain still pointed at it, that parent would be walking a child now
   * owned by a different plant — corrupting `findDeadLeaf`, resource transport and health aggregation
   * all at once, in a way that would be extremely hard to trace back here.
   *
   * Returns the water the plant was holding, which the caller must re-home.
   */
  retirePlant(nodeIds: readonly number[], grid: SubstrateGrid, litterPerNode = 0): number {
    let freedMl = 0;
    for (const n of nodeIds) {
      if (this.alive[n]) {
        const cell =
          this.kind[n] === NodeKind.Root
            ? grid.idx(this.cellX[n], this.cellY[n])
            : grid.surfaceOfColumn[Math.max(1, Math.min(grid.w - 2, Math.round(this.x[n] - 0.5)))];
        freedMl += this.release(n, grid);
        if (litterPerNode > 0 && cell >= 0) grid.organic[cell] += litterPerNode;
      }
      this.unlink(n);
    }

    // Sorted ascending so `takeSlot` hands out the lowest safe index and the pool stays compact.
    for (const n of nodeIds) {
      if (!this.freeSlots.includes(n)) this.freeSlots.push(n);
    }
    this.freeSlots.sort((a, b) => a - b);
    return freedMl;
  }

  /** Detach a node from its parent's child chain so its slot can be safely handed to another plant. */
  private unlink(n: number): void {
    const p = this.parent[n];
    if (p >= 0) {
      if (this.firstChild[p] === n) {
        this.firstChild[p] = this.nextSibling[n];
      } else {
        for (let c = this.firstChild[p]; c >= 0; c = this.nextSibling[c]) {
          if (this.nextSibling[c] === n) {
            this.nextSibling[c] = this.nextSibling[n];
            break;
          }
        }
      }
    }
    this.parent[n] = -1;
    this.firstChild[n] = -1;
    this.nextSibling[n] = -1;
    this.plantId[n] = -1;
    this.alive[n] = 0;
  }

  anchorRoot(n: number, grid: SubstrateGrid, x: number, y: number): void {
    const prev = grid.idx(this.cellX[n], this.cellY[n]);
    if ((this.cellX[n] !== 0 || this.cellY[n] !== 0) && grid.rootCount[prev] > 0) grid.rootCount[prev]--;
    this.cellX[n] = x;
    this.cellY[n] = y;
    grid.rootCount[grid.idx(x, y)]++;
    this.x[n] = x + 0.5;
    this.y[n] = y + 0.5;
  }

  /**
   * Bring a tombstoned LEAF back into service in its original slot.
   *
   * This is how the pool survives leaf turnover. Leaves senesce and drop continuously, so a pool that
   * only ever appends fills with tombstones and `spawn` starts silently returning -1 — after which the
   * plant can never replace a leaf again and quietly strips itself bare in a perfectly healthy jar.
   *
   * Reviving in place is safe precisely BECAUSE a leaf is terminal: its index and its parent link are
   * unchanged, so the `parent < child` invariant that every sweep depends on still holds exactly. A
   * general free list would not be safe, since reusing a slot for a node with children could easily
   * seat a parent after its own child.
   */
  reviveLeaf(n: number, tick: number, lifespan: number): void {
    this.alive[n] = 1;
    this.kind[n] = NodeKind.Leaf;
    this.health[n] = 1;
    this.growth[n] = 0;
    this.water[n] = 0;
    this.sugar[n] = 0;
    this.starve[n] = 0;
    this.spawnTick[n] = tick;
    this.lifespan[n] = lifespan;
    this.pests[n] = 0;
  }

  /** A dead leaf hanging off this parent that can be brought back, or -1. */
  findDeadLeaf(parent: number): number {
    for (let c = this.firstChild[parent]; c >= 0; c = this.nextSibling[c]) {
      if (!this.alive[c] && this.kind[c] === NodeKind.Leaf) return c;
    }
    return -1;
  }

  /** Live water held by every node, needed by the closed-system conservation audit. */
  totalWaterMl(): number {
    let sum = 0;
    for (let n = 0; n < this.count; n++) if (this.alive[n]) sum += this.water[n];
    return sum;
  }

  /** Dev assert for the invariant the whole traversal strategy rests on. */
  assertInvariant(): void {
    for (let n = 0; n < this.count; n++) {
      const p = this.parent[n];
      if (p >= n) throw new Error(`node ${n} has parent ${p}: parent < child invariant broken`);
    }
  }
}

/**
 * How a root reacts when the player changes the substrate under it. Tiered deliberately, because
 * this is a game-design decision as much as a data-integrity one.
 */
export type AnchorVerdict = 'ok' | 'barren' | 'exposed';

export function checkAnchor(pool: NodePool, n: number, grid: SubstrateGrid): AnchorVerdict {
  const s = grid.substrate[grid.idx(pool.cellX[n], pool.cellY[n])] as SubstrateId;
  if (SUBSTRATES[s].rootable) return 'ok';
  // Air or glass means the root is hanging in open space: sharp, memorable, kills the subtree.
  if (s === Substrate.Air || s === Substrate.Glass) return 'exposed';
  // Gravel or charcoal: the root lives but cannot draw, and will try to re-anchor. Forgiving,
  // so amending near roots is costly rather than instantly fatal.
  return 'barren';
}

/**
 * Find an unoccupied rootable neighbour, biased toward moisture. Used both by growth and by a
 * barren root trying to re-anchor, so the two behave consistently.
 */
export function bestRootCell(
  cfg: CompiledConfig,
  grid: SubstrateGrid,
  fromX: number,
  fromY: number,
  preferDown: boolean,
): { x: number; y: number } | null {
  const cap = cfg.raw.plant.uptake.rootsPerCellMax;
  let best: { x: number; y: number } | null = null;
  let bestScore = -Infinity;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const x = fromX + dx;
      const y = fromY + dy;
      if (!grid.isInterior(x, y)) continue;
      const i = grid.idx(x, y);
      if (!SUBSTRATES[grid.substrate[i] as SubstrateId].rootable) continue;
      if (grid.rootCount[i] >= cap) continue;
      // Roots seek water, and seek downward while the plant is still establishing.
      let score = grid.saturation(i) * 2 + grid.nutrients[i] * 0.1;
      if (preferDown) score += dy * 0.75;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}

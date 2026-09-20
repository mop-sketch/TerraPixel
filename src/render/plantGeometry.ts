// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Plant geometry for the art, kept free of any browser API so the test suite can run it under Node.
 *
 * Everything here turns simulation state into shape, and nothing here ever writes back: how thick a
 * stem is at a given height, which way a leaf points and how far it droops when thirsty, the eased
 * per-slot state that keeps that droop from twitching, and how bushy moss looks where springtails
 * crowd.
 */

/** A leaf's local drawing frame, in logical pixels. */
export interface LeafFrame {
  /** Where the leaf attaches: its stem node. */
  ox: number;
  oy: number;
  /** Unit vector along the leaf, stem to tip, after any drooping. */
  ax: number;
  ay: number;
  /** Unit vector perpendicular to the leaf, on its UPPER side. */
  nx: number;
  ny: number;
  /** Distance from the stem node to the leaf node, before species scaling. */
  len: number;
  /** -1 for a leaf on the left of its stem, 1 on the right. */
  side: -1 | 1;
}

/** How far a fully wilted leaf rotates downward about its attachment: about 55 degrees. */
export const MAX_DROOP_RAD = 0.96;

/**
 * A constant hang applied to every leaf on top of its thirst, as a fraction of `MAX_DROOP_RAD`.
 *
 * Real foliage sags a little even when it is perfectly turgid; leaves radiating dead straight from a
 * stem read as a diagram of a plant rather than a plant. Deliberately far below the wilt range — about
 * seven degrees against fifty-five — so a genuinely drooping plant still means thirst, and the blade
 * narrowing that accompanies real wilt is driven by thirst ALONE, never by this.
 */
export const LEAF_HANG = 0.12;

/** How far the reach of a drawn blade is from its stem, in cells — the offset `growLeaf` itself uses. */
export const LEAF_REACH = 1.05;

/** Half the angle between two blades that would otherwise stack: about 18 degrees either way. */
export const LEAF_FAN = 0.32;

/**
 * A small extra splay per rank, so a stem allowed MORE than three leaves still separates them.
 *
 * With `leavesPerStem` at its current maximum of three, a stem carries at most two leaves per side and
 * the alternating tilt alone does the work. This term only matters if that quota is ever raised, and it
 * is here so that raising it degrades gracefully instead of stacking rank 2 back onto rank 0.
 */
export const LEAF_RANK_STEP = 0.13;

/**
 * Which way a leaf swings to clear the blades around it: -1 tilts it up, +1 down.
 *
 * Blades overlapped for two separate reasons, and one rule fixes both. WITHIN a stem, the two leaves on
 * the same side sit half a cell apart — about 22 degrees — while a blade is roughly 22 degrees wide at
 * its midpoint, so each covered half of the other. BETWEEN stems, every stem puts its first leaf on the
 * left at the same angle and stem nodes are one cell apart, while a blade is about 1.24 cells wide.
 *
 * Alternating on `rank + host cell` separates both cases at once: successive ranks on one stem tilt
 * opposite ways, and the whole pattern inverts on the stem above. The host's x is in the sum so that a
 * branch running alongside its own trunk does not tilt its leaves in step with it.
 *
 * Deliberately keyed to the HOST CELL rather than to a sibling scan. Leaves senesce constantly, and an
 * angle derived from "how many live siblings do I have" would make every remaining blade on a stem jump
 * the instant one of them dropped.
 */
export function leafTilt(hostX: number, hostY: number, rank: number): -1 | 1 {
  return ((rank + Math.round(hostX) + Math.round(hostY)) & 1) === 0 ? -1 : 1;
}

/**
 * Which leaf of its side this is: 0 for the first, 1 for the next one down, and so on.
 *
 * Recovered from the half-cell step `growLeaf` applies per PAIR, which makes it stable for the life of
 * the leaf and identical for the left and right of a stem.
 */
export function leafRank(dy: number): number {
  return Math.max(0, Math.round(dy * 2));
}

/**
 * Stem width at a node: thickest at the crown, thinning toward the tip.
 *
 * `depth` is the node's hops above the crown and `maxDepth` the plant's tallest stem, so the taper is
 * proportional to each plant's own height rather than fixed — a seedling is not drawn as a stub of
 * mature trunk.
 */
export function stemWidth(depth: number, maxDepth: number, base: number, tipFrac = 0.35): number {
  const t = maxDepth > 0 ? Math.min(1, Math.max(0, depth / maxDepth)) : 0;
  return base * (1 - t * (1 - tipFrac));
}

/**
 * Wilt from a leaf's tissue water, 0 (turgid) to 1 (limp).
 *
 * Deliberately the same measure `plantInternal` uses for leaf dehydration stress —
 * `1 − min(1, water / leafWaterNeed)` — so a drooping leaf means exactly what the Selected plant card's
 * "Thirst" means.
 */
export function wiltOf(water: number, leafWaterNeed: number): number {
  if (leafWaterNeed <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - water / leafWaterNeed));
}

/**
 * The frame a leaf is drawn in: attached at its stem, pointing toward its leaf node on its own side,
 * rotated downward by `wilt`.
 *
 * Rotation is signed by side so a left leaf droops down as well, not up, and it stops at hanging
 * straight down — a leaf never folds back under its own stem.
 */
export function leafFrame(
  sx: number,
  sy: number,
  lx: number,
  ly: number,
  wilt: number,
  tilt = 0,
): LeafFrame {
  const dx = lx - sx;
  const dy = ly - sy;
  const len = Math.hypot(dx, dy) || 1;
  const side: -1 | 1 = dx < 0 ? -1 : 1;
  // `tilt` rides on top of wilt in the leaf's OWN sense, so positive is downward on either side.
  const theta = side * (Math.min(1, Math.max(0, wilt)) * MAX_DROOP_RAD + tilt);
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  let ax = (dx / len) * cos - (dy / len) * sin;
  let ay = (dx / len) * sin + (dy / len) * cos;
  // Rotating past vertical would flip the leaf to the other side of the stem.
  if (side === 1 ? ax < 0 : ax > 0) {
    ax = 0;
    ay = 1;
  }
  const nx = side === 1 ? ay : -ay;
  const ny = side === 1 ? -ax : ax;
  return { ox: sx, oy: sy, ax, ay, nx, ny, len, side };
}

/**
 * Per-pool-slot eased values, for presentation.
 *
 * Leaf water swings from tick to tick, so drawing wilt raw makes leaves twitch; easing smooths it. The
 * trap is slot recycling: `NodePool.retirePlant` hands a dead plant's slots to other plants, so the
 * eased value must RESET whenever a slot's `spawnTick` changes, or a fresh seedling would inherit the
 * droop of whatever leaf died in that slot before it.
 */
export class SlotEase {
  private readonly value: Float32Array;
  private readonly born: Float64Array;

  constructor(capacity: number) {
    this.value = new Float32Array(capacity);
    this.born = new Float64Array(capacity).fill(-1);
  }

  /** Ease slot `n` toward `target`; snaps straight to it the first time a slot is seen, or reborn. */
  step(n: number, spawnTick: number, target: number, rate: number): number {
    if (this.born[n] !== spawnTick) {
      this.born[n] = spawnTick;
      this.value[n] = target;
      return target;
    }
    this.value[n] += (target - this.value[n]) * rate;
    return this.value[n];
  }
}

/**
 * Mean springtails per cell, as a fraction of the per-cell cap, at which moss starts to look bushy —
 * and at which it is fully bushy.
 *
 * Both numbers were originally guessed, at 0.08 and 0.5, and then measured against what jars actually
 * produce: the densest column in a thriving jar carries only about 20-24% of the per-cell cap. Ramped
 * against a curve that did not finish until 50%, bushes never drew above roughly a third of their
 * intended size however well the jar was doing — a feature calibrated for a crowd the simulation never
 * makes, and correct by its own arithmetic the whole time.
 *
 * Re-pitched onto the range that really occurs, so a well-kept colony reaches a full cushion.
 */
export const BUSH_START = 0.03;
export const BUSH_FULL = 0.22;

/**
 * Moss cover counted as a FULL mat for the purpose of bushiness.
 *
 * Not 1, because 1 never happens. Moss grows only in daylight and dies back around the clock, so
 * per-cell cover asymptotes near 0.68 and a well-kept jar measures about 0.56. Scaling bushiness by raw
 * cover therefore capped it at roughly half however thickly the springtails swarmed — the same mistake
 * as the crowding ramp above, made twice in the same function: calibrating against a maximum the
 * simulation cannot produce.
 */
export const COVER_FULL = 0.6;

/**
 * How bushy moss looks in a column, 0..1: moss cover times how crowded the springtails are.
 *
 * `popNearSurface` is the population summed over the surface cell and the two cells below it, where a
 * colony actually lives. Purely a look: it never creates moss the simulation doesn't have, which is
 * why too little cover returns zero no matter how many springtails there are.
 */
export function mossBushiness(cover: number, popNearSurface: number, cap: number): number {
  if (cover < 0.2 || cap <= 0) return 0;
  const crowd = (popNearSurface / 3 / cap - BUSH_START) / (BUSH_FULL - BUSH_START);
  return Math.min(1, Math.max(0, crowd)) * Math.min(1, cover / COVER_FULL);
}

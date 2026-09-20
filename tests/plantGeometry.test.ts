// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Plant art geometry: stem taper, leaf direction and drooping, eased per-slot state, and moss bushes.
 *
 * Runs under Node because plantGeometry.ts deliberately uses no browser API.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_DROOP_RAD,
  SlotEase,
  leafFrame,
  mossBushiness,
  stemWidth,
  wiltOf,
} from '../src/render/plantGeometry.js';

describe('plant geometry', () => {
  it('tapers stems: thickest at the crown, never widening toward the tip', () => {
    let prev = Infinity;
    for (let d = 0; d <= 10; d++) {
      const w = stemWidth(d, 10, 3);
      expect(w).toBeLessThanOrEqual(prev);
      prev = w;
    }
    expect(stemWidth(0, 10, 3)).toBe(3);
    expect(stemWidth(10, 10, 3)).toBeCloseTo(3 * 0.35);
    // A seedling with nothing above its crown is not drawn as a thin stub.
    expect(stemWidth(0, 0, 3)).toBe(3);
  });

  it('points a leaf away from its stem toward its own side, with its upper side up', () => {
    const right = leafFrame(10, 10, 11.05, 10.22, 0);
    expect(right.side).toBe(1);
    expect(right.ax).toBeGreaterThan(0);
    expect(right.ny).toBeLessThan(0);

    const left = leafFrame(10, 10, 8.95, 9.78, 0);
    expect(left.side).toBe(-1);
    expect(left.ax).toBeLessThan(0);
    expect(left.ny).toBeLessThan(0);
  });

  it('droops a thirsty leaf downward on either side, and never past hanging straight down', () => {
    const fresh = leafFrame(10, 10, 11, 10, 0);
    const wilted = leafFrame(10, 10, 11, 10, 1);
    expect(wilted.ay).toBeGreaterThan(fresh.ay);
    expect(Math.atan2(wilted.ay, wilted.ax)).toBeCloseTo(MAX_DROOP_RAD);

    // A left leaf droops down too, not up.
    expect(leafFrame(10, 10, 9, 10, 1).ay).toBeGreaterThan(0);

    // A leaf already pointing mostly down stops at vertical rather than folding under its stem.
    const hanging = leafFrame(10, 10, 10.2, 11, 1);
    expect(hanging.ax).toBeGreaterThanOrEqual(0);
    expect(hanging.ay).toBeCloseTo(1);
  });

  it('measures wilt from tissue water the same way leaf thirst does', () => {
    expect(wiltOf(0.35, 0.35)).toBe(0);
    expect(wiltOf(0.7, 0.35)).toBe(0);
    expect(wiltOf(0.175, 0.35)).toBeCloseTo(0.5);
    expect(wiltOf(0, 0.35)).toBe(1);
    expect(wiltOf(-1, 0.35)).toBe(1);
  });

  it('eases toward its target, but resets when a recycled slot is reborn', () => {
    const e = new SlotEase(4);
    expect(e.step(2, 100, 1, 0.1)).toBe(1); // first sight snaps
    let v = 1;
    for (let k = 0; k < 5; k++) v = e.step(2, 100, 0, 0.1);
    expect(v).toBeGreaterThan(0.5); // still easing: a leaf perks up gradually

    // Same slot, new spawnTick: a different leaf now lives here and must not inherit the old droop.
    expect(e.step(2, 250, 0, 0.1)).toBe(0);
  });

  it('bushes moss only where there is moss and a crowd of springtails', () => {
    expect(mossBushiness(0, 120, 40)).toBe(0); // no moss, however many springtails
    expect(mossBushiness(1, 3, 40)).toBe(0); // moss, but only a few springtails

    // Sampled INSIDE the ramp, which now spans roughly 4 to 26 springtails summed across three cells.
    // The old samples of 30 and 45 both sit past the top of it and would clamp to 1, making a
    // "more crowding means more bush" assertion pass on two identical numbers.
    const some = mossBushiness(1, 8, 40);
    const more = mossBushiness(1, 16, 40);
    expect(some).toBeGreaterThan(0);
    expect(more).toBeGreaterThan(some);

    expect(mossBushiness(1, 120, 40)).toBe(1);
    // Thin cover still holds bushiness back, but it is scaled against the cover a jar can REACH
    // (COVER_FULL), not against a full mat that never occurs.
    expect(mossBushiness(0.3, 120, 40)).toBeCloseTo(0.5, 2);
  });

  it('treats the cover a real mat reaches as a full mat', () => {
    // Per-cell cover asymptotes near 0.68 and measures about 0.56 in a well-kept jar. Scaling by raw
    // cover therefore capped bushes near half no matter how the springtails swarmed.
    const cap = 40;
    const swarm = 0.3 * cap * 3;
    expect(mossBushiness(0.6, swarm, cap)).toBeCloseTo(1, 2);
    expect(mossBushiness(0.56, swarm, cap)).toBeGreaterThan(0.9);
  });

  it('reaches a real cushion at the crowding a thriving jar actually produces', () => {
    /*
     * The regression this exists for, and the reason the first version looked like nothing.
     *
     * The ramp was pitched to finish at half the per-cell cap. Measured, a healthy jar's densest column
     * only ever reaches about 20-24% of it, so bushes never drew past roughly a third of their size in
     * play. Every unit test passed the whole time, because they all sampled crowding levels the
     * simulation cannot actually reach.
     *
     * So this asserts against the measurement rather than against the formula: at the density a real
     * jar produces, the moss has to look genuinely bushy.
     */
    const cap = 40;
    const denseColumn = 0.2 * cap * 3; // 20% of cap, summed over the three cells a colony occupies
    expect(mossBushiness(1, denseColumn, cap)).toBeGreaterThan(0.8);
  });
});

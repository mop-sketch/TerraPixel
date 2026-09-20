// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The balance matrix, as a test.
 *
 * This is the point of the whole harness: "is the game balanced?" stops being a question you answer by
 * playing for an afternoon and becomes one CI answers in a minute. Each target states what a scenario
 * is FOR, and fails with the specific number that drifted — so a future tuning change that quietly
 * breaks a failure mode, or lets a jar invent carbon, cannot land unnoticed.
 *
 * The bounds are deliberately loose. They exist to catch a system that has fallen out of its intended
 * role, not to pin every number in place and make each future adjustment a test failure.
 */

import { describe, expect, it } from 'vitest';
import { checkTarget, runScenario, SCENARIOS, TARGETS } from '../tools/harness.js';

describe('balance matrix', () => {
  for (const target of TARGETS) {
    it(`${target.scenario}: ${target.intent}`, () => {
      const result = checkTarget(target, runScenario(SCENARIOS[target.scenario], target.days));
      // Reported as a joined string so a failure names every broken expectation at once rather than
      // making you re-run to discover the next one.
      expect(result.failures.join('; ')).toBe('');
    });
  }
});

describe('the decomposers earn their place', () => {
  /**
   * The cross-scenario comparison the per-scenario targets cannot express. If a jar with springtails
   * does not measurably beat the identical jar without them, the entire decomposer system is
   * decoration and should be cut rather than tuned.
   */
  it('buys more plant, more blooms, and far less standing litter', () => {
    const withFauna = runScenario(SCENARIOS['overplanted-fauna'], 40);
    const without = runScenario(SCENARIOS.overplanted, 40);
    const a = withFauna.samples.at(-1)!;
    const b = without.samples.at(-1)!;

    expect(a.liveNodes).toBeGreaterThan(b.liveNodes * 1.1);
    expect(a.flowers).toBeGreaterThan(b.flowers * 1.2);
    expect(a.litter).toBeLessThan(b.litter * 0.5);
  });

  it('shows the same advantage in a lightly planted jar', () => {
    const withFauna = runScenario(SCENARIOS['well-built'], 40);
    const without = runScenario(SCENARIOS['no-fauna'], 40);
    const a = withFauna.samples.at(-1)!;
    const b = without.samples.at(-1)!;

    expect(a.liveNodes).toBeGreaterThan(b.liveNodes);
    expect(a.litter).toBeLessThan(b.litter * 0.25);
    // Recycled litter is recycled carbon, so the air stays richer too.
    expect(a.co2).toBeGreaterThan(b.co2);
  });
});

describe('carbon conservation', () => {
  /**
   * A sealed jar cannot gain or lose carbon; it can only move it between the air, living tissue,
   * stored sugar, and leaf litter. Sustained drift means the loop is inventing or destroying it, and
   * no tuning elsewhere can compensate — this caught a 35% leak where dying roots vanished without
   * leaving litter, and flowers cost more sugar than they ever returned.
   */
  for (const name of ['well-built', 'overplanted-fauna', 'swampy'] as const) {
    it(`holds across a sim-month of ${name}`, () => {
      const r = runScenario(SCENARIOS[name], 30);
      expect(r.error).toBeUndefined();
      const first = r.samples[0].carbon;
      const last = r.samples.at(-1)!.carbon;
      expect(Math.abs((last - first) / first)).toBeLessThan(0.03);
    });
  }
});

describe('the reference jar is genuinely unattended', () => {
  it('survives two sim-months on one watering, with no failure ever tripping', () => {
    const r = runScenario(SCENARIOS['well-built'], 60);
    expect(r.error).toBeUndefined();
    expect(r.died).toBe(false);
    expect(r.failures).toEqual([]);
    expect(r.samples.at(-1)!.flowers).toBeGreaterThan(60);
  });
});

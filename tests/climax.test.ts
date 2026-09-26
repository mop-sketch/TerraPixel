// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The climax: the jar's ending, reached when it has stopped getting bigger.
 */

import { describe, expect, it } from 'vitest';
import { compile, cloneBalance, REFERENCE_JAR } from '../src/sim/config/balance.js';
import { SCENARIOS, runScenario } from '../tools/harness.js';

/** The sim-day a scenario first reaches its climax, or -1 if it never does within `days`. */
function climaxDay(name: string, days: number): number {
  let day = -1;
  runScenario(SCENARIOS[name], days, 60, (w, tick) => {
    if (day < 0 && w.phase === 'climax') day = tick / 1440;
  });
  return day;
}

describe('the climax', () => {
  it('is reached by the reference jar in the full-size jar, not endlessly put off by slow creep', () => {
    // It took 121 days when any new record, however small, restarted the clock: the bigger jar's plants
    // creep up by a node every few days forever. Measured at 42 with growth taken over the window.
    const day = climaxDay('well-built', 75);
    expect(day).toBeGreaterThan(30);
    expect(day).toBeLessThan(75);
  });

  it('is not declared on a dim jar still slowly filling in', () => {
    // The trap a margin fell into once, tested hour to hour: fern-shade "finished" on day 12 with two
    // plants. Over the window its slow growth still counts.
    const day = climaxDay('fern-shade', 45);
    expect(day).toBe(-1);
  });
});

describe('the air in a bigger jar', () => {
  it('moves less for the same growth, by the ratio of the jars', () => {
    const ref = compile(cloneBalance({ grid: { ...REFERENCE_JAR, cornerRadius: 5 } })).raw;
    const big = compile(cloneBalance({ grid: { interiorW: 128, interiorH: 64, cornerRadius: 6 } })).raw;
    expect(big.plant.photosynthesis.co2PpmPerUnit).toBeCloseTo(ref.plant.photosynthesis.co2PpmPerUnit / 4, 12);
    expect(big.plant.maintenance.co2PpmPerRespiredSugar).toBeCloseTo(ref.plant.maintenance.co2PpmPerRespiredSugar / 4, 12);
    expect(big.decay.co2PpmPerUnit).toBeCloseTo(ref.decay.co2PpmPerUnit / 4, 12);
    expect(big.decay.o2PctPerUnit).toBeCloseTo(ref.decay.o2PctPerUnit / 4, 18);
  });

  it('is scaled once only: compiling never touches the config it is handed', () => {
    const given = cloneBalance();
    const before = given.decay.co2PpmPerUnit;
    compile(given);
    compile(given);
    expect(given.decay.co2PpmPerUnit).toBe(before);
  });
});

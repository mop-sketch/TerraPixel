// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
import { describe, expect, it } from 'vitest';
import { airCapacityMl, cloneBalance, compile, type Overrides } from '../src/sim/config/balance.js';
import { humidity, stepCondensation, stepTemperature } from '../src/sim/atmosphere.js';
import { World } from '../src/sim/world.js';
import { tick } from '../src/sim/tick.js';
import { expNeg, pow2 } from '../src/sim/detmath.js';

function sealedJar(overrides: Overrides = {}) {
  const w = new World(cloneBalance(overrides));
  w.commands.push({ t: 'layerBands', gravelRows: 4, charcoalRows: 3, soilRows: 9 });
  w.commands.push({ t: 'seal' });
  tick(w);
  return w;
}

describe('condensation hysteresis', () => {
  it('does not chatter when humidity is parked on the threshold', () => {
    const cfg = compile(cloneBalance());
    const a = {
      tempC: 21,
      airWaterMl: 0,
      co2Ppm: 900,
      o2Pct: 21,
      airCells: 1000,
      condensing: false,
      fogged: false,
      glassWaterMl: 0,
      lidOpen: false,
      lampIntensity: 0,
    };
    const cap = airCapacityMl(cfg, a.tempC);

    let toggles = 0;
    let prev = a.condensing;
    // Derived from the config, never hardcoded: this used to pin RH at 86.5% because the trigger was
    // 86, and silently stopped testing anything the moment fogging and condensing were split onto
    // separate thresholds and condensation moved to 95.
    const justOver = (cfg.raw.atmosphere.condensation.onHumidity + 0.5) / 100;
    for (let i = 0; i < 500; i++) {
      // Hold RH pinned just above the trigger every tick — the worst case for a bare threshold.
      a.airWaterMl = cap * justOver;
      stepCondensation(cfg, a, () => {});
      if (a.condensing !== prev) {
        toggles++;
        prev = a.condensing;
      }
    }
    // A bare threshold with instant transfer gives a two-tick limit cycle: hundreds of toggles.
    expect(toggles).toBeLessThanOrEqual(1);
    expect(a.condensing).toBe(true);
  });

  it('releases discrete droplets only once the glass has enough water for a bead', () => {
    const cfg = compile(cloneBalance());
    const a = {
      tempC: 21,
      airWaterMl: airCapacityMl(cfg, 21) * 0.99,
      co2Ppm: 900,
      o2Pct: 21,
      airCells: 1000,
      condensing: false,
      fogged: false,
      glassWaterMl: 0,
      lidOpen: false,
      lampIntensity: 0,
    };
    const drops: number[] = [];
    for (let i = 0; i < 200; i++) stepCondensation(cfg, a, (ml) => drops.push(ml));

    expect(drops.length).toBeGreaterThan(0);
    // Every bead is exactly one quantum, which is what makes the visual read as beads running down.
    for (const ml of drops) expect(ml).toBeCloseTo(cfg.raw.atmosphere.condensation.dropletMassMl, 6);
  });

  it('never lets the air hold more water than its capacity', () => {
    const cfg = compile(cloneBalance());
    const a = {
      tempC: 21,
      airWaterMl: airCapacityMl(cfg, 21) * 3, // deliberately supersaturated
      co2Ppm: 900,
      o2Pct: 21,
      airCells: 1000,
      condensing: false,
      fogged: false,
      glassWaterMl: 0,
      lidOpen: false,
      lampIntensity: 0,
    };
    stepCondensation(cfg, a, () => {});
    expect(humidity(cfg, a)).toBeLessThanOrEqual(100.001);
  });
});

describe('humidity is derived, not stored', () => {
  it('falls when the jar warms, without any water moving', () => {
    const cfg = compile(cloneBalance());
    const a = {
      tempC: 20,
      airWaterMl: airCapacityMl(cfg, 20) * 0.9,
      co2Ppm: 900,
      o2Pct: 21,
      airCells: 1000,
      condensing: false,
      fogged: false,
      glassWaterMl: 0,
      lidOpen: false,
      lampIntensity: 0,
    };
    const before = humidity(cfg, a);
    const waterBefore = a.airWaterMl;
    a.tempC = 30;
    const after = humidity(cfg, a);

    expect(a.airWaterMl).toBe(waterBefore); // not a drop of water moved
    expect(after).toBeLessThan(before); // yet the fog clears
    expect(after).toBeCloseTo(before / 2, 1); // capacity doubles per +10 C
  });
});

describe('thermal inertia', () => {
  it('makes the lamp a slow lever rather than an instant switch', () => {
    const cfg = compile(cloneBalance());
    const a = {
      tempC: 21,
      airWaterMl: 0,
      co2Ppm: 900,
      o2Pct: 21,
      airCells: 1000,
      condensing: false,
      fogged: false,
      glassWaterMl: 0,
      lidOpen: false,
      lampIntensity: 1,
    };
    stepTemperature(cfg, a);
    // One tick must move the temperature only a fraction of the way to the target.
    expect(a.tempC).toBeLessThan(22);

    for (let i = 0; i < 500; i++) stepTemperature(cfg, a);
    const target = cfg.raw.thermal.ambientC + cfg.raw.thermal.lampDeltaC;
    expect(a.tempC).toBeCloseTo(target, 1);
  });
});

describe('gas commit ordering', () => {
  it('is not sensitive to how many air cells the jar happens to have at commit time', () => {
    // A crowded jar must swing FURTHER on the same respiration, not differently in kind.
    const roomy = sealedJar();
    const tight = sealedJar();
    tight.baseAirCells = tight.atmo.airCells * 4;

    roomy.delta.co2Ppm = -10;
    tight.delta.co2Ppm = -10;
    const before = roomy.atmo.co2Ppm;
    tick(roomy);
    tick(tight);
    expect(before - roomy.atmo.co2Ppm).toBeLessThan(before - tight.atmo.co2Ppm);
  });
});

describe('deterministic math', () => {
  it('approximates exp(-x) closely enough to be indistinguishable in gameplay', () => {
    for (const x of [0, 0.01, 0.1, 0.5, 1, 2, 5, 12]) {
      expect(expNeg(x)).toBeCloseTo(Math.exp(-x), 8);
    }
  });

  it('approximates 2^x without calling Math.pow', () => {
    for (const x of [-3.5, -1, 0, 0.5, 1, 2.25, 7]) {
      expect(pow2(x)).toBeCloseTo(Math.pow(2, x), 6);
    }
  });
});

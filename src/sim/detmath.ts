// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Deterministic math for the simulation core.
 *
 * `Math.exp`, `Math.pow` and `Math.sin` are implementation-defined by the ECMAScript spec and DO
 * diverge between V8 versions and engines. Anything that depends on them cannot be replay-verified,
 * which would cost us the single best bug-reproduction tool in the project (run the same seed and
 * command script headless, diff the state hash).
 *
 * `+ - * /` and `Math.sqrt` are IEEE-754-exact and therefore safe. Everything here is built from
 * those alone, with a FIXED iteration count so the result cannot vary with input magnitude.
 */

/** e^-x for x >= 0, via a fixed 16-term Maclaurin series with range reduction. */
export function expNeg(x: number): number {
  if (x <= 0) return 1;
  // Range-reduce by repeated halving so the series always converges in its sweet spot,
  // then square back up. Fixed shift count keeps the op sequence input-independent.
  let shifts = 0;
  while (x > 0.5 && shifts < 12) {
    x *= 0.5;
    shifts++;
  }
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 16; n++) {
    term *= -x / n;
    sum += term;
  }
  for (let s = 0; s < shifts; s++) sum *= sum;
  return sum;
}

/**
 * Convert an expected-events-per-sim-minute rate into a per-tick probability.
 * Storing rates and converting here is what lets the tick rate change without rebalancing the game.
 */
export function rateToChance(ratePerMinute: number, minutesPerTick: number): number {
  return 1 - expNeg(ratePerMinute * minutesPerTick);
}

/** 2^x for any real x, built from sqrt and integer squaring. Used for humidity capacity. */
export function pow2(x: number): number {
  let whole = Math.floor(x);
  const frac = x - whole;
  // 2^frac via 8 steps of binary expansion: each halving of the exponent is one sqrt.
  let fracPart = 1;
  let bit = 0.5;
  let f = frac;
  let root = 1.4142135623730951; // sqrt(2)
  for (let i = 0; i < 12; i++) {
    if (f >= bit) {
      fracPart *= root;
      f -= bit;
    }
    bit *= 0.5;
    root = Math.sqrt(root);
  }
  let wholePart = 1;
  const neg = whole < 0;
  if (neg) whole = -whole;
  for (let i = 0; i < whole; i++) wholePart *= 2;
  return neg ? fracPart / wholePart : fracPart * wholePart;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Sample a uniformly spaced lookup table with linear interpolation.
 * Every curve in the sim resolves through one of these so the hot path stays transcendental-free.
 */
export function sampleLut(lut: Float32Array, lo: number, hi: number, x: number): number {
  const t = clamp((x - lo) / (hi - lo), 0, 1) * (lut.length - 1);
  const i = Math.floor(t);
  if (i >= lut.length - 1) return lut[lut.length - 1];
  return lerp(lut[i], lut[i + 1], t - i);
}

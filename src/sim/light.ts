// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Per-cell light field.
 *
 * Without this, there is no reason for a plant to have a SHAPE: branching has no spatial strategy,
 * shading is meaningless, and the whole node-tree architecture degenerates into `growth += leafCount`.
 * Two passes over ~2,000 cells per tick, which is the cheapest structural upgrade in the project.
 *
 * Light enters through the lid and attenuates through every leaf above a given cell, so a canopy
 * genuinely starves the growth below it — which is what makes pruning a decision.
 */

import { NodeKind, type NodePool } from './plant.js';
import type { SubstrateGrid } from './grid.js';
import type { CompiledConfig } from './config/balance.js';

export class LightField {
  readonly value: Float32Array;
  /** Leaf occupancy per cell, rebuilt each tick from the node pool. */
  private readonly leaves: Uint8Array;

  constructor(private readonly grid: SubstrateGrid) {
    this.value = new Float32Array(grid.size);
    this.leaves = new Uint8Array(grid.size);
  }

  /** Minute of the sim-day, 0 .. dayLengthSimMinutes-1. The one place this formula lives. */
  static minuteOfDay(cfg: CompiledConfig, tickCount: number): number {
    const t = cfg.raw.time;
    return Math.floor(t.startMinute + tickCount * cfg.dt) % t.dayLengthSimMinutes;
  }

  /** Daylight fraction for the current sim-minute. A trapezoid, so no transcendentals. */
  static dayFraction(cfg: CompiledConfig, tickCount: number): number {
    return cfg.dayCurve[LightField.minuteOfDay(cfg, tickCount)];
  }

  compute(cfg: CompiledConfig, pool: NodePool, lampIntensity: number, tickCount: number): void {
    const g = this.grid;
    const c = cfg.raw.light;

    this.leaves.fill(0);
    for (let n = 0; n < pool.count; n++) {
      if (!pool.alive[n]) continue;
      if (pool.kind[n] !== NodeKind.Leaf) continue;
      const x = Math.round(pool.x[n] - 0.5);
      const y = Math.round(pool.y[n] - 0.5);
      if (!g.isInterior(x, y)) continue;
      const i = g.idx(x, y);
      if (this.leaves[i] < 255) this.leaves[i]++;
    }

    // Ambient daylight plus the lamp. Both enter from above, so one top-down column sweep does it.
    const incident =
      c.nightPpfd + (c.lampPpfd - c.nightPpfd) * Math.max(LightField.dayFraction(cfg, tickCount), 0) * lampIntensity;

    for (let x = 1; x <= g.w - 2; x++) {
      let lit = incident;
      for (let y = 1; y <= g.h - 2; y++) {
        const i = g.idx(x, y);
        this.value[i] = lit;
        // A leaf shades everything under it, including its own cell's neighbours below.
        for (let k = 0; k < this.leaves[i]; k++) lit *= c.attenuationPerLeafAbove;
        // Solid substrate is opaque: nothing below the soil line receives light.
        if (g.props(i).solid) lit = 0;
      }
    }
  }

  at(x: number, y: number): number {
    if (!this.grid.isInterior(x, y)) return 0;
    return this.value[this.grid.idx(x, y)];
  }

  atNode(pool: NodePool, n: number): number {
    return this.at(Math.round(pool.x[n] - 0.5), Math.round(pool.y[n] - 0.5));
  }
}

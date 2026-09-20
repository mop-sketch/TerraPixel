// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Player intent, queued rather than applied immediately.
 *
 * Input handlers push commands; the tick drains them at exactly one point (phase 0). Nothing outside
 * `drainCommands` may mutate world state. That is what makes the sim replayable: a seed plus an
 * ordered command log reproduces a run exactly.
 */

import type { SubstrateId } from './config/content.js';
import type { SpeciesId } from './config/species.js';

export type Command =
  | { t: 'paint'; x: number; y: number; material: SubstrateId }
  | { t: 'layerBands'; gravelRows: number; charcoalRows: number; soilRows: number }
  /**
   * Pour water onto a column.
   *
   * `spread` is the watering can's rose: the number of columns each side that also get wetted, with
   * `ml` divided between them rather than multiplied. Omitted (or 0) means a single column gets the
   * exact amount — which is what the balance harness and the water tests rely on, so the default
   * must stay that way.
   */
  | { t: 'water'; x: number; ml: number; spread?: number }
  | { t: 'plantSeed'; x: number; species: SpeciesId }
  /** Seed a springtail culture into the substrate at this column. */
  | { t: 'addSpringtails'; x: number; y: number }
  /** Plant a moss patch on this column's surface. */
  | { t: 'addMoss'; x: number }
  | { t: 'prune'; node: number }
  /** Spray pesticide over one whole plant: every leaf it has, and exactly one dose. */
  | { t: 'spray'; plant: number }
  | { t: 'setLamp'; intensity: number }
  | { t: 'setLid'; open: boolean }
  | { t: 'seal' };

export class CommandQueue {
  private pending: Command[] = [];
  /** Every command ever applied, in order. A seed plus this log reproduces the run exactly. */
  readonly log: Array<{ tick: number; cmd: Command }> = [];

  push(cmd: Command): void {
    this.pending.push(cmd);
  }

  drain(tick: number, apply: (cmd: Command) => void): void {
    if (this.pending.length === 0) return;
    const batch = this.pending;
    this.pending = [];
    for (const cmd of batch) {
      this.log.push({ tick, cmd });
      apply(cmd);
    }
  }

  get depth(): number {
    return this.pending.length;
  }
}

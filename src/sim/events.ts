// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Events the sim emits for the renderer, audio and UI to consume.
 *
 * This is the ONLY channel from sim to presentation. The sim never calls into a renderer, and the
 * renderer never writes sim state — which is what lets the whole core run headless under Node.
 */

export type FailureMode = 'dehydration' | 'rootRot' | 'mold' | 'co2Stall' | 'faunaO2' | 'pests';

export type SimEvent =
  /** A bead detached from the glass and is falling down column x. */
  | { t: 'droplet'; x: number; ml: number }
  | { t: 'dropletLanded'; cell: number; ml: number }
  | { t: 'watered'; cell: number; ml: number }
  /** Granular substrate moved this tick, so anything caching the jar's shape should re-read it. */
  | { t: 'substrateSettled' }
  | { t: 'nodeSpawned'; node: number; kind: number }
  | { t: 'leafDropped'; node: number; cell: number }
  | { t: 'rootSevered'; node: number; reason: 'exposed' | 'amended' | 'sickened' }
  | { t: 'rootReanchored'; node: number }
  | { t: 'flowered'; node: number }
  /** A plant that had lost every leaf pushed out a new one from stored sugar. */
  | { t: 'resprouted'; plant: number }
  | { t: 'springtailsAdded'; cell: number }
  | { t: 'mossPlanted'; cell: number }
  /** Crossed 40% of a failure counter: the player's window to act. */
  | { t: 'warning'; mode: FailureMode }
  | { t: 'warningCleared'; mode: FailureMode }
  | { t: 'failure'; mode: FailureMode }
  | { t: 'plantDied'; plant: number }
  /** A plant was sprayed with pesticide. */
  | { t: 'sprayed'; plant: number }
  /** A plant's pests became visible: a new outbreak, not one that merely dipped out of sight. */
  | { t: 'infested'; plant: number }
  /**
   * A dose landed too soon after the last one to count toward the course.
   *
   * It still killed pests and still left residue — it simply bought no progress. Silent, this is the
   * one way a player can follow the rule and still not finish the course.
   */
  | { t: 'sprayTooSoon'; plant: number }
  /** A plant completed a pesticide course and is now immune to pests. */
  | { t: 'immunised'; plant: number }
  /** A plant took a lethal dose of pesticide. */
  | { t: 'poisoned'; plant: number }
  | { t: 'seeded'; plant: number; from: number; x: number }
  /**
   * A seed the PLAYER tried to plant was turned down, and why.
   *
   * Needed because the refusal has to be visible. A click that silently does nothing reads as a broken
   * button, not as a rule.
   */
  | { t: 'plantRefused'; x: number; reason: 'crowded' | 'unrootable' }
  | { t: 'sealed' }
  /** The jar filled its space and settled: growth stops, the overgrowth begins. */
  | { t: 'climaxReached' }
  /** Pruning (or anything else that reopened the jar) released it back to tending. */
  | { t: 'climaxEnded' };

/** A droplet in flight. Lands `remaining` ticks from now, crediting the soil then. */
export interface Droplet {
  x: number;
  y: number;
  ml: number;
  remaining: number;
}

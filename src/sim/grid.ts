// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The substrate grid: a padded structure-of-arrays.
 *
 * Why SoA at only ~2,000 cells (it is NOT about speed — the whole tick is ~0.1 ms):
 *  1. Double-buffering for diffusion is a memcpy (`next.set(cur)`), not a deep copy.
 *  2. Whole-world state is ~22 KB, which makes binary save/load, deterministic replay,
 *     rewind-debugging, and cell-by-cell diffing of two headless runs essentially free.
 *  3. Zero GC churn in a loop that runs for hours.
 *
 * Why padded: the grid carries a one-cell Glass border and the jar silhouette is baked into
 * `substrate` at init. Glass is impermeable, so every neighbour loop in the sim is branch-free and
 * no water routine ever needs a bounds check. The simulation has no concept of "jar shape" at all.
 */

import { Substrate, SUBSTRATES, type SubstrateId, type SubstrateProps } from './config/content.js';
import type { CompiledConfig } from './config/balance.js';
import type { Rng } from './rng.js';

export class SubstrateGrid {
  readonly w: number;
  readonly h: number;
  readonly size: number;

  readonly substrate: Uint8Array;
  /**
   * Absolute millilitres. NOT a percentage — always compare via `saturation()`.
   *
   * Float64 rather than Float32 specifically for the closed-system audit: summing ~2,000 Float32
   * cells accumulates rounding at roughly 1e-5 of the total, which is the same order as the smallest
   * real leak the sim can produce (a single condensation bead). At Float64 the drift is ~1e-12, so the
   * audit tolerance can stay tight enough to actually catch bugs. The extra 9 KB is irrelevant.
   */
  readonly moisture: Float64Array;
  readonly nutrients: Float32Array;
  /** Litter / dead matter. This is mold's food supply, which is what makes mold self-limiting. */
  readonly organic: Float32Array;
  readonly toxin: Float32Array;
  /**
   * Toxin a charcoal cell has permanently BOUND, as opposed to what is loose in the water.
   *
   * Separate from `toxin` because the two behave differently in every way that matters: loose toxin
   * washes between cells with percolating water and is clamped to 1 per cell, whereas bound toxin does
   * not move, does not wash, and accumulates past 1 until the cell is spent. Storing the bound amount
   * in `toxin` instead would collide with that clamp and make a spent layer indistinguishable from
   * merely dirty soil.
   */
  readonly charcoalLoad: Float32Array;
  readonly mold: Float32Array;
  /**
   * 1 where the player dug solid ground out into open space, and so where a Mud click may line a pond.
   *
   * Travels with the open space when material slumps into it, as everything else in a cell does. The
   * liner used to tell a dug hollow from the jar's own rounded bowl by width alone, capped at 24
   * columns, and that cap made every pond wider than it impossible to line at all.
   */
  readonly dug: Uint8Array;
  /**
   * Free water standing in a cell, in millilitres — a puddle, a flooded drainage layer, a pond.
   *
   * Only ever non-zero in Air cells. Material holds its water in `moisture`, inside its pores; this
   * is water with no material to be inside of, which is why it can have a surface and a level.
   */
  readonly standing: Float64Array;
  /** Incrementally maintained reverse index of anchored roots. Never rebuilt per tick. */
  readonly rootCount: Uint8Array;

  /** Diffusion write target. Private so nothing outside the water phase can read a half-state. */
  private readonly moistureNext: Float64Array;

  /**
   * Interior cells that can hold or move water. A view onto `activeBuf`, refreshed by `reindex()`.
   * Backed by one preallocated buffer because settling substrate re-indexes on any tick where
   * material actually moved.
   */
  activeCells: Int32Array;
  private readonly activeBuf: Int32Array;
  /**
   * Just the filtering cells — the charcoal. A view onto `filterBuf`, refreshed by `reindex()`.
   *
   * Worth its own index because the toxin filter runs three passes over it every tick, and charcoal is
   * under a tenth of the jar: scanning every active cell three times instead cost about 40% of the
   * frame rate at 32x, where 320 ticks land per second.
   */
  filterCells: Int32Array;
  private readonly filterBuf: Int32Array;
  /** Topmost solid cell per interior column, or -1. Recomputed with activeCells. */
  surfaceOfColumn: Int32Array;
  /**
   * Where the material now sitting in a cell fell FROM during the most recent `settle()` pass, or -1
   * if that cell did not receive anything this pass. Purely presentational — nothing in the tick reads
   * it back — kept for the same reason `NodePool` keeps continuous x/y instead of a bare cell index:
   * so the renderer can ease a falling grain across the gap between two cells instead of teleporting
   * it a whole 12px every tick, which is what reads as choppy at any speed above a crawl.
   *
   * Reset in full at the top of every `settle()` call, so a grain that has come to rest reports -1
   * again as soon as a further tick passes without it moving.
   */
  readonly fallFrom: Int32Array;

  constructor(interiorW: number, interiorH: number) {
    this.w = interiorW + 2;
    this.h = interiorH + 2;
    this.size = this.w * this.h;

    this.substrate = new Uint8Array(this.size);
    this.moisture = new Float64Array(this.size);
    this.nutrients = new Float32Array(this.size);
    this.organic = new Float32Array(this.size);
    this.toxin = new Float32Array(this.size);
    this.charcoalLoad = new Float32Array(this.size);
    this.mold = new Float32Array(this.size);
    this.dug = new Uint8Array(this.size);
    this.standing = new Float64Array(this.size);
    this.rootCount = new Uint8Array(this.size);
    this.moistureNext = new Float64Array(this.size);
    this.surfaceOfColumn = new Int32Array(this.w).fill(-1);
    this.fallFrom = new Int32Array(this.size).fill(-1);
    this.activeBuf = new Int32Array(this.size);
    this.filterBuf = new Int32Array(this.size);
    this.activeCells = this.activeBuf.subarray(0, 0);
    this.filterCells = this.filterBuf.subarray(0, 0);
  }

  /** y = 0 is the TOP row. Gravity is +y. */
  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  xOf(i: number): number {
    return i % this.w;
  }

  yOf(i: number): number {
    return (i / this.w) | 0;
  }

  props(i: number) {
    return SUBSTRATES[this.substrate[i] as SubstrateId];
  }

  /**
   * Wetness as a fraction of the pore space this material has. 1.0 means waterlogged — no air left
   * in the pores, which is the root-rot condition. Gravel and soil holding identical millilitres read
   * as very different wetness, which is what makes drainage gravel *feel* like drainage gravel.
   */
  saturation(i: number): number {
    const cap = SUBSTRATES[this.substrate[i] as SubstrateId].maxMl;
    return cap > 0 ? this.moisture[i] / cap : 0;
  }

  /** Moisture as a fraction of what the material HOLDS against gravity. Drives plant comfort. */
  wetness(i: number): number {
    const fc = SUBSTRATES[this.substrate[i] as SubstrateId].fieldCapacityMl;
    return fc > 0 ? Math.min(1, this.moisture[i] / fc) : 0;
  }

  isInterior(x: number, y: number): boolean {
    return x >= 1 && y >= 1 && x <= this.w - 2 && y <= this.h - 2;
  }

  /**
   * Bake the padded border plus rounded jar shoulders and base into the Glass sentinel.
   * Everything inside starts as Air.
   */
  bakeJarSilhouette(cornerRadius: number): void {
    this.substrate.fill(Substrate.Air);
    const r = cornerRadius;
    const x0 = 1;
    const x1 = this.w - 2;
    const y1 = this.h - 2;

    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.idx(x, y);
        if (x === 0 || y === 0 || x === this.w - 1 || y === this.h - 1) {
          this.substrate[i] = Substrate.Glass;
          continue;
        }
        // Round only the base corners: a jar has flat shoulders and a curved bottom.
        const dx = x < x0 + r ? x0 + r - x : x > x1 - r ? x - (x1 - r) : 0;
        const dy = y > y1 - r ? y - (y1 - r) : 0;
        if (dx > 0 && dy > 0 && dx * dx + dy * dy > r * r) this.substrate[i] = Substrate.Glass;
      }
    }
    this.reindex();
  }

  /**
   * Recompute the cached active-cell list and per-column surface.
   * Called after any substrate mutation — never per tick.
   */
  reindex(): void {
    let n = 0;
    let f = 0;
    this.surfaceOfColumn.fill(-1);
    for (let y = 1; y <= this.h - 2; y++) {
      for (let x = 1; x <= this.w - 2; x++) {
        const i = this.idx(x, y);
        const props = this.props(i);
        if (props.maxMl > 0) this.activeBuf[n++] = i;
        /*
         * The surface is the topmost SOLID cell, not the topmost water-holding one.
         *
         * Those were the same thing until mud existed. Mud is ground that holds no water at all, so
         * under the old test a lined basin had no surface: the index pointed at the soil *beneath*
         * the liner, and everything that lands on a surface — poured water, fallen litter — went
         * straight through the floor of the pond.
         */
        if (props.solid && this.surfaceOfColumn[x] < 0) this.surfaceOfColumn[x] = i;
        if (props.filters > 0) this.filterBuf[f++] = i;
      }
    }
    this.activeCells = this.activeBuf.subarray(0, n);
    this.filterCells = this.filterBuf.subarray(0, f);
  }

  /**
   * The cells a brush of `radius` centred on (x, y) would change to `material`.
   *
   * A round footprint (radius 0 is the single cell), keeping only cells a paint would actually alter:
   * inside the jar, not glass, and not already that material (spent charcoal excepted, since repainting
   * it is how a player renews a layer; see `World.paint`). A PURE QUERY, called every frame by the
   * brush preview as well as once by the brush itself, so the two can never disagree.
   */
  brushCells(x: number, y: number, radius: number, material: SubstrateId): number[] {
    const out: number[] = [];
    const r2 = radius * radius + radius;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const cx = x + dx;
        const cy = y + dy;
        if (!this.isInterior(cx, cy)) continue;
        const i = this.idx(cx, cy);
        const here = this.substrate[i];
        if (here === Substrate.Glass) continue;
        if (here === material && !(material === Substrate.Charcoal && this.charcoalLoad[i] > 0)) continue;
        out.push(i);
      }
    }
    return out;
  }

  /**
   * Everything a mud liner dropped at (x, y) would do, if that spot is inside a hollow at all.
   *
   * A PURE QUERY: reads the grid, changes nothing, and is safe to call every frame from a hover
   * preview as well as once from the tool that actually paints. That sharing is the whole reason this
   * lives here rather than beside `paint` — the preview and the real thing must never be able to
   * disagree about what a click would do.
   *
   * The rule is the one the water itself obeys: every cell the pond would touch from below or the
   * side has to be something it cannot get into. The clicked row is the level being asked for —
   * walking out to the first column whose ground already stands at or above it finds the rim, so a
   * shallow click lines a shallow pond and a deep one lines to the depth it was clicked at.
   *
   * `liner` is every cell that will turn to mud. `area` is every open cell inside the span at or
   * below the clicked row — roughly where the pond will end up sitting once it is filled — kept
   * separate because a preview draws the two very differently and neither the paint nor the sim has
   * any use for `area` at all.
   *
   * Returns null when there is nothing to line: not open air, open at one end (not a basin at all —
   * lining it would paint a shoreline across open ground and still hold nothing), not DUG (the open air
   * above an undug floor sits between the jar's own rounded corners, which are real walls, and read as
   * one enormous basin), or already lined.
   */
  basinLiner(x: number, y: number): { liner: number[]; area: number[] } | null {
    if (!this.isInterior(x, y) || this.substrate[this.idx(x, y)] !== Substrate.Air) return null;
    /*
     * The click has to be INSIDE a hollow the player dug. Checking only that the span held some dug
     * cell let a click in the air over flat ground on the far side of the jar walk across an existing
     * pond, find ITS dug cells, and line the whole jar between its rounded corners.
     */
    if (this.dug[this.idx(x, y)] !== 1) return null;

    const groundY = (col: number): number => {
      const s = this.surfaceOfColumn[col];
      return s < 0 ? this.h - 1 : this.yOf(s);
    };

    let left = x;
    while (left - 1 >= 1 && groundY(left - 1) > y) left--;
    let right = x;
    while (right + 1 <= this.w - 2 && groundY(right + 1) > y) right++;
    if (left - 1 < 1 || right + 1 > this.w - 2) return null;

    const seen = new Set<number>();
    const liner: number[] = [];
    const area: number[] = [];
    for (let col = left; col <= right; col++) {
      const floorY = groundY(col);
      for (let row = y; row < floorY; row++) {
        const cell = this.idx(col, row);
        // A shelf or an overhang inside the span holds no water, so nothing behind it needs lining.
        if (this.substrate[cell] !== Substrate.Air) continue;
        area.push(cell);
        for (const n of [cell + this.w, cell - 1, cell + 1]) {
          if (n < 0 || n >= this.size) continue;
          const p = this.props(n);
          // Only ground that water could soak INTO needs replacing; glass and mud already hold it,
          // and air is simply more of the pond.
          if (!p.solid || p.maxMl <= 0) continue;
          if (seen.has(n)) continue;
          seen.add(n);
          liner.push(n);
        }
      }
    }
    return liner.length > 0 ? { liner, area } : null;
  }

  /**
   * The one sanctioned way to move water. Clamps both ends and returns what actually moved, so a
   * caller can never invent or destroy millilitres by getting its own arithmetic wrong.
   */
  transfer(from: number, to: number, requested: number): number {
    if (requested <= 0) return 0;
    const room = this.props(to).maxMl - this.moisture[to];
    const moved = Math.min(requested, this.moisture[from], room);
    if (moved <= 0) return 0;

    // Dissolved nutrients travel WITH the water, in proportion to the fraction of the cell's water
    // that left. This is leaching, and it is what connects the fertility loop to the water loop:
    // litter rots on the surface but roots feed below it, so without transport the nutrients released
    // up top can never reach the plant. It also gives over-watering a second cost — flush the root
    // zone hard enough and the fertility ends up in the drainage layer.
    const fraction = moved / Math.max(this.moisture[from], 1e-9);
    const leached = this.nutrients[from] * fraction;
    this.nutrients[from] -= leached;
    this.nutrients[to] += leached;

    // Dissolved decay byproducts travel the same way, and this is the entire reason a charcoal layer
    // works: toxins are produced up at the surface where the litter rots, but the charcoal sits at the
    // bottom of the jar. Without leaching it would only ever clean its own neighbours and the root zone
    // above it would stay sour no matter how much charcoal was placed.
    const washed = this.toxin[from] * fraction;
    this.toxin[from] -= washed;
    this.toxin[to] = Math.min(1, this.toxin[to] + washed);

    this.moisture[from] -= moved;
    this.moisture[to] += moved;
    return moved;
  }

  /** Add water from outside the grid (watering can, landed droplet). Returns the overflow. */
  add(i: number, ml: number): number {
    const room = this.props(i).maxMl - this.moisture[i];
    const taken = Math.min(ml, Math.max(0, room));
    this.moisture[i] += taken;
    return ml - taken;
  }

  /** Remove water to outside the grid (evaporation). Returns what was actually removed. */
  remove(i: number, ml: number): number {
    const taken = Math.min(Math.max(0, ml), this.moisture[i]);
    this.moisture[i] -= taken;
    return taken;
  }

  /**
   * Remove water, but never below a floor. Both claimants in the demand-arbitration phase go through
   * this, so neither can dig into the capillary-bound water the other was promised.
   */
  removeAbove(i: number, ml: number, floorMl: number): number {
    const avail = Math.max(0, this.moisture[i] - floorMl);
    const taken = Math.min(Math.max(0, ml), avail);
    this.moisture[i] -= taken;
    return taken;
  }

  totalWaterMl(): number {
    let sum = 0;
    for (let i = 0; i < this.size; i++) sum += this.moisture[i];
    return sum;
  }

  /**
   * Free water across the jar. Kept OUT of `totalWaterMl`, which means "water held in the substrate"
   * and is read as such by the soil readout and the balance harness; the conservation audit adds the
   * two together itself.
   */
  standingMl(): number {
    let sum = 0;
    for (let i = 0; i < this.size; i++) sum += this.standing[i];
    return sum;
  }

  /** Can free water sit here? Air only — material holds its water in its pores instead. */
  private holdsWater(i: number): boolean {
    return this.substrate[i] === Substrate.Air;
  }

  /**
   * Free water: settles to the bottom of the space it is in, soaks into what it lands on, and levels.
   *
   * ALL OF IT IS INSTANT, and that is a statement about the clock rather than a shortcut. One tick is
   * a sim-MINUTE; water crosses a jar in about a second and a pond is flat long before a minute is up.
   *
   * Levelling used to trade half the difference between neighbouring cells, a few passes a tick. That
   * spreads one cell per pass, so a steady pour (24 mL a tick landing in one spot) outran it: the
   * surface heaped into a hill over the pour point, stepped down toward the banks, and shifted every
   * tick, and a brimming pond stood piled ABOVE its rim instead of spilling. Now each row is levelled
   * whole, in one step, so a body of water is flat at the end of every tick however fast it is fed.
   */
  flowStanding(cfg: CompiledConfig): void {
    const c = cfg.raw.standing;
    const soak = c.soakMlPerMin * cfg.dt;

    /*
     * Most jars never hold a drop, and this runs up to 128 times per frame at the fastest speed. One
     * read-only sweep finds the rows that actually have water; a jar with no pond leaves immediately.
     */
    let loY = this.topStandingRow();
    if (loY < 0) return;

    this.settleStanding(c.cellMl, soak);
    /*
     * Levelling can hand water to a cell the settle has not seen yet (a drop beside a ledge, spilled
     * into) so the two alternate. A few rounds resolve anything one tick's pour can create; what little
     * is left resolves next tick, a tenth of a second later on screen.
     */
    for (let round = 0; round < c.levelPasses; round++) {
      // A spill can lift water a row higher than it started, so the band is re-found each round.
      loY = this.topStandingRow();
      if (loY < 0) return;
      for (let y = this.h - 2; y >= loY; y--) this.levelRow(y, c.cellMl, loY);
      this.settleStanding(c.cellMl, 0);
    }
  }

  /** The highest row holding any free water, or -1 when the jar has none. Stops at the first hit. */
  private topStandingRow(): number {
    for (let y = 1; y <= this.h - 2; y++) {
      const row = y * this.w;
      for (let x = 1; x <= this.w - 2; x++) if (this.standing[row + x] > 0) return y;
    }
    return -1;
  }

  /**
   * Settle and soak, one column at a time.
   *
   * A column is cut into CHAMBERS (runs of open cells with something solid between them) and each
   * chamber settles on its own. That is what stops water in a basin from draining through the shelf
   * it is sitting on: a chamber's floor is whatever is under its lowest cell, and water pools on it
   * rather than continuing past.
   */
  private settleStanding(cap: number, soak: number): void {
    for (let x = 1; x <= this.w - 2; x++) {
      let y = this.h - 2;
      while (y >= 1) {
        if (!this.holdsWater(this.idx(x, y))) {
          y--;
          continue;
        }
        let top = y;
        while (top - 1 >= 1 && this.holdsWater(this.idx(x, top - 1))) top--;

        // Lift the whole chamber's water out, then put it back from the floor up.
        let total = 0;
        for (let k = top; k <= y; k++) {
          const i = this.idx(x, k);
          total += this.standing[i];
          this.standing[i] = 0;
        }

        if (total > 0) {
          // Resting on material: it sinks in at that material's own pace, and stops when the pores
          // are full, which is when a puddle starts to stand rather than soak.
          const below = this.idx(x, y) + this.w;
          if (soak > 0 && below < this.size && !this.holdsWater(below)) {
            const taken = Math.min(total, soak);
            total -= taken - this.add(below, taken);
          }

          let k = y;
          while (total > 0 && k >= top) {
            const put = Math.min(total, cap);
            this.standing[this.idx(x, k)] = put;
            total -= put;
            k--;
          }
          // A chamber handed more than it can hold keeps the surplus rather than losing it; levelling
          // carries it sideways. Conservation is not negotiable even when the arithmetic upstream was.
          if (total > 0) this.standing[this.idx(x, top)] += total;
        }
        y = top - 1;
      }
    }
  }

  /**
   * Level one row of free water in a single step.
   *
   * A row is cut into runs of open cells between solid ones, and each run into SUPPORTED stretches:
   * cells resting on something, either ground or a cell of water that is already full. A supported
   * stretch is one body of water at this height.
   *
   * The stretch takes in everything stacked ABOVE it too, not just what is in the row, and refills from
   * the bottom: this row across the whole stretch first, the rest spread over the row above. Without
   * that, a pond's top row sat a hair short of full after levelling, so the row above never counted as
   * supported; the water a pour stacked over its own columns could only trickle down a sliver per
   * round, and a brimming pond heaped up over the pour point instead of spilling. Refilled this way,
   * the row above is exactly full or not reached at all, and when it is reached its stretch runs on
   * over the rim, which is the spill.
   *
   * An unsupported cell beside a stretch is a drop: open space with nothing under it, like the lip of a
   * deeper hole. Water at the edge of a drop pours over it before it levels, so the stretch empties into
   * it and the next settle carries it down. That is what makes water on a shelf run into the deep part.
   */
  private levelRow(y: number, cap: number, topY: number): void {
    const full = cap - 1e-9;
    const row = y * this.w;
    const supported = (x: number): boolean => {
      const below = row + this.w + x;
      return !this.holdsWater(below) || this.standing[below] >= full;
    };

    let x = 1;
    while (x <= this.w - 2) {
      if (!this.holdsWater(row + x)) {
        x++;
        continue;
      }
      const a = x;
      while (x <= this.w - 2 && this.holdsWater(row + x)) x++;
      const b = x - 1;

      let k = a;
      while (k <= b) {
        if (!supported(k)) {
          k++;
          continue;
        }
        const s = k;
        while (k <= b && supported(k)) k++;
        const e = k - 1;

        // Everything in this stretch and stacked over it, in the same open air.
        let sum = 0;
        for (let i = s; i <= e; i++) {
          // Nothing stands above `topY`, so the gather stops there instead of climbing the whole jar.
          for (let cell = row + i; cell >= topY * this.w && this.holdsWater(cell); cell -= this.w) {
            sum += this.standing[cell];
            this.standing[cell] = 0;
          }
        }
        if (sum <= 0) continue;

        // Over the edge first, split between the drops on either side.
        let drops = 0;
        if (s - 1 >= a) drops++;
        if (e + 1 <= b) drops++;
        for (const d of [s - 1, e + 1]) {
          if (d < a || d > b || drops === 0) continue;
          const share = sum / drops--;
          const moved = Math.min(share, Math.max(0, cap - this.standing[row + d]));
          this.standing[row + d] += moved;
          sum -= moved;
        }

        // Refill from this row up, one row at a time, over the columns still open at each height.
        const len = e - s + 1;
        const level = Math.min(cap, sum / len);
        for (let i = s; i <= e; i++) this.standing[row + i] = level;
        sum -= level * len;
        for (let r = y - 1; r >= 1 && sum > 1e-12; r--) {
          const up = r * this.w;
          let open = 0;
          for (let i = s; i <= e; i++) if (this.openTo(up + i, row + i)) open++;
          if (open === 0) break;
          const per = Math.min(cap, sum / open);
          for (let i = s; i <= e; i++) if (this.openTo(up + i, row + i)) this.standing[up + i] = per;
          sum -= per * open;
        }
        // Nowhere left above: keep it in the row rather than lose it. Conservation first, always.
        if (sum > 0) this.standing[row + s] += sum;
      }
    }
  }

  /** Is `cell` reachable straight up from `from` through open air, with nothing solid between? */
  private openTo(cell: number, from: number): boolean {
    for (let i = from; i >= cell; i -= this.w) if (!this.holdsWater(i)) return false;
    return true;
  }

  // --- granular physics ----------------------------------------------------------------------

  /**
   * Move every cell's contents to another cell, wholesale.
   *
   * Substrate travels WITH its water, nutrients, litter, toxins and mold, because those live in the
   * pores of the material rather than at a fixed address in the jar. Moving the material and leaving
   * its water behind would both read wrong (a dry landslide arriving on wet ground) and break the
   * closed-system audit on the very first collapse.
   *
   * `rootCount` is deliberately NOT swapped: a cell holding roots never moves in the first place.
   */
  private swapCells(a: number, b: number): void {
    const s = this.substrate[a]; this.substrate[a] = this.substrate[b]; this.substrate[b] = s;
    const m = this.moisture[a]; this.moisture[a] = this.moisture[b]; this.moisture[b] = m;
    const n = this.nutrients[a]; this.nutrients[a] = this.nutrients[b]; this.nutrients[b] = n;
    const o = this.organic[a]; this.organic[a] = this.organic[b]; this.organic[b] = o;
    const t = this.toxin[a]; this.toxin[a] = this.toxin[b]; this.toxin[b] = t;
    // Bound toxin travels with the charcoal it is bound to, or a slumping layer would shed its load.
    const cl = this.charcoalLoad[a]; this.charcoalLoad[a] = this.charcoalLoad[b]; this.charcoalLoad[b] = cl;
    const d = this.mold[a]; this.mold[a] = this.mold[b]; this.mold[b] = d;
    // Swapped, not dropped, and that is what makes displacement work: substrate slumping into a
    // puddle sends that water back where the substrate came from instead of deleting it.
    const st = this.standing[a]; this.standing[a] = this.standing[b]; this.standing[b] = st;
    const dg = this.dug[a]; this.dug[a] = this.dug[b]; this.dug[b] = dg;
  }

  /** Nothing may fall into a cell that is occupied or anchoring a root. */
  private isOpen(i: number): boolean {
    return this.substrate[i] === Substrate.Air && this.rootCount[i] === 0;
  }

  /**
   * One pass of granular settling. Returns true if anything actually moved, so the caller can stop
   * re-running (and re-indexing) once the substrate has come to rest.
   *
   * Iterated BOTTOM-UP, exactly as percolation is, so a grain travels at most one cell per tick and a
   * collapsing bank slumps visibly instead of teleporting into its final shape.
   *
   * Two rules give the three materials their distinct characters:
   *  - each falls straight down into open space;
   *  - if blocked, it may slide down-diagonally, at a per-material chance reduced by how wet it is.
   * Gravel runs and self-levels, charcoal stacks, and damp soil holds a bank that dry soil would not.
   */
  settle(rng: Rng): boolean {
    // Reset every call, not just when something moves: the tick that finds nothing left to settle is
    // exactly the tick that must stop reporting a `fallFrom` from further back, or a grain that came
    // to rest several ticks ago would keep re-animating its last hop forever.
    this.fallFrom.fill(-1);
    let moved = false;
    for (let y = this.h - 3; y >= 1; y--) {
      for (let x = 1; x <= this.w - 2; x++) {
        const i = this.idx(x, y);
        const here = this.props(i);
        if (!here.granular) continue;
        // Roots bind the substrate they grow through, which is true of real soil and makes an
        // established plant a structural feature of the jar rather than a passenger in it.
        if (this.rootCount[i] > 0) continue;

        const below = i + this.w;
        if (this.isOpen(below)) {
          this.swapCells(i, below);
          this.fallFrom[below] = i;
          moved = true;
          continue;
        }

        const chance = here.slide * (1 - here.cohesion * this.wetness(i));
        if (chance <= 0 || !rng.chance(chance)) continue;

        // Pick the first side at random so a pile spreads symmetrically; always trying left first
        // would visibly lean every slope in the jar the same way.
        const first = rng.next() < 0.5 ? -1 : 1;
        for (const dx of [first, -first]) {
          if (this.isOpen(i + dx) && this.isOpen(below + dx)) {
            this.swapCells(i, below + dx);
            this.fallFrom[below + dx] = i;
            moved = true;
            break;
          }
        }
      }
    }
    return moved;
  }

  // --- water physics -------------------------------------------------------------------------

  /**
   * Downward percolation, iterated BOTTOM-UP so water moves at most one cell per tick.
   * Top-down would let a droplet fall the full depth of the substrate in a single tick.
   *
   * Only water above field capacity is mobile; the rest is held by capillary action. That single
   * rule is what makes soil "hold" moisture and gravel refuse to.
   */
  percolate(): void {
    for (let y = this.h - 3; y >= 1; y--) {
      for (let x = 1; x <= this.w - 2; x++) {
        const i = this.idx(x, y);
        const here = this.props(i);
        if (here.maxMl <= 0 || this.moisture[i] <= 0) continue;
        const below = i + this.w;
        if (this.props(below).maxMl <= 0) continue;
        // Only the surplus above field capacity is mobile. Water at or below it is capillary-bound.
        const mobile = this.moisture[i] - here.fieldCapacityMl;
        if (mobile <= 0) continue;
        this.transfer(i, below, mobile * here.permeability);
      }
    }
  }

  /**
   * Capillary diffusion across all four neighbours, double-buffered so pass direction cannot bias
   * flow. Writing in place makes water drift left-to-right for free, and players do notice.
   *
   * Two things here are load-bearing:
   *
   * 1. It is FOUR-neighbour, not horizontal-only. With horizontal diffusion alone there is no way for
   *    water to travel downward below field capacity — gravity only moves the surplus above it — so
   *    water lost from the surface and handed back by condensation piles up in the top row while the
   *    root zone underneath is mined dry. A plant then kills itself in about a sim-day inside a jar
   *    that is, in total, perfectly well watered.
   *
   * 2. It equalises WETNESS (moisture against field capacity, capped at 1), not saturation and not
   *    millilitres. Wetness is a stand-in for matric potential, which is what water actually moves
   *    down. Capping it at 1 is what keeps the two water mechanisms cleanly separated:
   *      - gravity percolation moves the surplus ABOVE field capacity downward,
   *      - capillary diffusion equalises potential BELOW field capacity in every direction.
   *    So the drainage layer can wick its reservoir back up into dry soil, but can never push soil
   *    past field capacity and waterlog the roots — which is precisely the job the layer is for.
   */
  diffuse(cfg: CompiledConfig): void {
    const k = cfg.raw.water.diffusionCoefficient;
    for (let s = 0; s < cfg.raw.water.diffusionSubsteps; s++) {
      this.moistureNext.set(this.moisture);
      for (const i of this.activeCells) {
        const here = this.props(i);
        if (here.lateral <= 0) continue;
        this.diffuseInto(i, i - 1, here, k);
        this.diffuseInto(i, i + 1, here, k);
        this.diffuseInto(i, i - this.w, here, k);
        this.diffuseInto(i, i + this.w, here, k);
      }
      this.moisture.set(this.moistureNext);
    }
  }

  /**
   * One directed half-step of the diffusion stencil. Reads the live `moisture` snapshot and writes
   * only into `moistureNext`, which is what keeps the pass symmetric.
   * The Glass border guarantees `n` is in bounds, so there is no check here.
   */
  private diffuseInto(i: number, n: number, here: SubstrateProps, k: number): void {
    const there = this.props(n);
    if (there.lateral <= 0) return;
    const delta = (this.wetness(i) - this.wetness(n)) * Math.min(here.lateral, there.lateral) * k;
    if (delta <= 0) return;
    // Convert the potential gradient back into millilitres. The receiving cell is never filled past
    // its own field capacity by capillary action — anything beyond that only ever arrives by gravity.
    const room = Math.max(0, there.fieldCapacityMl - this.moistureNext[n]);
    const ml = Math.min(delta * here.fieldCapacityMl, this.moistureNext[i], room);
    if (ml <= 0) return;
    this.moistureNext[i] -= ml;
    this.moistureNext[n] += ml;

    // Nutrients ride along with capillary flow too, so fertility released at the surface can work its
    // way down into the root zone instead of sitting on top where nothing can reach it.
    const fraction = ml / Math.max(this.moisture[i], 1e-9);
    const leached = this.nutrients[i] * fraction;
    this.nutrients[i] -= leached;
    this.nutrients[n] += leached;

    const washed = this.toxin[i] * fraction;
    this.toxin[i] -= washed;
    this.toxin[n] = Math.min(1, this.toxin[n] + washed);
  }

  /**
   * Standing water in the drainage layer, surfaced to the player as the sump gauge.
   * Gravel holds almost nothing against gravity, so anything sitting in it IS standing water — which
   * is exactly the reading the player needs to judge whether they are over-watering.
   */
  sumpMl(): number {
    let ml = 0;
    for (const i of this.activeCells) {
      if (this.substrate[i] !== Substrate.Gravel) continue;
      ml += Math.max(0, this.moisture[i] - this.props(i).fieldCapacityMl);
    }
    return ml;
  }
}

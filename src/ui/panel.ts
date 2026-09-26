// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The control panel.
 *
 * Only TWO values are player inputs: the lamp and the lid. Humidity, CO2 and O2 are OUTPUTS the
 * player diagnoses, which is why they are presented as words first ("muggy", "stale") with the raw
 * numbers alongside rather than as dials.
 */

import { describe, humidity } from '../sim/atmosphere.js';
import { LightField } from '../sim/light.js';
import { standardLayers } from '../sim/config/balance.js';
import { Substrate, type SubstrateId } from '../sim/config/content.js';
import type { FailureMode } from '../sim/events.js';
import { SPECIES, SpeciesId } from '../sim/config/species.js';
import { GrowthLimiter, STRESS_CAUSE_COUNT, StressCause, type Plant } from '../sim/plant.js';
import type { World } from '../sim/world.js';
import { GEAR_ICON } from './settings.js';

export type Tool =
  | 'water'
  | 'seedFern'
  | 'seedHerb'
  | 'seedSucculent'
  | 'springtails'
  | 'moss'
  | 'lilies'
  | 'snails'
  | 'hornwort'
  | 'fish'
  | 'reeds'
  | 'clearPond'
  | 'paintGravel'
  | 'paintCharcoal'
  | 'paintSoil'
  | 'paintMud'
  | 'dig'
  | 'prune'
  | 'pesticide';

const TOOL_MATERIAL: Partial<Record<Tool, SubstrateId>> = {
  paintGravel: Substrate.Gravel,
  paintCharcoal: Substrate.Charcoal,
  paintSoil: Substrate.Soil,
  paintMud: Substrate.Mud,
  /*
   * Digging is painting AIR, which is why it needs no new command, no new code path in the sim, and
   * no second way for a cell to change. Everything that makes amending cost something — the spilt
   * water, the damaged roots — applies to excavation unchanged, because it is the same operation.
   */
  dig: Substrate.Air,
};

/** Exactly the shape of TOOL_MATERIAL above: one tool per species, no new UI concept to learn. */
const TOOL_SPECIES: Partial<Record<Tool, SpeciesId>> = {
  seedFern: SpeciesId.Fern,
  seedHerb: SpeciesId.Herb,
  seedSucculent: SpeciesId.Succulent,
};

/**
 * Stale air, in one place, because it is advised from three.
 *
 * ORDER IS THE POINT HERE. Venting comes first because it is the only fix that works immediately:
 * an open lid pulls the jar toward room air at a quarter of the difference per sim-minute, so a jar
 * stalled at 150 ppm is back over the 200 ppm threshold within one sim-minute. Springtails come
 * second because they are what stops it RECURRING — but they eat litter, so in a young jar they do
 * nothing at all for days. Leading with them, as this used to, hands the player the slowest fix and
 * no way to tell it is not working yet.
 */
const STALE_AIR = {
  title: 'The air has gone stale',
  fix: 'Open the lid to let fresh air in, then close it again.',
  lasting:
    ' Springtails recycling litter are what stop it coming back — or prune, which cuts demand and leaves litter for them.',
};

/**
 * How long a warning or failure must stay active, in real milliseconds, before the Diagnosis card
 * shows it. One that clears inside this window is never shown at all.
 *
 * Strike counters sit right at their thresholds in a jar that is only just coping, so a warning can
 * flip on and off within a few frames. Drawn raw, the card popped open, shoved Selected plant down
 * the column, and snapped shut again — which read as a glitch rather than as information. Real time
 * rather than sim time on purpose: at 32x a sim-second is gone before the eye can register it.
 */
const ALERT_HOLD_MS = 1000;

/**
 * How often the readouts are allowed to change, in real milliseconds.
 *
 * 8 Hz: fast enough that the panel feels live and a change you caused shows up immediately, slow
 * enough that a jar running at 128x reads as a jar running fast rather than as a broken display.
 */
const DATA_REFRESH_MS = 125;

/** How much worse another plant must be before the auto-selected card moves to it. */
const AUTO_PLANT_MARGIN = 0.05;

/** What the player should actually DO about each warning. One fix each, never a list. */
const ADVICE: Record<FailureMode, { title: string; fix: string }> = {
  dehydration: { title: 'Roots are drying out', fix: 'Water the soil above them.' },
  rootRot: { title: 'Soil is waterlogged', fix: 'Stop watering — the drainage layer needs depth.' },
  mold: {
    title: 'Mold is taking the root zone',
    fix: 'Open the lid to clear the fog — and springtails graze it.',
  },
  // The jar-wide alert has room for the lasting fix as well as the immediate one.
  co2Stall: { title: STALE_AIR.title, fix: `${STALE_AIR.fix}${STALE_AIR.lasting}` },
  faunaO2: { title: 'Springtails are suffocating', fix: 'More leaves, or vent the lid.' },
  pests: {
    title: 'Pests are spreading through the plants',
    fix: 'Prune the speckled leaves to buy time, or finish a pesticide course — three sprays at least a day apart — and this plant will never be infested again. Keep the lid shut: that is how they get in.',
  },
};

/**
 * One fix per cause, in the player's words. Same discipline as ADVICE above: never a list of things
 * to try, and never a restatement of the number.
 */
const CAUSE: Record<StressCause, { label: string; fix: string; benign?: boolean }> = {
  [StressCause.Thirst]: { label: 'Thirst', fix: 'Water the soil around it.' },
  // Placeholder: temperature stress is symmetric — the same term covers too hot AND too cold, and
  // each species has its own optimum. `tempAdvice` below resolves it against the actual reading,
  // because telling a Succulent (optimum 28 C) to turn the lamp down at 25 C is exactly backwards.
  [StressCause.Heat]: { label: 'Temperature', fix: '' },
  [StressCause.Rot]: {
    label: 'Waterlogged',
    fix: 'Stop watering — the drainage layer should be catching this.',
  },
  [StressCause.Toxins]: { label: 'Sour soil', fix: 'Charcoal under the soil filters this out.' },
  [StressCause.Mold]: { label: 'Mold', fix: 'Vent the lid to clear the fog; springtails graze it.' },
  [StressCause.Starvation]: {
    label: 'Starving',
    // Deliberately vague about the remedy, because starvation is nearly always DOWNSTREAM: a plant
    // that dried out loses its leaves and then starves, and "give it more light" would be flatly
    // wrong advice for someone who simply never watered. The limiter line below names the actual
    // constraint, and `verdict` defers to it — see renderSelected.
    fix: 'It is spending more than it earns.',
  },
  [StressCause.Pests]: {
    label: 'Pests',
    // Pruning is the fix that always works. Healing the plant is the lasting one — a thriving host
    // holds its pests down on its own — but "fix whatever else is wrong" is a list, not a fix, and the
    // diagnosis already names that other cause on its own line.
    fix: 'Prune the speckled leaves before they spread to their neighbours.',
  },
  [StressCause.Pesticide]: {
    label: 'Pesticide',
    // The only cause whose fix is to STOP doing something, which is worth saying plainly: a player
    // watching a sprayed plant yellow will otherwise assume the pests are winning and spray again.
    fix: 'Too much spray. Stop spraying this plant; the residue wears off in a day or two.',
  },
  [StressCause.Age]: {
    label: 'Old age',
    fix: 'Normal. Old leaves yellow and drop, and that litter feeds the soil.',
    benign: true,
  },
};

const LIMITER: Record<GrowthLimiter, { label: string; fix: string }> = {
  [GrowthLimiter.None]: { label: '—', fix: 'Nothing to measure — it has no leaves right now.' },
  [GrowthLimiter.Light]: { label: 'light', fix: 'Raise the lamp, or prune whatever is shading it.' },
  [GrowthLimiter.Air]: { label: 'stale air', fix: STALE_AIR.fix },
  [GrowthLimiter.Water]: { label: 'water', fix: 'Water the soil around it.' },
  [GrowthLimiter.Warmth]: { label: 'temperature', fix: 'Adjust the lamp toward about 24 °C.' },
  [GrowthLimiter.StoreFull]: { label: 'nothing', fix: 'Its sugar store is full — it is doing fine.' },
};

/**
 * Which way the temperature is wrong, for this species, right now.
 *
 * Measured in a real jar at 25.5 C: the Fern (optimum 21 C) reads 9% stress and genuinely wants the
 * lamp turned down, while the Succulent (optimum 28 C) reads 2% and wants the opposite. One shared
 * string for both would be wrong half the time.
 */
function tempAdvice(tempC: number, optimalC: number): { label: string; fix: string } {
  return tempC > optimalC
    ? { label: 'Too warm', fix: 'Turn the lamp down, or open the lid to vent.' }
    : { label: 'Too cool', fix: 'Turn the lamp up to warm the jar.' };
}

export class Panel {
  tool: Tool = 'paintSoil';
  /** Plant id the player last clicked, or null. Cleared when that plant dies. */
  selected: number | null = null;
  /**
   * Eased copy of the shown plant's stress breakdown, for display only.
   *
   * The sim's per-tick attribution is exact and correctly spiky — a struggling plant cycles leaves,
   * so a cause genuinely swings between 0% and 36% within a sim-day. Drawing that raw makes the bars
   * reshuffle several times a second and the card unreadable, so the PANEL eases it. Easing is
   * presentation (see the note at the top of theme.ts), which is why it lives here and not in the
   * sim: tests and the harness still read the exact numbers.
   */
  private shownBy = new Float32Array(STRESS_CAUSE_COUNT);
  /** Wall-clock time of the last data refresh. See the cadence note in `update`. */
  private lastDataMs = -Infinity;
  /** Eased display values for the fastest-moving readouts, keyed by gauge. See `eased`. */
  private readonly shownValue = new Map<string, number>();
  private shownFor: number | null = null;
  /** The speed the PLAYER chose. Never overwritten by the pour override — see `effectiveSpeed`. */
  speed = 1;
  paused = false;
  /**
   * Set by the driver while the player is actively pouring water.
   *
   * Watering at 16x or 32x is close to unusable: the pour is driven by REAL elapsed time, so the
   * stream rate is fixed while the jar percolates, evaporates and drinks sixteen times faster
   * around it. You are filling a sieve, and you cannot see where the water is going.
   */
  pouring = false;
  private pouringShown = false;
  /**
   * The speed the buttons are currently showing.
   *
   * Needed because `speed` can now change from OUTSIDE the panel: a jar that reaches its climax drops
   * to 1x from the frame loop. Without this edge, the jar would slow down while the 32x button stayed
   * lit — the UI flatly contradicting what the world was doing.
   */
  private speedShown = 1;
  private readonly root: HTMLElement;
  private readonly refs: Record<string, HTMLElement> = {};
  /** When each failure mode became active, in `performance.now()` ms. Cleared the moment it lapses. */
  private readonly alertSince = new Map<FailureMode, number>();

  constructor(
    host: HTMLElement,
    private readonly world: World,
    private readonly onDebugToggle: (on: boolean) => void,
  ) {
    // `host` is the whole app shell. Each region is filled on its own — never the shell itself, which
    // also holds the canvas the Renderer is already drawing into. Every lookup below still searches
    // `this.root`, so wiring does not care which region a control ended up in.
    this.root = host;
    this.root.querySelector<HTMLElement>('#topbar')!.innerHTML = TOPBAR;
    this.root.querySelector<HTMLElement>('#tray')!.innerHTML = TRAY;
    this.root.querySelector<HTMLElement>('#notes')!.innerHTML = NOTES;
    this.root.querySelectorAll<HTMLElement>('[data-ref]').forEach((el) => {
      this.refs[el.dataset.ref!] = el;
    });
    this.wire();
    this.tool = 'paintSoil';
    this.syncTools();
    this.showTab(loadTab());
  }

  /**
   * Show one Tend tab and hide the other. The selected tool is left alone: switching tab to look at
   * what the other one holds should not put down what is in your hand.
   */
  private showTab(tab: TendTab): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    this.root.querySelectorAll<HTMLElement>('[data-panel]').forEach((p) => {
      p.hidden = p.dataset.panel !== tab;
    });
    saveTab(tab);
  }

  /**
   * Brush size, 1 to BRUSH_MAX: 1 paints a single cell, each step up widens the round footprint by a
   * cell on every side. Only the Build tools use it.
   */
  brushSize = 1;

  /** The brush's radius in cells, as the sim command takes it. */
  brushRadius(): number {
    return this.brushSize - 1;
  }

  /** Grow or shrink the brush by one step, within its limits. */
  resizeBrush(step: number): void {
    this.brushSize = Math.max(1, Math.min(BRUSH_MAX, this.brushSize + step));
    this.refs.brushSize.textContent = String(this.brushSize);
    (this.refs.brushDown as HTMLButtonElement).disabled = this.brushSize <= 1;
    (this.refs.brushUp as HTMLButtonElement).disabled = this.brushSize >= BRUSH_MAX;
  }

  material(): SubstrateId | null {
    return TOOL_MATERIAL[this.tool] ?? null;
  }

  /** The species the selected seed tool plants, or null if the current tool is not a seed tool. */
  species(): SpeciesId | null {
    return TOOL_SPECIES[this.tool] ?? null;
  }

  private wire(): void {
    const w = this.world;

    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.addEventListener('click', () => {
        this.tool = b.dataset.tool as Tool;
        this.syncTools();
      });
    });

    // The Land / Aquatic tabs: click, or the arrow keys between them, as tabs are expected to work.
    const tabs = Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-tab]'));
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => this.showTab(b.dataset.tab as TendTab));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
        this.showTab(next.dataset.tab as TendTab);
        next.focus();
      });
    });

    this.refs.brushDown.addEventListener('click', () => this.resizeBrush(-1));
    this.refs.brushUp.addEventListener('click', () => this.resizeBrush(1));
    this.resizeBrush(0);

    this.refs.bands.addEventListener('click', () => {
      w.commands.push({ t: 'layerBands', ...standardLayers(w.cfg.raw.grid.interiorH) });
      // The layers are the jar ready to plant, so the next thing in hand is the watering can.
      this.tool = 'water';
      this.syncTools();
    });

    (this.refs.lamp as HTMLInputElement).addEventListener('input', (e) => {
      const v = Number((e.target as HTMLInputElement).value) / 100;
      w.commands.push({ t: 'setLamp', intensity: v });
    });

    this.refs.lid.addEventListener('click', () => {
      w.commands.push({ t: 'setLid', open: !w.atmo.lidOpen });
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      b.addEventListener('click', () => {
        const v = Number(b.dataset.speed);
        if (v === 0) this.paused = !this.paused;
        else {
          this.speed = v;
          this.paused = false;
        }
        this.syncSpeed();
      });
    });

    this.refs.debug.addEventListener('click', () => {
      const on = this.refs.debug.getAttribute('aria-pressed') !== 'true';
      this.refs.debug.setAttribute('aria-pressed', String(on));
      this.onDebugToggle(on);
    });
  }

  private syncTools(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
    });
  }

  /**
   * The speed the world should actually run at, as opposed to the one the player picked.
   *
   * Pouring drops to 1x for as long as the mouse is held, then hands the chosen speed straight
   * back. Holding the choice separately from the override is what makes that possible: clobbering
   * `speed` would mean a player who fast-forwards, waters, and lets go silently loses their setting.
   */
  get effectiveSpeed(): number {
    if (this.paused) return 0;
    return this.pouring ? Math.min(1, this.speed) : this.speed;
  }

  private syncSpeed(): void {
    // Show the override, so a jar that suddenly crawls mid-pour reads as deliberate rather than as a
    // stutter. The player's own choice lights up again the moment they let go.
    const shown = this.pouring && !this.paused ? Math.min(1, this.speed) : this.speed;
    this.root.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      const v = Number(b.dataset.speed);
      const active = v === 0 ? this.paused : !this.paused && shown === v;
      b.setAttribute('aria-pressed', String(active));
    });
  }

  /** Called once per animation frame. Reads world state; never writes it. */
  update(): void {
    // Only on the edge: syncSpeed touches every speed button, and this runs every frame.
    if (this.pouring !== this.pouringShown || this.speed !== this.speedShown) {
      this.pouringShown = this.pouring;
      this.speedShown = this.speed;
      this.syncSpeed();
    }

    /*
     * The readouts refresh on a REAL-TIME cadence, not once per frame.
     *
     * A frame at 128x advances the jar by a couple of sim-hours, so every number downstream of this
     * was being rewritten with a visibly different value sixty times a second: the clock scrambled,
     * the gauges strobed, and the whole panel read as broken rather than fast. Nothing in here is
     * worth watching at frame rate — a jar is a slow thing — and at 8 Hz the same numbers are legible
     * while still feeling live.
     *
     * The speed and pause buttons are deliberately handled ABOVE this gate: those answer a click and
     * have to respond on the frame the player makes it.
     */
    const nowMs = performance.now();
    if (nowMs - this.lastDataMs < DATA_REFRESH_MS) return;
    this.lastDataMs = nowMs;

    const w = this.world;
    const a = w.atmo;
    const rh = humidity(w.cfg, a);
    const mood = describe(w.cfg, a);
    // The jar is sealed and running from the start; it is still being BUILT until it has been given
    // water or anything alive. See `World.established`.
    const build = !w.established;

    const minute = LightField.minuteOfDay(w.cfg, w.tickCount);
    const hh = String(Math.floor(minute / 60)).padStart(2, '0');
    const mm = String(minute % 60).padStart(2, '0');
    // The climax keeps the day count — it is still a running jar, not a score screen — and says what
    // it is beside the clock, where the build phase puts its instruction.
    const finished = w.phase === 'climax';
    text(this.refs.phase, `Day ${w.simDay}`);
    text(this.refs.clock, finished ? `${hh}:${mm} · overgrown` : `${hh}:${mm}`);

    // Once the jar is established the Build row dims, but stays usable: reshaping a living jar is
    // allowed, it just costs, which is what the hint under it says.
    this.refs.buildRow.classList.toggle('inactive', !build);
    this.refs.paintHint.hidden = build;
    // Standard layers lays all three bands at once over whatever is there, so it is only offered
    // before anything has been watered or planted.
    (this.refs.bands as HTMLButtonElement).disabled = !build;

    /*
     * Eased on top of the cadence, because these four move fastest.
     *
     * The refresh rate alone stops the strobing; easing stops the remaining jumps, where two readings
     * an eighth of a second apart at 128x are a sim-hour apart and the needle teleports. Colour bands
     * read the EASED figure too, so a gauge cannot sit green while its number shows red.
     */
    const tempC = this.eased('temp', a.tempC, 4);
    const rhShown = this.eased('rh', rh, 12);
    gauge(this.refs, 'temp', tempC / 40, `${tempC.toFixed(1)}°C`, band(tempC, 19, 28, 14, 33));
    gauge(this.refs, 'rh', rhShown / 100, `${rhShown.toFixed(0)}%`, band(rhShown, 45, 84, 25, 92));
    /*
     * The CO2 gauge is scaled from the CONFIG, not from hardcoded numbers.
     *
     * It used to read `band(co2, 300, 1100, 200, 1200)`, which was calibrated by hand to a jar sealed
     * at 900 ppm. Raising that to 1400 meant a freshly sealed, perfectly healthy jar lit its own air
     * gauge red on tick one — the reading was right and the yardstick was stale.
     *
     * Low end: `stallBelowPpm` IS the failure, so it is the red line rather than a number that merely
     * resembles it, and amber sits half again above it as the run-down warning. High end: nothing in
     * the sim is harmed by abundant CO2 — `co2Stall` is the only CO2 failure mode there is — so the
     * ceilings are not danger at all. They report air that is not being BREATHED: normal in a jar just
     * sealed, worth a look in one that has been planted a while.
     */
    const co2Cfg = w.cfg.raw.atmosphere.co2;
    const co2Full = co2Cfg.startPpm * 1.3;
    const co2 = this.eased('co2', a.co2Ppm, 150);
    const o2 = this.eased('o2', a.o2Pct, 3);
    gauge(
      this.refs,
      'co2',
      co2 / co2Full,
      `${co2.toFixed(0)} ppm`,
      band(co2, co2Cfg.stallBelowPpm * 1.5, co2Cfg.startPpm * 1.1, co2Cfg.stallBelowPpm, co2Cfg.startPpm * 1.4),
    );
    gauge(this.refs, 'o2', o2 / 25, `${o2.toFixed(1)}%`, band(o2, 17, 24, 14, 26));

    text(this.refs.mood, `${mood.warmth}, ${mood.air}`);
    text(this.refs.lid, a.lidOpen ? 'Lid: open' : 'Lid: closed');
    this.refs.lid.setAttribute('aria-pressed', String(a.lidOpen));
    text(this.refs.sump, `${w.sumpMl.toFixed(0)} mL standing`);

    // The census, in the top bar: who is in the jar. Everything about an individual plant lives in
    // the Selected plant card, where the player can aim it at the plant they are asking about.
    const living = w.plants.filter((p) => p.stage !== 'dead');
    if (living.length === 0) {
      // Blank during build: the title line already says what to do, and repeating it just below reads
      // as clutter.
      text(this.refs.plant, build ? '' : 'no plants yet — pick a seed from the Tend row');
    } else {
      const seedlings = living.filter((p) => p.stage === 'seedling').length;
      const mix = SPECIES.map((sp) => ({ sp, n: living.filter((p) => p.species === sp.id).length }))
        .filter((e) => e.n > 0)
        .map((e) => `${e.n} ${e.sp.name}${e.n > 1 ? 's' : ''}`)
        .join(' + ');
      const blooms = living.reduce((a, p) => a + p.flowers, 0);
      text(
        this.refs.plant,
        `${mix}${seedlings > 0 ? ` · ${seedlings} seedling${seedlings > 1 ? 's' : ''}` : ''}${blooms > 0 ? ` · ${blooms} bloomed` : ''}`,
      );
    }

    // Soil life, described rather than counted: the player needs to know whether the crew is thriving,
    // not its exact headcount.
    // "Dormant" is a distinct state worth naming: a starved colony is waiting in the litter, not gone,
    // and it will come back on its own once there is something to eat. Reporting that as "none" would
    // send the player off to add more when they only need to be patient.
    const pop = w.faunaPopulation;
    text(
      this.refs.fauna,
      pop <= 0
        ? 'none'
        : pop < 1.5
          ? 'dormant — waiting for litter'
          : pop < 20
            ? `a few (${pop.toFixed(0)})`
            : pop < 80
              ? `thriving (${pop.toFixed(0)})`
              : `swarming (${pop.toFixed(0)})`,
    );
    // Moss reported as how much of the surface it has taken, since that is what drives every one of
    // its effects — fixation, mold suppression and shade all scale with coverage.
    const moss = w.mossCover() * 100;
    text(
      this.refs.moss,
      moss < 1
        ? 'none'
        : moss < 15
          ? `just starting (${moss.toFixed(0)}%)`
          : moss < 50
            ? `spreading (${moss.toFixed(0)}%)`
            : `established (${moss.toFixed(0)}%)`,
    );

    const litter = w.totalLitter();
    text(this.refs.litter, litter < 1 ? 'none' : litter < 40 ? 'a light scatter' : litter < 150 ? 'building up' : 'piling up');
    const mold = w.moldCoverage * 100;
    text(this.refs.mold, mold < 0.5 ? 'clear' : mold < 5 ? 'a few patches' : `spreading (${mold.toFixed(0)}%)`);
    // Share of leaves VISIBLY infested. A dormant colony reads as "none", because to the player it is:
    // there is nothing on the leaves to see and nothing to prune.
    const pests = w.pestCoverage * 100;
    text(
      this.refs.pests,
      pests <= 0 ? 'none seen' : pests < 5 ? 'a few leaves' : `spreading (${pests.toFixed(0)}% of leaves)`,
    );

    // "No charcoal placed" and "charcoal fully spent" are both a capacity of 0 numerically, but they
    // mean opposite things to the player — one is "nothing to worry about yet," the other is "replace
    // it now." hasCharcoal() is what tells them apart.
    const hasChar = w.hasCharcoal();
    const char = w.charcoalCapacity();
    gauge(
      this.refs,
      'char',
      hasChar ? char : 0,
      !hasChar ? 'none placed' : char <= 0 ? 'spent' : `${(char * 100).toFixed(0)}%`,
      hasChar ? band(char, 0.35, 2, 0.12, 2) : 'var(--line)',
    );

    this.renderSelected();
    this.renderAlerts();
  }

  /**
   * The diagnosis card: what is wrong with ONE plant, ranked, with the fix for whatever is worst.
   *
   * Everything here is read straight off the plant — the sim attributes each stress contribution to a
   * named cause as it computes it, so this cannot drift from what is actually happening to the plant.
   */
  private renderSelected(): void {
    const w = this.world;
    const living = w.plants.filter((p) => p.stage !== 'dead');

    // A dead plant stays in `w.plants` forever (node plantIds index into it), so a stale selection
    // would pin this card to a corpse.
    if (this.selected !== null && w.plants[this.selected]?.stage === 'dead') this.selected = null;

    const picked = this.selected !== null ? w.plants[this.selected] : undefined;
    /*
     * "Most in need" sticks to the plant it is already showing unless another is CLEARLY worse.
     *
     * Two plants in similar trouble trade places on the smallest wobble, and the card was swapping
     * name, species, node count and every bar with them — several times a second in a busy jar. The
     * margin means the card only moves when the answer to "which plant needs me" really has changed.
     */
    const worstOf = (margin: number): Plant | undefined =>
      living.reduce<Plant | undefined>((worst, p) => {
        if (!worst) return p;
        if (p.id === this.shownFor) return worst.id === this.shownFor ? worst : p.distress > worst.distress - margin ? p : worst;
        return p.distress > worst.distress + (worst.id === this.shownFor ? margin : 0) ? p : worst;
      }, undefined);
    const plant = picked ?? worstOf(AUTO_PLANT_MARGIN);

    if (!plant) {
      this.setHtml('who', `<p class="hint">${!w.established ? 'Lay out the layers and water the soil, then plant a seed.' : 'No plants yet — pick a seed from the tools.'}</p>`);
      return;
    }

    // Snap rather than ease when the card switches plants — easing across a switch would show the
    // previous plant's problems briefly attached to this one's name.
    if (this.shownFor !== plant.id) {
      this.shownFor = plant.id;
      this.shownBy.set(plant.stressBy);
    } else {
      for (let k = 0; k < this.shownBy.length; k++) {
        this.shownBy[k] += (plant.stressBy[k] - this.shownBy[k]) * 0.04;
      }
    }

    const col = Math.round(w.pool.x[plant.crown] - 0.5);
    const live = plant.nodeIds.filter((n) => w.pool.alive[n]).length;
    const head = `${SPECIES[plant.species].name} · ${plant.stage} · ${live} nodes · ${plant.rootCount}R/${plant.leafCount}L`;

    // Ranked, biggest first, and zero-valued causes dropped — a permanent list of "Mold 0%" rows
    // trains the player to stop reading the card.
    const ranked = [...this.shownBy]
      .map((v, id) => ({ v, id: id as StressCause }))
      .filter((e) => e.v > 0.005)
      .sort((a, b) => b.v - a.v);

    const optimalC = w.cfg.species[plant.species].raw.photosynthesis.tempOptimalC;
    // Past its resistant years a plant cannot hold its colonies down however well it is kept, so
    // pruning leaves only buys time. The cure that lasts is replacing it: the jar's own seedlings
    // start clean, and never inherit the stowaways a bought seed carried in.
    const pc = w.cfg.raw.pests;
    const ageDays = ((w.tickCount - w.pool.spawnTick[plant.crown]) * w.cfg.dt) / w.cfg.raw.time.dayLengthSimMinutes;
    const aged = ageDays >= pc.resistantDays;
    const describe = (id: StressCause) =>
      id === StressCause.Heat
        ? { ...CAUSE[id], ...tempAdvice(w.atmo.tempC, optimalC) }
        : id === StressCause.Pests && aged
          ? {
              ...CAUSE[id],
              fix: 'This plant is too old to fight them off alone. Finish a pesticide course — three sprays at least a day apart — and it will never be infested again. Or remove it (right-click with Prune) and let its clean seedlings take over.',
            }
          : CAUSE[id];

    const rows = ranked
      .map((e) => {
        const c = describe(e.id);
        const colour = c.benign ? 'var(--dim)' : e.v > 0.3 ? 'var(--bad)' : 'var(--warn)';
        return `<div class="gauge"><span>${c.label}</span><span class="bar"><span style="width:${Math.min(100, e.v * 100).toFixed(0)}%;background:${colour}"></span></span><span class="readout">${(e.v * 100).toFixed(0)}%</span></div>`;
      })
      .join('');

    // The fix names the worst REAL problem. Old age outranking everything means nothing is wrong.
    const worst = ranked.find((e) => !CAUSE[e.id].benign);
    // Starvation is a symptom, not a cause — a plant that dried out loses its leaves and then
    // starves. When it tops the list, defer to the limiter, which is the sim's own answer to "which
    // input is scarcest" and therefore the one thing actually worth fixing.
    const defer =
      worst?.id === StressCause.Starvation &&
      plant.limiter !== GrowthLimiter.None &&
      plant.limiter !== GrowthLimiter.StoreFull;
    const verdict = worst
      ? `<div class="alert${worst.v > 0.3 ? ' fail' : ''}"><strong>${describe(worst.id).label}</strong><em>${describe(worst.id).fix}${defer ? ` ${LIMITER[plant.limiter].fix}` : ''}</em></div>`
      : `<p class="hint">${ranked.length ? 'Nothing wrong — just old leaves ageing out, which is how the soil gets fed.' : 'In good health.'}</p>`;

    // Halts are not stress and never appear in the breakdown, but they are exactly why a healthy
    // plant can sit there doing nothing.
    const halt = plant.nutrientStarved
      ? '<div class="alert"><strong>Needs feeding</strong><em>Soil minerals are gone. Add springtails to recycle the litter.</em></div>'
      : plant.co2Stalled
        ? `<div class="alert"><strong>Growth paused — stale air</strong><em>${STALE_AIR.fix}</em></div>`
        : '';

    const lim = LIMITER[plant.limiter];
    const bloom = plant.flowers > 0 ? ` · ${plant.flowers} bloomed` : '';
    const course = courseLine(w, plant);

    this.setHtml(
      'who',
      `<div class="row"><strong>${head}</strong></div>` +
        `<div class="row"><label>${this.selected === null ? 'Most in need' : 'Column'}</label><span class="readout">${this.selected === null ? `col ${col}` : col}${bloom}</span></div>` +
        `<div class="gauge"><span>distress</span><span class="bar"><span style="width:${(plant.distress * 100).toFixed(0)}%;background:${plant.distress > 0.3 ? 'var(--bad)' : plant.distress > 0.12 ? 'var(--warn)' : 'var(--good)'}"></span></span><span class="readout">${(plant.distress * 100).toFixed(0)}%</span></div>` +
        rows +
        `<div class="advice">${verdict}${halt}</div>` +
        course +
        `<div class="row"><label>Growth capped by</label><span class="readout">${lim.label}</span></div>` +
        `<p class="hint">${lim.fix}${this.selected === null ? ' · Point at any plant to inspect it.' : ''}</p>`,
    );
  }

  /** Swap a block of markup only when it actually changed — this runs every animation frame. */
  /**
   * A readout's displayed value, eased toward the real one.
   *
   * SNAPS when the gap exceeds `snap`. Easing is for smoothing a live number, not for animating a
   * jump: sealing the jar, opening the lid or a scenario reset move these figures by more than they
   * ever drift, and crawling toward the new value would show a reading that was never true for
   * several seconds.
   */
  private eased(key: string, value: number, snap: number): number {
    const prev = this.shownValue.get(key);
    const next = prev === undefined || Math.abs(value - prev) > snap ? value : prev + (value - prev) * 0.25;
    this.shownValue.set(key, next);
    return next;
  }

  private setHtml(ref: string, html: string): void {
    if (this.refs[ref].innerHTML !== html) this.refs[ref].innerHTML = html;
  }

  private renderAlerts(): void {
    const w = this.world;
    const parts: string[] = [];
    const now = performance.now();
    for (const mode of Object.keys(w.strikes) as FailureMode[]) {
      /*
       * Stale air is never an alert.
       *
       * A jar that has finished growing sits near the stall threshold permanently — that is what a
       * closed carbon loop at capacity looks like, not an emergency — and it crosses back and forth
       * every night, so the banner flashed up and vanished over and over in exactly the jars that were
       * doing best. The condition is still reported, on the plant card, as the calm line "Growth
       * paused — stale air", which says the same thing without crying wolf.
       */
      if (mode === 'co2Stall') continue;
      const s = w.strikes[mode];
      if (!s.warned && !s.triggered) {
        // Lapsed: forget it entirely, so if it comes back it has to earn its full second again.
        this.alertSince.delete(mode);
        continue;
      }
      if (!this.alertSince.has(mode)) this.alertSince.set(mode, now);
      if (now - this.alertSince.get(mode)! < ALERT_HOLD_MS) continue;
      const a = ADVICE[mode];
      const pct = Math.round((s.value / w.cfg.raw.failure.triggerTicks[mode]) * 100);
      parts.push(
        `<div class="alert ${s.triggered ? 'fail' : ''}"><strong>${a.title}${
          s.triggered ? '' : ` (${pct}%)`
        }</strong><em>${a.fix}</em></div>`,
      );
    }
    const host = this.refs.alerts;
    const html = parts.join('') || '<p class="hint">Nothing wrong. The jar is holding steady.</p>';
    if (host.innerHTML !== html) host.innerHTML = html;
    // With nothing to report the card shrinks to that one line, so it stops taking the top of the
    // notes away from the Selected plant card in a healthy jar.
    this.refs.alertsCard.classList.toggle('quiet', parts.length === 0);
  }
}

function text(el: HTMLElement, v: string): void {
  if (el.textContent !== v) el.textContent = v;
}

function band(v: number, goodLo: number, goodHi: number, badLo: number, badHi: number): string {
  if (v < badLo || v > badHi) return 'var(--bad)';
  if (v < goodLo || v > goodHi) return 'var(--warn)';
  return 'var(--good)';
}

/**
 * The plant's pesticide course or immunity, as one row — or nothing, when neither applies.
 *
 * The course has a hidden clock in both directions (too soon does not count, too late lapses), and a
 * rule with a clock the player cannot see reads as the game ignoring their clicks. So the row always
 * says what the NEXT spray will do.
 */
function courseLine(w: World, plant: Plant): string {
  const c = w.cfg.raw.pesticide;
  const perDay = w.cfg.raw.time.dayLengthSimMinutes / w.cfg.dt;
  const span = (ticks: number) => {
    const days = ticks / perDay;
    return days >= 1 ? `${days.toFixed(1)} days` : `${Math.max(1, Math.round(days * 24))} h`;
  };
  const row = (label: string, value: string) =>
    `<div class="row"><label>${label}</label><span class="readout">${value}</span></div>`;

  // Nothing is shown for a plant that has come through an infestation: surviving one is meant to be
  // quiet, not a badge with a timer on it.
  if (plant.pestImmune || plant.courseDoses === 0) return '';
  const since = w.tickCount - plant.courseLastTick;
  const lapse = c.courseMaxGapDays * perDay - since;
  if (lapse <= 0) return '';
  const wait = c.courseMinGapDays * perDay - since;
  const next = wait > 0 ? `next dose in ${span(wait)}` : `next dose now — lapses in ${span(lapse)}`;
  return row('Pesticide course', `${plant.courseDoses} of ${c.courseDoses} · ${next}`);
}

function gauge(refs: Record<string, HTMLElement>, key: string, frac: number, label: string, color: string): void {
  const fill = refs[`${key}Bar`];
  fill.style.width = `${Math.max(0, Math.min(100, frac * 100)).toFixed(1)}%`;
  fill.style.background = color;
  text(refs[`${key}Val`], label);
}

/** Global state and controls, across the top of the spread. */
const TOPBAR = /* html */ `
  <div>
    <div class="topbar-title">
      <strong data-ref="phase">Build</strong>
      <span class="clock readout" data-ref="clock"></span>
      <span class="mood" data-ref="mood">—</span>
    </div>
    <div class="census" data-ref="plant">—</div>
  </div>
  <div class="topbar-controls">
    <div class="speed">
      <button data-speed="0" title="Pause (space)">❚❚</button>
      <button data-speed="1" title="Real time (key 1)" aria-pressed="true">1×</button>
      <button data-speed="16" title="16× (key 2)">16×</button>
      <button data-speed="32" title="32× (key 3)">32×</button>
      <button data-speed="64" title="64× (key 4)">64×</button>
      <button data-speed="128" title="128× (key 5)">128×</button>
    </div>
    <label class="lamp">Lamp <input type="range" min="0" max="100" value="60" data-ref="lamp" /></label>
    <button data-ref="lid" aria-pressed="false" title="Open to vent heat, fog and stale air — at the cost of the jar's water, and of being the only way pests get in">Lid: closed</button>
    <button class="gear-btn" data-ref="settings" aria-label="Settings" title="Settings: music, lag-free mode, the tutorial, and the way back to the title (Esc)">${GEAR_ICON}</button>
    <button class="quiet-btn" data-ref="debug" aria-pressed="false" title="Debug overlay (D)">Debug</button>
  </div>
`;

/** The largest brush: an 11-cell-wide disc, a fair share of the jar in one stroke. */
const BRUSH_MAX = 6;

/** The two halves of the Tend row. */
type TendTab = 'land' | 'aquatic';

const TAB_KEY = 'terrapixel.tendTab';

/** The tab the player last had open. A convenience only: storage may be unavailable, and then Land. */
function loadTab(): TendTab {
  try {
    return localStorage.getItem(TAB_KEY) === 'aquatic' ? 'aquatic' : 'land';
  } catch {
    return 'land';
  }
}

function saveTab(tab: TendTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Nothing to fall back to; the tab simply resets next load.
  }
}

/**
 * The tools, directly under the jar they act on. Two rows, both always usable: painting still works in
 * a living jar, it just costs water and roots, so hiding it would be lying.
 */
const TRAY = /* html */ `
  <div class="tray-row" data-ref="buildRow">
    <span class="tray-label">Build</span>
    <div class="tools">
      <button data-tool="paintGravel" title="Drainage layer: place at the bottom to catch excess water">Gravel</button>
      <button data-tool="paintCharcoal" title="Filters toxins from decaying litter: place above the gravel">Charcoal</button>
      <button data-tool="paintSoil" title="Where roots anchor and plants grow: place on top">Soil</button>
      <button data-tool="paintMud" title="Watertight lining. Click inside a dug hollow and it lines the whole thing, up to the height you clicked. Nothing roots in it.">Mud</button>
      <button data-tool="dig" title="Remove a tile, leaving open space. Dig a hollow, click Mud once inside it, then fill it with water.">Dig</button>
      <span class="brush" title="How many cells a Build tool paints at once. Keys: [ and ], or the mouse wheel over the jar.">
        <span class="brush-label">Brush</span>
        <button data-ref="brushDown" aria-label="Smaller brush">&minus;</button>
        <span class="brush-size" data-ref="brushSize">1</span>
        <button data-ref="brushUp" aria-label="Larger brush">+</button>
      </span>
      <span class="sep" aria-hidden="true"></span>
      <button class="primary" data-ref="bands" title="Gravel, charcoal and soil in one go, ready to plant. Only before the jar has been watered or planted.">Standard layers</button>
    </div>
    <p class="hint" data-ref="paintHint" hidden>Reshaping a living jar costs the cell's water and hurts nearby roots.</p>
  </div>
  <div class="tray-row" data-ref="tendRow">
    <span class="tray-label">Tend</span>
    <div class="tend">
      <div class="tabs" role="tablist" aria-label="What to tend">
        <button role="tab" id="tab-land" data-tab="land" aria-controls="panel-land" aria-selected="true">Land</button>
        <button role="tab" id="tab-aquatic" data-tab="aquatic" aria-controls="panel-aquatic" aria-selected="false" tabindex="-1">Aquatic</button>
      </div>
      <div class="tools">
      <button data-tool="water" title="Click, or click and hold, to water the soil beneath the cursor">Water</button>
      <span class="sep" aria-hidden="true"></span>
      <div class="tab-panel" id="panel-land" data-panel="land" role="tabpanel" aria-labelledby="tab-land">
        <button data-tool="seedFern" title="Fern — shade-loving and thirsty. Keep the lamp low and the soil damp.">Fern</button>
        <button data-tool="seedHerb" title="Herb — middling in everything. The forgiving one to learn a jar with.">Herb</button>
        <button data-tool="seedSucculent" title="Succulent — wants bright light and dry soil, and rots if you keep it wet.">Succulent</button>
        <span class="sep" aria-hidden="true"></span>
        <button data-tool="springtails" title="Decomposers that recycle fallen litter into nutrients and fresh air">Springtails</button>
        <button data-tool="moss" title="Ground cover that pulls new nutrients from the air, holds moisture in, and crowds out mold">Moss</button>
        <span class="sep" aria-hidden="true"></span>
        <button data-tool="prune" title="Remove a stem or leaf; cuttings become litter, and any pests on them go too">Prune</button>
        <button data-tool="pesticide" title="Spray the plant under the cursor to kill its pests. Three sprays at least a day apart will clear an infestation for good — but spray too often and the plant sickens, and three doses close together kill it.">Pesticide</button>
      </div>
      <div class="tab-panel" id="panel-aquatic" data-panel="aquatic" role="tabpanel" aria-labelledby="tab-aquatic" hidden>
        <button data-tool="lilies" title="Water lilies for a pond. Their broad pads spread across the surface, shading out the algae beneath and slowing evaporation, and flower once they have taken hold. Click on a pond.">Lily pads</button>
        <button data-tool="hornwort" title="An underwater plant for ponds. It grows up from the bottom, soaks up the food algae live on, and holds them back. A thick bed of lily pads shades it out. Click on a pond.">Hornwort</button>
        <button data-tool="reeds" title="Reeds for the edges of a pond: its outermost columns, or the bank one tile out. Tall stems stand up out of the water; they soak up the pond\'s food, but pump its water up into the air, so a reedbed dries a pond faster and makes the jar more humid. Click in a pond to plant both sides, or at one edge for just that side.">Reeds</button>
        <span class="sep" aria-hidden="true"></span>
        <button data-tool="fish" title="Small pond fish. They eat algae and clean up the floor, and their waste feeds the water. A pond kept spotless leaves them hungry, and stale water or a dried-up pond kills them. Click on a pond.">Fish</button>
        <button data-tool="snails" title="Ramshorn snails for a pond. They graze algae and clean up what sinks, but a pond left to go stale will kill them. Click on a pond.">Snails</button>
        <span class="sep" aria-hidden="true"></span>
        <button data-tool="clearPond" title="Kill every plant in a pond: its lily pads, hornwort, reeds and algae, edge to edge. Fish and snails are spared. The dead plants rot where they fall, which feeds the water, so algae can come back, and a thick bloom killed all at once sours the water. Click on a pond.">Clear pond</button>
      </div>
      </div>
    </div>
  </div>
`;

/** The field notes, ordered by urgency: what is wrong, then the plant you are looking at, then the jar. */
const NOTES = /* html */ `
  <div class="card alerts-card quiet" data-ref="alertsCard">
    <h2>Diagnosis</h2>
    <div id="alerts" data-ref="alerts"></div>
  </div>

  <div class="card">
    <h2>Selected plant</h2>
    <div data-ref="who"></div>
  </div>

  <div class="card">
    <h2>Atmosphere</h2>
    <div class="gauge"><span>Temp</span><div class="bar"><span data-ref="tempBar"></span></div><span class="readout" data-ref="tempVal">—</span></div>
    <div class="gauge"><span>Humidity</span><div class="bar"><span data-ref="rhBar"></span></div><span class="readout" data-ref="rhVal">—</span></div>
    <div class="gauge"><span>CO₂</span><div class="bar"><span data-ref="co2Bar"></span></div><span class="readout" data-ref="co2Val">—</span></div>
    <div class="gauge"><span>O₂</span><div class="bar"><span data-ref="o2Bar"></span></div><span class="readout" data-ref="o2Val">—</span></div>
  </div>

  <div class="card">
    <h2>Soil life</h2>
    <div class="row"><label>Springtails</label><span class="readout" data-ref="fauna">none</span></div>
    <div class="row"><label>Moss</label><span class="readout" data-ref="moss">none</span></div>
    <div class="row"><label>Leaf litter</label><span class="readout" data-ref="litter">none</span></div>
    <div class="row"><label>Mold</label><span class="readout" data-ref="mold">clear</span></div>
    <div class="row"><label>Pests</label><span class="readout" data-ref="pests">none seen</span></div>
    <div class="row"><label>Drainage</label><span class="readout" data-ref="sump">0 mL</span></div>
    <div class="gauge"><span>Charcoal</span><div class="bar"><span data-ref="charBar"></span></div><span class="readout" data-ref="charVal">—</span></div>
  </div>

  <p class="credit">TerraPixel · © 2026 Robert Audley · noncommercial use only</p>
`;

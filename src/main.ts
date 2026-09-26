// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The driver. Fixed timestep, decoupled from rendering — all logic lives in sim/tick.ts.
 *
 * Fast-forward is literally a loop count, which falls out of the fixed-step design for free and is
 * the same mechanism the headless balance harness uses.
 */

import { DEFAULT_BALANCE } from './sim/config/balance.js';
import { World } from './sim/world.js';
import { tick } from './sim/tick.js';
import { Renderer } from './render/renderer.js';
import { Panel, type Tool } from './ui/panel.js';
import { Onboarding, hasSeenOnboarding, type OnboardingFlags } from './ui/onboarding.js';
import { Lessons } from './ui/lessons.js';
import { Music } from './ui/music.js';
import { Settings, SettingsMenu } from './ui/settings.js';
import { TitleScreen } from './ui/title.js';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
/** The whole notebook spread. Panel fills its regions; it never replaces the shell, which holds the canvas. */
const host = document.querySelector<HTMLElement>('#app')!;
const notes = document.querySelector<HTMLElement>('#notes')!;

const world = new World(DEFAULT_BALANCE);
const renderer = new Renderer(canvas, world);
const panel = new Panel(host, world, (on) => {
  renderer.showDebug = on;
});
/*
 * The intro and checklist, prepended into the field notes ahead of Panel's own cards. Built when the
 * player first leaves the title screen, so the intro card never sits on top of the title.
 *
 * There is no Seal button: the jar is sealed, empty, the moment the player is in, and its clock runs
 * from then. Layout still follows until the jar is established (see `World.established`).
 */
let started = false;
let onboarding: Onboarding | null = null;
const onboardingFlags: OnboardingFlags = { usedWaterTool: false };
/**
 * The rest of the teaching, which the checklist cannot carry: mold, sour soil and pests all arrive
 * sim-days after it has removed itself. Each lesson waits for its own trigger — see lessons.ts.
 */
const lessons = new Lessons(notes);
/** The ambient score. Reads the jar to pick its track; the settings menu is its only control. */
const music = new Music();
const settings = new Settings();
const menu = new SettingsMenu(settings);

/** Into the player's jar, from the title screen: the first time, this is where the game begins. */
function enterJar(): void {
  title.hide();
  music.title = false;
  if (!onboarding) {
    onboarding = new Onboarding(notes, () => {
      started = true;
      world.commands.push({ t: 'seal' });
    });
  }
}

function backToTitle(): void {
  title.show(true);
  music.title = true;
}

/** From the menu: the intro and checklist again. From the title, that means going into the jar first. */
function replayTutorial(): void {
  if (title.isVisible) enterJar();
  onboarding?.replay();
}

/**
 * The title screen: the name over a living jar of its own, with its own music. The player's jar waits,
 * untouched and not running, until they press Start.
 */
const title = new TitleScreen({
  start: enterJar,
  // A new jar is a fresh page: the world, the tools and every card start over together.
  newJar: () => location.reload(),
  settings: () => menu.open({ replayTutorial }),
});
music.title = true;

settings.watch((s) => {
  music.setEnabled(s.music);
  music.setVolume(s.volume);
  renderer.lowFx = s.lowFx;
  title.lowFx = s.lowFx;
});

const openSettings = (): void => menu.open({ replayTutorial, backToTitle });
host.querySelector<HTMLButtonElement>('[data-ref="settings"]')?.addEventListener('click', openSettings);
/** The intro modal is dismissed exactly once per browser, and that is what `hasSeenOnboarding` records. */
let introDone = hasSeenOnboarding();

// --- input. Handlers only ever push commands; they never touch world state directly.
let painting = false;

/**
 * @param wholePlant Right-click. For the prune tool this takes the WHOLE plant rather than the branch
 *                   under the cursor — see the prune branch below. Ignored by every other tool.
 */
function actAt(clientX: number, clientY: number, wholePlant = false): void {
  const { x, y } = renderer.toGrid(clientX, clientY);
  if (!world.grid.isInterior(x, y)) return;
  const tool: Tool = panel.tool;
  const material = panel.material();
  if (material !== null) {
    world.commands.push({ t: 'paintBrush', x, y, radius: panel.brushRadius(), material });
    return;
  }
  if (tool === 'water') {
    // Same can, same rose, whether you tap it or hold it.
    world.commands.push({
      t: 'water',
      x,
      ml: world.cfg.raw.tools.wateringCanMl,
      spread: world.cfg.raw.tools.wateringSpreadColumns,
    });
    onboardingFlags.usedWaterTool = true;
    return;
  }
  const species = panel.species();
  if (species !== null) {
    world.commands.push({ t: 'plantSeed', x, species });
    return;
  }
  if (tool === 'springtails') {
    world.commands.push({ t: 'addSpringtails', x, y });
    return;
  }
  if (tool === 'moss') {
    world.commands.push({ t: 'addMoss', x });
    return;
  }
  if (tool === 'hornwort') {
    world.commands.push({ t: 'addHornwort', x });
    return;
  }
  if (tool === 'reeds') {
    world.commands.push({ t: 'addReeds', x });
    return;
  }
  if (tool === 'clearPond') {
    world.commands.push({ t: 'clearPond', x });
    return;
  }
  if (tool === 'fish') {
    world.commands.push({ t: 'addFish', x });
    return;
  }
  if (tool === 'snails') {
    world.commands.push({ t: 'addSnails', x });
    return;
  }
  if (tool === 'lilies') {
    world.commands.push({ t: 'addLilies', x });
    return;
  }
  if (tool === 'pesticide') {
    // One click, one dose, deliberately — no hold-to-spray. Dose is what kills a plant here, and a
    // stream would let a held button deliver a lethal one in a fraction of a second. Aimed at a plant
    // the same way Prune is, so "the plant under the cursor" means the same thing for both tools.
    const n = nearestNode(x, y, false);
    if (n < 0) return;
    world.commands.push({ t: 'spray', plant: world.pool.plantId[n] });
    return;
  }
  if (tool === 'prune') {
    const n = nearestNode(x, y, false);
    if (n < 0) return;
    /*
     * Left-click takes the branch under the cursor; right-click takes the whole plant.
     *
     * Both go through the same `prune` command, because pruning a node already kills everything below
     * it — so "delete this plant" is just pruning its CROWN, and needs no new command, no new code path
     * in the sim, and no second way for a plant to die.
     */
    const target = wholePlant ? (world.plants[world.pool.plantId[n]]?.crown ?? n) : n;
    world.commands.push({ t: 'prune', node: target });
  }
}

/**
 * Selecting a plant to inspect, by POINTING at it — no click involved.
 *
 * This used to happen on press, alongside the tool's own action, and that was simply wrong: trying
 * to read what was wrong with a plant also pruned it, planted into it, or dumped water on it. Any
 * fix that keeps inspection on the click has the same problem, since suppressing the tool over a
 * plant would make it impossible to water the one thing you most want to water.
 *
 * Hovering sidesteps it completely. Every tool behaves exactly as it did before, and inspecting
 * costs nothing.
 *
 * Two deliberate details keep it steady rather than twitchy:
 *  - Only ever SETS, never clears. Sweeping the pointer across empty glass on the way to the lamp
 *    slider leaves the card showing the plant you were just looking at, which is the whole point of
 *    having read it.
 *  - The same `nearestNode` radius as the tools, so "pointing at a plant" means the same thing here
 *    as aiming at one does everywhere else.
 */
function inspectAt(clientX: number, clientY: number): void {
  const { x, y } = renderer.toGrid(clientX, clientY);
  if (!world.grid.isInterior(x, y)) return;
  const n = nearestNode(x, y, true);
  if (n >= 0) panel.selected = world.pool.plantId[n];
}

/**
 * Nearest live node to a click, so aiming at a plant is forgiving.
 *
 * `includeRoots` is the difference between the two callers: pruning must never take a root out of
 * the canopy, while selecting a plant should work anywhere on it — clicking the roots you are
 * worried about is the natural thing to do.
 */
function nearestNode(x: number, y: number, includeRoots: boolean): number {
  const P = world.pool;
  let best = -1;
  let bestD = 2.2;
  for (let n = 0; n < P.count; n++) {
    if (!P.alive[n] || P.parent[n] < 0) continue;
    if (!includeRoots && P.kind[n] === 0) continue;
    const dx = P.x[n] - (x + 0.5);
    const dy = P.y[n] - (y + 0.5);
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD) {
      bestD = d;
      best = n;
    }
  }
  return best;
}

canvas.addEventListener('pointerdown', (e) => {
  // Right-click never starts a drag: it is a single deliberate act, not a stroke.
  const right = e.button === 2;
  painting = !right;
  if (!right) canvas.setPointerCapture(e.pointerId);
  actAt(e.clientX, e.clientY, right);
});

// Without this the browser menu covers the jar on every right-click, and the prune never reads as
// having happened.
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener('pointermove', (e) => {
  const { x, y } = renderer.toGrid(e.clientX, e.clientY);
  renderer.hoverCell = world.grid.isInterior(x, y) ? world.grid.idx(x, y) : -1;
  inspectAt(e.clientX, e.clientY);
  // Drag-painting for substrate tools: one splash per cell the cursor actually crosses. Water does
  // NOT use this path — see the continuous pour in frame() below, which is driven by real elapsed
  // time rather than by how many pixels the mouse crossed, so a fast drag can't dump the whole can.
  if (painting && panel.material() !== null) actAt(e.clientX, e.clientY);
});

const stop = () => {
  painting = false;
};
canvas.addEventListener('pointerup', stop);
canvas.addEventListener('pointercancel', stop);
// The mouse wheel over the jar resizes the brush while a Build tool is in hand; otherwise it is left alone.
canvas.addEventListener(
  'wheel',
  (e) => {
    if (panel.material() === null) return;
    e.preventDefault();
    panel.resizeBrush(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);

canvas.addEventListener('pointerleave', () => {
  renderer.hoverCell = -1;
});

/** Number keys to speeds, in the order the buttons sit in the tray. */
const SPEED_KEYS: Record<string, number> = { '1': 1, '2': 16, '3': 32, '4': 64, '5': 128 };

window.addEventListener('keydown', (e) => {
  // The jar's shortcuts belong to the jar: none of them while the title, the settings or the intro is up.
  if (title.isVisible || menu.isOpen || onboarding?.introOpen) return;
  if (e.key === 'Escape') {
    openSettings();
    return;
  }
  const picked = SPEED_KEYS[e.key];
  if (picked !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
    // Picking a speed also un-pauses: pressing a speed key on a paused jar means "run at this speed",
    // and leaving it frozen would read as the key having done nothing.
    panel.paused = false;
    panel.speed = picked;
  }
  if (e.key === 'd' || e.key === 'D') {
    renderer.showDebug = !renderer.showDebug;
    host.querySelector('[data-ref="debug"]')?.setAttribute('aria-pressed', String(renderer.showDebug));
  }
  // Brush size, as painting programs do it. Ignored while typing into anything.
  if ((e.key === '[' || e.key === ']') && !(e.target instanceof HTMLInputElement)) {
    panel.resizeBrush(e.key === ']' ? 1 : -1);
  }
  if (e.key === ' ') {
    e.preventDefault();
    panel.paused = !panel.paused;
  }
});

/** Where a new infestation puts the clock. See the outbreak check in the loop. */
const PEST_SPEED = 16;

// --- the fixed-step loop.
const STEP_MS = 1000 / world.cfg.raw.time.ticksPerSecond;
let acc = 0;
let last = performance.now();

/**
 * Hard ceiling on ticks per frame, so a long frame can never lock the page up.
 *
 * Raised from 96 to carry the 128x speed. That setting asks for 1280 ticks/sec, which is only about
 * 21 ticks in a 60 fps frame — comfortably under this — but the ceiling has to leave room for a frame
 * that runs long, or the backlog is dropped and the jar silently runs slower than the badge claims.
 *
 * There is real headroom for it: measured on a MATURE jar, the simulation alone sustains about 4,500
 * ticks per second, against the 1,280 this speed needs.
 */
const MAX_TICKS_PER_FRAME = 256;

function frame(now: number): void {
  // Clamp the elapsed time: a backgrounded tab must not come back and stampede a thousand ticks.
  const elapsed = Math.min(now - last, 250);
  last = now;

  // On the title screen only its own jar runs; the player's waits exactly where it was.
  if (title.isVisible) {
    title.frame(elapsed);
    music.update(world);
    requestAnimationFrame(frame);
    return;
  }

  // Click-and-hold pouring: while the pointer is down with the Water tool selected, add water
  // proportional to REAL elapsed time rather than to how many cells the cursor crossed. That is what
  // keeps a stationary hold pouring a steady stream (pointermove doesn't fire when the mouse doesn't
  // move, but `renderer.hoverCell` still holds the last cell the cursor was over) while making a fast
  // drag behave the same as a slow one instead of flooding every column it passes through.
  const pouring = painting && panel.tool === 'water' && renderer.hoverCell >= 0;
  if (pouring) {
    const x = world.grid.xOf(renderer.hoverCell);
    const ml = world.cfg.raw.tools.wateringStreamMlPerSec * (elapsed / 1000);
    world.commands.push({ t: 'water', x, ml, spread: world.cfg.raw.tools.wateringSpreadColumns });
    onboardingFlags.usedWaterTool = true;
  }
  // Watering drops the world to 1x for as long as the mouse is down, and the player's chosen speed
  // comes back untouched on release. See Panel.effectiveSpeed.
  panel.pouring = pouring;

  // Fast-forward scales SIMULATED time, not the tick budget.
  //
  // Capping the number of ticks per frame instead does nothing at all: the accumulator only ever fills
  // at real-time rate, so it never holds more than one tick's worth anyway and every speed setting runs
  // at exactly 1x. Multiplying the elapsed time is what actually makes 16x run sixteen times faster.
  // Nothing advances until the player is in: not even the clock, while a first-time player reads the intro.
  const speed = started ? panel.effectiveSpeed : 0;
  acc += elapsed * speed;

  // Pause stops the world advancing, but the player can still edit it — so a paused frame with queued
  // commands runs exactly one tick to apply them. Without this, painting while paused does nothing at
  // all and the tool reads as broken.
  if (speed === 0 && started && world.commands.depth > 0) acc = STEP_MS;

  const phaseBefore = world.phase;
  let ran = 0;
  let outbreak = false;
  while (acc >= STEP_MS && ran < MAX_TICKS_PER_FRAME) {
    tick(world);
    // Checked per tick rather than after the loop: at 128x a frame runs dozens of ticks, and each one
    // clears the last one's events, so an outbreak announced early in the frame would be gone by the end.
    if (!outbreak) outbreak = world.events.some((e) => e.t === 'infested');
    renderer.consumeEvents();
    acc -= STEP_MS;
    ran++;
  }
  /*
   * A new infestation pulls the jar to 16x — fast enough to still be playing, slow enough to act.
   *
   * Pests are the one problem measured in days: doses have to be a day apart to count, so watching an
   * infestation at 1x is minutes of nothing. Set rather than capped, so it also speeds a slow jar up.
   * Left alone while paused, since a pause is the player deliberately stopping the world.
   */
  if (outbreak && !panel.paused) panel.speed = PEST_SPEED;
  /*
   * A jar that finishes drops to 1x, so the ending is actually watched rather than fast-forwarded past.
   *
   * ONE-TIME, not a lock, and the difference matters practically rather than philosophically: releasing
   * the climax by pruning takes two sim-days, which is about nine seconds at 32x but nearly five real
   * MINUTES at 1x. Holding the player at 1x would make undoing the ending a punishment.
   *
   * Watched here rather than pushed from the simulation, because `src/sim` must not reach into the UI —
   * main.ts already holds both, so reading the transition costs nothing and keeps the arrow one-way.
   */
  if (phaseBefore !== 'climax' && world.phase === 'climax') panel.speed = 1;
  // Hit the ceiling: drop the backlog rather than letting it spiral into a death march.
  if (ran >= MAX_TICKS_PER_FRAME) acc = 0;

  // The pesticide notes belong to the tool, so they follow the tool selection every frame.
  renderer.pesticideMode = panel.tool === 'pesticide';
  {
    // The brush preview follows the tool in hand every frame, like the pesticide notes do.
    const material = panel.material();
    renderer.brush = material === null ? null : { radius: panel.brushRadius(), material };
  }
  renderer.render(Math.min(1, acc / STEP_MS));
  panel.update();
  onboarding?.update(world, onboardingFlags);
  if (!introDone) introDone = hasSeenOnboarding();
  lessons.update(world, introDone);
  music.update(world);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);

// Dev-only handle for driving the jar from the console or a Playwright script. Stripped from a
// production build by the `import.meta.env.DEV` guard. Worth having: the interesting behaviour here
// plays out over sim-months, which is not something you can reach by clicking.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__terra = { world, tick, renderer, panel };
}

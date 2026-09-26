// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The title screen: the game's name over a living jar.
 *
 * The jar behind the title is a real one, running on its own world and its own renderer, so it shows
 * exactly what the game is rather than a picture of it: a jar laid out, watered and planted, whose
 * seedlings come up and fill out in the first few seconds and then settle to a gentle pace. It is not
 * the player's jar, and nothing done here touches that one.
 */

import { DEFAULT_BALANCE, standardLayers } from '../sim/config/balance.js';
import { World } from '../sim/world.js';
import { tick } from '../sim/tick.js';
import { Renderer } from '../render/renderer.js';
import { GEAR_ICON } from './settings.js';

/** How fast the demo jar runs: quickly while its plants come up, then gently. */
const GROWING_SPEED = 64;
const SETTLED_SPEED = 6;
/** The sim-day the demo jar slows down on, once its plants have filled out. */
const SETTLED_DAY = 9;

export interface TitleActions {
  /** Begin, or carry on with, the player's jar. */
  start: () => void;
  /** Throw the player's jar away and start a new one. Only offered once there is one. */
  newJar: () => void;
  settings: () => void;
}

export class TitleScreen {
  private readonly el: HTMLElement;
  private readonly world: World;
  private readonly renderer: Renderer;
  private readonly stepMs: number;
  private acc = 0;
  private visible = true;

  constructor(private readonly actions: TitleActions) {
    this.el = document.createElement('div');
    this.el.id = 'title';
    // The name and buttons sit in the jar's open air, above its soil, so the jar is framed behind them.
    this.el.innerHTML = `
      <div class="title-stage">
        <canvas class="title-jar" width="792" height="408" aria-hidden="true"></canvas>
        <div class="title-card">
          <div class="title-plate">
            <h1 class="title-name">TerraPixel</h1>
            <p class="title-tag">A sealed jar, and everything that lives in it.</p>
          </div>
          <div class="title-buttons" data-ref="buttons"></div>
        </div>
      </div>
    `;
    document.body.appendChild(this.el);

    this.world = new World(DEFAULT_BALANCE);
    this.renderer = new Renderer(this.el.querySelector<HTMLCanvasElement>('.title-jar')!, this.world);
    this.stepMs = 1000 / this.world.cfg.raw.time.ticksPerSecond;
    this.plant();
    this.setButtons(false);
  }

  /** Lay the demo jar out, seal it, water it and plant it, as a player would. */
  private plant(): void {
    const w = this.world;
    const g = w.grid;
    w.commands.push({ t: 'layerBands', ...standardLayers(w.cfg.raw.grid.interiorH) });
    tick(w);
    while (w.substrateDirty) tick(w);
    w.commands.push({ t: 'seal' });
    tick(w);
    for (let x = 1; x <= g.w - 2; x++) w.commands.push({ t: 'water', x, ml: 2600 / (g.w - 2) });
    for (let i = 0; i < 120; i++) tick(w);
    const at = (f: number): number => Math.round(1 + f * (g.w - 3));
    w.commands.push({ t: 'plantSeed', x: at(0.2), species: 0 });
    w.commands.push({ t: 'plantSeed', x: at(0.4), species: 1 });
    w.commands.push({ t: 'plantSeed', x: at(0.6), species: 2 });
    w.commands.push({ t: 'plantSeed', x: at(0.8), species: 1 });
    for (const f of [0.3, 0.7]) {
      const x = at(f);
      const top = g.surfaceOfColumn[x];
      if (top >= 0) w.commands.push({ t: 'addSpringtails', x, y: g.yOf(top) });
    }
    w.commands.push({ t: 'addMoss', x: at(0.5) });
  }

  /** The buttons: Start on a first visit; Continue and New jar once the player has a jar. */
  setButtons(hasJar: boolean): void {
    const box = this.el.querySelector<HTMLElement>('[data-ref="buttons"]')!;
    box.innerHTML = hasJar
      ? `<button type="button" class="primary title-btn" data-act="start">Continue</button>
         <button type="button" class="title-btn" data-act="new">New jar</button>
         <button type="button" class="title-btn gear-btn" data-act="settings" aria-label="Settings" title="Settings">${GEAR_ICON}</button>`
      : `<button type="button" class="primary title-btn" data-act="start">Start</button>
         <button type="button" class="title-btn gear-btn" data-act="settings" aria-label="Settings" title="Settings">${GEAR_ICON}</button>`;
    box.querySelector('[data-act="start"]')!.addEventListener('click', () => this.actions.start());
    box.querySelector('[data-act="new"]')?.addEventListener('click', () => this.actions.newJar());
    box.querySelector('[data-act="settings"]')!.addEventListener('click', () => this.actions.settings());
  }

  get isVisible(): boolean {
    return this.visible;
  }

  show(hasJar: boolean): void {
    this.setButtons(hasJar);
    this.el.hidden = false;
    this.visible = true;
    this.el.querySelector<HTMLButtonElement>('[data-act="start"]')?.focus();
  }

  hide(): void {
    this.el.hidden = true;
    this.visible = false;
  }

  /** The demo jar's visuals follow the player's settings, lag-free mode included. */
  set lowFx(on: boolean) {
    this.renderer.lowFx = on;
  }

  /** One frame of the demo jar: run it on, then draw it. */
  frame(elapsedMs: number): void {
    if (!this.visible) return;
    const speed = this.world.simDay < SETTLED_DAY ? GROWING_SPEED : SETTLED_SPEED;
    this.acc += elapsedMs * speed;
    let ran = 0;
    while (this.acc >= this.stepMs && ran < 64) {
      tick(this.world);
      this.renderer.consumeEvents();
      this.acc -= this.stepMs;
      ran++;
    }
    if (ran >= 64) this.acc = 0;
    this.renderer.render(Math.min(1, this.acc / this.stepMs));
  }
}

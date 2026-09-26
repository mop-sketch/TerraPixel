// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The player's settings, and the menu that changes them.
 *
 * UI-only: nothing here touches the simulation. Settings are remembered in this browser, and the page
 * works the same when storage is unavailable, just without remembering.
 */

const STORAGE_KEY = 'terrapixel.settings';
/** Where the music choice lived before there was a settings menu, so an existing choice carries over. */
const LEGACY_MUSIC_KEY = 'terrapixel.music';

/**
 * The settings gear, drawn inline so it looks the same everywhere (a gear character is a different
 * picture on every system, and missing on some), in the button's own text colour. Its button carries
 * the word "Settings" as its accessible name, so nothing is lost for a screen reader.
 */
export const GEAR_ICON = `<svg class="gear" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"
  fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="3"/>
  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
</svg>`;

export interface SettingsValues {
  /** Ambient music on or off. */
  music: boolean;
  /** Music volume, 0..1. */
  volume: number;
  /**
   * Lag-free mode: the costliest visuals off (light beams, caustics, leaf shading and shadows, water
   * beads), for a slower computer. The jar plays exactly the same.
   */
  lowFx: boolean;
}

const DEFAULTS: SettingsValues = { music: true, volume: 0.8, lowFx: false };

function load(): SettingsValues {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<SettingsValues>) };
    return { ...DEFAULTS, music: localStorage.getItem(LEGACY_MUSIC_KEY) !== 'off' };
  } catch {
    return { ...DEFAULTS };
  }
}

export class Settings {
  private current = load();
  private readonly listeners: Array<(s: SettingsValues) => void> = [];

  get values(): Readonly<SettingsValues> {
    return this.current;
  }

  set(patch: Partial<SettingsValues>): void {
    this.current = { ...this.current, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.current));
    } catch {
      // Not remembered, but still applied.
    }
    for (const fn of this.listeners) fn(this.current);
  }

  /** Call `fn` now and whenever a setting changes. */
  watch(fn: (s: SettingsValues) => void): void {
    this.listeners.push(fn);
    fn(this.current);
  }
}

export interface MenuActions {
  /** Show the intro and the getting-started checklist again. */
  replayTutorial: () => void;
  /** Leave the jar for the title screen. Only offered while playing. */
  backToTitle?: () => void;
}

/**
 * The settings menu: a card over the page, opened from the title screen or the top bar.
 *
 * Every control applies the moment it changes; there is no Save. Escape or a click outside closes it,
 * and focus returns to whatever opened it.
 */
export class SettingsMenu {
  private backdrop: HTMLElement | null = null;
  private returnFocus: HTMLElement | null = null;

  constructor(private readonly settings: Settings) {}

  get isOpen(): boolean {
    return this.backdrop !== null;
  }

  open(actions: MenuActions): void {
    if (this.backdrop) return;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const s = this.settings.values;
    const back = document.createElement('div');
    back.className = 'modal-backdrop settings-backdrop';
    back.innerHTML = `
      <div class="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <h2 id="settings-title">Settings</h2>

        <section class="setting-group" aria-label="Music">
          <div class="setting-row">
            <span class="setting-name">Music</span>
            <button type="button" data-set="music" aria-pressed="${s.music}">${s.music ? 'On' : 'Off'}</button>
          </div>
          <label class="setting-row">
            <span class="setting-name">Volume</span>
            <input type="range" min="0" max="100" step="1" data-set="volume" value="${Math.round(s.volume * 100)}" />
            <span class="setting-value readout" data-show="volume">${Math.round(s.volume * 100)}%</span>
          </label>
        </section>

        <section class="setting-group" aria-label="Performance">
          <div class="setting-row">
            <span class="setting-name">Lag-free mode</span>
            <button type="button" data-set="lowFx" aria-pressed="${s.lowFx}">${s.lowFx ? 'On' : 'Off'}</button>
          </div>
          <p class="hint">Turns off the light beams, the ripples of light on the glass, leaf shading and
          shadows, and water beads, for a smoother game on a slower computer. The jar plays exactly the same.</p>
        </section>

        <section class="setting-group" aria-label="Help">
          <div class="setting-row">
            <span class="setting-name">Tutorial</span>
            <button type="button" data-act="tutorial">Replay the tutorial</button>
          </div>
        </section>

        <div class="settings-foot">
          ${actions.backToTitle ? '<button type="button" data-act="title">Back to title</button>' : '<span></span>'}
          <button type="button" class="primary" data-act="close">Done</button>
        </div>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string): T => back.querySelector<T>(sel)!;
    const music = q<HTMLButtonElement>('[data-set="music"]');
    music.addEventListener('click', () => {
      const on = !this.settings.values.music;
      this.settings.set({ music: on });
      music.setAttribute('aria-pressed', String(on));
      music.textContent = on ? 'On' : 'Off';
    });
    const volume = q<HTMLInputElement>('[data-set="volume"]');
    const shown = q<HTMLElement>('[data-show="volume"]');
    volume.addEventListener('input', () => {
      const v = Number(volume.value) / 100;
      this.settings.set({ volume: v });
      shown.textContent = `${volume.value}%`;
    });
    const lowFx = q<HTMLButtonElement>('[data-set="lowFx"]');
    lowFx.addEventListener('click', () => {
      const on = !this.settings.values.lowFx;
      this.settings.set({ lowFx: on });
      lowFx.setAttribute('aria-pressed', String(on));
      lowFx.textContent = on ? 'On' : 'Off';
    });
    q('[data-act="tutorial"]').addEventListener('click', () => {
      this.close();
      actions.replayTutorial();
    });
    q('[data-act="close"]').addEventListener('click', () => this.close());
    back.querySelector('[data-act="title"]')?.addEventListener('click', () => {
      this.close();
      actions.backToTitle?.();
    });
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) this.close();
    });
    back.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.close();
      }
    });

    document.body.appendChild(back);
    this.backdrop = back;
    music.focus();
  }

  close(): void {
    this.backdrop?.remove();
    this.backdrop = null;
    this.returnFocus?.focus();
    this.returnFocus = null;
  }
}

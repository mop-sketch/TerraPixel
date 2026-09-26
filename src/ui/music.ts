// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The ambient score: four loops, chosen by what the jar is doing, crossfaded between.
 *
 * UI-only and read-only, like the panel: it looks at `World` and never writes to it.
 *
 * Deliberately plain `<audio>` elements rather than the Web Audio API. These are long stereo loops,
 * not effects — nothing here needs sample-accurate timing, filtering or mixing, and an `<audio>` tag
 * streams rather than decoding four three-minute files into memory up front.
 */

import type { World } from '../sim/world.js';
import alertUrl from '../../Sound-Effects/Alert-Ambience.mp3?url';
import climaxUrl from '../../Sound-Effects/Climax-Ambience.mp3?url';
import mainUrl from '../../Sound-Effects/Main-Ambience.mp3?url';
import titleUrl from '../../Sound-Effects/Title-Ambience.mp3?url';

const STORAGE_KEY = 'terrapixel.music';

/** Ambience, so it sits under everything. Loud enough to notice, quiet enough to forget. */
const VOLUME = 0.4;
/** Seconds to cross from one track to the next. Long, because nothing in this game is abrupt. */
const FADE_SECONDS = 2.5;

/**
 * How long trouble must persist before the music reacts, and how long it must be gone before the
 * music relaxes again, in real milliseconds.
 *
 * Strike counters sit right on their thresholds in a jar that is only just coping, so a warning can
 * appear and clear several times a minute. Chasing that turns the score into a stutter. Slow in and
 * slower out means the music only changes when the jar's situation actually has.
 */
const TROUBLE_ON_MS = 4000;
const TROUBLE_OFF_MS = 12000;

type Cue = 'title' | 'main' | 'alert' | 'climax';

const SOURCES: Record<Cue, string> = {
  title: titleUrl,
  main: mainUrl,
  alert: alertUrl,
  climax: climaxUrl,
};

function stored(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    // Storage disabled: default to playing, which is the same as a first-time visitor.
    return true;
  }
}

export class Music {
  /** Created on first use, so a jar that never reaches the climax never fetches its track. */
  private readonly tracks = new Map<Cue, HTMLAudioElement>();
  private playing: Cue | null = null;
  private enabled = stored();
  private lastMs = 0;
  /** Debounced "something is wrong", and when the raw signal last changed. See the constants above. */
  private trouble = false;
  private rawTrouble = false;
  private rawSince = 0;
  /**
   * Browsers refuse to start audio until the page has been interacted with, and refuse silently. So
   * the first gesture anywhere retries whatever should already be playing.
   */
  private unlocked = false;
  /** The player's volume, 0..1, scaling the score's own level. */
  private volume = 1;
  /** Set while the title screen is up: it has its own track. */
  title = false;

  constructor() {
    const unlock = (): void => {
      this.unlocked = true;
      if (this.enabled && this.playing) void this.tracks.get(this.playing)?.play().catch(() => {});
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  get on(): boolean {
    return this.enabled;
  }

  /** Music on or off, from the settings menu. */
  setEnabled(on: boolean): void {
    if (on !== this.enabled) this.toggle();
  }

  /** The player's volume, 0..1. Applied through the per-frame fade, so a change eases in. */
  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v));
  }

  toggle(): void {
    this.enabled = !this.enabled;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      // Nothing to fall back to; the choice just will not survive a reload.
    }
    if (!this.enabled) {
      for (const el of this.tracks.values()) el.pause();
    } else if (this.playing) {
      // Clicking the button IS a gesture, so this play() is allowed even on a fresh page.
      this.unlocked = true;
      void this.tracks.get(this.playing)?.play().catch(() => {});
    }
  }

  /** Called once per frame, alongside the panel. */
  update(w: World): void {
    const nowMs = performance.now();
    const dt = this.lastMs === 0 ? 0 : Math.min(0.25, (nowMs - this.lastMs) / 1000);
    this.lastMs = nowMs;

    const want = this.cueFor(w, nowMs);
    if (want !== this.playing) this.start(want);
    if (!this.enabled) return;

    // Fade the chosen track up and everything else down. Running every frame means a cue that changes
    // back mid-fade simply turns around rather than cutting.
    const step = dt / FADE_SECONDS;
    for (const [cue, el] of this.tracks) {
      const target = cue === this.playing ? VOLUME * this.volume : 0;
      if (el.volume < target) el.volume = Math.min(target, el.volume + step * VOLUME);
      else if (el.volume > target) el.volume = Math.max(target, el.volume - step * VOLUME);
      // Only stop a track once it is silent, or the crossfade would have a hole in it.
      if (el.volume === 0 && cue !== this.playing && !el.paused) el.pause();
    }
  }

  private cueFor(w: World, nowMs: number): Cue {
    const raw = Object.entries(w.strikes).some(
      ([mode, s]) => !MUSIC_IGNORES.has(mode) && (s.warned || s.triggered),
    );
    if (raw !== this.rawTrouble) {
      this.rawTrouble = raw;
      this.rawSince = nowMs;
    }
    const held = nowMs - this.rawSince;
    if (raw && held >= TROUBLE_ON_MS) this.trouble = true;
    if (!raw && held >= TROUBLE_OFF_MS) this.trouble = false;

    // The title screen has its own track, whatever the player's jar is doing behind it.
    if (this.title) return 'title';
    if (this.trouble) return 'alert';
    if (w.phase === 'climax') return 'climax';
    return 'main';
  }

  private start(cue: Cue): void {
    this.playing = cue;
    if (!this.enabled) return;
    let el = this.tracks.get(cue);
    if (!el) {
      el = new Audio(SOURCES[cue]);
      el.loop = true;
      el.preload = 'auto';
      el.volume = 0;
      this.tracks.set(cue, el);
    }
    if (this.unlocked) void el.play().catch(() => {});
  }
}

/**
 * Which track the jar is asking for.
 *
 * Trouble outranks the ending: a jar that reaches its climax with a failure running still has
 * something wrong with it, and the music should say so rather than play the credits over it.
 *
 * Stale air is excluded entirely. A finished jar lives near the stall threshold and crosses it every
 * night, so it would have the score flipping to the alert theme and back for the rest of the run —
 * which is precisely what it did.
 */
const MUSIC_IGNORES: ReadonlySet<string> = new Set(['co2Stall']);

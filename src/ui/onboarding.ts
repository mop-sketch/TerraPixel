// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * First-run onboarding: a one-time intro card stating the premise and goal, followed by a
 * self-clearing getting-started checklist.
 *
 * Everything here is UI-only, reading `World` the same way `Panel` and `Renderer` already do and
 * writing nothing back except through the same command queue the rest of the UI uses. No sim
 * changes were needed for this: every step's completion is derivable from state `World` already
 * exposes, except "has the player used the water tool," which `main.ts` tracks as a plain flag at
 * the one place the water command is already pushed.
 */

import type { World } from '../sim/world.js';

const STORAGE_KEY = 'terrapixel.onboarded';

export function hasSeenOnboarding(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    // Private browsing / storage disabled: fall back to always showing it rather than throwing.
    return false;
  }
}

function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch {
    // Nothing to fall back to — worst case the intro reappears next load, which is harmless.
  }
}

export interface OnboardingFlags {
  /** Set true by main.ts the first time the player pushes a 'water' command. */
  usedWaterTool: boolean;
}

interface Step {
  id: string;
  label: string;
  sub: string;
  done: (w: World, flags: OnboardingFlags) => boolean;
}

const STEPS: Step[] = [
  {
    id: 'layout',
    label: 'Lay out the substrate',
    sub: 'Bottom to top: gravel, then charcoal, then soil — or click Standard layers to skip ahead.',
    done: (w) => w.grid.activeCells.length > 0,
  },
  {
    id: 'seal',
    label: 'Seal the jar',
    sub: 'Locks in your layout and starts the clock — nothing more gets added after this.',
    done: (w) => w.phase !== 'build',
  },
  {
    id: 'water',
    label: 'Water the soil',
    sub: 'Click, or click and hold, with the Water tool to soak it.',
    done: (_w, flags) => flags.usedWaterTool,
  },
  {
    id: 'seed',
    label: 'Plant a seed',
    sub: 'Click with the Seed tool on the wet soil.',
    done: (w) => w.plants.length > 0,
  },
];

/**
 * How long the closing tips stay up before the checklist card removes itself automatically, for a
 * player who doesn't click the "Got it" button. Generous, since there's a real habit to convey (water
 * wider than one spot, and keep doing it) and rushing past it is exactly how this confusion recurs.
 */
const CLOSING_DISPLAY_MS = 12000;

export class Onboarding {
  private readonly modal: HTMLElement | null;
  private readonly checklistCard: HTMLElement;
  private readonly listEl: HTMLElement;

  /** One-way latch: once the checklist has done its job, it must never reappear — even if the
   * plant it was tracking later dies and `world.plants.length` drops back to 0. */
  private completed = hasSeenOnboarding();
  private closingSince = -1;

  constructor(panelHost: HTMLElement) {
    this.modal = hasSeenOnboarding() ? null : buildModal(() => this.dismissIntro());

    this.checklistCard = document.createElement('div');
    this.checklistCard.className = 'card onboarding-checklist';
    this.checklistCard.innerHTML = `<h2>Getting started</h2><ul class="checklist"></ul>`;
    this.listEl = this.checklistCard.querySelector('.checklist')!;
    panelHost.prepend(this.checklistCard);

    if (this.modal) {
      document.body.appendChild(this.modal);
      // The checklist stays hidden until the intro is dismissed — no point explaining "how" before
      // the player has been told "what" and "why".
      this.checklistCard.classList.add('hidden');
    } else if (this.completed) {
      this.checklistCard.classList.add('hidden');
    }
  }

  private dismissIntro(): void {
    this.modal?.remove();
    markOnboarded();
    this.checklistCard.classList.remove('hidden');
  }

  /** Called once per animation frame, same cadence as Panel.update(). */
  update(world: World, flags: OnboardingFlags): void {
    if (this.completed) return;

    const allDone = STEPS.every((s) => s.done(world, flags));
    if (allDone && this.closingSince < 0) {
      this.closingSince = performance.now();
      markOnboarded();
    }

    if (this.closingSince >= 0) {
      if (performance.now() - this.closingSince > CLOSING_DISPLAY_MS) {
        this.finish();
        return;
      }
      this.renderClosing();
      return;
    }

    this.renderSteps(world, flags);
  }

  private renderSteps(world: World, flags: OnboardingFlags): void {
    // Highlight only the first not-yet-done step, so the player always has exactly one thing to do
    // next rather than a wall of four instructions to parse at once.
    let currentSeen = false;
    this.listEl.innerHTML = STEPS.map((s) => {
      const done = s.done(world, flags);
      const current = !done && !currentSeen;
      if (current) currentSeen = true;
      const state = done ? 'done' : current ? 'current' : 'pending';
      const mark = done ? '✓' : current ? '→' : '○';
      return `<li data-state="${state}"><span class="mark">${mark}</span><span><b>${s.label}</b><br><small>${s.sub}</small></span></li>`;
    }).join('');
  }

  private finish(): void {
    this.completed = true;
    this.checklistCard.remove();
  }

  private renderClosing(): void {
    if (this.listEl.dataset.closing === '1') return;
    this.listEl.dataset.closing = '1';
    // Two short tips rather than one paragraph. The first is the single most common way a first jar
    // goes wrong: watering only the spot the seed went into, then not coming back — roots spread
    // outward as the plant grows, and a root left in a never-watered patch reads as "roots are drying
    // out" even while the spot you originally watered looks fine.
    this.listEl.innerHTML = `
      <li data-state="done"><span class="mark">✓</span><span>
        Keep watering it, and water <b>wider</b> than just this one spot — roots spread outward as
        the plant grows, and a dry patch anywhere under it will stress the whole plant.
      </span></li>
      <li data-state="done"><span class="mark">✓</span><span>
        Add springtails once leaves start dropping, and check the Diagnosis card below if anything
        needs attention. A plant that's thriving will eventually flower.
      </span></li>
      <li data-state="done"><span class="mark">✓</span><span>
        Later on, plant <b>moss</b>. It spreads on its own, pulls fresh nutrients out of the air, and
        is the long-term answer if a plant ever says it <i>needs feeding</i>.
      </span></li>
      <li data-state="done"><span class="mark">✓</span><span>
        A jar you keep in balance will <b>seed itself</b> — flowers occasionally drop a seed nearby
        and a new sprout appears. Crowded ones fade on their own, so you don't have to thin them.
      </span></li>
      <li class="dismiss-row"><button type="button" class="dismiss-checklist">Got it</button></li>
    `;
    this.listEl.querySelector('.dismiss-checklist')!.addEventListener('click', () => this.finish());
  }
}

function buildModal(onDismiss: () => void): HTMLElement {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <h2 id="intro-title">A Sealed Terrarium</h2>
      <p>
        This jar is a closed loop. Once you seal it, nothing new comes in — water, air, and
        nutrients all have to keep recycling on their own, and how you layer it beforehand decides
        whether that loop can hold.
      </p>
      <p>
        The <b>lid</b> is your one way back out. Opening it trades humidity and water for fresh
        air, which is how you rescue a jar that has gone stale, muggy or too warm — and it is the
        only way pests ever get in, so it is a decision rather than a habit.
      </p>
      <p class="layer-order">
        <strong>Layers, bottom to top:</strong>
        <span class="layer-chain">
          <span class="chip gravel">Gravel</span><span class="arrow">→</span>
          <span class="chip charcoal">Charcoal</span><span class="arrow">→</span>
          <span class="chip soil">Soil</span>
        </span>
        Gravel drains excess water away from the roots; charcoal filters what decays; soil is where
        roots anchor and plants grow. Get the order right, or click <em>Standard layers</em> to have
        it done for you.
      </p>
      <p>
        Seal the jar, water the soil, and plant a seed. Once it's growing, add springtails when
        leaves start dropping to keep nutrients cycling — a plant that's thriving will eventually
        flower, and that's how you'll know you got it right.
      </p>
      <div class="row" style="justify-content: space-between; margin-top: 14px">
        <button class="skip-intro" type="button">skip intro</button>
        <button class="primary start" type="button">Start building</button>
      </div>
    </div>
  `;
  backdrop.querySelector('.start')!.addEventListener('click', onDismiss);
  backdrop.querySelector('.skip-intro')!.addEventListener('click', onDismiss);
  return backdrop;
}

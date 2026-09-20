// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * Just-in-time teaching: a short card the first time each system actually shows up in the jar.
 *
 * The getting-started checklist in `onboarding.ts` cannot carry this. It removes itself once the
 * first seed is in, while mold, sour soil and pests are all things that happen sim-DAYS later — and
 * explaining them up front would mean a wall of warnings about problems the player has not met yet
 * and cannot picture. So each lesson waits for its own trigger and then says one thing.
 *
 * UI-only, exactly like the checklist: every trigger is read from state `World` already exposes, and
 * nothing here writes to the simulation.
 */

import { NodeKind, StressCause } from '../sim/plant.js';
import type { World } from '../sim/world.js';

const STORAGE_KEY = 'terrapixel.lessons';

function seen(): Set<string> {
  try {
    return new Set((localStorage.getItem(STORAGE_KEY) ?? '').split(',').filter(Boolean));
  } catch {
    // Storage disabled: lessons reappear next load, which is harmless.
    return new Set();
  }
}

function remember(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, [...ids].join(','));
  } catch {
    // Nothing to fall back to.
  }
}

interface Lesson {
  id: string;
  title: string;
  /** Two or three sentences. What it is, what causes it, and the one thing to do about it. */
  body: string;
  when: (w: World) => boolean;
}

/** Any live plant showing pests the player can actually see on a leaf. */
function pestsVisible(w: World): boolean {
  const P = w.pool;
  const at = w.cfg.raw.pests.visibleAt;
  for (const plant of w.plants) {
    if (plant.stage === 'dead') continue;
    for (const n of plant.nodeIds) {
      if (P.alive[n] && P.kind[n] === NodeKind.Leaf && P.pests[n] >= at) return true;
    }
  }
  return false;
}

/**
 * Ordered by how early in a jar's life each one tends to fire, which is also the order they queue in
 * on the rare tick where two trigger at once.
 */
const LESSONS: Lesson[] = [
  {
    id: 'fog',
    title: 'The glass has fogged up',
    body:
      'The air is holding about as much water as it can, so it is misting on the inside of the glass. ' +
      'That is normal for a sealed jar and plants like it — but mold can only take hold while it lasts. ' +
      'Open the lid for a while if you want it to clear, bearing in mind that an open lid is also the ' +
      'only way pests get in.',
    when: (w) => w.atmo.fogged,
  },
  {
    id: 'mold',
    title: 'Mold on the soil',
    body:
      'Fuzz spreads on damp surfaces where dead leaves are piling up, and it starts hurting roots once ' +
      'it takes hold of a patch. Springtails graze it, and venting the lid dries the air that feeds it. ' +
      'Fresh charcoal under the soil holds it back too.',
    when: (w) => w.moldCoverage > 0.02,
  },
  {
    id: 'toxins',
    title: 'The charcoal is filling up',
    body:
      'Charcoal soaks up what decaying matter releases, and it fills up over time — the gauge in Soil ' +
      'life shows how much it has left. Once it is spent, the soil turns sour and roots start to suffer. ' +
      'Paint fresh charcoal over the old layer to replace it.',
    when: (w) => w.hasCharcoal() && w.charcoalCapacity() < 0.4,
  },
  {
    id: 'sour',
    title: 'The soil has turned sour',
    body:
      'Decay has built up faster than the charcoal can filter it, and the roots in it are being damaged. ' +
      'Replace the charcoal layer by painting fresh charcoal over it, and add springtails so litter stops ' +
      'piling up in the first place.',
    when: (w) =>
      w.plants.some((p) => p.stage !== 'dead' && p.stressBy[StressCause.Toxins] > 0.05),
  },
  {
    id: 'pests',
    title: 'Pests on the leaves',
    body:
      'Those pale specks are sap-suckers. They only ever get in while the lid is open — a sealed jar ' +
      'keeps them out entirely — and once started they spread where leaves touch and get worse the ' +
      'longer they are left. Pruning the speckled growth off buys time; finish a course of the ' +
      'Pesticide tool, three sprays at least a day apart, and that plant will never be infested again. ' +
      'Space them out, because spraying the same plant three times in quick succession kills it.',
    when: pestsVisible,
  },
  {
    id: 'climax',
    title: 'The jar has filled in',
    body:
      'It has stopped growing and settled into what it is going to be, and the glass is closing over with ' +
      'moss and creepers. Nothing more is needed from you. Prune something if you would rather it kept ' +
      'growing — that reopens it.',
    when: (w) => w.phase === 'climax',
  },
];

export class Lessons {
  private readonly card: HTMLElement;
  private readonly seenIds = seen();
  private showing: Lesson | null = null;

  constructor(host: HTMLElement) {
    this.card = document.createElement('div');
    this.card.className = 'card lesson-card hidden';
    // Prepended, so a lesson sits above the readouts rather than below the fold of the notes column.
    host.prepend(this.card);
  }

  /**
   * Called once per frame, alongside the panel.
   *
   * @param ready False while the intro modal is still up: a lesson behind a modal is a lesson nobody
   *              reads, and the jar cannot have produced one that early anyway.
   */
  update(w: World, ready: boolean): void {
    if (!ready || this.showing) return;
    const next = LESSONS.find((l) => !this.seenIds.has(l.id) && l.when(w));
    if (next) this.show(next);
  }

  private show(lesson: Lesson): void {
    this.showing = lesson;
    // Marked seen on SHOW rather than on dismiss: a player who ignores the card has still been told,
    // and re-showing the same lesson on the next frame they meet it would be nagging.
    this.seenIds.add(lesson.id);
    remember(this.seenIds);

    this.card.innerHTML = `
      <h2>${lesson.title}</h2>
      <p class="lesson-body">${lesson.body}</p>
      <div class="row" style="justify-content: flex-end">
        <button type="button" class="dismiss-lesson">Got it</button>
      </div>
    `;
    this.card.classList.remove('hidden');
    this.card.querySelector('.dismiss-lesson')!.addEventListener('click', () => this.dismiss());
  }

  private dismiss(): void {
    this.showing = null;
    this.card.classList.add('hidden');
    this.card.innerHTML = '';
  }
}

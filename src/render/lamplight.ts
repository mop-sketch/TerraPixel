// Copyright (c) 2026 Robert Audley. SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
/**
 * The lamp's light in the jar: a warm glow falling from the top, soft shafts slanting down through the
 * air with dust turning in them, pools of light where they land, and the rippling web light throws
 * on the back glass after bending through the jar's shoulder.
 *
 * All of it is drawn only, and all of it is scaled by `strength`: the lamp's intensity times daylight,
 * the same product the plants photosynthesise on. So it dims at dusk, is gone at night, and a player
 * turning the lamp down sees the light go, rather than only reading it off a slider.
 *
 * Motion is paced in real seconds, like the fog, and held still for anyone whose system asks for
 * reduced motion.
 */

import { THEME } from '../theme.js';
import { hash2 } from './plate.js';

type Rgb = readonly [number, number, number];
const rgba = ([r, g, b]: Rgb, a: number): string => `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;

/** One shaft of light, as it stands this frame: a quad from the lamp down to `length`. */
interface Shaft {
  x: number;
  dx: number;
  top: number;
  width: number;
  spread: number;
  length: number;
  alpha: number;
}

/** Caustic samples per logical pixel. Coarse on purpose: drawn scaled up, the blur is the softness. */
const CAUSTIC_RES = 1 / 4;

/**
 * Beam layer pixels per logical pixel. The beams are built in thin lanes, and at full resolution the
 * lanes' edges showed as fine stripes; built at a third and scaled up, they blur into one soft beam.
 */
const BEAM_RES = 1 / 3;

export class LampLight {
  private readonly caustic: HTMLCanvasElement;
  private readonly causticCtx: CanvasRenderingContext2D;
  private readonly causticImage: ImageData;
  private causticFrame = 0;
  private readonly still: boolean;
  /** The beams' warm tint, their bright cores, and the haze they cut through, each on its own small layer. */
  private readonly beamTint: CanvasRenderingContext2D;
  private readonly beamCore: CanvasRenderingContext2D;
  private readonly beamHaze: CanvasRenderingContext2D;

  constructor(
    private readonly W: number,
    private readonly H: number,
    private readonly c: number,
  ) {
    this.caustic = document.createElement('canvas');
    this.caustic.width = Math.max(1, Math.round(W * CAUSTIC_RES));
    this.caustic.height = Math.max(1, Math.round(H * 0.55 * CAUSTIC_RES));
    this.causticCtx = this.caustic.getContext('2d')!;
    this.causticImage = this.causticCtx.createImageData(this.caustic.width, this.caustic.height);
    this.still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const layer = (): CanvasRenderingContext2D => {
      const el = document.createElement('canvas');
      el.width = Math.max(1, Math.ceil(W * BEAM_RES));
      el.height = Math.max(1, Math.ceil(H * BEAM_RES));
      return el.getContext('2d')!;
    };
    this.beamTint = layer();
    this.beamCore = layer();
    this.beamHaze = layer();
  }

  /** Real seconds as the light should see them: frozen for reduced motion. */
  private time(seconds: number): number {
    return this.still ? 0 : seconds;
  }

  /**
   * The glow: warm light pooling from the top of the jar and falling away down it, with a brighter
   * bloom right under the lamp. Drawn over everything inside the glass, before the night tint.
   *
   * The bloom is filled to the full reach of its gradient and kept to the AIR. It was filled only to 60%
   * of the jar's height, short of its own radius, so it ended in a hard line; in a built jar that line
   * fell across the soil, as a lighter band with an obvious edge.
   */
  drawGlow(ctx: CanvasRenderingContext2D, strength: number, air: Path2D): void {
    if (strength <= 0.01) return;
    const { W, H } = this;
    const L = THEME.lamp;
    const fall = ctx.createLinearGradient(0, 0, 0, H * 0.8);
    fall.addColorStop(0, rgba(L.glow, 0.26 * strength));
    fall.addColorStop(0.45, rgba(L.glow, 0.09 * strength));
    fall.addColorStop(1, rgba(L.glow, 0));
    ctx.fillStyle = fall;
    ctx.fillRect(0, 0, W, H * 0.8);

    ctx.save();
    ctx.clip(air, 'evenodd');
    ctx.globalCompositeOperation = 'screen';
    const reach = W * 0.42;
    const bloom = ctx.createRadialGradient(W / 2, 0, 0, W / 2, 0, reach);
    bloom.addColorStop(0, rgba(L.bloom, 0.35 * strength));
    bloom.addColorStop(1, rgba(L.bloom, 0));
    ctx.fillStyle = bloom;
    ctx.fillRect(0, 0, W, Math.min(H, reach));
    ctx.restore();
  }

  /**
   * Caustics on the back wall: the web of light a curved, wet glass throws, rippling slowly. Drawn right
   * after the paper inside the jar, so the soil, the water and the plants all stand in front of it and
   * it is only ever seen through the air, as it would be.
   *
   * Three families of ridges, each a sine bent by another, summed: where two meet, the light gathers.
   * Computed at a quarter resolution and every other frame; scaled up, that coarseness is the softness.
   */
  drawCaustics(ctx: CanvasRenderingContext2D, vessel: Path2D, strength: number, seconds: number): void {
    if (strength <= 0.02) return;
    const t = this.time(seconds);
    const cw = this.caustic.width;
    const ch = this.caustic.height;
    if (this.causticFrame++ % 2 === 0 || this.still) {
      const px = this.causticImage.data;
      const [r, g, b] = THEME.lamp.caustic;
      // Sample spacing in the pattern's own units: about one ripple every two cells of the jar.
      const k = 1 / (this.c * 2 * CAUSTIC_RES);
      for (let y = 0; y < ch; y++) {
        // Strongest at the top, gone a little over halfway down.
        const fade = 1 - y / ch;
        const v0 = y * k;
        for (let x = 0; x < cw; x++) {
          const u = x * k * 1.6;
          const v = v0 * 1.6;
          const r1 = 1 - Math.abs(Math.sin(u * 0.9 + Math.sin(v * 1.3 + t * 0.6) * 1.2 + t * 0.4));
          const r2 = 1 - Math.abs(Math.sin(v * 1.1 + u * 0.5 + Math.sin(u * 0.8 - t * 0.5) * 1.3 - t * 0.3));
          const r3 = 1 - Math.abs(Math.sin((u - v) * 0.7 + Math.sin((u + v) * 0.9 + t * 0.45) * 1.1 + t * 0.25));
          const a1 = r1 * r1 * r1 * r1;
          const a2 = r2 * r2 * r2 * r2;
          const a3 = r3 * r3 * r3 * r3;
          const light = Math.min(1, (a1 * a1 + a2 * a2 + a3 * a3) * 1.3);
          // Brightest under the lamp, easing off toward the walls.
          const centre = 1 - Math.abs(x / cw - 0.5) * 1.1;
          const i = (y * cw + x) * 4;
          px[i] = r;
          px[i + 1] = g;
          px[i + 2] = b;
          px[i + 3] = Math.round(255 * light * fade * fade * centre);
        }
      }
      this.causticCtx.putImageData(this.causticImage, 0, 0);
    }
    ctx.save();
    ctx.clip(vessel);
    ctx.globalAlpha = Math.min(1, 0.85 * strength);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.caustic, 0, 0, this.W, this.H * 0.55);
    ctx.restore();
  }

  /**
   * Shafts of lamplight slanting down through the air, stopped by what is in the way, and the dust
   * turning in them.
   *
   * Drawn BEHIND the plants, in the air they stand in: a beam laid over everything tinted every leaf
   * it crossed, which read as a filter on the picture rather than as light in the jar. Leaves in front
   * of a beam block it; the leaves' own lighting is what shows them lit. `strength` already carries
   * the lamp, the time of day, and how fogged and beaded the glass is: a misted jar dims the shine,
   * rather than piling more light on a picture that is already busy.
   *
   * Each beam runs until it meets the ground, the jar's own floor if it is empty, and still carries
   * light when it lands. A beam of fixed length that faded to nothing stopped in mid-air in an empty
   * jar, well short of the bottom.
   *
   * Fanned out from a lamp above the middle of the jar, each swaying slowly and breathing in width and
   * brightness. A beam is not a flat overlay: it is cut into thin lanes across its width, and down each
   * lane its brightness follows `lightAt`, the share of the lamp's light the SIM says reaches that
   * point, after every leaf above it and nothing at all below the ground. So a beam falls bright until
   * it meets the canopy, and is shadowed below it; a thick canopy stops it. What the player sees lit is
   * what the plants are growing on.
   *
   * A beam of light only shows against dimmer air, and on this pale plate there was none: the beams
   * were all but invisible. So by day the air carries a faint warm haze, and each beam CUTS through
   * it, as far as its light reaches. Below a leaf, where the beam is stopped, the haze shows through:
   * that is the beam's shadow, and what makes it read as hitting something.
   *
   * The lanes are brightest in the middle of the beam and fade to its edges, which is its softness.
   * The dust in it and the pool it leaves on the soil are dimmed by the same light, so neither shows in
   * a beam's shadow.
   */
  drawShafts(
    ctx: CanvasRenderingContext2D,
    air: Path2D,
    ground: Path2D | null,
    surfaceAt: (px: number) => number,
    lightAt: (px: number, py: number) => number,
    strength: number,
    seconds: number,
  ): void {
    if (strength <= 0.02) return;
    const { W, H, c } = this;
    const L = THEME.lamp;
    const t = this.time(seconds);
    /*
     * How much of a beam survives at a point. The sim passes 72% of the light past each leaf, which is
     * right for growth but reads as nothing on screen, so the picture sharpens it: one leaf leaves
     * about 40% of the beam, two about 15%.
     */
    const through = (px: number, py: number): number => {
      const v = lightAt(px, py);
      return v <= 0 ? 0 : v * v * v;
    };

    const shafts: Shaft[] = [];
    const count = 5;
    for (let k = 0; k < count; k++) {
      const h = hash2(k + 3, 911);
      const across = (k + 0.5) / count;
      const x = W * (0.2 + 0.6 * across) + Math.sin(t * 0.11 + k * 1.7) * c * 0.8;
      // Fanning out from the middle: a shaft right of centre leans right.
      const dx = (across - 0.5) * 0.5 + Math.sin(t * 0.07 + k * 2.1) * 0.04;
      const width = c * (1.6 + (h % 100) / 50 + 0.4 * Math.sin(t * 0.23 + k * 2.9));
      // Down the beam's middle to where it meets the ground: the soil, or the glass floor of an empty jar.
      const top = c * 0.5;
      let length = H - top;
      for (let i = 1; i <= 80; i++) {
        const y = top + (i / 80) * (H - top);
        if (y >= surfaceAt(x + dx * (y - top))) {
          length = y - top + c * 0.5;
          break;
        }
      }
      shafts.push({
        x,
        dx,
        top,
        width,
        spread: 1.7 + ((h >> 8) % 60) / 100,
        length,
        alpha: (0.55 + 0.45 * Math.sin(t * 0.17 + k * 1.3)) * (0.7 + ((h >> 4) % 30) / 100),
      });
    }

    const STOPS = 28;
    const T = this.beamTint;
    const K = this.beamCore;
    const Z = this.beamHaze;
    for (const layer of [T, K, Z]) {
      layer.setTransform(1, 0, 0, 1, 0, 0);
      layer.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      layer.setTransform(BEAM_RES, 0, 0, BEAM_RES, 0, 0);
    }
    // The haze: faint at the lid, a little thicker further from the lamp.
    const haze = Z.createLinearGradient(0, 0, 0, H);
    haze.addColorStop(0, rgba(L.haze, 0.12 * strength));
    haze.addColorStop(1, rgba(L.haze, 0.22 * strength));
    Z.fillStyle = haze;
    Z.fillRect(0, 0, W, H);
    Z.globalCompositeOperation = 'destination-out';
    for (const s of shafts) {
      const bx = s.x + s.dx * s.length;
      const by = s.top + s.length;
      // The beam, wider than its bright core so its edges can fade: about one lane a cell, at least 5.
      const halfTop = s.width * 0.8;
      const halfBottom = halfTop * s.spread;
      const lanes = Math.max(5, Math.round((halfBottom * 2) / c));
      const peak = Math.min(0.75, 0.42 * strength * s.alpha);
      const corePeak = Math.min(0.8, 0.5 * strength * s.alpha);
      for (let j = 0; j < lanes; j++) {
        const u0 = j / lanes - 0.5;
        const u1 = (j + 1) / lanes - 0.5;
        const um = (u0 + u1) / 2;
        // Brightest down the middle, nothing at the edges: a beam's soft sides.
        const weight = Math.cos(Math.PI * um) ** 2;
        if (weight < 0.02) continue;
        // The lane's own line down the beam, sampled for the light that reaches along it.
        const tx = s.x + um * 2 * halfTop;
        const lx = bx + um * 2 * halfBottom;
        const grad = T.createLinearGradient(tx, s.top, lx, by);
        const cut = Z.createLinearGradient(tx, s.top, lx, by);
        const core = Math.abs(um) < 0.2 ? K.createLinearGradient(tx, s.top, lx, by) : null;
        for (let k = 0; k <= STOPS; k++) {
          const f = k / STOPS;
          const px = tx + (lx - tx) * f;
          const py = s.top + (by - s.top) * f;
          // Easing off down the beam, but landing with nearly half its light, where it leaves its pool.
          const fall = 1 - 0.55 * f;
          const lit = through(px, py);
          grad.addColorStop(f, rgba(L.shaft, peak * fall * lit * weight));
          // How much of the haze this stretch of beam clears: all of it where the light is full.
          cut.addColorStop(f, `rgba(0, 0, 0, ${Math.min(1, (0.35 + 0.65 * fall) * lit * weight * 1.3).toFixed(3)})`);
          if (core) core.addColorStop(f, rgba(L.bloom, corePeak * Math.max(0, 1 - f / 0.55) * lit * weight));
        }
        const lane = new Path2D();
        lane.moveTo(s.x + u0 * 2 * halfTop, s.top);
        lane.lineTo(s.x + u1 * 2 * halfTop, s.top);
        lane.lineTo(bx + u1 * 2 * halfBottom, by);
        lane.lineTo(bx + u0 * 2 * halfBottom, by);
        lane.closePath();
        T.fillStyle = grad;
        T.fill(lane);
        Z.fillStyle = cut;
        Z.fill(lane);
        if (core) {
          K.fillStyle = core;
          K.fill(lane);
        }
      }
    }

    // The warm tint laid onto the cut haze while both are still small, so the jar takes one image, not two.
    Z.globalCompositeOperation = 'source-over';
    Z.setTransform(1, 0, 0, 1, 0, 0);
    Z.drawImage(T.canvas, 0, 0);

    ctx.save();
    ctx.clip(air, 'evenodd');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(Z.canvas, 0, 0, W, H);
    // The cores screened, so they lift toward white: what reads as LIGHT on pale paper, where a warm
    // tint alone reads only as a stain.
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(K.canvas, 0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';

    // Dust turning in the light: a few motes per shaft, drifting down it and across, only where lit.
    ctx.fillStyle = rgba(L.mote, 0.85 * strength);
    for (let k = 0; k < shafts.length; k++) {
      const s = shafts[k];
      for (let m = 0; m < 7; m++) {
        const h = hash2(k * 17 + m, 313);
        const along = ((h % 1000) / 1000 + t * (0.008 + ((h >> 10) % 10) / 1000)) % 1;
        const y = s.top + along * s.length * 0.7;
        const across = (((h >> 4) % 100) / 100 - 0.5) * s.width * (1 + (s.spread - 1) * along);
        const x = s.x + s.dx * (y - s.top) + across + Math.sin(t * 0.6 + m) * c * 0.15;
        const twinkle = Math.sin(Math.PI * along) * (0.6 + 0.4 * Math.sin(t * 1.3 + h)) * through(x, y);
        if (twinkle <= 0.05) continue;
        ctx.globalAlpha = twinkle * s.alpha;
        ctx.beginPath();
        ctx.arc(x, y, 0.55, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    // Where each shaft lands: a warm pool of light on the soil, as bright as the light that got there.
    if (!ground) return;
    ctx.save();
    ctx.clip(ground);
    for (const s of shafts) {
      // Walk the shaft down to the ground: a few steps is plenty, the ground is smooth at this scale.
      let y = s.top;
      let x = s.x;
      for (let i = 0; i < 40; i++) {
        y = s.top + (i / 40) * s.length;
        x = s.x + s.dx * (y - s.top);
        if (y >= surfaceAt(x)) break;
      }
      // Sampled just above the soil, since the soil itself takes no light.
      const arrived = through(x, y - c * 0.6);
      if (arrived < 0.05) continue;
      const reach = ((y - s.top) / s.length) * (s.spread - 1) + 1;
      const rx = s.width * 0.9 * reach;
      const pool = ctx.createRadialGradient(x, y, 0, x, y, rx);
      pool.addColorStop(0, rgba(L.pool, 0.22 * strength * s.alpha * arrived));
      pool.addColorStop(1, rgba(L.pool, 0));
      ctx.fillStyle = pool;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, 0.35);
      ctx.translate(-x, -y);
      ctx.fillRect(x - rx, y - rx, rx * 2, rx * 2);
      ctx.restore();
    }
    ctx.restore();
  }
}

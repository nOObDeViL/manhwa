/**
 * Ken Burns timeline + Canvas 2D frame renderer.
 * The same renderer drives the live preview and the FFmpeg.wasm export, so what you
 * preview is exactly what gets encoded.
 */
import { getPanelBlob } from './panelCache';
import { clamp, lerp } from './utils';

export type Effect = 'zoom-in' | 'zoom-out' | 'pan-down' | 'pan-up' | 'static';
export type EffectChoice = Effect | 'auto';
export const EFFECTS: EffectChoice[] = ['auto', 'zoom-in', 'zoom-out', 'pan-down', 'pan-up', 'static'];

export interface ComposeSettings {
  width: number;
  height: number;
  fps: number;
  /** fit = whole panel visible over a blurred backdrop; fill = crop to fill the frame. */
  framing: 'fit' | 'fill';
  /** Zoom strength, e.g. 0.15 = 15%. */
  zoom: number;
  /** Crossfade between panels, seconds. */
  transition: number;
  background: 'blur' | 'black';
}

export interface TimelinePanel {
  id: string;
  name: string;
  width?: number;
  height?: number;
  effect?: EffectChoice;
}

export interface Segment {
  index: number;
  panelId: string;
  start: number;
  end: number;
  effect: EffectChoice;
}

/**
 * Map panels onto the narration.
 *  - "beats": panels are spread across beats proportionally and every panel change lands
 *    on a beat boundary when panels ÷ beats is whole (e.g. 40 panels, 20 beats → 2 per beat).
 *  - "even": every panel gets the same screen time.
 */
export function buildSegments(
  panels: TimelinePanel[],
  duration: number,
  beatStarts: number[] | null,
  mode: 'beats' | 'even',
): Segment[] {
  const P = panels.length;
  if (!P || duration <= 0) return [];
  let boundaryAt: (j: number) => number;

  if (mode === 'beats' && beatStarts && beatStarts.length > 0) {
    const B = beatStarts.length;
    // Beat i covers [b_i, b_{i+1}); b_0 = 0 and b_B = duration so the video has no gaps.
    const b = [0, ...beatStarts.slice(1), duration];
    const T = (x: number) => {
      if (x >= B) return duration;
      const i = Math.floor(x);
      return lerp(b[i], b[i + 1], x - i);
    };
    boundaryAt = (j) => T((j * B) / P);
  } else {
    boundaryAt = (j) => (j * duration) / P;
  }

  return panels.map((p, j) => ({
    index: j,
    panelId: p.id,
    start: boundaryAt(j),
    end: j === P - 1 ? duration : boundaryAt(j + 1),
    effect: p.effect ?? 'auto',
  }));
}

export function resolveEffect(effect: EffectChoice, iw: number, ih: number, index: number, W: number, H: number): Effect {
  if (effect !== 'auto') return effect;
  const tall = ih / iw > (H / W) * 1.25;
  if (tall) return 'pan-down';
  return index % 2 === 0 ? 'zoom-in' : 'zoom-out';
}

const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2;

interface Camera {
  cx: number;
  cy: number;
  scale: number;
}

export function camera(effect: Effect, p: number, iw: number, ih: number, W: number, H: number, s: ComposeSettings): Camera {
  const fit = Math.min(W / iw, H / ih);
  const cover = Math.max(W / iw, H / ih);
  const base = s.framing === 'fill' ? cover : fit;
  let scale = base;
  let cx = iw / 2;
  let cy = ih / 2;
  const ep = easeInOutSine(p);

  switch (effect) {
    case 'zoom-in':
      scale = base * (1 + s.zoom * p);
      cy = ih * (0.5 - 0.06 * p);
      break;
    case 'zoom-out':
      scale = base * (1 + s.zoom * (1 - p));
      cy = ih * (0.44 + 0.06 * p);
      break;
    case 'pan-down':
    case 'pan-up': {
      // Show the panel reasonably large and scroll along it.
      const widthFrac = W >= H ? 0.72 : 0.96;
      scale = s.framing === 'fill' ? cover : Math.max(base * (1 + s.zoom * 0.4), Math.min((W * widthFrac) / iw, cover));
      const vh = H / scale;
      if (vh < ih) {
        const top = vh / 2;
        const bottom = ih - vh / 2;
        cy = effect === 'pan-down' ? lerp(top, bottom, ep) : lerp(bottom, top, ep);
      }
      break;
    }
    case 'static':
      break;
  }

  // Where the image is bigger than the view, keep the view inside the image.
  const vw = W / scale;
  const vh = H / scale;
  cx = vw < iw ? clamp(cx, vw / 2, iw - vw / 2) : iw / 2;
  cy = vh < ih ? clamp(cy, vh / 2, ih - vh / 2) : ih / 2;
  return { cx, cy, scale };
}

/** Draw only the visible part of the image (fast and avoids huge destination rects on Safari). */
function drawWithCamera(ctx: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, cam: Camera, W: number, H: number) {
  let sx = cam.cx - W / 2 / cam.scale;
  let sy = cam.cy - H / 2 / cam.scale;
  let sw = W / cam.scale;
  let sh = H / cam.scale;
  let dx = 0;
  let dy = 0;
  let dw = W;
  let dh = H;
  if (sx < 0) {
    dx = -sx * cam.scale;
    dw -= dx;
    sw += sx;
    sx = 0;
  }
  if (sy < 0) {
    dy = -sy * cam.scale;
    dh -= dy;
    sh += sy;
    sy = 0;
  }
  if (sx + sw > iw) {
    const over = sx + sw - iw;
    sw -= over;
    dw -= over * cam.scale;
  }
  if (sy + sh > ih) {
    const over = sy + sh - ih;
    sh -= over;
    dh -= over * cam.scale;
  }
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/** Cheap, cross-browser blur (Safari lacks ctx.filter): downscale hard, upscale smoothly, darken. */
function makeBackdrop(img: ImageBitmap, W: number, H: number): HTMLCanvasElement {
  const tiny = document.createElement('canvas');
  tiny.width = 24;
  tiny.height = Math.max(8, Math.round((24 * H) / W));
  const t = tiny.getContext('2d')!;
  const s = Math.max(tiny.width / img.width, tiny.height / img.height);
  t.drawImage(img, (tiny.width - img.width * s) / 2, (tiny.height - img.height * s) / 2, img.width * s, img.height * s);

  const mid = document.createElement('canvas');
  mid.width = Math.round(W / 8);
  mid.height = Math.round(H / 8);
  const m = mid.getContext('2d')!;
  m.imageSmoothingQuality = 'high';
  m.drawImage(tiny, 0, 0, mid.width, mid.height);

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const o = out.getContext('2d')!;
  o.imageSmoothingQuality = 'high';
  o.drawImage(mid, 0, 0, W, H);
  o.fillStyle = 'rgba(0,0,0,0.55)';
  o.fillRect(0, 0, W, H);
  const g = o.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.6)');
  o.fillStyle = g;
  o.fillRect(0, 0, W, H);
  tiny.width = tiny.height = mid.width = mid.height = 0;
  return out;
}

interface Asset {
  bmp: ImageBitmap;
  bg: HTMLCanvasElement | null;
  w: number;
  h: number;
}

export class FrameRenderer {
  private cache = new Map<string, Promise<Asset>>();
  private order: string[] = [];
  private readonly maxAssets = 5;

  constructor(
    private ctx: CanvasRenderingContext2D,
    private W: number,
    private H: number,
    private settings: ComposeSettings,
    private segments: Segment[],
  ) {}

  get duration() {
    return this.segments.length ? this.segments[this.segments.length - 1].end : 0;
  }

  private asset(id: string): Promise<Asset> {
    let p = this.cache.get(id);
    if (!p) {
      p = (async () => {
        const bmp = await createImageBitmap(await getPanelBlob(id));
        const bg = this.settings.background === 'blur' ? makeBackdrop(bmp, this.W, this.H) : null;
        return { bmp, bg, w: bmp.width, h: bmp.height };
      })();
      p.catch(() => this.cache.delete(id));
      this.cache.set(id, p);
    }
    this.order = [id, ...this.order.filter((x) => x !== id)];
    while (this.order.length > this.maxAssets) {
      const evict = this.order.pop()!;
      const old = this.cache.get(evict);
      this.cache.delete(evict);
      old?.then((a) => {
        a.bmp.close();
        if (a.bg) a.bg.width = a.bg.height = 0;
      }).catch(() => undefined);
    }
    return p;
  }

  private indexAt(t: number): number {
    const segs = this.segments;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].start <= t) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  private drawSegment(a: Asset, seg: Segment, t: number, alpha: number) {
    const dur = Math.max(0.001, seg.end - seg.start);
    const p = clamp((t - seg.start) / dur, 0, 1);
    const effect = resolveEffect(seg.effect, a.w, a.h, seg.index, this.W, this.H);
    const cam = camera(effect, p, a.w, a.h, this.W, this.H, this.settings);
    this.ctx.globalAlpha = alpha;
    if (a.bg) this.ctx.drawImage(a.bg, 0, 0);
    else {
      this.ctx.fillStyle = '#000';
      this.ctx.fillRect(0, 0, this.W, this.H);
    }
    drawWithCamera(this.ctx, a.bmp, a.w, a.h, cam, this.W, this.H);
  }

  async renderFrame(t: number): Promise<void> {
    const ctx = this.ctx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.W, this.H);
    if (!this.segments.length) return;

    const i = this.indexAt(t);
    const seg = this.segments[i];
    const local = t - seg.start;
    const fade = Math.min(this.settings.transition, (seg.end - seg.start) / 2);
    const inFade = i > 0 && fade > 0 && local < fade;

    const [cur, prev] = await Promise.all([
      this.asset(seg.panelId),
      inFade ? this.asset(this.segments[i - 1].panelId) : Promise.resolve(null),
    ]);
    if (i + 1 < this.segments.length) this.asset(this.segments[i + 1].panelId).catch(() => undefined); // prefetch

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (prev) this.drawSegment(prev, this.segments[i - 1], t, 1);
    this.drawSegment(cur, seg, t, prev ? easeInOutSine(local / fade) : 1);
    ctx.globalAlpha = 1;
  }

  dispose() {
    for (const p of this.cache.values()) p.then((a) => a.bmp.close()).catch(() => undefined);
    this.cache.clear();
    this.order = [];
  }
}

export const RESOLUTIONS = [
  { id: '1080p', label: '1080p landscape (1920×1080)', width: 1920, height: 1080 },
  { id: '720p', label: '720p landscape (1280×720) — faster', width: 1280, height: 720 },
  { id: 'shorts', label: 'Vertical Shorts (1080×1920)', width: 1080, height: 1920 },
  { id: 'shorts720', label: 'Vertical Shorts (720×1280) — faster', width: 720, height: 1280 },
] as const;

/**
 * Canvas-based webtoon panel slicer.
 *
 * All source pages are treated as ONE continuous vertical strip (webtoon chapters are
 * often split into arbitrary image files that cut panels in half). We scan the strip
 * row by row on a hidden canvas, mark rows that are a single flat colour (white/black/
 * any) as "gutter", and cut the strip wherever a gutter run is tall enough. Panels can
 * therefore span two source files and are stitched back together on export.
 */
import type { SourceImage } from './cbz';
import { canvasToBlob, clamp, yieldToMain } from './utils';

export interface SliceOptions {
  /** Which gutter colour to look for. `auto` = any flat colour. */
  gutter: 'auto' | 'white' | 'black';
  /** Luminance tolerance (0–255) for a pixel to count as "same colour" as its row. */
  tolerance: number;
  /** Fraction of a row's pixels that must match for it to be a gutter row. */
  coverage: number;
  /** Minimum gutter height (px, output scale) to cut on. */
  minGutter: number;
  /** Regions shorter than this are merged into a neighbour (speech bubbles, SFX). */
  minPanelHeight: number;
  /** Split regions taller than this at the quietest row (0 = only split when the browser requires it). */
  maxPanelHeight: number;
  /** Extra gutter kept around each panel (px). */
  padding: number;
  format: 'image/jpeg' | 'image/webp' | 'image/png';
  quality: number;
  /** Output strip width is the pages' most common width, capped at this. */
  maxWidth: number;
}

export const DEFAULT_SLICE_OPTIONS: SliceOptions = {
  gutter: 'auto',
  tolerance: 14,
  coverage: 0.985,
  minGutter: 20,
  minPanelHeight: 160,
  maxPanelHeight: 0,
  padding: 6,
  format: 'image/jpeg',
  quality: 0.92,
  maxWidth: 1600,
};

interface StripSource {
  name: string;
  blob: Blob;
  width: number;
  height: number;
  /** Offset & height in strip (output) pixels. */
  offset: number;
  h: number;
  /** Offset & height in analysis rows. */
  aOffset: number;
  ha: number;
}

export interface Strip {
  width: number;
  height: number;
  analysisWidth: number;
  analysisHeight: number;
  sources: StripSource[];
  skipped: string[];
}

export interface SlicedPanel {
  index: number;
  blob: Blob;
  width: number;
  height: number;
  y0: number;
  y1: number;
}

export type SliceProgress = (stage: 'measuring' | 'analysing' | 'exporting', fraction: number) => void;

const ANALYSIS_WIDTH = 400;

export async function prepareStrip(images: SourceImage[], maxWidth: number, onProgress?: SliceProgress): Promise<Strip> {
  const dims: Array<{ img: SourceImage; w: number; h: number }> = [];
  const skipped: string[] = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const bmp = await createImageBitmap(images[i].blob);
      dims.push({ img: images[i], w: bmp.width, h: bmp.height });
      bmp.close();
    } catch {
      skipped.push(images[i].name);
    }
    onProgress?.('measuring', (i + 1) / images.length);
  }
  if (!dims.length) throw new Error('None of the images could be decoded.');

  // Most common page width (ties → wider) becomes the strip width.
  const counts = new Map<number, number>();
  for (const d of dims) counts.set(d.w, (counts.get(d.w) ?? 0) + 1);
  const modeWidth = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const width = Math.min(maxWidth, modeWidth);
  const analysisWidth = Math.min(width, ANALYSIS_WIDTH);

  let offset = 0;
  let aOffset = 0;
  const sources: StripSource[] = dims.map(({ img, w, h }) => {
    const sh = Math.max(1, Math.round((h * width) / w));
    const ha = Math.max(1, Math.round((h * analysisWidth) / w));
    const src = { name: img.name, blob: img.blob, width: w, height: h, offset, h: sh, aOffset, ha };
    offset += sh;
    aOffset += ha;
    return src;
  });
  return { width, height: offset, analysisWidth, analysisHeight: aOffset, sources, skipped };
}

/** Per analysis row: 1 if gutter; plus a "busyness" score used to pick split points. */
async function analyse(strip: Strip, opts: SliceOptions, onProgress?: SliceProgress) {
  const Wa = strip.analysisWidth;
  const gutter = new Uint8Array(strip.analysisHeight);
  const busy = new Float32Array(strip.analysisHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Wa;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const x0 = Math.floor(Wa * 0.02); // ignore 2% at each edge (scan borders, scrollbars)
  const x1 = Wa - x0;
  const count = x1 - x0;
  const lums = new Float32Array(Wa);
  const BAND = 1024;

  for (let s = 0; s < strip.sources.length; s++) {
    const src = strip.sources[s];
    const bmp = await createImageBitmap(src.blob);
    const k = src.height / src.ha; // source px per analysis row
    for (let ay = 0; ay < src.ha; ay += BAND) {
      const rows = Math.min(BAND, src.ha - ay);
      if (canvas.height !== rows) canvas.height = rows;
      ctx.clearRect(0, 0, Wa, rows);
      const sy = ay * k;
      const sh = Math.min(rows * k, src.height - sy);
      ctx.drawImage(bmp, 0, sy, src.width, sh, 0, 0, Wa, rows);
      const d = ctx.getImageData(0, 0, Wa, rows).data;

      for (let r = 0; r < rows; r++) {
        const base = r * Wa * 4;
        let sum = 0;
        for (let x = x0; x < x1; x++) {
          const i = base + x * 4;
          const a = d[i + 3] / 255;
          // Composite transparent pixels over white.
          const l = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a);
          lums[x] = l;
          sum += l;
        }
        const mean = sum / count;
        let match = 0;
        for (let x = x0; x < x1; x++) if (Math.abs(lums[x] - mean) <= opts.tolerance) match++;
        const frac = match / count;
        const colourOk =
          opts.gutter === 'auto' || (opts.gutter === 'white' && mean >= 200) || (opts.gutter === 'black' && mean <= 60);
        const row = src.aOffset + ay + r;
        gutter[row] = frac >= opts.coverage && colourOk ? 1 : 0;
        busy[row] = 1 - frac;
      }
      await yieldToMain();
    }
    bmp.close();
    onProgress?.('analysing', (s + 1) / strip.sources.length);
  }
  canvas.width = canvas.height = 0;
  return { gutter, busy };
}

interface Region {
  s: number;
  e: number;
  locked?: boolean;
}

function findContentRegions(gutter: Uint8Array, minGutterRows: number): Region[] {
  const regions: Region[] = [];
  let start = -1;
  let lastContentEnd = -1;
  let run = 0;
  for (let i = 0; i < gutter.length; i++) {
    if (gutter[i]) {
      run++;
      continue;
    }
    if (start < 0) start = i;
    else if (run >= minGutterRows) {
      regions.push({ s: start, e: lastContentEnd });
      start = i;
    }
    run = 0;
    lastContentEnd = i + 1;
  }
  if (start >= 0) regions.push({ s: start, e: lastContentEnd });
  return regions;
}

/** Merge short fragments into the nearer neighbour; drop isolated specks. */
function mergeSmall(regions: Region[], minRows: number, maxMergeGap: number, minKeepRows: number): Region[] {
  const out = regions.map((r) => ({ ...r }));
  for (;;) {
    if (out.length <= 1) break;
    let idx = -1;
    let smallest = Infinity;
    out.forEach((r, i) => {
      const h = r.e - r.s;
      if (!r.locked && h < minRows && h < smallest) {
        smallest = h;
        idx = i;
      }
    });
    if (idx < 0) break;
    const cur = out[idx];
    const gapPrev = idx > 0 ? cur.s - out[idx - 1].e : Infinity;
    const gapNext = idx < out.length - 1 ? out[idx + 1].s - cur.e : Infinity;
    if (Math.min(gapPrev, gapNext) <= maxMergeGap) {
      if (gapNext < gapPrev) out[idx + 1] = { s: cur.s, e: out[idx + 1].e };
      else out[idx - 1] = { s: out[idx - 1].s, e: cur.e };
      out.splice(idx, 1);
    } else if (cur.e - cur.s < minKeepRows) {
      out.splice(idx, 1);
    } else {
      cur.locked = true; // isolated but meaningful (e.g. a lone caption) — keep as its own panel
    }
  }
  return out;
}

function splitTall(r: Region, maxRows: number, busy: Float32Array): Region[] {
  const h = r.e - r.s;
  if (h <= maxRows) return [r];
  // Aim for pieces at 70% of the max so the ±20% search window can never exceed it.
  const k = Math.ceil(h / (maxRows * 0.7));
  const piece = h / k;
  const win = piece * 0.2;
  const out: Region[] = [];
  let start = r.s;
  for (let j = 1; j < k; j++) {
    const target = r.s + piece * j;
    let best = Math.round(target);
    let bestScore = Infinity;
    for (let y = Math.max(start + 1, Math.round(target - win)); y <= Math.min(r.e - 1, Math.round(target + win)); y++) {
      if (busy[y] < bestScore) {
        bestScore = busy[y];
        best = y;
      }
    }
    out.push({ s: start, e: best });
    start = best;
  }
  out.push({ s: start, e: r.e });
  return out;
}

function analysisToStrip(strip: Strip, a: number): number {
  for (const src of strip.sources) {
    if (a <= src.aOffset + src.ha) return src.offset + (a - src.aOffset) * (src.h / src.ha);
  }
  return strip.height;
}

/** Compute panel boundaries (strip pixel coordinates). */
export async function computeRegions(strip: Strip, opts: SliceOptions, onProgress?: SliceProgress): Promise<Array<[number, number]>> {
  const { gutter, busy } = await analyse(strip, opts, onProgress);
  const r = strip.width / strip.analysisWidth; // strip px per analysis row
  // Canvas size limits: iOS/iPadOS Safari caps canvases at ~16.7M pixels.
  const hardMax = Math.min(16000, Math.floor(16_000_000 / strip.width));
  const maxPx = opts.maxPanelHeight > 0 ? Math.min(opts.maxPanelHeight, hardMax) : hardMax;

  let regions = findContentRegions(gutter, Math.max(1, Math.round(opts.minGutter / r)));
  regions = mergeSmall(regions, opts.minPanelHeight / r, (opts.minPanelHeight * 2.5) / r, 40 / r);
  regions = regions.flatMap((reg) => splitTall(reg, maxPx / r, busy));

  const bounds = regions.map((reg) => [Math.floor(analysisToStrip(strip, reg.s)), Math.ceil(analysisToStrip(strip, reg.e))] as [number, number]);

  // Add padding, but never more than halfway into the neighbouring gutter.
  return bounds
    .map(([y0, y1], i) => {
      const prevEnd = i > 0 ? bounds[i - 1][1] : 0;
      const nextStart = i < bounds.length - 1 ? bounds[i + 1][0] : strip.height;
      const top = Math.max(y0 - opts.padding, Math.ceil((prevEnd + y0) / 2), 0);
      const bottom = Math.min(y1 + opts.padding, Math.floor((y1 + nextStart) / 2), strip.height);
      return [top, bottom] as [number, number];
    })
    .filter(([y0, y1]) => y1 - y0 >= 8);
}

/** Render each region to its own image, stitching across source files when needed. */
export async function exportPanels(
  strip: Strip,
  regions: Array<[number, number]>,
  opts: SliceOptions,
  onProgress?: SliceProgress,
): Promise<SlicedPanel[]> {
  const cache = new Map<number, ImageBitmap>();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const W = strip.width;
  const panels: SlicedPanel[] = [];

  try {
    for (let k = 0; k < regions.length; k++) {
      const [y0, y1] = regions[k];
      // Free bitmaps we've scrolled past.
      for (const [i, bmp] of cache) {
        const src = strip.sources[i];
        if (src.offset + src.h <= y0) {
          bmp.close();
          cache.delete(i);
        }
      }
      canvas.width = W;
      canvas.height = y1 - y0;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, W, y1 - y0);

      for (let i = 0; i < strip.sources.length; i++) {
        const src = strip.sources[i];
        const ov0 = Math.max(y0, src.offset);
        const ov1 = Math.min(y1, src.offset + src.h);
        if (ov1 <= ov0) continue;
        let bmp = cache.get(i);
        if (!bmp) {
          bmp = await createImageBitmap(src.blob);
          cache.set(i, bmp);
        }
        const kk = src.height / src.h; // source px per strip px
        const sy = clamp((ov0 - src.offset) * kk, 0, src.height);
        const sh = Math.min((ov1 - ov0) * kk, src.height - sy);
        if (sh > 0) ctx.drawImage(bmp, 0, sy, src.width, sh, 0, ov0 - y0, W, ov1 - ov0);
      }

      const blob = await canvasToBlob(canvas, opts.format, opts.quality);
      panels.push({ index: k, blob, width: W, height: y1 - y0, y0, y1 });
      onProgress?.('exporting', (k + 1) / regions.length);
      await yieldToMain();
    }
  } finally {
    for (const bmp of cache.values()) bmp.close();
    canvas.width = canvas.height = 0;
  }
  return panels;
}

export async function slice(strip: Strip, opts: SliceOptions, onProgress?: SliceProgress): Promise<SlicedPanel[]> {
  const regions = await computeRegions(strip, opts, onProgress);
  return exportPanels(strip, regions, opts, onProgress);
}

export function extensionFor(format: SliceOptions['format']) {
  return format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg';
}

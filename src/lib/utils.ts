export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ');
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Give the browser a chance to paint / handle input during long loops. */
export const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const pad = (n: number, width = 4) => String(n).padStart(width, '0');

export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function formatBytes(value?: number | string | null): string {
  const n = Number(value);
  if (!value || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.round(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m, 2)}:${pad(sec, 2)}` : `${m}:${pad(sec, 2)}`;
}

export function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Compact timestamp for file names, e.g. 20260925-2231 */
export function stamp(date = new Date()): string {
  return `${date.getFullYear()}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}-${pad(date.getHours(), 2)}${pad(
    date.getMinutes(),
    2,
  )}`;
}

/** Drive allows almost anything in names; strip path separators and control characters. */
export function sanitizeName(name: string): string {
  return name.replace(/[\u0000-\u001f/\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled';
}

export function fileSlug(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '_')
      .slice(0, 60) || 'untitled'
  );
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Run `fn` over `items` with at most `limit` in flight. Results keep input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Simple counting semaphore for throttling downloads. */
export function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    queue.shift()?.();
  };
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.92): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Canvas export failed (out of memory?)'))), type, quality);
  });
}

export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    avif: 'image/avif',
    zip: 'application/zip',
    cbz: 'application/vnd.comicbook+zip',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    json: 'application/json',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

export function downloadLocally(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Keep the screen awake during long renders on tablets/phones (best effort). */
export async function requestWakeLock(): Promise<{ release: () => Promise<void> } | null> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> } };
    return (await nav.wakeLock?.request('screen')) ?? null;
  } catch {
    return null;
  }
}

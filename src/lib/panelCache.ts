/** In-memory cache of panel images downloaded from Drive (shared by Panels, Script and Composer pages). */
import { downloadBlob } from './drive';
import { createLimiter } from './utils';

const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();
const inflight = new Map<string, Promise<Blob>>();
const limit = createLimiter(6);

export function getPanelBlob(id: string): Promise<Blob> {
  const cached = blobs.get(id);
  if (cached) return Promise.resolve(cached);
  let p = inflight.get(id);
  if (!p) {
    p = limit(() => downloadBlob(id))
      .then((blob) => {
        blobs.set(id, blob);
        return blob;
      })
      .finally(() => inflight.delete(id));
    inflight.set(id, p);
  }
  return p;
}

export async function getPanelUrl(id: string): Promise<string> {
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(await getPanelBlob(id));
  urls.set(id, url);
  return url;
}

/** Seed the cache with a blob we already have (e.g. right after slicing). */
export function putPanelBlob(id: string, blob: Blob) {
  blobs.set(id, blob);
}

export function evictPanel(id: string) {
  blobs.delete(id);
  const url = urls.get(id);
  if (url) URL.revokeObjectURL(url);
  urls.delete(id);
}

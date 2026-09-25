/**
 * Thin Google Drive v3 REST client (fetch + XHR for upload progress).
 * No gapi dependency — works the same on desktop, tablet and phone browsers.
 */
import { AuthError, getToken, markTokenExpired } from './auth';
import { sleep } from './utils';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,parents,webViewLink,iconLink,appProperties,imageMediaMetadata(width,height)';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  parents?: string[];
  webViewLink?: string;
  iconLink?: string;
  appProperties?: Record<string, string>;
  imageMediaMetadata?: { width?: number; height?: number };
}

export class DriveError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'DriveError';
    this.status = status;
  }
}

/** Escape a value for use inside a Drive `q` string literal. */
export function escapeQ(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const RETRYABLE_REASONS = /rateLimitExceeded|userRateLimitExceeded|backendError|internalError/;

async function driveFetch(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
  const token = getToken();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...init, headers });
  if (res.ok) return res;

  const text = await res.text().catch(() => '');
  let message = res.statusText;
  let reason = '';
  try {
    const j = JSON.parse(text);
    message = j.error?.message || message;
    reason = j.error?.errors?.[0]?.reason || '';
  } catch {
    /* not JSON */
  }

  const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && RETRYABLE_REASONS.test(reason));
  if (retryable && attempt < 4) {
    await sleep(600 * 2 ** attempt + Math.random() * 400);
    return driveFetch(url, init, attempt + 1);
  }
  if (res.status === 401) {
    markTokenExpired();
    throw new AuthError();
  }
  throw new DriveError(`Google Drive: ${message} (${res.status})`, res.status);
}

export async function getAbout(): Promise<{ user: { displayName?: string; emailAddress?: string; photoLink?: string } }> {
  const res = await driveFetch(`${API}/about?fields=${encodeURIComponent('user(displayName,emailAddress,photoLink)')}`);
  return res.json();
}

export async function listFiles(
  q: string,
  opts: { orderBy?: string; pageSize?: number; fields?: string; max?: number } = {},
): Promise<DriveFile[]> {
  const out: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q,
      pageSize: String(opts.pageSize ?? 1000),
      fields: `nextPageToken,files(${opts.fields ?? FILE_FIELDS})`,
      spaces: 'drive',
    });
    if (opts.orderBy) params.set('orderBy', opts.orderBy);
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveFetch(`${API}/files?${params}`);
    const data = await res.json();
    out.push(...((data.files as DriveFile[]) ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken && (!opts.max || out.length < opts.max));
  return out;
}

export function listChildren(
  folderId: string,
  opts: { foldersOnly?: boolean; orderBy?: string; mimePrefix?: string } = {},
): Promise<DriveFile[]> {
  let q = `'${escapeQ(folderId)}' in parents and trashed = false`;
  if (opts.foldersOnly) q += ` and mimeType = '${FOLDER_MIME}'`;
  if (opts.mimePrefix) q += ` and mimeType contains '${escapeQ(opts.mimePrefix)}'`;
  return listFiles(q, { orderBy: opts.orderBy ?? 'folder,name_natural' });
}

export async function findChild(parentId: string, name: string, mimeType?: string): Promise<DriveFile | null> {
  let q = `name = '${escapeQ(name)}' and '${escapeQ(parentId)}' in parents and trashed = false`;
  if (mimeType) q += ` and mimeType = '${escapeQ(mimeType)}'`;
  const files = await listFiles(q, { orderBy: 'createdTime', pageSize: 10, max: 10 });
  return files[0] ?? null;
}

export async function getFile(id: string): Promise<DriveFile> {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`);
  return res.json();
}

export async function createFolder(name: string, parentId: string): Promise<DriveFile> {
  const res = await driveFetch(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return res.json();
}

const folderCache = new Map<string, Promise<string>>();

/** Find-or-create a folder. Concurrent calls for the same folder share one request (no duplicates). */
export function ensureFolder(name: string, parentId: string): Promise<string> {
  const key = `${parentId}/${name}`;
  let p = folderCache.get(key);
  if (!p) {
    p = (async () => {
      const existing = await findChild(parentId, name, FOLDER_MIME);
      return existing ? existing.id : (await createFolder(name, parentId)).id;
    })();
    p.catch(() => folderCache.delete(key));
    folderCache.set(key, p);
  }
  return p;
}

export function clearFolderCache() {
  folderCache.clear();
}

export async function downloadBlob(id: string, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<Blob> {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, { signal });
  const total = Number(res.headers.get('Content-Length')) || 0;
  const type = res.headers.get('Content-Type') || '';
  if (!onProgress || !res.body || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(1, loaded / total));
  }
  return new Blob(chunks as BlobPart[], { type });
}

export async function downloadText(id: string): Promise<string> {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?alt=media`);
  return res.text();
}

export async function downloadJson<T = unknown>(id: string): Promise<T> {
  return JSON.parse(await downloadText(id)) as T;
}

export interface UploadOptions {
  name: string;
  parentId: string;
  mimeType?: string;
  appProperties?: Record<string, string>;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const MULTIPART_LIMIT = 5 * 1024 * 1024;

/** Upload a new file. Small files use one multipart request; large ones a resumable session with progress. */
export async function uploadFile(blob: Blob, opts: UploadOptions): Promise<DriveFile> {
  const mimeType = opts.mimeType || blob.type || 'application/octet-stream';
  const meta: Record<string, unknown> = { name: opts.name, parents: [opts.parentId], mimeType };
  if (opts.appProperties) meta.appProperties = opts.appProperties;

  if (blob.size <= MULTIPART_LIMIT) {
    const file = await uploadMultipart(blob, meta, mimeType, opts.signal);
    opts.onProgress?.(1);
    return file;
  }

  const init = await driveFetch(`${UPLOAD_API}/files?uploadType=resumable&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(blob.size),
    },
    body: JSON.stringify(meta),
    signal: opts.signal,
  });
  const sessionUrl = init.headers.get('Location');
  if (!sessionUrl) return uploadMultipart(blob, meta, mimeType, opts.signal);
  return putWithProgress(sessionUrl, blob, mimeType, opts.onProgress, opts.signal);
}

async function uploadMultipart(blob: Blob, meta: Record<string, unknown>, mimeType: string, signal?: AbortSignal) {
  const boundary = `mrs_${Math.random().toString(36).slice(2)}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const res = await driveFetch(`${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
    signal,
  });
  return (await res.json()) as DriveFile;
}

function putWithProgress(
  url: string,
  blob: Blob,
  mimeType: string,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<DriveFile> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('Upload finished but Drive returned an unexpected response.'));
        }
      } else if (xhr.status === 401) {
        markTokenExpired();
        reject(new AuthError());
      } else {
        reject(new DriveError(`Upload failed (${xhr.status}): ${xhr.responseText.slice(0, 200)}`, xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(blob);
  });
}

/** Replace the content of an existing file. */
export async function updateFileContent(id: string, blob: Blob, mimeType: string): Promise<DriveFile> {
  const res = await driveFetch(`${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': mimeType },
    body: blob,
  });
  return res.json();
}

/** Create or overwrite `name` inside `parentId`. */
export async function saveFile(parentId: string, name: string, blob: Blob, mimeType: string, existingId?: string): Promise<DriveFile> {
  const id = existingId || (await findChild(parentId, name))?.id;
  if (id) {
    try {
      return await updateFileContent(id, blob, mimeType);
    } catch (err) {
      if (!(err instanceof DriveError && err.status === 404)) throw err;
    }
  }
  return uploadFile(blob, { name, parentId, mimeType });
}

export function saveJson(parentId: string, name: string, data: unknown, existingId?: string): Promise<DriveFile> {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  return saveFile(parentId, name, blob, 'application/json', existingId);
}

export function saveText(parentId: string, name: string, text: string, existingId?: string): Promise<DriveFile> {
  return saveFile(parentId, name, new Blob([text], { type: 'text/plain' }), 'text/plain', existingId);
}

/** Moves a file to Drive's trash (recoverable for 30 days) — never hard-deletes. */
export async function trashFile(id: string): Promise<void> {
  await driveFetch(`${API}/files/${encodeURIComponent(id)}?fields=id`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

export async function renameFile(id: string, name: string): Promise<DriveFile> {
  const res = await driveFetch(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return res.json();
}

export const isFolder = (f: Pick<DriveFile, 'mimeType'>) => f.mimeType === FOLDER_MIME;
export const isImage = (f: Pick<DriveFile, 'mimeType' | 'name'>) =>
  f.mimeType.startsWith('image/') || /\.(jpe?g|png|webp|gif|bmp|avif)$/i.test(f.name);
export const isArchive = (f: Pick<DriveFile, 'mimeType' | 'name'>) =>
  /\.(cbz|zip)$/i.test(f.name) || /zip|comicbook/i.test(f.mimeType);
export const isAudio = (f: Pick<DriveFile, 'mimeType' | 'name'>) => f.mimeType.startsWith('audio/') || /\.(mp3|wav|m4a|ogg)$/i.test(f.name);
export const isJson = (f: Pick<DriveFile, 'mimeType' | 'name'>) => /\.json$/i.test(f.name) || f.mimeType === 'application/json';

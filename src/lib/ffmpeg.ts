/**
 * Single shared FFmpeg.wasm instance (single-threaded core — no COOP/COEP headers
 * needed, so Google sign-in popups keep working). The ~31 MB core is fetched from a
 * CDN the first time and then served from the browser cache.
 */
import type { FFmpeg } from '@ffmpeg/ffmpeg';

const CORE_VERSION = '0.12.10';
// Next.js (webpack) bundles the FFmpeg worker as a classic worker, which needs the UMD
// core (loaded via importScripts). The ESM builds are a fallback in case the worker ends
// up as a module worker (e.g. other bundlers), where only `import()` works.
const CORE_BASES = [
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/umd`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];

let instance: FFmpeg | null = null;
let loading: Promise<FFmpeg> | null = null;
const logListeners = new Set<(line: string) => void>();
const progressListeners = new Set<(p: number) => void>();

export function onFFmpegLog(fn: (line: string) => void) {
  logListeners.add(fn);
  return () => void logListeners.delete(fn);
}

export function onFFmpegProgress(fn: (p: number) => void) {
  progressListeners.add(fn);
  return () => void progressListeners.delete(fn);
}

export function getFFmpeg(): Promise<FFmpeg> {
  if (instance) return Promise.resolve(instance);
  if (!loading) {
    loading = (async () => {
      const [{ FFmpeg }, { toBlobURL }] = await Promise.all([import('@ffmpeg/ffmpeg'), import('@ffmpeg/util')]);
      let lastErr: unknown;
      for (const base of CORE_BASES) {
        const ff = new FFmpeg();
        ff.on('log', ({ message }) => logListeners.forEach((fn) => fn(message)));
        ff.on('progress', ({ progress }) => progressListeners.forEach((fn) => fn(progress)));
        try {
          await ff.load({
            coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
          });
          instance = ff;
          return ff;
        } catch (err) {
          lastErr = err;
          try {
            ff.terminate();
          } catch {
            /* ignore */
          }
        }
      }
      throw new Error(`Could not load FFmpeg.wasm: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** Kill the worker (used to cancel a running job). The next getFFmpeg() starts fresh. */
export function resetFFmpeg() {
  try {
    instance?.terminate();
  } catch {
    /* ignore */
  }
  instance = null;
  loading = null;
}

export async function safeDelete(ff: FFmpeg, path: string) {
  try {
    await ff.deleteFile(path);
  } catch {
    /* already gone */
  }
}

/** WAV → 128 kbps MP3 with libmp3lame. */
export async function encodeMp3(wav: Blob, bitrate = '128k'): Promise<Blob> {
  const ff = await getFFmpeg();
  await ff.writeFile('narration_in.wav', new Uint8Array(await wav.arrayBuffer()));
  const code = await ff.exec(['-y', '-i', 'narration_in.wav', '-codec:a', 'libmp3lame', '-b:a', bitrate, 'narration_out.mp3']);
  await safeDelete(ff, 'narration_in.wav');
  if (code !== 0) throw new Error('MP3 encoding failed.');
  const data = (await ff.readFile('narration_out.mp3')) as Uint8Array;
  await safeDelete(ff, 'narration_out.mp3');
  return new Blob([data as BlobPart], { type: 'audio/mpeg' });
}

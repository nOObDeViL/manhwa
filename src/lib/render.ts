/**
 * Browser-only MP4 export with FFmpeg.wasm.
 *
 * Frames are drawn with the Ken Burns canvas renderer, JPEG-encoded, and fed to FFmpeg
 * in chunks (default 90 frames). Each chunk becomes a small H.264 segment and its frames
 * are deleted straight away, so memory stays flat no matter how long the video is.
 * Finally the segments are concatenated (stream copy, no re-encode) and muxed with the
 * narration as AAC.
 */
import { getFFmpeg, onFFmpegLog, onFFmpegProgress, resetFFmpeg, safeDelete } from './ffmpeg';
import { ComposeSettings, FrameRenderer, Segment } from './kenburns';
import { canvasToBlob, pad } from './utils';

export const QUALITY_PRESETS = {
  fast: { label: 'Fast (ultrafast, bigger file)', preset: 'ultrafast', crf: 24 },
  balanced: { label: 'Balanced (superfast)', preset: 'superfast', crf: 22 },
  quality: { label: 'Quality (veryfast, slowest)', preset: 'veryfast', crf: 20 },
} as const;
export type QualityKey = keyof typeof QUALITY_PRESETS;

export interface RenderJob {
  segments: Segment[];
  settings: ComposeSettings;
  audio: Blob;
  audioExt: string;
  /** Video length (narration + tail). */
  duration: number;
  quality: QualityKey;
  signal: AbortSignal;
  onProgress: (info: { stage: string; fraction: number; fps?: number; etaSec?: number }) => void;
  onLog?: (line: string) => void;
}

const CHUNK_FRAMES = 90;

export async function renderVideo(job: RenderJob): Promise<Blob> {
  const { width: W, height: H, fps } = job.settings;
  const q = QUALITY_PRESETS[job.quality];
  job.onProgress({ stage: 'Loading FFmpeg.wasm (≈31 MB, cached after first use)…', fraction: 0 });

  const abortError = () => new DOMException('Render cancelled', 'AbortError');
  if (job.signal.aborted) throw abortError();
  const onAbort = () => resetFFmpeg(); // kills an in-flight exec immediately
  job.signal.addEventListener('abort', onAbort, { once: true });

  const logTail: string[] = [];
  const offLog = onFFmpegLog((line) => {
    logTail.push(line);
    if (logTail.length > 30) logTail.shift();
    job.onLog?.(line);
  });

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const renderer = new FrameRenderer(ctx, W, H, job.settings, job.segments);
  const written: string[] = [];
  // Frame files of the chunk in progress — must be removed even on failure, otherwise a later
  // render's shorter final chunk would pick up stale frames through the f%04d.jpg pattern.
  let frameNames: string[] = [];

  try {
    const ff = await getFFmpeg();
    const totalFrames = Math.max(1, Math.ceil(job.duration * fps));
    const segFiles: string[] = [];
    const started = performance.now();
    let chunkProgress = 0;
    let doneFrames = 0;

    const report = (stage: string) => {
      const fraction = Math.min(1, (doneFrames + chunkProgress) / totalFrames) * 0.97;
      const elapsed = (performance.now() - started) / 1000;
      const speed = (doneFrames + chunkProgress) / Math.max(0.001, elapsed);
      job.onProgress({ stage, fraction, fps: speed, etaSec: speed > 0 ? (totalFrames - doneFrames - chunkProgress) / speed : undefined });
    };

    for (let c = 0, s = 0; c < totalFrames; c += CHUNK_FRAMES, s++) {
      const n = Math.min(CHUNK_FRAMES, totalFrames - c);
      frameNames = [];

      // 1) draw + JPEG-encode this chunk's frames (≈40% of the chunk's work)
      for (let k = 0; k < n; k++) {
        if (job.signal.aborted) throw abortError();
        await renderer.renderFrame((c + k) / fps);
        const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
        const name = `f${pad(k, 4)}.jpg`;
        await ff.writeFile(name, new Uint8Array(await jpg.arrayBuffer()));
        frameNames.push(name);
        chunkProgress = ((k + 1) / n) * 0.4 * n;
        if (k % 10 === 0) report(`Drawing frames ${c + k + 1}/${totalFrames}`);
      }

      // 2) encode the chunk to an H.264 segment (≈60%)
      const seg = `seg${pad(s, 5)}.mp4`;
      const offProgress = onFFmpegProgress((p) => {
        chunkProgress = n * (0.4 + 0.6 * Math.min(1, Math.max(0, p)));
        report(`Encoding segment ${s + 1}/${Math.ceil(totalFrames / CHUNK_FRAMES)}`);
      });
      const code = await ff.exec([
        '-y',
        '-framerate', String(fps),
        '-i', 'f%04d.jpg',
        '-c:v', 'libx264',
        '-preset', q.preset,
        '-crf', String(q.crf),
        '-bf', '0',
        '-g', String(fps * 2),
        '-pix_fmt', 'yuv420p',
        '-r', String(fps),
        seg,
      ]);
      offProgress();
      for (const f of frameNames) await safeDelete(ff, f);
      frameNames = [];
      if (job.signal.aborted) throw abortError();
      if (code !== 0) throw new Error(`Encoding failed on segment ${s + 1}.\n${logTail.slice(-6).join('\n')}`);
      segFiles.push(seg);
      written.push(seg);
      doneFrames += n;
      chunkProgress = 0;
      report(`Encoded ${doneFrames}/${totalFrames} frames`);
    }

    // 3) concat segments + mux narration
    job.onProgress({ stage: 'Muxing audio and finalising MP4…', fraction: 0.975 });
    const audioName = `narration.${job.audioExt}`;
    await ff.writeFile(audioName, new Uint8Array(await job.audio.arrayBuffer()));
    await ff.writeFile('list.txt', segFiles.map((f) => `file '${f}'`).join('\n'));
    written.push(audioName, 'list.txt');

    const mux = (audioCodec: string[]) =>
      ff.exec([
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', 'list.txt',
        '-i', audioName,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        ...audioCodec,
        '-movflags', '+faststart',
        'out.mp4',
      ]);
    let code = await mux(['-c:a', 'aac', '-b:a', '192k']);
    if (code !== 0 && !job.signal.aborted) code = await mux(['-c:a', 'copy']); // fallback: keep MP3 audio as-is
    if (job.signal.aborted) throw abortError();
    if (code !== 0) throw new Error(`Final mux failed.\n${logTail.slice(-6).join('\n')}`);
    written.push('out.mp4');

    const data = (await ff.readFile('out.mp4')) as Uint8Array;
    job.onProgress({ stage: 'Done', fraction: 1 });
    return new Blob([data as BlobPart], { type: 'video/mp4' });
  } finally {
    offLog();
    job.signal.removeEventListener('abort', onAbort);
    renderer.dispose();
    canvas.width = canvas.height = 0;
    if (!job.signal.aborted) {
      try {
        const ff = await getFFmpeg();
        for (const f of [...frameNames, ...written]) await safeDelete(ff, f);
      } catch {
        /* ignore */
      }
    }
  }
}

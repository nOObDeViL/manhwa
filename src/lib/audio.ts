/** Web Audio helpers: decode TTS clips, stitch them into one narration track, encode WAV. */

export const SAMPLE_RATE = 44100;

/** Decode any browser-supported audio (mp3/wav/ogg) to a mono Float32Array at 44.1 kHz. */
export async function decodeToMono(data: ArrayBuffer): Promise<Float32Array> {
  // OfflineAudioContext resamples to its own rate and needs no user gesture.
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(data.slice(0));
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buffer.numberOfChannels;
  }
  return out;
}

/** Trim leading/trailing near-silence that TTS engines pad clips with (keeps a 40 ms margin). */
export function trimSilence(samples: Float32Array, threshold = 0.008, marginSec = 0.04): Float32Array {
  const margin = Math.round(marginSec * SAMPLE_RATE);
  let start = 0;
  let end = samples.length - 1;
  while (start < samples.length && Math.abs(samples[start]) < threshold) start++;
  while (end > start && Math.abs(samples[end]) < threshold) end--;
  if (start >= end) return samples;
  return samples.subarray(Math.max(0, start - margin), Math.min(samples.length, end + margin + 1));
}

export interface StitchOptions {
  leadSec: number;
  /** Silence between beats. */
  gapSec: number;
  /** Silence between chunks of the same beat. */
  chunkGapSec: number;
  tailSec: number;
  normalize: boolean;
  trim: boolean;
}

export const DEFAULT_STITCH: StitchOptions = { leadSec: 0.3, gapSec: 0.45, chunkGapSec: 0.12, tailSec: 0.8, normalize: true, trim: true };

export interface StitchResult {
  samples: Float32Array;
  sampleRate: number;
  duration: number;
  /** Start/end of each beat's speech, in seconds. */
  beats: Array<{ start: number; end: number }>;
}

/** `beats[i]` is the list of decoded chunks for beat i. */
export function stitch(beats: Float32Array[][], opts: StitchOptions = DEFAULT_STITCH): StitchResult {
  const sec = (s: number) => Math.round(s * SAMPLE_RATE);
  const clips = beats.map((chunks) => chunks.map((c) => (opts.trim ? trimSilence(c) : c)));

  let total = sec(opts.leadSec) + sec(opts.tailSec);
  clips.forEach((chunks, i) => {
    chunks.forEach((c, j) => {
      total += c.length + (j > 0 ? sec(opts.chunkGapSec) : 0);
    });
    if (i > 0) total += sec(opts.gapSec);
  });

  const out = new Float32Array(total);
  const timeline: StitchResult['beats'] = [];
  let pos = sec(opts.leadSec);
  clips.forEach((chunks, i) => {
    if (i > 0) pos += sec(opts.gapSec);
    const start = pos;
    chunks.forEach((c, j) => {
      if (j > 0) pos += sec(opts.chunkGapSec);
      out.set(c, pos);
      pos += c.length;
    });
    timeline.push({ start: start / SAMPLE_RATE, end: pos / SAMPLE_RATE });
  });

  if (opts.normalize) {
    let peak = 0;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0.001) {
      const gain = 0.89 / peak; // ≈ -1 dBFS
      for (let i = 0; i < out.length; i++) out[i] *= gain;
    }
  }
  return { samples: out, sampleRate: SAMPLE_RATE, duration: out.length / SAMPLE_RATE, beats: timeline };
}

export function encodeWav(samples: Float32Array, sampleRate = SAMPLE_RATE): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** Duration of an audio blob via a media element (cheap; no full decode). */
export function audioDuration(blob: Blob): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const el = new Audio();
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = el.duration;
      URL.revokeObjectURL(url);
      if (Number.isFinite(d)) resolve(d);
      else reject(new Error('Could not read audio duration.'));
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This audio file could not be read by the browser.'));
    };
    el.src = url;
  });
}

export interface NarrationTimeline {
  app: 'manhwa-recap-studio';
  version: 1;
  audioFileName: string;
  scriptTitle?: string;
  duration: number;
  sampleRate: number;
  createdAt: string;
  beats: Array<{ n: number; start: number; end: number; text: string }>;
}

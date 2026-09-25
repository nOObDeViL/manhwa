/**
 * Gemini helpers shared by the script generator and Gemini TTS:
 *  - discovers which models your API key can use and ranks them (free-tier friendly first)
 *  - on quota/busy errors automatically waits or moves to the next model
 *  - remembers exhausted models for this session so every request doesn't re-hit them
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ModelKind = 'text' | 'tts';

const STATIC_FALLBACKS: Record<ModelKind, string[]> = {
  text: ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
  tts: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'],
};

let clientCache: { key: string; ai: any; Type: any } | null = null;
export async function getGemini(apiKey: string): Promise<{ ai: any; Type: any }> {
  if (!apiKey) throw new Error('Add your Google Gemini API key on the Settings page (free at aistudio.google.com/apikey).');
  if (clientCache?.key === apiKey) return clientCache;
  const { GoogleGenAI, Type } = await import('@google/genai');
  clientCache = { key: apiKey, ai: new GoogleGenAI({ apiKey }), Type };
  return clientCache;
}

let modelList: { key: string; names: Promise<string[]> } | null = null;

/** All models this key can call generateContent on (cached per session). */
export function listAvailableModels(apiKey: string): Promise<string[]> {
  if (modelList?.key === apiKey) return modelList.names;
  const names = (async () => {
    const { ai } = await getGemini(apiKey);
    const pager = await ai.models.list({ config: { pageSize: 200 } });
    const out: string[] = [];
    for await (const m of pager) {
      const name = String(m.name ?? '').replace(/^models\//, '');
      const actions: string[] | undefined = m.supportedActions;
      if (name.startsWith('gemini') && (!actions || actions.includes('generateContent'))) out.push(name);
    }
    return out;
  })();
  names.catch(() => {
    modelList = null;
  });
  modelList = { key: apiKey, names };
  return names;
}

const version = (name: string) => {
  const m = name.match(/gemini-(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : name.includes('latest') ? 99 : 0;
};

/** Best-first order. Flash models have the most generous free tier; Pro is often “limit: 0” on free keys. */
export function rankModels(names: string[], kind: ModelKind): string[] {
  const usable = names.filter((n) =>
    kind === 'tts' ? /tts/.test(n) : !/tts|image|embedding|live|audio|native|vision|aqa|computer-use|robotics|thinking-exp/.test(n),
  );
  const tier = (n: string) => (/flash-lite/.test(n) ? 2 : /flash/.test(n) ? 3 : /pro/.test(n) ? 1 : 0);
  const penalty = (n: string) => (/exp/.test(n) ? 1 : 0);
  return usable.sort((a, b) => tier(b) - tier(a) || version(b) - version(a) || penalty(a) - penalty(b) || a.localeCompare(b));
}

type ErrorClass = 'exhausted' | 'ratelimit' | 'busy' | 'unavailable-model' | 'auth' | 'other';

function errText(err: unknown): string {
  return err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
}

export function classifyGeminiError(err: unknown): { kind: ErrorClass; retryAfterSec?: number } {
  const msg = errText(err);
  const retry = msg.match(/retry in ([\d.]+)s/i) || msg.match(/"retryDelay":"(\d+)s"/);
  const retryAfterSec = retry ? Math.ceil(parseFloat(retry[1])) : undefined;
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|API key expired/i.test(msg)) return { kind: 'auth' };
  if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(msg)) {
    // "limit: 0" = model not in free tier; PerDay = daily cap reached. Either way, skip this model.
    if (/limit: 0\b|PerDay/i.test(msg)) return { kind: 'exhausted', retryAfterSec };
    return { kind: 'ratelimit', retryAfterSec };
  }
  if (/\b(503|500)\b|UNAVAILABLE|overloaded|high demand|INTERNAL/i.test(msg)) return { kind: 'busy' };
  if (/\b404\b|NOT_FOUND|not found|not supported|does not support|INVALID_ARGUMENT.*(model|modality)|response modalit/i.test(msg))
    return { kind: 'unavailable-model' };
  return { kind: 'other' };
}

/** Models known to be unusable this session → epoch ms until which to skip them. */
const skipUntil = new Map<string, number>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `call(model)` on the best available model. `preferred` models (user choice, last
 * success) are tried first, then the ranked list for the key, then static fallbacks.
 */
export async function withGeminiModel<T>(
  apiKey: string,
  kind: ModelKind,
  preferred: Array<string | undefined>,
  call: (model: string) => Promise<T>,
  onStatus?: (message: string) => void,
): Promise<{ result: T; model: string }> {
  let discovered: string[] = [];
  try {
    discovered = rankModels(await listAvailableModels(apiKey), kind);
  } catch (err) {
    if (classifyGeminiError(err).kind === 'auth') throw friendly(err);
    /* listing failed — fall back to static names */
  }
  const seen = new Set<string>();
  const candidates = [...preferred, ...discovered, ...STATIC_FALLBACKS[kind]].filter((m): m is string => {
    if (!m || m === 'auto' || seen.has(m)) return false;
    seen.add(m);
    return true;
  });
  // If the key's model list is known, don't waste requests on names it doesn't have.
  const pool = discovered.length ? candidates.filter((m) => discovered.includes(m) || preferred.includes(m)) : candidates;

  let lastErr: unknown = null;
  let sawExhausted = false;
  for (const model of pool) {
    if ((skipUntil.get(model) ?? 0) > Date.now()) continue;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        onStatus?.(attempt ? `Retrying ${model}…` : `Using ${model}…`);
        return { result: await call(model), model };
      } catch (err) {
        lastErr = err;
        const c = classifyGeminiError(err);
        if (c.kind === 'auth' || c.kind === 'other') throw friendly(err);
        if (c.kind === 'exhausted') {
          sawExhausted = true;
          skipUntil.set(model, Date.now() + 6 * 3600_000);
          onStatus?.(`${model} has no free quota left — switching model…`);
          break;
        }
        if (c.kind === 'unavailable-model') {
          skipUntil.set(model, Date.now() + 24 * 3600_000);
          break;
        }
        if (c.kind === 'ratelimit' && attempt < 3) {
          const wait = Math.min(65, c.retryAfterSec ?? 20);
          for (let s = wait; s > 0; s--) {
            onStatus?.(`Free-tier rate limit on ${model} — waiting ${s}s…`);
            await sleep(1000);
          }
          continue;
        }
        if (c.kind === 'busy' && attempt < 1) {
          onStatus?.(`${model} is busy — retrying…`);
          await sleep(3000);
          continue;
        }
        break; // move on to the next model
      }
    }
  }
  if (sawExhausted && lastErr && classifyGeminiError(lastErr).kind === 'exhausted')
    throw new Error('Every Gemini model available to your key has used up its free quota for now. Try again later (daily limits reset at midnight Pacific time), or switch engine/provider.');
  throw friendly(lastErr ?? new Error('No Gemini model is available for this key.'));
}

export function friendly(err: unknown): Error {
  const msg = errText(err);
  const c = classifyGeminiError(err);
  if (c.kind === 'auth') return new Error('Your Gemini API key was rejected — check it on the Settings page.');
  if (c.kind === 'busy') return new Error('Gemini is overloaded right now. Wait a minute and try again.');
  if (c.kind === 'ratelimit' || c.kind === 'exhausted') return new Error('Gemini free-tier quota reached. Wait a bit and try again.');
  return err instanceof Error ? err : new Error(msg);
}

/* ------------------------------ Gemini TTS ------------------------------ */

/** Gemini's prebuilt voices (name — character). */
export const GEMINI_VOICES: Array<{ id: string; detail: string }> = [
  { id: 'Charon', detail: 'Informative · deep male' },
  { id: 'Fenrir', detail: 'Excitable · male' },
  { id: 'Orus', detail: 'Firm · male' },
  { id: 'Algenib', detail: 'Gravelly · male' },
  { id: 'Iapetus', detail: 'Clear · male' },
  { id: 'Enceladus', detail: 'Breathy · male' },
  { id: 'Puck', detail: 'Upbeat · male' },
  { id: 'Alnilam', detail: 'Firm · male' },
  { id: 'Rasalgethi', detail: 'Informative · male' },
  { id: 'Sadaltager', detail: 'Knowledgeable · male' },
  { id: 'Gacrux', detail: 'Mature · female' },
  { id: 'Umbriel', detail: 'Easy-going · male' },
  { id: 'Algieba', detail: 'Smooth · male' },
  { id: 'Schedar', detail: 'Even · male' },
  { id: 'Achird', detail: 'Friendly · male' },
  { id: 'Zubenelgenubi', detail: 'Casual · male' },
  { id: 'Sadachbia', detail: 'Lively · male' },
  { id: 'Kore', detail: 'Firm · female' },
  { id: 'Zephyr', detail: 'Bright · female' },
  { id: 'Aoede', detail: 'Breezy · female' },
  { id: 'Leda', detail: 'Youthful · female' },
  { id: 'Callirrhoe', detail: 'Easy-going · female' },
  { id: 'Autonoe', detail: 'Bright · female' },
  { id: 'Despina', detail: 'Smooth · female' },
  { id: 'Erinome', detail: 'Clear · female' },
  { id: 'Laomedeia', detail: 'Upbeat · female' },
  { id: 'Achernar', detail: 'Soft · female' },
  { id: 'Pulcherrima', detail: 'Forward · female' },
  { id: 'Vindemiatrix', detail: 'Gentle · female' },
  { id: 'Sulafat', detail: 'Warm · female' },
];

export const GEMINI_STYLE_PRESETS = [
  { label: 'Dramatic recap narrator', value: 'Narrate like a gripping YouTube manhwa recap storyteller, dramatic but clear, with natural pauses' },
  { label: 'Hype & energetic', value: 'Read with high energy and excitement, like a hype anime recap channel' },
  { label: 'Dark & suspenseful', value: 'Read in a low, tense, suspenseful voice, building dread' },
  { label: 'Calm storyteller', value: 'Read warmly and calmly, like a bedtime storyteller' },
  { label: 'Epic trailer voice', value: 'Read like an epic movie trailer narrator, slow and powerful' },
  { label: 'Comedic & sarcastic', value: 'Read with playful sarcasm and comedic timing' },
  { label: 'None (neutral)', value: '' },
];

/** Wrap raw 16-bit little-endian PCM in a WAV header so the browser can decode it. */
function pcm16ToWav(pcm: Uint8Array, sampleRate: number, channels = 1): ArrayBuffer {
  const buf = new ArrayBuffer(44 + pcm.length);
  const v = new DataView(buf);
  const w = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, pcm.length, true);
  new Uint8Array(buf, 44).set(pcm);
  return buf;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function geminiSpeak(opts: {
  apiKey: string;
  text: string;
  voice: string;
  style?: string;
  preferredModel?: string;
  onStatus?: (m: string) => void;
  onModel?: (m: string) => void;
}): Promise<ArrayBuffer> {
  const { ai } = await getGemini(opts.apiKey);
  const style = opts.style?.trim();
  const prompt = style ? `${style.replace(/[:.\s]+$/, '')}:\n${opts.text}` : opts.text;
  const { result, model } = await withGeminiModel(
    opts.apiKey,
    'tts',
    [opts.preferredModel],
    async (model) => {
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: opts.voice || 'Charon' } } },
        },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p: any) => p?.inlineData?.data);
      if (!part) throw new Error('Gemini TTS returned no audio (the text may have been blocked).');
      const mime: string = part.inlineData.mimeType || '';
      const bytes = base64ToBytes(part.inlineData.data);
      if (/wav|mpeg|mp3/i.test(mime)) return bytes.buffer as ArrayBuffer;
      const rate = Number(mime.match(/rate=(\d+)/)?.[1]) || 24000;
      return pcm16ToWav(bytes, rate);
    },
    opts.onStatus,
  );
  opts.onModel?.(model);
  return result;
}

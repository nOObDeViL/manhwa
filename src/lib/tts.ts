/**
 * Provider calls for ElevenLabs and Google Cloud Text-to-Speech.
 * Pure `fetch` — shared by the browser ("direct" transport) and the /api/tts edge function.
 * Must not import anything browser-only.
 */

export type TtsProviderId = 'elevenlabs' | 'google';

export interface TtsRequest {
  provider: TtsProviderId;
  text: string;
  voice: string;
  modelId?: string;
  speakingRate?: number;
}

export interface TtsVoice {
  id: string;
  name: string;
  detail?: string;
}

export class TtsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
  }
}

/** Characters per request. Google's hard limit is 5000 *bytes*; we check bytes separately. */
export const CHUNK_LIMITS: Record<TtsProviderId, number> = { elevenlabs: 2400, google: 4000 };

export const MAX_TEXT_LENGTH = 5000;

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    const detail = j.detail;
    if (typeof detail === 'string') return detail;
    if (detail?.message) return detail.message;
    if (j.error?.message) return j.error.message;
  } catch {
    /* not JSON */
  }
  return text.slice(0, 300) || res.statusText;
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export async function synthesizeWithKey(req: TtsRequest, apiKey: string): Promise<ArrayBuffer> {
  if (!apiKey) throw new TtsError('Missing TTS API key.', 400);
  const rate = req.speakingRate ?? 1;

  if (req.provider === 'elevenlabs') {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(req.voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: req.text,
          model_id: req.modelId || 'eleven_multilingual_v2',
          voice_settings: { stability: 0.45, similarity_boost: 0.8, speed: Math.min(1.2, Math.max(0.7, rate)) },
        }),
      },
    );
    if (!res.ok) throw new TtsError(`ElevenLabs: ${await readError(res)}`, res.status);
    return res.arrayBuffer();
  }

  const languageCode = req.voice.split('-').slice(0, 2).join('-') || 'en-US';
  const audioConfig: Record<string, unknown> = { audioEncoding: 'MP3' };
  if (rate !== 1) audioConfig.speakingRate = rate;
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { text: req.text }, voice: { languageCode, name: req.voice }, audioConfig }),
  });
  if (!res.ok) throw new TtsError(`Google TTS: ${await readError(res)}`, res.status);
  const json = (await res.json()) as { audioContent?: string };
  if (!json.audioContent) throw new TtsError('Google TTS returned no audio.', 502);
  return base64ToArrayBuffer(json.audioContent);
}

export async function listVoicesWithKey(provider: TtsProviderId, apiKey: string, languageCode = 'en-US'): Promise<TtsVoice[]> {
  if (!apiKey) throw new TtsError('Missing TTS API key.', 400);
  if (provider === 'elevenlabs') {
    const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': apiKey } });
    if (!res.ok) throw new TtsError(`ElevenLabs: ${await readError(res)}`, res.status);
    const json = (await res.json()) as {
      voices?: Array<{ voice_id: string; name: string; category?: string; labels?: Record<string, string> }>;
    };
    return (json.voices ?? []).map((v) => ({
      id: v.voice_id,
      name: v.name,
      detail: [v.category, v.labels?.accent, v.labels?.gender, v.labels?.age].filter(Boolean).join(' · '),
    }));
  }
  const res = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?languageCode=${encodeURIComponent(languageCode)}&key=${encodeURIComponent(apiKey)}`,
  );
  if (!res.ok) throw new TtsError(`Google TTS: ${await readError(res)}`, res.status);
  const json = (await res.json()) as { voices?: Array<{ name: string; ssmlGender?: string; languageCodes?: string[] }> };
  return (json.voices ?? [])
    .map((v) => ({ id: v.name, name: v.name, detail: [v.ssmlGender?.toLowerCase(), v.languageCodes?.join(', ')].filter(Boolean).join(' · ') }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/** Split text into provider-sized chunks on sentence (then word) boundaries. */
export function chunkText(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const fits = (s: string) => s.length <= maxChars && byteLength(s) <= 4800;
  if (fits(clean)) return [clean];

  const sentences = clean.match(/[^.!?…。！？]+[.!?…。！？]+["'”’)\]]*\s*|[^.!?…。！？]+$/g) ?? [clean];
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  for (const sentence of sentences) {
    if (fits(current + sentence)) {
      current += sentence;
      continue;
    }
    push();
    if (fits(sentence)) {
      current = sentence;
      continue;
    }
    // A single enormous sentence: fall back to word boundaries.
    for (const word of sentence.split(' ')) {
      if (!fits(current + ' ' + word)) push();
      current += (current ? ' ' : '') + word;
    }
  }
  push();
  return chunks;
}

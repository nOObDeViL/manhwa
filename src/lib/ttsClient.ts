/** Browser-side TTS: Gemini (in browser), or ElevenLabs/Google via the edge function or directly. */
import { GEMINI_VOICES, geminiSpeak } from './gemini';
import { useSession, useSettings } from './store';
import { TtsError, TtsRequest, TtsVoice, listVoicesWithKey, synthesizeWithKey } from './tts';
import { sleep } from './utils';

function currentKey(): string {
  const s = useSettings.getState();
  return (s.ttsProvider === 'elevenlabs' ? s.elevenApiKey : s.ttsProvider === 'google' ? s.googleTtsApiKey : s.geminiApiKey).trim();
}

/** The voice currently selected for the active provider. */
export function currentVoice(): string {
  const s = useSettings.getState();
  return s.ttsProvider === 'elevenlabs' ? s.elevenVoiceId : s.ttsProvider === 'google' ? s.googleTtsVoice : s.geminiTtsVoice;
}

function edgeHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const key = currentKey();
  if (key) headers['x-tts-key'] = key;
  const token = useSession.getState().token;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function edgeError(res: Response): Promise<TtsError> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  return new TtsError(j?.error || `TTS request failed (${res.status})`, res.status);
}

function buildRequest(text: string): TtsRequest {
  const s = useSettings.getState();
  return {
    provider: s.ttsProvider === 'google' ? 'google' : 'elevenlabs',
    text,
    voice: currentVoice(),
    modelId: s.ttsProvider === 'elevenlabs' ? s.elevenModelId : undefined,
    speakingRate: s.speakingRate,
    pitch: s.ttsProvider === 'google' ? s.googlePitch : undefined,
    stability: s.elevenStability,
    similarity: s.elevenSimilarity,
    style: s.elevenStyle,
    speakerBoost: s.elevenSpeakerBoost,
  };
}

async function synthesizeOnce(text: string, onStatus?: (m: string) => void): Promise<ArrayBuffer> {
  const s = useSettings.getState();
  if (s.ttsProvider === 'gemini') {
    return geminiSpeak({
      apiKey: s.geminiApiKey,
      text,
      voice: s.geminiTtsVoice,
      style: s.geminiTtsStyle,
      preferredModel: s.geminiTtsModel !== 'auto' ? s.geminiTtsModel : s.geminiTtsLastGood,
      onStatus,
      onModel: (m) => m !== s.geminiTtsLastGood && useSettings.getState().update({ geminiTtsLastGood: m }),
    });
  }
  const req = buildRequest(text);
  if (s.ttsTransport === 'direct') return synthesizeWithKey(req, currentKey());
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...edgeHeaders() },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await edgeError(res);
  return res.arrayBuffer();
}

/** Synthesize with the current Voice settings. Retries transient errors (Gemini handles its own quota/model fallback). */
export async function synthesize(text: string, onStatus?: (m: string) => void, attempts = 4): Promise<ArrayBuffer> {
  if (useSettings.getState().ttsProvider === 'gemini') return synthesizeOnce(text, onStatus);
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await synthesizeOnce(text, onStatus);
    } catch (err) {
      lastErr = err;
      const status = err instanceof TtsError ? err.status : 0;
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || i === attempts - 1) break;
      onStatus?.(`Retrying (${i + 1}/${attempts - 1})…`);
      await sleep(1500 * 2 ** i);
    }
  }
  throw lastErr;
}

export async function listVoices(languageCode = 'en-US'): Promise<TtsVoice[]> {
  const s = useSettings.getState();
  if (s.ttsProvider === 'gemini') return GEMINI_VOICES.map((v) => ({ id: v.id, name: v.id, detail: v.detail }));
  if (s.ttsTransport === 'direct') return listVoicesWithKey(s.ttsProvider, currentKey(), languageCode);
  const res = await fetch(`/api/tts/voices?provider=${s.ttsProvider}&languageCode=${encodeURIComponent(languageCode)}`, {
    headers: edgeHeaders(),
  });
  if (!res.ok) throw await edgeError(res);
  return res.json();
}

/** Friendly hint for common provider failures. */
export function ttsHint(message: string): string | null {
  if (/unusual activity|free tier/i.test(message))
    return 'ElevenLabs blocks free-tier requests from cloud servers. Switch “Transport” to Direct, or use the free Gemini voices.';
  if (/billing/i.test(message)) return 'Google Cloud TTS needs billing linked. The free Gemini voices need no billing — switch provider to Gemini.';
  if (/API key not valid|invalid.*key|unauthorized|rejected/i.test(message)) return 'Check the API key on the Settings page.';
  if (/quota|credits|limit/i.test(message)) return 'Free quota used up for now. Wait a while, or switch to another voice provider.';
  return null;
}

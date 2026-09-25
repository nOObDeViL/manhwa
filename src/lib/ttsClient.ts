/** Browser-side TTS: routes through the edge function or straight to the provider. */
import { useSession, useSettings } from './store';
import { TtsError, TtsRequest, TtsVoice, listVoicesWithKey, synthesizeWithKey } from './tts';
import { sleep } from './utils';

function currentKey(): string {
  const s = useSettings.getState();
  return (s.ttsProvider === 'elevenlabs' ? s.elevenApiKey : s.googleTtsApiKey).trim();
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

async function synthesizeOnce(req: TtsRequest): Promise<ArrayBuffer> {
  if (useSettings.getState().ttsTransport === 'direct') return synthesizeWithKey(req, currentKey());
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...edgeHeaders() },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw await edgeError(res);
  return res.arrayBuffer();
}

/** Synthesize with retry/backoff on rate limits and transient errors. */
export async function synthesize(req: TtsRequest, attempts = 4): Promise<ArrayBuffer> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await synthesizeOnce(req);
    } catch (err) {
      lastErr = err;
      const status = err instanceof TtsError ? err.status : 0;
      const retryable = status === 429 || status >= 500 || status === 0;
      if (!retryable || i === attempts - 1) break;
      await sleep(1500 * 2 ** i);
    }
  }
  throw lastErr;
}

export async function listVoices(languageCode = 'en-US'): Promise<TtsVoice[]> {
  const s = useSettings.getState();
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
    return 'ElevenLabs blocks free-tier requests from cloud servers. Switch “TTS transport” to Direct in Settings.';
  if (/billing/i.test(message)) return 'Google Cloud TTS needs a billing account linked (the free tier is still free).';
  if (/API key not valid|invalid.*key|unauthorized/i.test(message)) return 'Check the TTS API key on the Settings page.';
  if (/quota|credits|limit/i.test(message)) return 'You may have used up this month’s free quota for this provider.';
  return null;
}

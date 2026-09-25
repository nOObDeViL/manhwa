import { MAX_TEXT_LENGTH, TtsError, TtsRequest, synthesizeWithKey } from '@/lib/tts';
import { jsonError, resolveKey } from '@/lib/ttsServer';

export const runtime = 'edge';

/** POST { provider, text, voice, modelId?, speakingRate? } → audio/mpeg */
export async function POST(req: Request) {
  let body: TtsRequest;
  try {
    body = (await req.json()) as TtsRequest;
  } catch {
    return jsonError('Invalid JSON body.', 400);
  }
  if (body.provider !== 'elevenlabs' && body.provider !== 'google') return jsonError('Unknown provider.', 400);
  if (typeof body.text !== 'string' || !body.text.trim()) return jsonError('Text is required.', 400);
  if (body.text.length > MAX_TEXT_LENGTH) return jsonError(`Text must be under ${MAX_TEXT_LENGTH} characters per request.`, 400);
  if (typeof body.voice !== 'string' || !body.voice) return jsonError('Voice is required.', 400);

  const key = await resolveKey(req, body.provider);
  if ('error' in key) return jsonError(key.error, key.status);

  try {
    const audio = await synthesizeWithKey(
      { provider: body.provider, text: body.text, voice: body.voice, modelId: body.modelId, speakingRate: body.speakingRate },
      key.key,
    );
    return new Response(audio, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
  } catch (err) {
    const status = err instanceof TtsError ? err.status : 502;
    return jsonError(err instanceof Error ? err.message : 'TTS failed.', status);
  }
}

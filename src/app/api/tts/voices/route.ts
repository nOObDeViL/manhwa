import { TtsError, TtsProviderId, listVoicesWithKey } from '@/lib/tts';
import { jsonError, resolveKey } from '@/lib/ttsServer';

export const runtime = 'edge';

/** GET ?provider=elevenlabs|google&languageCode=en-US → [{ id, name, detail }] */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const provider = url.searchParams.get('provider') as TtsProviderId | null;
  if (provider !== 'elevenlabs' && provider !== 'google') return jsonError('Unknown provider.', 400);

  const key = await resolveKey(req, provider);
  if ('error' in key) return jsonError(key.error, key.status);

  try {
    const voices = await listVoicesWithKey(provider, key.key, url.searchParams.get('languageCode') || 'en-US');
    return Response.json(voices, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Failed to list voices.', err instanceof TtsError ? err.status : 502);
  }
}

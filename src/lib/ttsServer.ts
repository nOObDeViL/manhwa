/** Server-side (edge) helpers for the /api/tts routes. */
import type { TtsProviderId } from './tts';

type KeyResult = { key: string } | { error: string; status: number };

export function serverKeyFor(provider: TtsProviderId): string | undefined {
  return provider === 'elevenlabs' ? process.env.ELEVENLABS_API_KEY : process.env.GOOGLE_TTS_API_KEY;
}

/**
 * Use the caller's own key (x-tts-key header) if provided. Otherwise fall back to the
 * server's env key — but only for Google accounts listed in ALLOWED_EMAILS, verified by
 * asking Google Drive who owns the caller's OAuth access token.
 */
export async function resolveKey(req: Request, provider: TtsProviderId): Promise<KeyResult> {
  const userKey = req.headers.get('x-tts-key')?.trim();
  if (userKey) return { key: userKey };

  const envKey = serverKeyFor(provider);
  if (!envKey) return { error: 'No TTS API key. Add one on the Settings page or set it as a server environment variable.', status: 400 };

  const allowed = (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length)
    return { error: 'The server has a TTS key but ALLOWED_EMAILS is not set, so it refuses to use it.', status: 403 };

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return { error: 'Sign in with Google to use the server TTS key.', status: 401 };

  const who = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!who.ok) return { error: 'Could not verify your Google session. Reconnect and try again.', status: 401 };
  const email = ((await who.json()) as { user?: { emailAddress?: string } }).user?.emailAddress?.toLowerCase();
  if (!email || !allowed.includes(email)) return { error: `${email ?? 'This account'} is not in ALLOWED_EMAILS.`, status: 403 };

  return { key: envKey };
}

export function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

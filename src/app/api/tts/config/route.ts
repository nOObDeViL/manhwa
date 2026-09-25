import { serverKeyFor } from '@/lib/ttsServer';

export const runtime = 'edge';

/** Tells the Settings page which providers have a server-side key (never returns the keys). */
export async function GET() {
  return Response.json(
    {
      elevenlabs: Boolean(serverKeyFor('elevenlabs')),
      google: Boolean(serverKeyFor('google')),
      allowedEmailsConfigured: Boolean((process.env.ALLOWED_EMAILS || '').trim()),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

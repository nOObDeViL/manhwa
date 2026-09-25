'use client';

import { useEffect, useState } from 'react';
import { KeyRound, List, ShieldCheck } from 'lucide-react';
import { DRIVE_SCOPE, clientIdFromEnv, getRequiredAccount, initAuth } from '@/lib/auth';
import { listGeminiModels } from '@/lib/script';
import { DEFAULT_SETTINGS, ScriptEngine, TtsProvider, TtsTransport, useSettings } from '@/lib/store';
import { errorMessage } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Select } from '@/components/ui';

function Secret({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex gap-2">
      <Input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={placeholder} />
      <Button size="md" variant="ghost" onClick={() => setShow((s) => !s)}>
        {show ? 'Hide' : 'Show'}
      </Button>
    </div>
  );
}

export default function SettingsPage() {
  const s = useSettings();
  const [origin, setOrigin] = useState('');
  const [models, setModels] = useState<string[] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [server, setServer] = useState<{ elevenlabs: boolean; google: boolean; allowedEmailsConfigured: boolean } | null>(null);

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch('/api/tts/config')
      .then((r) => (r.ok ? r.json() : null))
      .then(setServer)
      .catch(() => setServer(null));
  }, []);

  const fetchModels = async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      setModels(await listGeminiModels(s.geminiApiKey));
    } catch (err) {
      setModelsError(errorMessage(err));
    } finally {
      setModelsLoading(false);
    }
  };

  const envAccount = Boolean(process.env.NEXT_PUBLIC_DRIVE_ACCOUNT);
  const serverKey = s.ttsProvider === 'gemini' ? false : server?.[s.ttsProvider];

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Keys are stored only in this browser (localStorage) and sent only to the service they belong to. Nothing is stored on a server."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Google Drive (OAuth 2.0)" subtitle="Create a Web OAuth client in Google Cloud Console — see README.">
          <div className="space-y-4">
            <Field
              label="OAuth Client ID"
              hint={clientIdFromEnv() ? 'Set by NEXT_PUBLIC_GOOGLE_CLIENT_ID on the server (overrides this field).' : 'Looks like 1234-abc.apps.googleusercontent.com'}
            >
              <Input
                value={clientIdFromEnv() ? process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID : s.googleClientId}
                disabled={clientIdFromEnv()}
                onChange={(e) => s.update({ googleClientId: e.target.value.trim() })}
                onBlur={() => initAuth().catch(() => undefined)}
                placeholder="xxxxxxxx.apps.googleusercontent.com"
              />
            </Field>
            <Field
              label="Drive storage account"
              hint={
                envAccount
                  ? 'Locked by NEXT_PUBLIC_DRIVE_ACCOUNT on the server.'
                  : 'Sign-in pre-selects this Google account and rejects any other. Leave empty to allow any account.'
              }
            >
              <Input
                type="email"
                value={envAccount ? getRequiredAccount() : s.driveAccountEmail}
                disabled={envAccount}
                onChange={(e) => s.update({ driveAccountEmail: e.target.value.trim() })}
                placeholder="you@gmail.com"
              />
            </Field>
            <div className="rounded-xl bg-zinc-950/60 p-3 text-xs text-zinc-400">
              <div className="mb-1 font-medium text-zinc-300">Add this exact origin under “Authorized JavaScript origins”:</div>
              <code className="break-all text-violet-300">{origin}</code>
              <div className="mt-2">
                Scope requested: <code className="text-zinc-300">{DRIVE_SCOPE}</code>
              </div>
            </div>
          </div>
        </Card>

        <Card title="Script engine" subtitle="Gemini runs straight from your browser with a free AI Studio key.">
          <div className="space-y-4">
            <Field label="Default engine">
              <Select value={s.scriptEngine} onChange={(e) => s.update({ scriptEngine: e.target.value as ScriptEngine })}>
                <option value="gemini">Google Gemini</option>
                <option value="openai">OpenAI-compatible (Groq, OpenRouter…)</option>
              </Select>
            </Field>
            <Field label="Gemini API key" hint="Free: aistudio.google.com → Get API key.">
              <Secret value={s.geminiApiKey} onChange={(v) => s.update({ geminiApiKey: v })} placeholder="AIza…" />
            </Field>
            <Field label="Gemini model" hint="Auto tries free-tier models your key can use and switches when one runs out of quota. Pro models usually have no free quota.">
              <div className="flex gap-2">
                {models?.length ? (
                  <Select value={s.geminiModel} onChange={(e) => s.update({ geminiModel: e.target.value })}>
                    <option value="auto">Auto (best available)</option>
                    {s.geminiModel !== 'auto' && !models.includes(s.geminiModel) && <option value={s.geminiModel}>{s.geminiModel}</option>}
                    {models.map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </Select>
                ) : (
                  <Input value={s.geminiModel} onChange={(e) => s.update({ geminiModel: e.target.value.trim() || 'auto' })} placeholder="auto" />
                )}
                <Button onClick={fetchModels} loading={modelsLoading} disabled={!s.geminiApiKey} icon={<List className="size-4" />}>
                  List models
                </Button>
              </div>
            </Field>
            {modelsError && <Notice kind="error">{modelsError}</Notice>}
            <details className="rounded-xl border border-zinc-800 p-3">
              <summary className="cursor-pointer text-sm text-zinc-300">OpenAI-compatible fallback engine</summary>
              <div className="mt-3 space-y-3">
                <Field label="Base URL" hint="Groq: https://api.groq.com/openai/v1 · OpenRouter: https://openrouter.ai/api/v1">
                  <Input value={s.openaiBaseUrl} onChange={(e) => s.update({ openaiBaseUrl: e.target.value.trim() })} />
                </Field>
                <Field label="API key">
                  <Secret value={s.openaiApiKey} onChange={(v) => s.update({ openaiApiKey: v })} />
                </Field>
                <Field label="Model">
                  <Input value={s.openaiModel} onChange={(e) => s.update({ openaiModel: e.target.value.trim() })} />
                </Field>
              </div>
            </details>
          </div>
        </Card>

        <Card title="Voice (TTS)" subtitle="ElevenLabs free tier or Google Cloud Text-to-Speech free tier.">
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider">
                <Select value={s.ttsProvider} onChange={(e) => s.update({ ttsProvider: e.target.value as TtsProvider })}>
                  <option value="gemini">Gemini (free, uses Gemini key)</option>
                  <option value="elevenlabs">ElevenLabs</option>
                  <option value="google">Google Cloud TTS</option>
                </Select>
              </Field>
              <Field label="Transport">
                <Select value={s.ttsTransport} onChange={(e) => s.update({ ttsTransport: e.target.value as TtsTransport })}>
                  <option value="edge">Edge function (/api/tts)</option>
                  <option value="direct">Direct from browser</option>
                </Select>
              </Field>
            </div>
            {server && (
              <div className="flex flex-wrap gap-1.5 text-xs">
                <Badge tone={server.elevenlabs ? 'good' : 'default'}>server ElevenLabs key: {server.elevenlabs ? 'yes' : 'no'}</Badge>
                <Badge tone={server.google ? 'good' : 'default'}>server Google key: {server.google ? 'yes' : 'no'}</Badge>
                {(server.elevenlabs || server.google) && (
                  <Badge tone={server.allowedEmailsConfigured ? 'good' : 'bad'}>
                    <ShieldCheck className="size-3" /> ALLOWED_EMAILS {server.allowedEmailsConfigured ? 'set' : 'missing'}
                  </Badge>
                )}
              </div>
            )}
            {s.ttsProvider === 'gemini' ? (
              <Notice kind="success">Gemini voices use the Gemini API key above — nothing else to set up. Pick a voice and delivery style on the Voice page.</Notice>
            ) : s.ttsProvider === 'elevenlabs' ? (
              <>
                <Field label="ElevenLabs API key" hint={serverKey && s.ttsTransport === 'edge' ? 'Optional — the server key will be used if empty.' : 'elevenlabs.io → Profile → API keys.'}>
                  <Secret value={s.elevenApiKey} onChange={(v) => s.update({ elevenApiKey: v })} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Voice ID" hint="Pick one on the Voice page.">
                    <Input value={s.elevenVoiceId} onChange={(e) => s.update({ elevenVoiceId: e.target.value.trim() })} />
                  </Field>
                  <Field label="Model">
                    <Select value={s.elevenModelId} onChange={(e) => s.update({ elevenModelId: e.target.value })}>
                      <option value="eleven_multilingual_v2">Multilingual v2 (best)</option>
                      <option value="eleven_flash_v2_5">Flash v2.5 (cheaper, fast)</option>
                      <option value="eleven_turbo_v2_5">Turbo v2.5</option>
                    </Select>
                  </Field>
                </div>
                <Notice kind="info">
                  ElevenLabs often blocks free-tier calls coming from cloud servers. If you see “unusual activity”, switch Transport to <b>Direct</b>.
                </Notice>
              </>
            ) : (
              <>
                <Field label="Google Cloud API key" hint={serverKey && s.ttsTransport === 'edge' ? 'Optional — the server key will be used if empty.' : 'Restrict it to the Cloud Text-to-Speech API.'}>
                  <Secret value={s.googleTtsApiKey} onChange={(v) => s.update({ googleTtsApiKey: v })} />
                </Field>
                <Field label="Voice name" hint="e.g. en-US-Neural2-D, en-US-Studio-Q, en-US-Chirp3-HD-Charon">
                  <Input value={s.googleTtsVoice} onChange={(e) => s.update({ googleTtsVoice: e.target.value.trim() })} />
                </Field>
              </>
            )}
          </div>
        </Card>

        <Card title="This browser">
          <div className="space-y-3 text-sm text-zinc-400">
            <p>
              <KeyRound className="mr-1 inline size-4 text-violet-300" />
              API keys never leave this device except in requests to their own provider (or your own /api/tts edge function when Transport is “Edge”).
            </p>
            <Button
              variant="danger"
              onClick={() => {
                if (confirm('Clear all keys and settings stored in this browser?')) s.update({ ...DEFAULT_SETTINGS });
              }}
            >
              Clear local settings
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

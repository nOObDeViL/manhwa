'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CloudUpload, FolderOpen, Mic, Play, RefreshCw, Square, Wand2 } from 'lucide-react';
import { DEFAULT_STITCH, NarrationTimeline, StitchResult, decodeToMono, encodeWav, stitch } from '@/lib/audio';
import { DriveFile, downloadJson, isJson, uploadFile, saveJson } from '@/lib/drive';
import { encodeMp3 } from '@/lib/ffmpeg';
import { Project, patchProject } from '@/lib/projects';
import { RecapScript } from '@/lib/script';
import { useSession, useSettings } from '@/lib/store';
import { CHUNK_LIMITS, TtsVoice, chunkText } from '@/lib/tts';
import { currentVoice, listVoices, synthesize, ttsHint } from '@/lib/ttsClient';
import { GEMINI_STYLE_PRESETS, GEMINI_VOICES } from '@/lib/gemini';
import type { TtsProvider } from '@/lib/store';
import { cn, errorMessage, fileSlug, formatDuration, pool, stamp } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Progress, Select, Slider, Textarea, Toggle } from '@/components/ui';
import RequireProject from '@/components/RequireProject';
import DrivePicker from '@/components/DrivePicker';

export default function VoicePage() {
  return (
    <div>
      <PageHeader
        title="Cloud voice generator"
        description="Each beat is split into provider-sized chunks, sent to ElevenLabs or Google TTS, then stitched into one narration track with the Web Audio API."
      />
      <RequireProject>{(project) => <VoiceStudio key={project.id} project={project} />}</RequireProject>
    </div>
  );
}

type Status = 'idle' | 'working' | 'done' | 'error';
interface BeatAudio {
  status: Status;
  error?: string;
  note?: string;
  chunks: Float32Array[] | null;
}

function VoiceStudio({ project }: { project: Project }) {
  const settings = useSettings();
  const script = useSession((s) => s.script);
  const setSession = useSession((s) => s.set);
  const toast = useSession((s) => s.toast);

  const [audio, setAudio] = useState<BeatAudio[]>([]);
  const [running, setRunning] = useState(false);
  const [voices, setVoices] = useState<TtsVoice[] | null>(null);
  const [voicesLoading, setVoicesLoading] = useState(false);
  const [gap, setGap] = useState(DEFAULT_STITCH.gapSec);
  const [normalize, setNormalize] = useState(true);
  const [master, setMaster] = useState<{ result: StitchResult; wav: Blob; url: string } | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const player = useRef<HTMLAudioElement | null>(null);
  const cancelled = useRef(false);

  const provider = settings.ttsProvider;
  const voice = currentVoice();
  const [previewing, setPreviewing] = useState(false);
  const limit = CHUNK_LIMITS[provider];

  const beats = useMemo(
    () => (script?.beats ?? []).map((b) => ({ n: b.n, text: b.narration.trim(), chunks: chunkText(b.narration, limit) })).filter((b) => b.text),
    [script, limit],
  );
  const chars = beats.reduce((s, b) => s + b.text.length, 0);

  // Reset audio whenever the script, provider or voice changes.
  useEffect(() => {
    setAudio(beats.map(() => ({ status: 'idle', chunks: null })));
    setMaster((m) => {
      if (m) URL.revokeObjectURL(m.url);
      return null;
    });
    setSavedName(null);
  }, [beats, provider, voice, settings.speakingRate, settings.geminiTtsStyle, settings.googlePitch, settings.elevenStability, settings.elevenSimilarity, settings.elevenStyle]);

  // Voice list for the active provider (Gemini's is built in).
  useEffect(() => {
    setVoices(provider === 'gemini' ? GEMINI_VOICES.map((v) => ({ id: v.id, name: v.id, detail: v.detail })) : null);
  }, [provider]);

  // Load the active script if the Script page hasn't already.
  useEffect(() => {
    if (!script && project.meta.activeScriptFileId) {
      downloadJson<RecapScript>(project.meta.activeScriptFileId)
        .then((s) => s?.beats && setSession({ script: s, scriptFileId: project.meta.activeScriptFileId ?? null }))
        .catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(() => () => player.current?.pause(), []);

  const patchBeat = (i: number, p: Partial<BeatAudio>) => setAudio((a) => a.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const synthBeat = async (i: number) => {
    patchBeat(i, { status: 'working', error: undefined });
    try {
      const chunks: Float32Array[] = [];
      for (const text of beats[i].chunks) {
        if (cancelled.current) throw new Error('Stopped');
        const mp3 = await synthesize(text, (note) => patchBeat(i, { note }));
        chunks.push(await decodeToMono(mp3));
      }
      patchBeat(i, { status: 'done', chunks, note: undefined });
    } catch (err) {
      const msg = errorMessage(err);
      const hint = ttsHint(msg);
      patchBeat(i, { status: 'error', note: undefined, error: hint ? `${msg}\n${hint}` : msg });
    }
  };

  const generateAll = async () => {
    if (!voice) {
      toast('Choose a voice first.', 'error');
      return;
    }
    cancelled.current = false;
    setRunning(true);
    const todo = beats.map((_, i) => i).filter((i) => audio[i]?.status !== 'done');
    // Gemini's free tier is rate-limited per minute, so voice one beat at a time there.
    await pool(todo, provider === 'gemini' ? 1 : 2, async (i) => {
      if (!cancelled.current) await synthBeat(i);
    });
    setRunning(false);
  };

  const doneCount = audio.filter((a) => a.status === 'done').length;
  const errorCount = audio.filter((a) => a.status === 'error').length;
  const allDone = beats.length > 0 && doneCount === beats.length;

  const playSamples = (i: number, samples: Float32Array[][]) => {
    player.current?.pause();
    if (playing === i) {
      setPlaying(null);
      return;
    }
    const r = stitch(samples, { ...DEFAULT_STITCH, leadSec: 0, tailSec: 0, normalize: false });
    const url = URL.createObjectURL(encodeWav(r.samples));
    const el = new Audio(url);
    player.current = el;
    el.onended = () => {
      setPlaying(null);
      URL.revokeObjectURL(url);
    };
    el.play().catch(() => undefined);
    setPlaying(i);
  };

  const buildMaster = () => {
    const result = stitch(
      audio.map((a) => a.chunks ?? []),
      { ...DEFAULT_STITCH, gapSec: gap, normalize },
    );
    const wav = encodeWav(result.samples, result.sampleRate);
    setMaster((m) => {
      if (m) URL.revokeObjectURL(m.url);
      return { result, wav, url: URL.createObjectURL(wav) };
    });
    setSavedName(null);
  };

  const save = async (format: 'mp3' | 'wav') => {
    if (!master || !script) return;
    try {
      let blob = master.wav;
      if (format === 'mp3') {
        setSaving('Encoding MP3 with FFmpeg.wasm (first run downloads ~31 MB)…');
        blob = await encodeMp3(master.wav);
      }
      const base = `narration_${fileSlug(script.chapter || script.title)}_${stamp()}`;
      setSaving('Uploading narration to Drive…');
      const audioFile = await uploadFile(blob, { name: `${base}.${format}`, parentId: project.folders.audio, mimeType: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' });
      const timeline: NarrationTimeline = {
        app: 'manhwa-recap-studio',
        version: 1,
        audioFileName: audioFile.name,
        scriptTitle: script.title,
        duration: master.result.duration,
        sampleRate: master.result.sampleRate,
        createdAt: new Date().toISOString(),
        beats: master.result.beats.map((b, i) => ({ n: beats[i].n, start: b.start, end: b.end, text: beats[i].text })),
      };
      const tlFile = await saveJson(project.folders.audio, `${base}.timeline.json`, timeline);
      await patchProject({ narrationFileId: audioFile.id, timelineFileId: tlFile.id });
      setSavedName(audioFile.name);
      toast(`Saved ${audioFile.name} + timeline to Drive › Audio`, 'success');
    } catch (err) {
      toast(`${errorMessage(err)}${format === 'mp3' ? ' — you can save as WAV instead.' : ''}`, 'error');
    } finally {
      setSaving(null);
    }
  };

  const fetchVoices = async () => {
    setVoicesLoading(true);
    try {
      const lang = provider === 'google' ? settings.googleTtsVoice.split('-').slice(0, 2).join('-') || 'en-US' : 'en-US';
      setVoices(await listVoices(lang));
    } catch (err) {
      const msg = errorMessage(err);
      toast(ttsHint(msg) ?? msg, 'error');
    } finally {
      setVoicesLoading(false);
    }
  };

  const setVoice = (id: string) =>
    settings.update(provider === 'elevenlabs' ? { elevenVoiceId: id } : provider === 'google' ? { googleTtsVoice: id } : { geminiTtsVoice: id });

  const previewVoice = async () => {
    setPreviewing(true);
    try {
      const sample = beats[0]?.text.split(/(?<=[.!?])\s/).slice(0, 2).join(' ') || 'This is how your recap narration will sound.';
      const data = await synthesize(sample.slice(0, 300));
      const url = URL.createObjectURL(encodeWav(await decodeToMono(data)));
      player.current?.pause();
      const el = new Audio(url);
      player.current = el;
      el.onended = () => URL.revokeObjectURL(url);
      await el.play().catch(() => undefined);
    } catch (err) {
      const msg = errorMessage(err);
      toast(ttsHint(msg) ?? msg, 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const loadScript = async (files: DriveFile[]) => {
    try {
      const s = await downloadJson<RecapScript>(files[0].id);
      if (!Array.isArray(s?.beats)) throw new Error('Not a recap script.');
      setSession({ script: s, scriptFileId: files[0].id });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  if (!script) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <Mic className="size-10 text-zinc-600" />
          <p className="text-sm text-zinc-400">No script loaded.</p>
          <div className="flex gap-2">
            <Link href="/script">
              <Button variant="primary">Write a script</Button>
            </Link>
            <Button icon={<FolderOpen className="size-4" />} onClick={() => setPickerOpen(true)}>
              Open from Drive
            </Button>
          </div>
        </div>
        <DrivePicker open={pickerOpen} onClose={() => setPickerOpen(false)} start={[{ id: project.folders.scripts, name: 'Scripts' }]} accept={isJson} onPick={loadScript} title="Open a script" />
      </Card>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <Card title="Voice" subtitle={provider === 'gemini' ? 'Gemini voices · free with your Google API key' : `${provider === 'elevenlabs' ? 'ElevenLabs' : 'Google Cloud TTS'} · ${settings.ttsTransport === 'edge' ? 'via edge function' : 'direct from browser'}`}>
          <div className="space-y-4">
            <Field label="Voice provider">
              <Select value={provider} onChange={(e) => settings.update({ ttsProvider: e.target.value as TtsProvider })}>
                <option value="gemini">Gemini — free human-like voices (uses your Google key)</option>
                <option value="elevenlabs">ElevenLabs — premium, 10k chars/month free</option>
                <option value="google">Google Cloud TTS — needs billing linked</option>
              </Select>
            </Field>
            <Field label="Voice" hint={provider === 'gemini' ? '30 natural voices. Charon, Fenrir and Algenib suit dramatic recaps.' : <>Keys and transport are on the <Link href="/settings" className="underline">Settings</Link> page.</>}>
              {voices ? (
                <Select value={voice} onChange={(e) => setVoice(e.target.value)}>
                  {!voices.some((v) => v.id === voice) && <option value={voice}>{voice}</option>}
                  {voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {v.detail ? ` — ${v.detail}` : ''}
                    </option>
                  ))}
                </Select>
              ) : (
                <div className="flex gap-2">
                  <div className="flex h-10 min-w-0 flex-1 items-center truncate rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 font-mono text-xs text-zinc-300">{voice || '—'}</div>
                  <Button onClick={fetchVoices} loading={voicesLoading}>
                    Browse
                  </Button>
                </div>
              )}
            </Field>
            <Button className="w-full" onClick={previewVoice} loading={previewing} icon={<Play className="size-4" />}>
              Preview this voice
            </Button>

            {provider === 'gemini' && (
              <>
                <Field label="Delivery style" hint="Tells the voice how to perform. Pick a preset or write your own.">
                  <Select
                    value={GEMINI_STYLE_PRESETS.some((p) => p.value === settings.geminiTtsStyle) ? settings.geminiTtsStyle : '__custom'}
                    onChange={(e) => e.target.value !== '__custom' && settings.update({ geminiTtsStyle: e.target.value })}
                  >
                    {GEMINI_STYLE_PRESETS.map((p) => (
                      <option key={p.label} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                    <option value="__custom">Custom…</option>
                  </Select>
                </Field>
                <Textarea rows={2} value={settings.geminiTtsStyle} onChange={(e) => settings.update({ geminiTtsStyle: e.target.value })} placeholder="e.g. Speak slowly with a deep, mysterious tone" />
                <Field label="TTS model" hint="Auto picks whichever Gemini TTS model still has free quota.">
                  <Input value={settings.geminiTtsModel} onChange={(e) => settings.update({ geminiTtsModel: e.target.value.trim() || 'auto' })} />
                </Field>
                {!settings.geminiApiKey && <Notice kind="warn">Add your Gemini API key in <Link href="/settings" className="underline">Settings</Link>.</Notice>}
              </>
            )}

            {provider === 'elevenlabs' && (
              <>
                <Field label="Model">
                  <Select value={settings.elevenModelId} onChange={(e) => settings.update({ elevenModelId: e.target.value })}>
                    <option value="eleven_multilingual_v2">Multilingual v2 (most natural)</option>
                    <option value="eleven_flash_v2_5">Flash v2.5 (half the credits)</option>
                    <option value="eleven_turbo_v2_5">Turbo v2.5</option>
                  </Select>
                </Field>
                <Slider label="Stability" value={settings.elevenStability} min={0} max={1} step={0.05} onChange={(v) => settings.update({ elevenStability: v })} format={(v) => v.toFixed(2)} hint="Lower = more emotional and varied, higher = steadier." />
                <Slider label="Similarity" value={settings.elevenSimilarity} min={0} max={1} step={0.05} onChange={(v) => settings.update({ elevenSimilarity: v })} format={(v) => v.toFixed(2)} />
                <Slider label="Style exaggeration" value={settings.elevenStyle} min={0} max={1} step={0.05} onChange={(v) => settings.update({ elevenStyle: v })} format={(v) => v.toFixed(2)} />
                <Toggle checked={settings.elevenSpeakerBoost} onChange={(v) => settings.update({ elevenSpeakerBoost: v })} label="Speaker boost" />
              </>
            )}

            {provider !== 'gemini' && (
              <Slider
                label="Speaking rate"
                value={settings.speakingRate}
                min={provider === 'elevenlabs' ? 0.7 : 0.5}
                max={provider === 'elevenlabs' ? 1.2 : 2}
                step={0.05}
                onChange={(v) => settings.update({ speakingRate: v })}
                format={(v) => `${v.toFixed(2)}×`}
              />
            )}
            {provider === 'google' && (
              <Slider label="Pitch" value={settings.googlePitch} min={-10} max={10} step={0.5} onChange={(v) => settings.update({ googlePitch: v })} format={(v) => `${v > 0 ? '+' : ''}${v} st`} hint="Not supported by Chirp 3 HD voices." />
            )}
            <Slider label="Pause between beats" value={gap} min={0} max={1.5} step={0.05} onChange={setGap} format={(v) => `${v.toFixed(2)}s`} />
            <Toggle checked={normalize} onChange={setNormalize} label="Normalize loudness (peak −1 dB)" />
            <div className="rounded-xl bg-zinc-950/60 p-3 text-xs text-zinc-400">
              {beats.length} beats · {beats.reduce((s, b) => s + b.chunks.length, 0)} requests · {chars.toLocaleString()} characters
              {provider === 'elevenlabs' && <div className="mt-1 text-zinc-500">≈ {chars.toLocaleString()} ElevenLabs credits (free plan: 10,000/month).</div>}
            </div>
            <div className="flex gap-2">
              {running ? (
                <Button className="flex-1" variant="danger" icon={<Square className="size-4" />} onClick={() => (cancelled.current = true)}>
                  Stop
                </Button>
              ) : (
                <Button className="flex-1" variant="primary" icon={<Wand2 className="size-4" />} onClick={generateAll} disabled={allDone}>
                  {doneCount > 0 && !allDone ? `Continue (${beats.length - doneCount} left)` : allDone ? 'All beats voiced' : 'Generate narration'}
                </Button>
              )}
            </div>
            <Progress value={beats.length ? doneCount / beats.length : 0} label={`${doneCount}/${beats.length} beats${errorCount ? ` · ${errorCount} failed` : ''}`} />
          </div>
        </Card>

        <Card title="Master track">
          {!allDone ? (
            <p className="text-sm text-zinc-500">Voice every beat, then stitch them into one track.</p>
          ) : (
            <div className="space-y-3">
              <Button className="w-full" onClick={buildMaster} icon={<RefreshCw className="size-4" />}>
                {master ? 'Re-stitch' : 'Stitch narration'}
              </Button>
              {master && (
                <>
                  <audio controls src={master.url} className="w-full" />
                  <div className="text-xs text-zinc-400">Length {formatDuration(master.result.duration)} · mono 44.1 kHz</div>
                  {saving ? (
                    <div className="text-xs text-violet-200">{saving}</div>
                  ) : (
                    <div className="flex gap-2">
                      <Button variant="primary" className="flex-1" icon={<CloudUpload className="size-4" />} onClick={() => save('mp3')}>
                        Save MP3 to Drive
                      </Button>
                      <Button onClick={() => save('wav')}>WAV</Button>
                    </div>
                  )}
                  {savedName && (
                    <Notice kind="success">
                      {savedName} saved. Continue to the{' '}
                      <Link href="/compose" className="underline">
                        Composer
                      </Link>
                      .
                    </Notice>
                  )}
                </>
              )}
            </div>
          )}
        </Card>
      </div>

      <Card
        title={script.title}
        subtitle="Beats & audio status"
        actions={
          <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => setPickerOpen(true)}>
            Other script
          </Button>
        }
      >
        <ol className="space-y-2">
          {beats.map((b, i) => {
            const a = audio[i];
            return (
              <li key={i} className={cn('rounded-xl border p-3', a?.status === 'error' ? 'border-red-500/40 bg-red-500/5' : 'border-zinc-800 bg-zinc-950/40')}>
                <div className="flex items-start gap-3">
                  <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-600/20 font-mono text-xs text-violet-200">{b.n}</span>
                  <p className="min-w-0 flex-1 text-sm leading-relaxed text-zinc-300">{b.text}</p>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge tone={a?.status === 'done' ? 'good' : a?.status === 'error' ? 'bad' : a?.status === 'working' ? 'accent' : 'default'}>
                      {a?.status === 'working' ? 'voicing…' : a?.status ?? 'idle'}
                    </Badge>
                    {b.chunks.length > 1 && <span className="text-[10px] text-zinc-500">{b.chunks.length} chunks</span>}
                    <div className="flex gap-1">
                      {a?.status === 'done' && a.chunks && (
                        <button className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={() => playSamples(i, [a.chunks!])} aria-label="Play beat">
                          {playing === i ? <Square className="size-3.5" /> : <Play className="size-3.5" />}
                        </button>
                      )}
                      {(a?.status === 'error' || a?.status === 'done') && !running && (
                        <button className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={() => synthBeat(i)} aria-label="Regenerate beat">
                          <RefreshCw className="size-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
                {a?.note && a.status === 'working' && <p className="mt-2 text-xs text-violet-300">{a.note}</p>}
                {a?.error && <p className="mt-2 whitespace-pre-line text-xs text-red-300">{a.error}</p>}
              </li>
            );
          })}
        </ol>
      </Card>
      <DrivePicker open={pickerOpen} onClose={() => setPickerOpen(false)} start={[{ id: project.folders.scripts, name: 'Scripts' }]} accept={isJson} onPick={loadScript} title="Open a script" />
    </div>
  );
}

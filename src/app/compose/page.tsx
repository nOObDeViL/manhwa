'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard, CloudUpload, Download, ExternalLink, FolderOpen, Pause, Play, Square } from 'lucide-react';
import { NarrationTimeline, audioDuration } from '@/lib/audio';
import { refreshIfExpiringSoon } from '@/lib/auth';
import { DriveFile, downloadBlob, downloadJson, findChild, getFile, isAudio, uploadFile } from '@/lib/drive';
import { ComposeSettings, EFFECTS, EffectChoice, FrameRenderer, RESOLUTIONS, Segment, buildSegments, resolveEffect } from '@/lib/kenburns';
import { listOrderedPanels } from '@/lib/panels';
import { getPanelUrl } from '@/lib/panelCache';
import { Project, patchProject } from '@/lib/projects';
import { QUALITY_PRESETS, QualityKey, renderVideo } from '@/lib/render';
import { useSession } from '@/lib/store';
import { baseName, cn, downloadLocally, errorMessage, fileSlug, formatBytes, formatDuration, requestWakeLock, stamp } from '@/lib/utils';
import { Badge, Button, Card, Field, LogView, Notice, PageHeader, Progress, Select, Slider, Spinner } from '@/components/ui';
import RequireProject from '@/components/RequireProject';
import DrivePicker from '@/components/DrivePicker';

export default function ComposePage() {
  return (
    <div>
      <PageHeader
        title="Ken Burns video composer"
        description="Panels are timed to the narration, animated with zoom/pan on a canvas, and encoded to MP4 by FFmpeg.wasm right here in the browser."
      />
      <RequireProject>{(project) => <Composer key={project.id} project={project} />}</RequireProject>
    </div>
  );
}

interface Narration {
  file: DriveFile;
  blob: Blob;
  url: string;
  duration: number;
}

const TAIL_SEC = 0.6;

function Composer({ project }: { project: Project }) {
  const toast = useSession((s) => s.toast);
  const [panels, setPanels] = useState<DriveFile[] | null>(null);
  const [narration, setNarration] = useState<Narration | null>(null);
  const [timeline, setTimeline] = useState<NarrationTimeline | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [effects, setEffects] = useState<Record<string, EffectChoice>>((project.meta.panelEffects ?? {}) as Record<string, EffectChoice>);
  const [resolution, setResolution] = useState<(typeof RESOLUTIONS)[number]['id']>('1080p');
  const [fps, setFps] = useState(30);
  const [framing, setFraming] = useState<ComposeSettings['framing']>('fit');
  const [zoom, setZoom] = useState(0.15);
  const [transition, setTransition] = useState(0.4);
  const [background, setBackground] = useState<ComposeSettings['background']>('blur');
  const [quality, setQuality] = useState<QualityKey>('fast');
  const [sync, setSync] = useState<'beats' | 'even'>('beats');
  const [pickerOpen, setPickerOpen] = useState(false);

  const [render, setRender] = useState<{ stage: string; fraction: number; fps?: number; etaSec?: number } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [result, setResult] = useState<{ blob: Blob; url: string; name: string; driveFile?: DriveFile; uploadProgress?: number; uploadError?: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Panels in saved order.
  useEffect(() => {
    let alive = true;
    listOrderedPanels(project)
      .then((p) => alive && setPanels(p))
      .catch((err) => {
        toast(errorMessage(err), 'error');
        if (alive) setPanels([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const loadNarration = useCallback(
    async (file: DriveFile, timelineId?: string) => {
      setLoadingAudio(true);
      try {
        const blob = await downloadBlob(file.id);
        const duration = await audioDuration(blob);
        setNarration((old) => {
          if (old) URL.revokeObjectURL(old.url);
          return { file, blob, url: URL.createObjectURL(blob), duration };
        });
        // Timeline: explicit id, else "<audio name>.timeline.json" next to the audio.
        let tl: NarrationTimeline | null = null;
        const tlFile = timelineId ? { id: timelineId } : await findChild(project.folders.audio, `${baseName(file.name)}.timeline.json`);
        if (tlFile) tl = await downloadJson<NarrationTimeline>(tlFile.id).catch(() => null);
        setTimeline(tl?.beats?.length ? tl : null);
        if (!tl) setSync('even');
      } catch (err) {
        toast(errorMessage(err), 'error');
      } finally {
        setLoadingAudio(false);
      }
    },
    [project.folders.audio, toast],
  );

  // Auto-load the project's latest narration.
  useEffect(() => {
    if (!project.meta.narrationFileId) return;
    getFile(project.meta.narrationFileId)
      .then((f) => loadNarration(f, project.meta.timelineFileId))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const res = RESOLUTIONS.find((r) => r.id === resolution)!;
  const settings: ComposeSettings = useMemo(
    () => ({ width: res.width, height: res.height, fps, framing, zoom, transition, background }),
    [res.width, res.height, fps, framing, zoom, transition, background],
  );
  const duration = narration ? narration.duration + TAIL_SEC : 0;

  const segments: Segment[] = useMemo(() => {
    if (!panels?.length || !duration) return [];
    const beatStarts = timeline ? timeline.beats.map((b) => b.start) : null;
    return buildSegments(
      panels.map((p) => ({ id: p.id, name: p.name, width: p.imageMediaMetadata?.width, height: p.imageMediaMetadata?.height, effect: effects[p.id] ?? 'auto' })),
      duration,
      beatStarts,
      sync,
    );
  }, [panels, duration, timeline, sync, effects]);

  const avg = segments.length ? duration / segments.length : 0;

  const setEffect = (id: string, effect: EffectChoice) => {
    const next = { ...effects, [id]: effect };
    if (effect === 'auto') delete next[id];
    setEffects(next);
    patchProject({ panelEffects: next }).catch(() => undefined);
  };

  const startRender = async () => {
    if (!narration || !segments.length) return;
    // Refresh the Google token now (inside the click) so the upload at the end doesn't hit an expired session.
    refreshIfExpiringSoon().catch(() => undefined);
    const controller = new AbortController();
    abortRef.current = controller;
    setLogs([]);
    setResult((r) => {
      if (r) URL.revokeObjectURL(r.url);
      return null;
    });
    const wake = await requestWakeLock();
    try {
      const blob = await renderVideo({
        segments,
        settings,
        audio: narration.blob,
        audioExt: /\.wav$/i.test(narration.file.name) ? 'wav' : 'mp3',
        duration,
        quality,
        signal: controller.signal,
        onProgress: setRender,
        onLog: (line) => setLogs((l) => [...l.slice(-199), line]),
      });
      const name = `${fileSlug(project.name)}_recap_${res.width}x${res.height}_${stamp()}.mp4`;
      const url = URL.createObjectURL(blob);
      setResult({ blob, url, name });
      setRender(null);
      await uploadResult(blob, name);
    } catch (err) {
      setRender(null);
      if ((err as Error)?.name === 'AbortError') toast('Render cancelled.');
      else toast(errorMessage(err), 'error');
    } finally {
      wake?.release().catch(() => undefined);
      abortRef.current = null;
    }
  };

  const uploadResult = async (blob: Blob, name: string) => {
    setResult((r) => r && { ...r, uploadProgress: 0, uploadError: undefined });
    try {
      const file = await uploadFile(blob, {
        name,
        parentId: project.folders.exports,
        mimeType: 'video/mp4',
        onProgress: (p) => setResult((r) => r && { ...r, uploadProgress: p }),
      });
      setResult((r) => r && { ...r, driveFile: file, uploadProgress: 1 });
      await patchProject({ lastExportFileId: file.id });
      toast(`Saved ${name} to Drive › Final Exports`, 'success');
    } catch (err) {
      setResult((r) => r && { ...r, uploadError: errorMessage(err), uploadProgress: undefined });
    }
  };

  const ready = Boolean(narration && segments.length);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <Card title="Preview" subtitle={ready ? `${segments.length} panels · ${formatDuration(duration)} · avg ${avg.toFixed(1)}s per panel` : 'Needs panels and a narration track.'}>
          {ready ? (
            <PreviewPlayer segments={segments} settings={settings} audioUrl={narration!.url} duration={duration} />
          ) : (
            <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-zinc-800 text-sm text-zinc-500">
              {panels === null || loadingAudio ? <Spinner /> : !panels.length ? <Link href="/slicer" className="underline">Slice some panels first</Link> : 'Load a narration track →'}
            </div>
          )}
          {ready && avg < 1.5 && <Notice kind="warn" className="mt-3">Panels flash by in under 1.5 s each. Consider removing some panels or writing a longer script.</Notice>}
        </Card>

        <div className="space-y-4">
          <Card title="Narration">
            {narration ? (
              <div className="space-y-2 text-sm">
                <div className="truncate font-medium text-zinc-100">{narration.file.name}</div>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <Badge>{formatDuration(narration.duration)}</Badge>
                  {timeline ? <Badge tone="good">{timeline.beats.length} beat timings</Badge> : <Badge tone="warn">no timeline</Badge>}
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-500">{loadingAudio ? 'Loading…' : 'No narration yet — make one on the Voice page or pick an audio file.'}</p>
            )}
            <Button size="sm" className="mt-3" icon={<FolderOpen className="size-3.5" />} onClick={() => setPickerOpen(true)}>
              Choose audio from Drive
            </Button>
          </Card>

          <Card title="Video settings">
            <div className="space-y-4">
              <Field label="Resolution">
                <Select value={resolution} onChange={(e) => setResolution(e.target.value as typeof resolution)}>
                  {RESOLUTIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Frame rate">
                  <Select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                    <option value={24}>24 fps</option>
                    <option value={30}>30 fps</option>
                  </Select>
                </Field>
                <Field label="Framing">
                  <Select value={framing} onChange={(e) => setFraming(e.target.value as ComposeSettings['framing'])}>
                    <option value="fit">Fit + blur backdrop</option>
                    <option value="fill">Fill (crop)</option>
                  </Select>
                </Field>
                <Field label="Panel timing">
                  <Select value={sync} onChange={(e) => setSync(e.target.value as 'beats' | 'even')}>
                    <option value="beats" disabled={!timeline}>
                      Sync to beats
                    </option>
                    <option value="even">Even split</option>
                  </Select>
                </Field>
                <Field label="Backdrop">
                  <Select value={background} onChange={(e) => setBackground(e.target.value as ComposeSettings['background'])}>
                    <option value="blur">Blurred panel</option>
                    <option value="black">Black</option>
                  </Select>
                </Field>
              </div>
              <Slider label="Zoom strength" value={zoom} min={0} max={0.4} step={0.01} onChange={setZoom} format={(v) => `${Math.round(v * 100)}%`} />
              <Slider label="Crossfade" value={transition} min={0} max={1.2} step={0.05} onChange={setTransition} format={(v) => `${v.toFixed(2)}s`} />
              <Field label="Encoder speed" hint="FFmpeg.wasm is single-threaded. Use 720p + Fast for quick drafts.">
                <Select value={quality} onChange={(e) => setQuality(e.target.value as QualityKey)}>
                  {Object.entries(QUALITY_PRESETS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Card>
        </div>
      </div>

      <Card
        title="Render MP4"
        subtitle="Keep this tab in the foreground while rendering — mobile browsers pause background tabs."
        actions={
          render ? (
            <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} onClick={() => abortRef.current?.abort()}>
              Cancel
            </Button>
          ) : (
            <Button variant="primary" disabled={!ready} onClick={startRender} icon={<Clapperboard className="size-4" />}>
              Render {res.height >= 1080 && res.width >= 1080 ? (res.width > res.height ? '1080p' : '1080×1920') : `${res.width}×${res.height}`}
            </Button>
          )
        }
      >
        {render && (
          <div className="space-y-2">
            <Progress value={render.fraction} label={render.stage} />
            <div className="flex gap-4 text-xs text-zinc-500">
              {render.fps ? <span>{render.fps.toFixed(1)} frames/s</span> : null}
              {render.etaSec ? <span>≈ {formatDuration(render.etaSec)} left</span> : null}
            </div>
          </div>
        )}
        {result && (
          <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
            <video src={result.url} controls className="w-full rounded-xl bg-black" />
            <div className="space-y-3 text-sm">
              <div className="break-all font-medium text-zinc-100">{result.name}</div>
              <div className="text-xs text-zinc-500">{formatBytes(result.blob.size)}</div>
              {result.driveFile ? (
                <Notice kind="success">
                  Saved to Drive › {project.name} › Final Exports.
                  {result.driveFile.webViewLink && (
                    <a href={result.driveFile.webViewLink} target="_blank" rel="noreferrer" className="mt-1 flex items-center gap-1 underline">
                      Open in Drive <ExternalLink className="size-3" />
                    </a>
                  )}
                </Notice>
              ) : result.uploadError ? (
                <>
                  <Notice kind="error">{result.uploadError}</Notice>
                  <Button
                    variant="primary"
                    icon={<CloudUpload className="size-4" />}
                    onClick={async () => {
                      await refreshIfExpiringSoon(10 * 60_000).catch(() => undefined);
                      uploadResult(result.blob, result.name);
                    }}
                  >
                    Retry upload
                  </Button>
                </>
              ) : typeof result.uploadProgress === 'number' ? (
                <Progress value={result.uploadProgress} label="Uploading to Drive" />
              ) : null}
              <Button icon={<Download className="size-4" />} onClick={() => downloadLocally(result.blob, result.name)}>
                Download to this device
              </Button>
            </div>
          </div>
        )}
        {!render && !result && <p className="text-sm text-zinc-500">The finished MP4 is uploaded to this project’s “Final Exports” folder automatically.</p>}
        {(render || logs.length > 0) && (
          <details className="mt-4">
            <summary className="cursor-pointer text-xs text-zinc-500">FFmpeg log</summary>
            <LogView lines={logs.slice(-80)} className="mt-2" />
          </details>
        )}
      </Card>

      {segments.length > 0 && (
        <Card title="Timeline" subtitle="Per-panel effect overrides are saved to project.json.">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {segments.map((s) => {
              const p = panels!.find((x) => x.id === s.panelId)!;
              const w = p.imageMediaMetadata?.width;
              const h = p.imageMediaMetadata?.height;
              const auto = w && h ? resolveEffect('auto', w, h, s.index, settings.width, settings.height) : null;
              return (
                <div key={s.panelId} className="flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-2">
                  <Thumb id={s.panelId} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="font-mono text-zinc-300">#{s.index + 1}</span>
                      <span className="font-mono text-zinc-500">
                        {formatDuration(s.start)}–{formatDuration(s.end)}
                      </span>
                      <span className="text-zinc-500">{(s.end - s.start).toFixed(1)}s</span>
                    </div>
                    <Select className="mt-1 h-8 text-xs" value={effects[s.panelId] ?? 'auto'} onChange={(e) => setEffect(s.panelId, e.target.value as EffectChoice)}>
                      {EFFECTS.map((e) => (
                        <option key={e} value={e}>
                          {e === 'auto' ? `auto${auto ? ` (${auto})` : ''}` : e}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <DrivePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        start={[{ id: project.folders.audio, name: 'Audio' }]}
        title="Choose narration audio"
        accept={isAudio}
        onPick={(files) => loadNarration(files[0])}
      />
    </div>
  );
}

function Thumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    getPanelUrl(id)
      .then((u) => alive && setUrl(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);
  return (
    <div className="h-14 w-11 shrink-0 overflow-hidden rounded-md bg-zinc-900">
      {url && <img src={url} alt="" className="size-full object-cover object-top" />}
    </div>
  );
}

/** Canvas preview driven by the narration's currentTime — uses the exact renderer used for export. */
function PreviewPlayer({ segments, settings, audioUrl, duration }: { segments: Segment[]; settings: ComposeSettings; audioUrl: string; duration: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const busy = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);

  // Preview at reduced resolution for speed.
  const scale = Math.min(1, 960 / Math.max(settings.width, settings.height));
  const W = Math.round(settings.width * scale);
  const H = Math.round(settings.height * scale);

  const pending = useRef<number | null>(null);

  // One frame in flight at a time; if asked again meanwhile, draw the latest request afterwards
  // (so a seek while paused never leaves a stale frame on screen).
  const draw = useCallback(async (t: number) => {
    if (!rendererRef.current) return;
    if (busy.current) {
      pending.current = t;
      return;
    }
    busy.current = true;
    let next: number | null = t;
    while (next !== null && rendererRef.current) {
      pending.current = null;
      try {
        await rendererRef.current.renderFrame(next);
      } catch {
        /* panel failed to load — skip frame */
      }
      next = pending.current;
    }
    busy.current = false;
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { alpha: false })!;
    rendererRef.current?.dispose();
    rendererRef.current = new FrameRenderer(ctx, W, H, settings, segments);
    busy.current = false;
    draw(audioRef.current?.currentTime ?? 0);
    return () => {
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [segments, settings, W, H, draw]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      const t = audioRef.current?.currentTime ?? 0;
      setTime(t);
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, draw]);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) a.play().catch(() => undefined);
    else a.pause();
  };

  const seek = (t: number) => {
    const a = audioRef.current;
    if (a) a.currentTime = Math.min(t, a.duration || t);
    setTime(t);
    draw(t);
  };

  return (
    <div>
      <div className={cn('mx-auto overflow-hidden rounded-xl bg-black', settings.height > settings.width ? 'max-w-xs' : 'w-full')}>
        <canvas ref={canvasRef} className="block h-auto w-full" style={{ aspectRatio: `${settings.width} / ${settings.height}` }} />
      </div>
      <audio ref={audioRef} src={audioUrl} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} preload="auto" />
      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" variant="primary" onClick={toggle} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />}>
          {playing ? 'Pause' : 'Play'}
        </Button>
        <input type="range" className="flex-1" min={0} max={duration} step={0.05} value={time} onChange={(e) => seek(Number(e.target.value))} />
        <span className="w-24 text-right font-mono text-xs text-zinc-400">
          {formatDuration(time)} / {formatDuration(duration)}
        </span>
      </div>
    </div>
  );
}

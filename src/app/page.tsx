'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, Compass, ExternalLink, FileText, Film, HardDrive, Mic, Scissors } from 'lucide-react';
import { DriveFile, listChildren } from '@/lib/drive';
import { useSession } from '@/lib/store';
import { cn, formatBytes, formatDate } from '@/lib/utils';
import { Badge, Card, PageHeader } from '@/components/ui';
import { RequireDrive } from '@/components/RequireProject';

interface Stats {
  source: number;
  scripts: number;
  panels: number;
  audio: number;
  exports: DriveFile[];
}

export default function Dashboard() {
  const project = useSession((s) => s.project);
  const token = useSession((s) => s.token);
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    if (!project || !token) {
      setStats(null);
      return;
    }
    let alive = true;
    const f = project.folders;
    Promise.all([listChildren(f.source), listChildren(f.scripts), listChildren(f.panels), listChildren(f.audio), listChildren(f.exports, { orderBy: 'modifiedTime desc' })])
      .then(([source, scripts, panels, audio, exports]) => {
        if (alive)
          setStats({
            source: source.length,
            scripts: scripts.filter((x) => x.name.endsWith('.json')).length,
            panels: panels.length,
            audio: audio.filter((x) => /\.(mp3|wav)$/i.test(x.name)).length,
            exports,
          });
      })
      .catch(() => alive && setStats(null));
    return () => {
      alive = false;
    };
  }, [project, token]);

  const steps = [
    { href: '/discover', icon: Compass, title: 'Pick a series', desc: 'Browse trending manhwa and create a Drive project.', done: Boolean(project) },
    { href: '/slicer', icon: Scissors, title: 'Slice panels', desc: 'Extract a .cbz/.zip and cut the strip into panels.', done: (stats?.panels ?? 0) > 0, count: stats?.panels },
    { href: '/script', icon: FileText, title: 'Write the script', desc: 'Generate a beat-by-beat recap with Gemini.', done: (stats?.scripts ?? 0) > 0, count: stats?.scripts },
    { href: '/voice', icon: Mic, title: 'Record narration', desc: 'Turn the script into a single narration MP3.', done: (stats?.audio ?? 0) > 0, count: stats?.audio },
    { href: '/compose', icon: Film, title: 'Render video', desc: 'Ken Burns animation + narration → MP4 in Drive.', done: (stats?.exports.length ?? 0) > 0, count: stats?.exports.length },
  ];

  return (
    <div>
      <PageHeader
        title="Studio dashboard"
        description="A fully serverless recap pipeline. Files live in your Google Drive; slicing, audio stitching and video rendering happen in this browser tab."
      />

      {project && (
        <div className="relative mb-6 overflow-hidden rounded-2xl border border-zinc-800">
          {project.meta.bannerImage && <img src={project.meta.bannerImage} alt="" className="absolute inset-0 size-full object-cover opacity-25" />}
          <div className="relative flex gap-4 bg-gradient-to-r from-zinc-950 via-zinc-950/80 to-transparent p-5">
            {project.meta.coverImage && <img src={project.meta.coverImage} alt="" className="h-32 w-22 shrink-0 rounded-xl object-cover shadow-xl" />}
            <div className="min-w-0">
              <div className="text-[11px] uppercase tracking-wider text-violet-300">Current project</div>
              <h2 className="mt-1 text-lg font-semibold text-white">{project.name}</h2>
              <div className="mt-2 flex flex-wrap gap-1.5">{project.meta.genres?.slice(0, 5).map((g) => <Badge key={g}>{g}</Badge>)}</div>
              {project.meta.synopsis && <p className="mt-2 line-clamp-3 max-w-2xl text-sm text-zinc-400">{project.meta.synopsis}</p>}
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {steps.map((s, i) => (
          <Link key={s.href} href={s.href} className="group rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 transition hover:border-violet-500/50 hover:bg-zinc-900">
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-xl bg-violet-600/15 text-violet-300">
                <s.icon className="size-4" />
              </span>
              {s.done ? <CheckCircle2 className="size-5 text-emerald-400" /> : <Circle className="size-5 text-zinc-700" />}
            </div>
            <div className="mt-3 text-[11px] text-zinc-500">Step {i + 1}</div>
            <div className="font-medium text-zinc-100">{s.title}</div>
            <p className="mt-1 text-xs text-zinc-400">{s.desc}</p>
            {typeof s.count === 'number' && <div className="mt-2 text-[11px] text-zinc-500">{s.count} in Drive</div>}
          </Link>
        ))}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Recent exports" subtitle="Final Exports folder of the current project">
          <RequireDrive>
            {!project ? (
              <p className="text-sm text-zinc-500">Select a project to see its exports.</p>
            ) : !stats?.exports.length ? (
              <p className="text-sm text-zinc-500">No videos rendered yet.</p>
            ) : (
              <ul className="divide-y divide-zinc-800">
                {stats.exports.slice(0, 6).map((f) => (
                  <li key={f.id} className="flex items-center gap-3 py-2 text-sm">
                    <Film className="size-4 text-rose-300" />
                    <span className="min-w-0 flex-1 truncate">{f.name}</span>
                    <span className="text-[11px] text-zinc-500">{formatBytes(f.size)}</span>
                    <span className="hidden text-[11px] text-zinc-500 sm:inline">{formatDate(f.modifiedTime)}</span>
                    {f.webViewLink && (
                      <a href={f.webViewLink} target="_blank" rel="noreferrer" className="text-violet-300 hover:text-violet-200" aria-label="Open in Drive">
                        <ExternalLink className="size-4" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </RequireDrive>
        </Card>

        <Card title="How it stays serverless">
          <ul className="space-y-2 text-sm text-zinc-400">
            {[
              ['Storage', 'Google Drive API with OAuth 2.0 — project.json in each folder is the database.'],
              ['Scripts', 'Google Gemini called straight from the browser with your free API key.'],
              ['Slicing', 'JSZip + HTML5 canvas pixel analysis to find gutters.'],
              ['Voice', 'ElevenLabs / Google TTS via a tiny edge function, stitched with Web Audio.'],
              ['Video', 'Canvas Ken Burns frames encoded by FFmpeg.wasm (H.264 + AAC).'],
            ].map(([k, v]) => (
              <li key={k} className="flex gap-3">
                <span className={cn('w-16 shrink-0 text-xs font-medium text-violet-300')}>{k}</span>
                <span>{v}</span>
              </li>
            ))}
          </ul>
          <Link href="/drive" className="mt-4 inline-flex items-center gap-2 text-sm text-violet-300 hover:text-violet-200">
            <HardDrive className="size-4" /> Open the Drive explorer
          </Link>
        </Card>
      </div>
    </div>
  );
}

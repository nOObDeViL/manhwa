'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, FolderOpen, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { DriveFile, downloadJson, isJson, saveJson, saveText } from '@/lib/drive';
import { getPanelBlob } from '@/lib/panelCache';
import { listOrderedPanels } from '@/lib/panels';
import { Project, patchProject } from '@/lib/projects';
import {
  Beat,
  LENGTH_PRESETS,
  RecapScript,
  ScriptRequest,
  TONES,
  blobToPromptImage,
  estimateSeconds,
  generateWithGemini,
  generateWithOpenAI,
  scriptToText,
  totalSeconds,
} from '@/lib/script';
import { ScriptEngine, useSession, useSettings } from '@/lib/store';
import { errorMessage, fileSlug, formatDuration, stamp } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Notice, PageHeader, Select, Slider, Textarea, Toggle } from '@/components/ui';
import RequireProject from '@/components/RequireProject';
import DrivePicker from '@/components/DrivePicker';

export default function ScriptPage() {
  return (
    <div>
      <PageHeader title="Recap script generator" description="Paste chapter text or a summary, choose length and tone, and get a numbered beat script ready for narration." />
      <RequireProject>{(project) => <ScriptStudio key={project.id} project={project} />}</RequireProject>
    </div>
  );
}

const MAX_IMAGES = 24;

function ScriptStudio({ project }: { project: Project }) {
  const settings = useSettings();
  const script = useSession((s) => s.script);
  const scriptFileId = useSession((s) => s.scriptFileId);
  const setSession = useSession((s) => s.set);
  const toast = useSession((s) => s.toast);

  const [chapter, setChapter] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [targetSeconds, setTargetSeconds] = useState(300);
  const [tone, setTone] = useState(TONES[0]);
  const [language, setLanguage] = useState('English');
  const [includeOutro, setIncludeOutro] = useState(true);
  const [useSynopsis, setUseSynopsis] = useState(true);
  const [usePanels, setUsePanels] = useState(false);
  const [engine, setEngine] = useState<ScriptEngine>(settings.scriptEngine);
  const [panelFiles, setPanelFiles] = useState<DriveFile[]>([]);
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // Load the project's panels (for the optional multimodal mode) and its active script.
  useEffect(() => {
    let alive = true;
    listOrderedPanels(project)
      .then((files) => alive && setPanelFiles(files))
      .catch(() => undefined);
    if (!useSession.getState().script && project.meta.activeScriptFileId) {
      downloadJson<RecapScript>(project.meta.activeScriptFileId)
        .then((s) => alive && s?.beats && setSession({ script: s, scriptFileId: project.meta.activeScriptFileId ?? null }))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      let images: ScriptRequest['images'];
      if (usePanels && engine === 'gemini' && panelFiles.length) {
        // Evenly sample up to MAX_IMAGES panels across the chapter.
        const step = Math.max(1, panelFiles.length / MAX_IMAGES);
        const picks = Array.from({ length: Math.min(MAX_IMAGES, panelFiles.length) }, (_, i) => panelFiles[Math.floor(i * step)]);
        images = [];
        for (let i = 0; i < picks.length; i++) {
          setStage(`Preparing panel ${i + 1}/${picks.length}…`);
          images.push(await blobToPromptImage(await getPanelBlob(picks[i].id)));
        }
      }
      if (!sourceText.trim() && !images?.length) throw new Error('Paste some chapter text/summary, or enable “Use sliced panels”.');
      const req: ScriptRequest = {
        series: project.meta.title || project.name,
        synopsis: useSynopsis ? project.meta.synopsis : undefined,
        chapter: chapter.trim() || undefined,
        sourceText,
        targetSeconds,
        tone,
        language,
        includeOutro,
        images,
      };
      setStage(`Writing with ${engine === 'gemini' ? settings.geminiModel : settings.openaiModel}…`);
      const result =
        engine === 'gemini'
          ? await generateWithGemini(req, settings.geminiApiKey, settings.geminiModel, setStage)
          : await generateWithOpenAI(req, settings.openaiBaseUrl, settings.openaiApiKey, settings.openaiModel);
      setSession({ script: result, scriptFileId: null });
      toast(`Script ready: ${result.beats.length} beats.`, 'success');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setGenerating(false);
      setStage('');
    }
  };

  const updateScript = (patch: Partial<RecapScript>) => script && setSession({ script: { ...script, ...patch } });
  const updateBeat = (i: number, patch: Partial<Beat>) =>
    script && updateScript({ beats: script.beats.map((b, j) => (j === i ? { ...b, ...patch } : b)) });
  const renumber = (beats: Beat[]) => beats.map((b, i) => ({ ...b, n: i + 1 }));
  const moveBeat = (i: number, d: -1 | 1) => {
    if (!script) return;
    const beats = [...script.beats];
    const j = i + d;
    if (j < 0 || j >= beats.length) return;
    [beats[i], beats[j]] = [beats[j], beats[i]];
    updateScript({ beats: renumber(beats) });
  };

  const save = async () => {
    if (!script) return;
    setSaving(true);
    try {
      const cleaned: RecapScript = { ...script, beats: renumber(script.beats.filter((b) => b.narration.trim())).map((b) => ({ ...b, seconds: estimateSeconds(b.narration) })) };
      const base = `script_${fileSlug(cleaned.chapter || cleaned.title)}_${stamp()}`;
      // Keep saving into the same file once it exists; the .txt is a readable companion.
      const jsonFile = await saveJson(project.folders.scripts, `${base}.json`, cleaned, scriptFileId ?? undefined);
      await saveText(project.folders.scripts, jsonFile.name.replace(/\.json$/, '.txt'), scriptToText(cleaned));
      setSession({ script: cleaned, scriptFileId: jsonFile.id });
      await patchProject({ activeScriptFileId: jsonFile.id });
      toast(`Saved ${jsonFile.name} to Drive › ${project.name} › Scripts`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const loadFromDrive = async (files: DriveFile[]) => {
    const f = files[0];
    if (!f) return;
    try {
      const s = await downloadJson<RecapScript>(f.id);
      if (!Array.isArray(s?.beats)) throw new Error('That JSON file is not a recap script.');
      setSession({ script: s, scriptFileId: f.id });
      await patchProject({ activeScriptFileId: f.id });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const est = script ? totalSeconds(script) : 0;
  const keyMissing = engine === 'gemini' ? !settings.geminiApiKey : !settings.openaiApiKey;

  return (
    <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
      <div className="space-y-4">
        <Card title="Source & options">
          <div className="space-y-4">
            <Field label="Chapter / arc label">
              <Input value={chapter} onChange={(e) => setChapter(e.target.value)} placeholder="e.g. Chapters 1–12" />
            </Field>
            <Field label="Chapter summary or raw text" hint="Paste dialogue, a summary, or fan-translation text. The more detail, the better the recap.">
              <Textarea rows={9} value={sourceText} onChange={(e) => setSourceText(e.target.value)} placeholder="Jin-woo enters the double dungeon…" />
            </Field>
            <Field label="Target video length">
              <Select value={LENGTH_PRESETS.some((p) => p.seconds === targetSeconds) ? targetSeconds : 'custom'} onChange={(e) => e.target.value !== 'custom' && setTargetSeconds(Number(e.target.value))}>
                {LENGTH_PRESETS.map((p) => (
                  <option key={p.seconds} value={p.seconds}>
                    {p.label}
                  </option>
                ))}
                {!LENGTH_PRESETS.some((p) => p.seconds === targetSeconds) && <option value="custom">Custom</option>}
              </Select>
            </Field>
            <Slider label="Fine-tune length" value={targetSeconds} min={30} max={1800} step={15} onChange={setTargetSeconds} format={formatDuration} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tone">
                <Select value={tone} onChange={(e) => setTone(e.target.value)}>
                  {TONES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Language">
                <Input value={language} onChange={(e) => setLanguage(e.target.value)} />
              </Field>
            </div>
            <Field label="Engine">
              <Select value={engine} onChange={(e) => setEngine(e.target.value as ScriptEngine)}>
                <option value="gemini">Google Gemini ({settings.geminiModel})</option>
                <option value="openai">OpenAI-compatible ({settings.openaiModel})</option>
              </Select>
            </Field>
            <Toggle checked={useSynopsis} onChange={setUseSynopsis} label="Give the model the series synopsis" hint={project.meta.synopsis ? undefined : 'This project has no synopsis (create it from Discover to add one).'} />
            <Toggle checked={includeOutro} onChange={setIncludeOutro} label="End with a like & subscribe outro" />
            <Toggle
              checked={usePanels}
              onChange={setUsePanels}
              label={`Use sliced panels as visual reference (${panelFiles.length})`}
              hint={engine === 'gemini' ? `Gemini looks at up to ${MAX_IMAGES} panels to understand the chapter.` : 'Only available with Gemini.'}
            />
            {keyMissing && (
              <Notice kind="warn">
                No API key for this engine. Add one in <Link href="/settings" className="underline">Settings</Link>.
              </Notice>
            )}
            {error && <Notice kind="error">{error}</Notice>}
            <Button variant="primary" size="lg" className="w-full" loading={generating} onClick={generate} icon={<Sparkles className="size-4" />}>
              {generating ? stage || 'Generating…' : 'Generate script'}
            </Button>
          </div>
        </Card>
      </div>

      <Card
        title={script ? 'Script editor' : 'Script'}
        subtitle={script ? `${script.beats.length} beats · est. ${formatDuration(est)} of narration · target ${formatDuration(script.targetSeconds)}` : 'Generate or open a script to edit it here.'}
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<FolderOpen className="size-3.5" />} onClick={() => setPickerOpen(true)}>
              Open from Drive
            </Button>
            {script && (
              <Button size="sm" variant="primary" loading={saving} onClick={save} icon={<Save className="size-3.5" />}>
                Save to Drive
              </Button>
            )}
          </>
        }
      >
        {!script ? (
          <p className="py-10 text-center text-sm text-zinc-500">Nothing here yet.</p>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Input className="flex-1 text-base font-medium" value={script.title} onChange={(e) => updateScript({ title: e.target.value })} />
              <Badge tone="accent">{script.tone}</Badge>
              {scriptFileId ? <Badge tone="good">saved</Badge> : <Badge tone="warn">unsaved</Badge>}
            </div>
            <ol className="space-y-3">
              {script.beats.map((b, i) => (
                <li key={i} className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-600/20 font-mono text-xs text-violet-200">{b.n}</span>
                    <Input className="h-8 flex-1 text-sm" value={b.title ?? ''} placeholder="Beat title" onChange={(e) => updateBeat(i, { title: e.target.value })} />
                    <span className="w-12 text-right font-mono text-[11px] text-zinc-500">~{estimateSeconds(b.narration)}s</span>
                    <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white" onClick={() => moveBeat(i, -1)} aria-label="Move up">
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white" onClick={() => moveBeat(i, 1)} aria-label="Move down">
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-300"
                      onClick={() => updateScript({ beats: renumber(script.beats.filter((_, j) => j !== i)) })}
                      aria-label="Delete beat"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <Textarea rows={3} value={b.narration} onChange={(e) => updateBeat(i, { narration: e.target.value })} />
                  <Input className="mt-2 h-8 text-xs text-zinc-400" value={b.visual ?? ''} placeholder="Visual cue" onChange={(e) => updateBeat(i, { visual: e.target.value })} />
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => updateScript({ beats: renumber([...script.beats, { n: 0, narration: '', title: '' }]) })}>
                Add beat
              </Button>
              <Link href="/voice">
                <Button size="sm" variant="ghost">
                  Next: generate voice →
                </Button>
              </Link>
            </div>
          </div>
        )}
      </Card>

      <DrivePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        start={[{ id: project.folders.scripts, name: 'Scripts' }]}
        title="Open a script"
        accept={isJson}
        onPick={loadFromDrive}
      />
    </div>
  );
}

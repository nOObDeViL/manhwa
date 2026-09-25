'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CloudUpload, HardDrive, Scissors, Smartphone, Trash2, X } from 'lucide-react';
import { SourceImage, extractImagesFromZip, isArchiveName, isImageName } from '@/lib/cbz';
import { DriveFile, downloadBlob, getFile, isArchive, isImage, listChildren, trashFile, uploadFile } from '@/lib/drive';
import { putPanelBlob } from '@/lib/panelCache';
import { Project, patchProject } from '@/lib/projects';
import { DEFAULT_SLICE_OPTIONS, SliceOptions, SlicedPanel, Strip, extensionFor, prepareStrip, slice } from '@/lib/slicer';
import { useSession } from '@/lib/store';
import { baseName, errorMessage, fileSlug, formatBytes, mimeFromName, pad, pool } from '@/lib/utils';
import { Badge, Button, Card, Field, Input, Modal, Notice, PageHeader, Progress, Select, Slider, Toggle } from '@/components/ui';
import RequireProject from '@/components/RequireProject';
import DrivePicker from '@/components/DrivePicker';

export default function SlicerPage() {
  return (
    <div>
      <PageHeader
        title="Serverless panel slicer"
        description="Extract .cbz / .zip chapters in the browser, detect white/black gutters with canvas pixel analysis, and save each panel to Drive."
      />
      <RequireProject>{(project) => <Slicer key={project.id} project={project} />}</RequireProject>
    </div>
  );
}

interface Loaded {
  label: string;
  images: SourceImage[];
}

function Slicer({ project }: { project: Project }) {
  const toast = useSession((s) => s.toast);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState<{ label: string; value: number } | null>(null);
  const [opts, setOpts] = useState<SliceOptions>(DEFAULT_SLICE_OPTIONS);
  const [strip, setStrip] = useState<Strip | null>(null);
  const [panels, setPanels] = useState<Array<SlicedPanel & { url: string }>>([]);
  const [progress, setProgress] = useState<{ label: string; value: number } | null>(null);
  const [prefix, setPrefix] = useState('');
  const [mode, setMode] = useState<'append' | 'replace'>('append');
  const [saveSource, setSaveSource] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<number | null>(null);
  const deviceInput = useRef<HTMLInputElement>(null);

  const set = <K extends keyof SliceOptions>(k: K, v: SliceOptions[K]) => setOpts((o) => ({ ...o, [k]: v }));

  const clearPanels = () =>
    setPanels((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.url));
      return [];
    });

  useEffect(() => () => clearPanels(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const ingest = async (sources: Array<{ name: string; blob: Blob }>, label: string) => {
    const images: SourceImage[] = [];
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      if (isArchiveName(s.name) || /zip|comicbook/.test(s.blob.type)) {
        setLoading({ label: `Extracting ${s.name}`, value: 0 });
        images.push(...(await extractImagesFromZip(s.blob, (v) => setLoading({ label: `Extracting ${s.name}`, value: v }))));
      } else if (isImageName(s.name) || s.blob.type.startsWith('image/')) {
        images.push({ name: s.name, blob: s.blob });
      }
    }
    if (!images.length) throw new Error('No images found in the selected files.');
    clearPanels();
    setStrip(null);
    setUploaded(null);
    setLoaded({ label, images });
    setPrefix((p) => p || fileSlug(baseName(sources[0].name)));
  };

  const loadFromDrive = async (files: DriveFile[]) => {
    try {
      const sources: Array<{ name: string; blob: Blob }> = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        setLoading({ label: `Downloading ${f.name} (${i + 1}/${files.length})`, value: 0 });
        const blob = await downloadBlob(f.id, (v) => setLoading({ label: `Downloading ${f.name} (${i + 1}/${files.length})`, value: v }));
        sources.push({ name: f.name, blob: blob.type ? blob : new Blob([blob], { type: mimeFromName(f.name) }) });
      }
      sources.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      await ingest(sources, files.length === 1 ? files[0].name : `${files.length} files from Drive`);
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(null);
    }
  };

  const loadFromDevice = async (fileList: File[]) => {
    if (!fileList.length) return;
    try {
      const sorted = [...fileList].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      await ingest(sorted.map((f) => ({ name: f.name, blob: f })), sorted.length === 1 ? sorted[0].name : `${sorted.length} files from this device`);
      if (saveSource) {
        setLoading({ label: 'Saving originals to Drive › Source', value: 0 });
        for (let i = 0; i < sorted.length; i++) {
          const f = sorted[i];
          await uploadFile(f, {
            name: f.name,
            parentId: project.folders.source,
            mimeType: f.type || mimeFromName(f.name),
            onProgress: (v) => setLoading({ label: `Saving ${f.name} to Source`, value: (i + v) / sorted.length }),
          });
        }
      }
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setLoading(null);
    }
  };

  // Files passed from the Drive explorer (?files=id1,id2).
  useEffect(() => {
    const ids = new URLSearchParams(window.location.search).get('files')?.split(',').filter(Boolean);
    if (!ids?.length) return;
    window.history.replaceState(null, '', '/slicer');
    Promise.all(ids.map((id) => getFile(id)))
      .then((files) => loadFromDrive(files.filter((f) => isImage(f) || isArchive(f))))
      .catch((err) => toast(errorMessage(err), 'error'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runSlice = async () => {
    if (!loaded) return;
    setUploaded(null);
    try {
      let s = strip;
      if (!s) {
        s = await prepareStrip(loaded.images, opts.maxWidth, (_stage, v) => setProgress({ label: 'Measuring pages', value: v * 0.1 }));
        setStrip(s);
      }
      const result = await slice(s, opts, (stage, v) =>
        setProgress({
          label: stage === 'analysing' ? 'Scanning rows for gutters' : 'Cutting panels',
          value: stage === 'analysing' ? 0.1 + v * 0.5 : 0.6 + v * 0.4,
        }),
      );
      clearPanels();
      setPanels(result.map((p) => ({ ...p, url: URL.createObjectURL(p.blob) })));
      if (s.skipped.length) toast(`Skipped ${s.skipped.length} unreadable image(s).`, 'error');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setProgress(null);
    }
  };

  const upload = async () => {
    if (!panels.length) return;
    try {
      let order = project.meta.panelOrder;
      if (mode === 'replace') {
        setProgress({ label: 'Moving old panels to trash', value: 0 });
        const old = await listChildren(project.folders.panels);
        await pool(old, 4, (f) => trashFile(f.id));
        order = [];
      }
      const ext = extensionFor(opts.format);
      const name = fileSlug(prefix || 'panel');
      let done = 0;
      const ids = await pool(panels, 3, async (p, i) => {
        const file = await uploadFile(p.blob, {
          name: `${name}_${pad(i + 1)}.${ext}`,
          parentId: project.folders.panels,
          mimeType: opts.format,
          appProperties: { mrsPanel: '1', source: loaded?.label.slice(0, 100) ?? '' },
        });
        putPanelBlob(file.id, p.blob);
        done++;
        setProgress({ label: `Uploading panels ${done}/${panels.length}`, value: done / panels.length });
        return file.id;
      });
      await patchProject({ panelOrder: [...order.filter((id) => !ids.includes(id)), ...ids] });
      setUploaded(ids.length);
      toast(`Uploaded ${ids.length} panels to Drive › ${project.name} › Sliced Panels`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setProgress(null);
    }
  };

  const totalSize = useMemo(() => panels.reduce((s, p) => s + p.blob.size, 0), [panels]);
  const busy = Boolean(progress || loading);

  return (
    <div className="grid gap-4 xl:grid-cols-[340px_1fr]">
      <div className="space-y-4">
        <Card title="1 · Source">
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setPickerOpen(true)} icon={<HardDrive className="size-4" />} disabled={busy}>
              From Drive
            </Button>
            <Button onClick={() => deviceInput.current?.click()} icon={<Smartphone className="size-4" />} disabled={busy}>
              From device
            </Button>
          </div>
          <input
            ref={deviceInput}
            type="file"
            multiple
            accept=".cbz,.zip,.jpg,.jpeg,.png,.webp,image/*,application/zip"
            className="hidden"
            onChange={(e) => {
              loadFromDevice(Array.from(e.target.files ?? []));
              e.target.value = '';
            }}
          />
          <div className="mt-3">
            <Toggle checked={saveSource} onChange={setSaveSource} label="Also save device files to the project’s Source folder" />
          </div>
          {loading && <Progress className="mt-3" value={loading.value} label={loading.label} />}
          {loaded && (
            <div className="mt-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 text-sm">
              <div className="truncate font-medium text-zinc-100">{loaded.label}</div>
              <div className="text-xs text-zinc-500">
                {loaded.images.length} page image(s) · {formatBytes(loaded.images.reduce((s, i) => s + i.blob.size, 0))}
                {strip && ` · strip ${strip.width}×${strip.height}px`}
              </div>
            </div>
          )}
        </Card>

        <Card title="2 · Gutter detection">
          <div className="space-y-4">
            <Field label="Gutter colour">
              <Select value={opts.gutter} onChange={(e) => set('gutter', e.target.value as SliceOptions['gutter'])}>
                <option value="auto">Any flat colour (auto)</option>
                <option value="white">White gutters only</option>
                <option value="black">Black gutters only</option>
              </Select>
            </Field>
            <Slider label="Colour tolerance" value={opts.tolerance} min={2} max={60} onChange={(v) => set('tolerance', v)} hint="Raise for noisy/JPEG-compressed gutters." />
            <Slider
              label="Row coverage"
              value={opts.coverage}
              min={0.9}
              max={1}
              step={0.005}
              onChange={(v) => set('coverage', v)}
              format={(v) => `${(v * 100).toFixed(1)}%`}
              hint="Share of a row that must be flat to count as gutter."
            />
            <Slider label="Min gutter height" value={opts.minGutter} min={4} max={120} onChange={(v) => set('minGutter', v)} format={(v) => `${v}px`} />
            <Slider label="Min panel height" value={opts.minPanelHeight} min={40} max={800} step={10} onChange={(v) => set('minPanelHeight', v)} format={(v) => `${v}px`} hint="Smaller pieces (bubbles, SFX) merge into the nearest panel." />
            <Slider
              label="Max panel height"
              value={opts.maxPanelHeight}
              min={0}
              max={6000}
              step={100}
              onChange={(v) => set('maxPanelHeight', v)}
              format={(v) => (v ? `${v}px` : 'off')}
              hint="Split very tall panels at their quietest row."
            />
            <Slider label="Padding" value={opts.padding} min={0} max={40} onChange={(v) => set('padding', v)} format={(v) => `${v}px`} />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Format">
                <Select value={opts.format} onChange={(e) => set('format', e.target.value as SliceOptions['format'])}>
                  <option value="image/jpeg">JPEG</option>
                  <option value="image/webp">WebP</option>
                  <option value="image/png">PNG</option>
                </Select>
              </Field>
              <Field label="Max width">
                <Select
                  value={opts.maxWidth}
                  onChange={(e) => {
                    set('maxWidth', Number(e.target.value));
                    setStrip(null);
                  }}
                >
                  {[720, 1080, 1600, 2400].map((w) => (
                    <option key={w} value={w}>
                      {w}px
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" className="flex-1" disabled={!loaded || busy} onClick={runSlice} icon={<Scissors className="size-4" />}>
                {panels.length ? 'Re-slice' : 'Slice panels'}
              </Button>
              <Button variant="ghost" onClick={() => setOpts(DEFAULT_SLICE_OPTIONS)}>
                Reset
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <Card
        title={`3 · Review ${panels.length ? `(${panels.length} panels · ${formatBytes(totalSize)})` : ''}`}
        subtitle="Tap a panel to inspect it, remove bad cuts, then upload to Drive."
        actions={
          panels.length > 0 && (
            <Button size="sm" variant="ghost" icon={<X className="size-3.5" />} onClick={clearPanels}>
              Discard
            </Button>
          )
        }
      >
        {progress && <Progress className="mb-4" value={progress.value} label={progress.label} />}
        {!panels.length ? (
          <p className="py-16 text-center text-sm text-zinc-500">{loaded ? 'Adjust the settings and tap “Slice panels”.' : 'Load a chapter to get started.'}</p>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
              <Field label="File name prefix" className="min-w-40 flex-1">
                <Input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="ch001" />
              </Field>
              <Field label="Existing panels">
                <Select value={mode} onChange={(e) => setMode(e.target.value as 'append' | 'replace')}>
                  <option value="append">Append after existing</option>
                  <option value="replace">Replace (trash existing)</option>
                </Select>
              </Field>
              <Button variant="primary" onClick={upload} disabled={busy} icon={<CloudUpload className="size-4" />}>
                Upload {panels.length} to Drive
              </Button>
            </div>
            {uploaded !== null && (
              <Notice kind="success" className="mb-4">
                {uploaded} panels saved. Reorder them on the{' '}
                <Link href="/panels" className="underline">
                  Panels
                </Link>{' '}
                page.
              </Notice>
            )}
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 2xl:grid-cols-7">
              {panels.map((p, i) => (
                <div key={p.url} className="group relative overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
                  <button className="block w-full" onClick={() => setPreview(p.url)}>
                    <img src={p.url} alt="" className="aspect-[3/4] w-full object-cover object-top" loading="lazy" />
                  </button>
                  <div className="absolute top-1 left-1">
                    <Badge className="bg-black/70">{i + 1}</Badge>
                  </div>
                  <div className="flex items-center justify-between px-1.5 py-1 text-[10px] text-zinc-500">
                    <span>
                      {p.width}×{p.height}
                    </span>
                    <button
                      className="rounded p-0.5 hover:bg-zinc-800 hover:text-red-300"
                      onClick={() =>
                        setPanels((all) => {
                          URL.revokeObjectURL(p.url);
                          return all.filter((x) => x !== p);
                        })
                      }
                      aria-label="Remove panel"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      <DrivePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        start={[{ id: project.folders.source, name: 'Source' }]}
        title="Pick a .cbz / .zip or page images"
        accept={(f) => isImage(f) || isArchive(f)}
        multiple
        onPick={loadFromDrive}
      />
      <Modal open={Boolean(preview)} onClose={() => setPreview(null)} title="Panel" wide>
        {preview && <img src={preview} alt="" className="checker mx-auto max-h-[78dvh] object-contain" />}
      </Modal>
    </div>
  );
}

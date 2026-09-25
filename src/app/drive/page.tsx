'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { ChevronRight, ExternalLink, Eye, FolderPlus, Home, RefreshCw, Scissors, Trash2, Upload } from 'lucide-react';
import { DriveFile, createFolder, downloadBlob, isArchive, isFolder, isImage, listChildren, trashFile, uploadFile } from '@/lib/drive';
import { ROOT_FOLDER_NAME } from '@/lib/projects';
import { useSession } from '@/lib/store';
import { cn, errorMessage, formatBytes, formatDate, mimeFromName, uid } from '@/lib/utils';
import { Badge, Button, Card, Input, Modal, PageHeader, Progress, Spinner } from '@/components/ui';
import { RequireDrive } from '@/components/RequireProject';
import { FileIcon } from '@/components/FileIcon';
import type { Crumb } from '@/components/DrivePicker';

interface UploadItem {
  id: string;
  name: string;
  progress: number;
  error?: string;
  done?: boolean;
}

export default function DrivePage() {
  return (
    <div>
      <PageHeader
        title="Google Drive files"
        description="Browse, upload and pick .cbz / .zip / .jpg / .png files. Everything lives under “Manhwa Recap Studio” in your Drive."
      />
      <RequireDrive>
        <Explorer />
      </RequireDrive>
    </div>
  );
}

function Explorer() {
  const router = useRouter();
  const rootId = useSession((s) => s.rootId)!;
  const projectsId = useSession((s) => s.projectsId);
  const project = useSession((s) => s.project);
  const toast = useSession((s) => s.toast);
  const [crumbs, setCrumbs] = useState<Crumb[]>([{ id: rootId, name: ROOT_FOLDER_NAME }]);
  const [items, setItems] = useState<DriveFile[] | null>(null);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; url: string } | null>(null);
  const [confirmTrash, setConfirmTrash] = useState<DriveFile[] | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const current = crumbs[crumbs.length - 1];

  const refresh = useCallback(async () => {
    setItems(null);
    setSelected(new Set());
    try {
      setItems(await listChildren(current.id));
    } catch (err) {
      toast(errorMessage(err), 'error');
      setItems([]);
    }
  }, [current.id, toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const jump = (target: Crumb[]) => setCrumbs(target);

  const handleFiles = async (files: File[]) => {
    if (!files.length) return;
    const queue = files.map((f) => ({ file: f, item: { id: uid(), name: f.name, progress: 0 } as UploadItem }));
    setUploads((u) => [...queue.map((q) => q.item), ...u].slice(0, 30));
    const patch = (id: string, p: Partial<UploadItem>) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, ...p } : x)));
    for (const { file, item } of queue) {
      try {
        await uploadFile(file, {
          name: file.name,
          parentId: current.id,
          mimeType: file.type || mimeFromName(file.name),
          onProgress: (p) => patch(item.id, { progress: p }),
        });
        patch(item.id, { progress: 1, done: true });
      } catch (err) {
        patch(item.id, { error: errorMessage(err) });
      }
    }
    refresh();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    handleFiles(Array.from(e.dataTransfer.files));
  };

  const createNewFolder = async () => {
    if (!newFolder?.trim()) return;
    try {
      await createFolder(newFolder.trim(), current.id);
      setNewFolder(null);
      refresh();
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const openPreview = async (f: DriveFile) => {
    try {
      const blob = await downloadBlob(f.id);
      setPreview({ name: f.name, url: URL.createObjectURL(blob) });
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  const doTrash = async (files: DriveFile[]) => {
    setConfirmTrash(null);
    try {
      for (const f of files) await trashFile(f.id);
      toast(`Moved ${files.length} item(s) to Drive trash.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
    refresh();
  };

  const selectedFiles = (items ?? []).filter((f) => selected.has(f.id));
  const sliceable = selectedFiles.filter((f) => isImage(f) || isArchive(f));

  const quickLinks: Array<{ label: string; crumbs: Crumb[] }> = [
    { label: 'Studio root', crumbs: [{ id: rootId, name: ROOT_FOLDER_NAME }] },
    ...(project
      ? [
          {
            label: 'Current project',
            crumbs: [
              { id: rootId, name: ROOT_FOLDER_NAME },
              ...(projectsId ? [{ id: projectsId, name: 'Projects' }] : []),
              { id: project.id, name: project.name },
            ],
          },
          {
            label: 'Project Source',
            crumbs: [
              { id: rootId, name: ROOT_FOLDER_NAME },
              ...(projectsId ? [{ id: projectsId, name: 'Projects' }] : []),
              { id: project.id, name: project.name },
              { id: project.folders.source, name: 'Source' },
            ],
          },
        ]
      : []),
    { label: 'My Drive', crumbs: [{ id: 'root', name: 'My Drive' }] },
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
      <Card
        className={cn(dragging && 'border-violet-500 ring-2 ring-violet-500/30')}
        bodyClassName="p-0"
        title={
          <div className="flex flex-wrap items-center gap-1 text-sm">
            {crumbs.map((c, i) => (
              <span key={`${c.id}-${i}`} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5 text-zinc-600" />}
                <button className="rounded px-1 hover:bg-zinc-800" onClick={() => jump(crumbs.slice(0, i + 1))}>
                  {i === 0 ? <Home className="inline size-3.5" /> : null} {c.name}
                </button>
              </span>
            ))}
          </div>
        }
        actions={
          <>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={refresh}>
              Refresh
            </Button>
            <Button size="sm" icon={<FolderPlus className="size-3.5" />} onClick={() => setNewFolder('')}>
              Folder
            </Button>
            <Button size="sm" variant="primary" icon={<Upload className="size-3.5" />} onClick={() => fileInput.current?.click()}>
              Upload
            </Button>
            <input
              ref={fileInput}
              type="file"
              multiple
              accept=".cbz,.zip,.jpg,.jpeg,.png,.webp,.mp3,.wav,.json,.txt,image/*,audio/*"
              className="hidden"
              onChange={(e) => {
                handleFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
          </>
        }
      >
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className="min-h-64"
        >
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 bg-violet-600/10 px-4 py-2 text-sm">
              <span className="text-violet-200">{selected.size} selected</span>
              {sliceable.length > 0 && (
                <Button
                  size="sm"
                  variant="primary"
                  icon={<Scissors className="size-3.5" />}
                  onClick={() => router.push(`/slicer?files=${sliceable.map((f) => f.id).join(',')}`)}
                >
                  Slice {sliceable.length}
                </Button>
              )}
              <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmTrash(selectedFiles)}>
                Trash
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                Clear
              </Button>
            </div>
          )}

          {items === null ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-16 text-center text-sm text-zinc-500">
              This folder is empty. Drag files here or tap Upload.
            </div>
          ) : (
            <ul className="divide-y divide-zinc-800/80">
              {items.map((f) => {
                const folder = isFolder(f);
                const canSlice = isImage(f) || isArchive(f);
                return (
                  <li key={f.id} className={cn('group flex items-center gap-3 px-4 py-2.5 hover:bg-zinc-800/40', selected.has(f.id) && 'bg-violet-600/10')}>
                    <input
                      type="checkbox"
                      className="size-4 accent-violet-500"
                      checked={selected.has(f.id)}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (n.has(f.id)) n.delete(f.id);
                          else n.add(f.id);
                          return n;
                        })
                      }
                      aria-label={`Select ${f.name}`}
                    />
                    <button
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      onClick={() => (folder ? setCrumbs([...crumbs, { id: f.id, name: f.name }]) : isImage(f) ? openPreview(f) : undefined)}
                    >
                      <FileIcon file={f} />
                      <span className="min-w-0 flex-1 truncate text-sm text-zinc-100">{f.name}</span>
                    </button>
                    {isArchive(f) && <Badge tone="accent">archive</Badge>}
                    <span className="hidden w-16 text-right text-[11px] text-zinc-500 sm:block">{folder ? '' : formatBytes(f.size)}</span>
                    <span className="hidden w-24 text-right text-[11px] text-zinc-500 md:block">{formatDate(f.modifiedTime)}</span>
                    <div className="flex items-center gap-0.5">
                      {canSlice && (
                        <button
                          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-violet-300"
                          title="Slice panels"
                          onClick={() => router.push(`/slicer?files=${f.id}`)}
                        >
                          <Scissors className="size-4" />
                        </button>
                      )}
                      {isImage(f) && (
                        <button className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white" title="Preview" onClick={() => openPreview(f)}>
                          <Eye className="size-4" />
                        </button>
                      )}
                      {f.webViewLink && (
                        <a
                          href={f.webViewLink}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                          title="Open in Google Drive"
                        >
                          <ExternalLink className="size-4" />
                        </a>
                      )}
                      <button className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-red-300" title="Move to trash" onClick={() => setConfirmTrash([f])}>
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>

      <div className="space-y-4">
        <Card title="Jump to">
          <div className="flex flex-col gap-1.5">
            {quickLinks.map((q) => (
              <Button key={q.label} size="sm" variant="ghost" className="justify-start" onClick={() => jump(q.crumbs)}>
                {q.label}
              </Button>
            ))}
          </div>
        </Card>
        {uploads.length > 0 && (
          <Card title="Uploads" actions={<Button size="sm" variant="ghost" onClick={() => setUploads([])}>Clear</Button>}>
            <div className="space-y-3">
              {uploads.map((u) => (
                <div key={u.id}>
                  {u.error ? (
                    <div className="text-xs text-red-300">
                      <div className="truncate font-medium">{u.name}</div>
                      {u.error}
                    </div>
                  ) : (
                    <Progress value={u.progress} label={u.name} />
                  )}
                </div>
              ))}
            </div>
          </Card>
        )}
        <Card title="Tips">
          <ul className="list-disc space-y-1.5 pl-4 text-xs text-zinc-400">
            <li>On your phone or tablet you can also drop .cbz files into this folder from the Google Drive app — they show up here.</li>
            <li>Tick several page images to slice them as one continuous strip.</li>
            <li>Trash is recoverable from Google Drive for 30 days.</li>
          </ul>
        </Card>
      </div>

      <Modal
        open={newFolder !== null}
        onClose={() => setNewFolder(null)}
        title="New folder"
        footer={
          <Button variant="primary" onClick={createNewFolder} disabled={!newFolder?.trim()}>
            Create
          </Button>
        }
      >
        <Input autoFocus value={newFolder ?? ''} onChange={(e) => setNewFolder(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createNewFolder()} placeholder="Folder name" />
      </Modal>

      <Modal
        open={Boolean(confirmTrash)}
        onClose={() => setConfirmTrash(null)}
        title="Move to Drive trash?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmTrash(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => confirmTrash && doTrash(confirmTrash)}>
              Move to trash
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          {confirmTrash?.length === 1 ? `“${confirmTrash[0].name}”` : `${confirmTrash?.length} items`} will be moved to Google Drive’s trash. You can restore
          from drive.google.com within 30 days.
        </p>
      </Modal>

      <Modal
        open={Boolean(preview)}
        onClose={() => {
          if (preview) URL.revokeObjectURL(preview.url);
          setPreview(null);
        }}
        title={preview?.name}
        wide
      >
        {preview && <img src={preview.url} alt={preview.name} className="checker mx-auto max-h-[75dvh] rounded-lg object-contain" />}
      </Modal>
    </div>
  );
}

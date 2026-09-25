'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, FolderPlus, FolderOpen } from 'lucide-react';
import type { DriveFile } from '@/lib/drive';
import { createProject, listProjects, openProject } from '@/lib/projects';
import { useSession, useSettings } from '@/lib/store';
import { errorMessage, formatDate } from '@/lib/utils';
import { Button, Input, Modal, Spinner } from './ui';

export async function selectProject(folderId: string) {
  const { set, toast } = useSession.getState();
  set({ projectLoading: true });
  try {
    const project = await openProject(folderId);
    set({ project, script: null, scriptFileId: null });
    useSettings.getState().update({ lastProjectId: project.id });
    return project;
  } catch (err) {
    toast(errorMessage(err), 'error');
    throw err;
  } finally {
    set({ projectLoading: false });
  }
}

export default function ProjectPicker() {
  const project = useSession((s) => s.project);
  const loading = useSession((s) => s.projectLoading);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex max-w-full items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-1.5 text-left hover:border-zinc-700"
      >
        {project?.meta.coverImage ? (
          <img src={project.meta.coverImage} alt="" className="h-7 w-5 shrink-0 rounded object-cover" />
        ) : (
          <FolderOpen className="size-4 shrink-0 text-violet-400" />
        )}
        <span className="min-w-0">
          <span className="block text-[10px] uppercase tracking-wide text-zinc-500">Project</span>
          <span className="block truncate text-sm text-zinc-100">{loading ? 'Opening…' : project?.name ?? 'Select a project'}</span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-zinc-500" />
      </button>
      <ProjectDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function ProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projectsId = useSession((s) => s.projectsId);
  const current = useSession((s) => s.project);
  const [items, setItems] = useState<DriveFile[] | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!projectsId) return;
    setItems(null);
    try {
      setItems(await listProjects(projectsId));
    } catch (err) {
      useSession.getState().toast(errorMessage(err), 'error');
      setItems([]);
    }
  }, [projectsId]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const pick = async (id: string) => {
    setBusy(true);
    try {
      await selectProject(id);
      onClose();
    } catch {
      /* toast shown */
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!projectsId || !title.trim()) return;
    setBusy(true);
    try {
      const p = await createProject(projectsId, { title: title.trim() });
      await selectProject(p.id);
      setTitle('');
      useSession.getState().toast(`Project “${p.name}” is ready in Drive.`, 'success');
      onClose();
    } catch (err) {
      useSession.getState().toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Projects">
      <div className="mb-4 flex gap-2">
        <Input placeholder="New project title (e.g. Solo Leveling Ch. 1-10)" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} />
        <Button variant="primary" onClick={create} loading={busy} disabled={!title.trim()} icon={<FolderPlus className="size-4" />}>
          Create
        </Button>
      </div>
      <p className="mb-3 text-xs text-zinc-500">Tip: the Discover page creates projects pre-filled with cover art and synopsis.</p>
      {items === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-sm text-zinc-500">No projects yet.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
          {items.map((f) => (
            <li key={f.id}>
              <button
                disabled={busy}
                onClick={() => pick(f.id)}
                className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/60 disabled:opacity-50"
              >
                <FolderOpen className="size-4 text-violet-400" />
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                {current?.id === f.id && <span className="text-[11px] text-violet-300">current</span>}
                <span className="text-[11px] text-zinc-500">{formatDate(f.modifiedTime)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

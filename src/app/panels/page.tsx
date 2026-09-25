'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { DndContext, DragEndEvent, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowUpDown, ArrowLeft, ArrowRight, GripVertical, RefreshCw, Save, Trash2 } from 'lucide-react';
import { DriveFile, trashFile } from '@/lib/drive';
import { evictPanel, getPanelUrl } from '@/lib/panelCache';
import { listOrderedPanels } from '@/lib/panels';
import { Project, patchProject } from '@/lib/projects';
import { useSession } from '@/lib/store';
import { cn, errorMessage, naturalCompare, pool } from '@/lib/utils';
import { Badge, Button, Card, EmptyState, Modal, PageHeader, Spinner } from '@/components/ui';
import RequireProject from '@/components/RequireProject';

export default function PanelsPage() {
  return (
    <div>
      <PageHeader title="Sliced panels" description="Drag the grip handle to reorder (works with touch), remove bad panels, then save the order. The composer uses this order." />
      <RequireProject>{(project) => <PanelGrid key={project.id} project={project} />}</RequireProject>
    </div>
  );
}

function PanelGrid({ project }: { project: Project }) {
  const toast = useSession((s) => s.toast);
  const [items, setItems] = useState<DriveFile[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [lightbox, setLightbox] = useState<DriveFile | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);

  const load = useCallback(async () => {
    setItems(null);
    setDirty(false);
    setSelected(new Set());
    try {
      setItems(await listOrderedPanels(project));
    } catch (err) {
      toast(errorMessage(err), 'error');
      setItems([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, project.folders.panels]);

  useEffect(() => {
    load();
  }, [load]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!items || !over || active.id === over.id) return;
    const from = items.findIndex((x) => x.id === active.id);
    const to = items.findIndex((x) => x.id === over.id);
    setItems(arrayMove(items, from, to));
    setDirty(true);
  };

  const move = (i: number, d: -1 | 1) => {
    if (!items) return;
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    setItems(arrayMove(items, i, j));
    setDirty(true);
  };

  const saveOrder = async () => {
    if (!items) return;
    setSaving(true);
    try {
      await patchProject({ panelOrder: items.map((x) => x.id) });
      setDirty(false);
      toast('Panel order saved to project.json', 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async (ids: string[]) => {
    setConfirmDelete(null);
    try {
      await pool(ids, 4, (id) => trashFile(id));
      ids.forEach(evictPanel);
      const remaining = (items ?? []).filter((x) => !ids.includes(x.id));
      setItems(remaining);
      setSelected(new Set());
      await patchProject({ panelOrder: remaining.map((x) => x.id) });
      setDirty(false);
      toast(`Moved ${ids.length} panel(s) to Drive trash.`, 'success');
    } catch (err) {
      toast(errorMessage(err), 'error');
    }
  };

  if (items === null)
    return (
      <div className="flex justify-center py-20">
        <Spinner />
      </div>
    );

  if (!items.length)
    return (
      <EmptyState
        title="No panels yet"
        action={
          <Link href="/slicer">
            <Button variant="primary">Open the slicer</Button>
          </Link>
        }
      >
        Slice a chapter to fill this project’s “Sliced Panels” folder.
      </EmptyState>
    );

  return (
    <Card
      title={`${items.length} panels`}
      subtitle={dirty ? 'Unsaved order changes' : 'Order is saved'}
      actions={
        <>
          {selected.size > 0 && (
            <Button size="sm" variant="danger" icon={<Trash2 className="size-3.5" />} onClick={() => setConfirmDelete([...selected])}>
              Delete {selected.size}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<ArrowUpDown className="size-3.5" />}
            onClick={() => {
              setItems([...items].sort((a, b) => naturalCompare(a.name, b.name)));
              setDirty(true);
            }}
          >
            Sort by name
          </Button>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="size-3.5" />} onClick={load}>
            Reload
          </Button>
          <Button size="sm" variant="primary" icon={<Save className="size-3.5" />} disabled={!dirty} loading={saving} onClick={saveOrder}>
            Save order
          </Button>
        </>
      }
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={items.map((x) => x.id)} strategy={rectSortingStrategy}>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8">
            {items.map((f, i) => (
              <SortablePanel
                key={f.id}
                file={f}
                index={i}
                selected={selected.has(f.id)}
                onToggle={() =>
                  setSelected((s) => {
                    const n = new Set(s);
                    if (n.has(f.id)) n.delete(f.id);
                    else n.add(f.id);
                    return n;
                  })
                }
                onOpen={() => setLightbox(f)}
                onMove={(d) => move(i, d)}
                onDelete={() => setConfirmDelete([f.id])}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      <Modal open={Boolean(lightbox)} onClose={() => setLightbox(null)} title={lightbox?.name} wide>
        {lightbox && <PanelImage id={lightbox.id} className="checker mx-auto max-h-[78dvh] object-contain" />}
      </Modal>
      <Modal
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title="Delete panels?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => confirmDelete && doDelete(confirmDelete)}>
              Move to trash
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">{confirmDelete?.length} panel(s) will be moved to Google Drive’s trash (restorable for 30 days).</p>
      </Modal>
    </Card>
  );
}

function PanelImage({ id, className }: { id: string; className?: string }) {
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
  return url ? <img src={url} alt="" className={className} draggable={false} /> : <div className={cn('flex items-center justify-center', className)}><Spinner className="size-4" /></div>;
}

function SortablePanel({
  file,
  index,
  selected,
  onToggle,
  onOpen,
  onMove,
  onDelete,
}: {
  file: DriveFile;
  index: number;
  selected: boolean;
  onToggle: () => void;
  onOpen: () => void;
  onMove: (d: -1 | 1) => void;
  onDelete: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: file.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 20 : undefined }}
      className={cn(
        'relative overflow-hidden rounded-lg border bg-zinc-950',
        selected ? 'border-violet-500 ring-2 ring-violet-500/30' : 'border-zinc-800',
        isDragging && 'opacity-80 shadow-2xl',
      )}
    >
      <button className="block w-full" onClick={onOpen}>
        <PanelImage id={file.id} className="aspect-[3/4] w-full object-cover object-top" />
      </button>
      <div className="absolute top-1 left-1 flex items-center gap-1">
        <Badge className="bg-black/75">{index + 1}</Badge>
      </div>
      <input type="checkbox" checked={selected} onChange={onToggle} className="absolute top-1.5 right-1.5 size-4 accent-violet-500" aria-label="Select panel" />
      <div className="flex items-center justify-between border-t border-zinc-800 px-1 py-0.5">
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          style={{ touchAction: 'none' }}
          className="cursor-grab rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white active:cursor-grabbing"
          aria-label="Drag to reorder"
        >
          <GripVertical className="size-4" />
        </button>
        <div className="flex">
          <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white" onClick={() => onMove(-1)} aria-label="Move earlier">
            <ArrowLeft className="size-3.5" />
          </button>
          <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-white" onClick={() => onMove(1)} aria-label="Move later">
            <ArrowRight className="size-3.5" />
          </button>
          <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-300" onClick={onDelete} aria-label="Delete panel">
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

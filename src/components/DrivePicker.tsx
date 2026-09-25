'use client';

import { useEffect, useState } from 'react';
import { ChevronRight, Folder } from 'lucide-react';
import { DriveFile, isFolder, listChildren } from '@/lib/drive';
import { useSession } from '@/lib/store';
import { cn, errorMessage, formatBytes, formatDate } from '@/lib/utils';
import { Button, Modal, Spinner } from './ui';
import { FileIcon } from './FileIcon';

export interface Crumb {
  id: string;
  name: string;
}

/** Modal for choosing Drive files, starting from a given folder. */
export default function DrivePicker({
  open,
  onClose,
  start,
  title = 'Choose from Google Drive',
  accept,
  multiple,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  start: Crumb[];
  title?: string;
  accept: (f: DriveFile) => boolean;
  multiple?: boolean;
  onPick: (files: DriveFile[]) => void;
}) {
  const [crumbs, setCrumbs] = useState<Crumb[]>(start);
  const [items, setItems] = useState<DriveFile[] | null>(null);
  const [selected, setSelected] = useState<Map<string, DriveFile>>(new Map());

  useEffect(() => {
    if (open) {
      setCrumbs(start);
      setSelected(new Map());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const current = crumbs[crumbs.length - 1];

  useEffect(() => {
    if (!open || !current) return;
    let alive = true;
    setItems(null);
    listChildren(current.id)
      .then((files) => alive && setItems(files.filter((f) => isFolder(f) || accept(f))))
      .catch((err) => {
        useSession.getState().toast(errorMessage(err), 'error');
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, current?.id]);

  const toggle = (f: DriveFile) => {
    if (!multiple) {
      onPick([f]);
      onClose();
      return;
    }
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(f.id)) next.delete(f.id);
      else next.set(f.id, f);
      return next;
    });
  };

  const selectableHere = (items ?? []).filter((f) => !isFolder(f));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        multiple ? (
          <>
            {selectableHere.length > 1 && (
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Map(selectableHere.map((f) => [f.id, f])))}>
                Select all here
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!selected.size}
              onClick={() => {
                onPick([...selected.values()]);
                onClose();
              }}
            >
              Use {selected.size || ''} selected
            </Button>
          </>
        ) : undefined
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-zinc-400">
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            {i > 0 && <ChevronRight className="size-3" />}
            <button className="rounded px-1 py-0.5 hover:bg-zinc-800 hover:text-white" onClick={() => setCrumbs(crumbs.slice(0, i + 1))}>
              {c.name}
            </button>
          </span>
        ))}
      </div>
      {items === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-sm text-zinc-500">Nothing suitable in this folder.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 overflow-hidden rounded-xl border border-zinc-800">
          {items.map((f) => (
            <li key={f.id}>
              <button
                onClick={() => (isFolder(f) ? setCrumbs([...crumbs, { id: f.id, name: f.name }]) : toggle(f))}
                className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-zinc-800/60', selected.has(f.id) && 'bg-violet-600/15')}
              >
                {isFolder(f) ? <Folder className="size-4 text-amber-300" /> : <FileIcon file={f} />}
                <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                {!isFolder(f) && <span className="hidden text-[11px] text-zinc-500 sm:inline">{formatBytes(f.size)}</span>}
                <span className="hidden text-[11px] text-zinc-500 sm:inline">{formatDate(f.modifiedTime)}</span>
                {multiple && !isFolder(f) && (
                  <span className={cn('size-4 rounded border', selected.has(f.id) ? 'border-violet-400 bg-violet-500' : 'border-zinc-600')} />
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

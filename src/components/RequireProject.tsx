'use client';

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { FolderOpen, HardDrive } from 'lucide-react';
import { signIn } from '@/lib/auth';
import type { Project } from '@/lib/projects';
import { useSession } from '@/lib/store';
import { errorMessage } from '@/lib/utils';
import { Button, EmptyState, Spinner } from './ui';
import { ProjectDialog } from './ProjectPicker';

/** Gate for pages that need Drive (and optionally a selected project). */
export function RequireDrive({ children }: { children: ReactNode }) {
  const token = useSession((s) => s.token);
  const rootId = useSession((s) => s.rootId);
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <EmptyState
        icon={<HardDrive className="size-10" />}
        title="Connect Google Drive"
        action={
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await signIn();
              } catch (err) {
                useSession.getState().toast(errorMessage(err), 'error');
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign in with Google
          </Button>
        }
      >
        Everything you upload and create is stored in a “Manhwa Recap Studio” folder in your Google Drive.{' '}
        <Link href="/settings" className="text-violet-300 underline">
          Settings
        </Link>{' '}
        needs your OAuth Client ID first.
      </EmptyState>
    );
  }
  if (!rootId) {
    return (
      <div className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-400">
        <Spinner /> Preparing your Drive folder…
      </div>
    );
  }
  return <>{children}</>;
}

export default function RequireProject({ children }: { children: (project: Project) => ReactNode }) {
  const project = useSession((s) => s.project);
  const loading = useSession((s) => s.projectLoading);
  const [open, setOpen] = useState(false);

  return (
    <RequireDrive>
      {project ? (
        children(project)
      ) : loading ? (
        <div className="flex items-center justify-center gap-3 py-16 text-sm text-zinc-400">
          <Spinner /> Opening project…
        </div>
      ) : (
        <>
          <EmptyState
            icon={<FolderOpen className="size-10" />}
            title="Pick a project"
            action={
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" onClick={() => setOpen(true)}>
                  Open or create project
                </Button>
                <Link href="/discover">
                  <Button>Browse manhwa</Button>
                </Link>
              </div>
            }
          >
            Each project is a folder in Drive holding its source files, scripts, sliced panels, audio and exports.
          </EmptyState>
          <ProjectDialog open={open} onClose={() => setOpen(false)} />
        </>
      )}
    </RequireDrive>
  );
}

/**
 * Drive layout:
 *   Manhwa Recap Studio/
 *     Projects/
 *       <Series title>/
 *         project.json      ← metadata + panel order (acts as the "database")
 *         Source/           ← original .cbz/.zip/.jpg uploads
 *         Scripts/          ← generated scripts (.json + .txt)
 *         Sliced Panels/    ← output of the panel slicer
 *         Audio/            ← narration .mp3 + timeline .json
 *         Final Exports/    ← rendered .mp4 videos
 */
import { DriveFile, FOLDER_MIME, downloadJson, ensureFolder, getFile, listChildren, saveJson } from './drive';
import { useSession } from './store';
import { sanitizeName } from './utils';

export const ROOT_FOLDER_NAME = 'Manhwa Recap Studio';
export const PROJECTS_FOLDER_NAME = 'Projects';
export const PROJECT_FILE = 'project.json';

export const SUBFOLDERS = {
  source: 'Source',
  scripts: 'Scripts',
  panels: 'Sliced Panels',
  audio: 'Audio',
  exports: 'Final Exports',
} as const;
export type SubfolderKey = keyof typeof SUBFOLDERS;

export interface ProjectMeta {
  app: 'manhwa-recap-studio';
  version: 1;
  title: string;
  anilistId?: number;
  coverImage?: string;
  bannerImage?: string;
  synopsis?: string;
  genres?: string[];
  siteUrl?: string;
  createdAt: string;
  updatedAt: string;
  /** Drive file IDs of sliced panels, in video order. */
  panelOrder: string[];
  /** Per-panel Ken Burns effect overrides. */
  panelEffects: Record<string, string>;
  activeScriptFileId?: string;
  narrationFileId?: string;
  timelineFileId?: string;
  lastExportFileId?: string;
}

export interface Project {
  id: string;
  name: string;
  meta: ProjectMeta;
  metaFileId: string | null;
  folders: Record<SubfolderKey, string>;
}

function defaultMeta(title: string): ProjectMeta {
  const now = new Date().toISOString();
  return { app: 'manhwa-recap-studio', version: 1, title, createdAt: now, updatedAt: now, panelOrder: [], panelEffects: {} };
}

export async function ensureRoot(): Promise<{ rootId: string; projectsId: string }> {
  const rootId = await ensureFolder(ROOT_FOLDER_NAME, 'root');
  const projectsId = await ensureFolder(PROJECTS_FOLDER_NAME, rootId);
  return { rootId, projectsId };
}

export function listProjects(projectsId: string): Promise<DriveFile[]> {
  return listChildren(projectsId, { foldersOnly: true, orderBy: 'modifiedTime desc' });
}

export async function openProject(folderId: string): Promise<Project> {
  const [folder, entries] = await Promise.all([getFile(folderId), listChildren(folderId)]);
  if (folder.mimeType !== FOLDER_MIME) throw new Error('That item is not a project folder.');

  const folders = {} as Record<SubfolderKey, string>;
  await Promise.all(
    (Object.keys(SUBFOLDERS) as SubfolderKey[]).map(async (key) => {
      const existing = entries.find((e) => e.name === SUBFOLDERS[key] && e.mimeType === FOLDER_MIME);
      folders[key] = existing ? existing.id : await ensureFolder(SUBFOLDERS[key], folderId);
    }),
  );

  const metaFile = entries.find((e) => e.name === PROJECT_FILE && e.mimeType !== FOLDER_MIME);
  let meta = defaultMeta(folder.name);
  if (metaFile) {
    try {
      meta = { ...meta, ...(await downloadJson<Partial<ProjectMeta>>(metaFile.id)) };
    } catch {
      /* corrupt project.json — start fresh but keep the file id so we overwrite it */
    }
  }
  const project: Project = { id: folderId, name: folder.name, meta, metaFileId: metaFile?.id ?? null, folders };
  return metaFile ? project : saveProjectMeta(project, {});
}

export async function createProject(projectsId: string, init: Partial<ProjectMeta> & { title: string }): Promise<Project> {
  const folderId = await ensureFolder(sanitizeName(init.title), projectsId);
  const project = await openProject(folderId);
  const patch: Partial<ProjectMeta> = {};
  const keys = ['anilistId', 'coverImage', 'bannerImage', 'synopsis', 'genres', 'siteUrl'] as const;
  for (const k of keys) {
    if (init[k] !== undefined && project.meta[k] === undefined) (patch as Record<string, unknown>)[k] = init[k];
  }
  return Object.keys(patch).length ? saveProjectMeta(project, patch) : project;
}

export async function saveProjectMeta(project: Project, patch: Partial<ProjectMeta>): Promise<Project> {
  const meta: ProjectMeta = { ...project.meta, ...patch, updatedAt: new Date().toISOString() };
  const file = await saveJson(project.id, PROJECT_FILE, meta, project.metaFileId ?? undefined);
  return { ...project, meta, metaFileId: file.id };
}

let patchChain: Promise<unknown> = Promise.resolve();

/** Update the current project's metadata. Calls are serialised so concurrent edits don't clobber each other. */
export function patchProject(patch: Partial<ProjectMeta>): Promise<Project> {
  const run = patchChain.then(async () => {
    const current = useSession.getState().project;
    if (!current) throw new Error('No project selected.');
    const next = await saveProjectMeta(current, patch);
    // Only apply if the user hasn't switched project in the meantime.
    if (useSession.getState().project?.id === next.id) useSession.getState().set({ project: next });
    return next;
  });
  patchChain = run.catch(() => undefined);
  return run;
}

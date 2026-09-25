import { DriveFile, isImage, listChildren } from './drive';
import type { Project } from './projects';
import { naturalCompare } from './utils';

/** Panels in the project's saved order; panels missing from the order go last, by name. */
export async function listOrderedPanels(project: Project): Promise<DriveFile[]> {
  const files = (await listChildren(project.folders.panels)).filter(isImage);
  const pos = new Map(project.meta.panelOrder.map((id, i) => [id, i]));
  return files.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9) || naturalCompare(a.name, b.name));
}

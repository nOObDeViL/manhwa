/** Browser-side .cbz / .zip extraction with JSZip. */
import { mimeFromName, naturalCompare } from './utils';

export interface SourceImage {
  name: string;
  blob: Blob;
}

const IMAGE_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

export async function extractImagesFromZip(data: Blob, onProgress?: (fraction: number) => void): Promise<SourceImage[]> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(data);
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && IMAGE_RE.test(f.name) && !f.name.startsWith('__MACOSX/') && !/(^|\/)\._/.test(f.name),
  );
  entries.sort((a, b) => naturalCompare(a.name, b.name));
  if (!entries.length) throw new Error('No images found inside the archive.');

  const out: SourceImage[] = [];
  for (let i = 0; i < entries.length; i++) {
    const raw = await entries[i].async('blob');
    out.push({ name: entries[i].name.split('/').pop() || entries[i].name, blob: new Blob([raw], { type: mimeFromName(entries[i].name) }) });
    onProgress?.((i + 1) / entries.length);
  }
  return out;
}

export function isArchiveName(name: string) {
  return /\.(cbz|zip)$/i.test(name);
}

export function isImageName(name: string) {
  return IMAGE_RE.test(name);
}

import { File, FileArchive, FileAudio, FileJson, FileText, FileVideo, Folder, ImageIcon } from 'lucide-react';
import { DriveFile, isArchive, isAudio, isFolder, isImage, isJson } from '@/lib/drive';

export function FileIcon({ file, className = 'size-4' }: { file: DriveFile; className?: string }) {
  if (isFolder(file)) return <Folder className={`${className} text-amber-300`} />;
  if (isArchive(file)) return <FileArchive className={`${className} text-fuchsia-300`} />;
  if (isImage(file)) return <ImageIcon className={`${className} text-sky-300`} />;
  if (isAudio(file)) return <FileAudio className={`${className} text-emerald-300`} />;
  if (file.mimeType.startsWith('video/') || /\.mp4$/i.test(file.name)) return <FileVideo className={`${className} text-rose-300`} />;
  if (isJson(file)) return <FileJson className={`${className} text-yellow-200`} />;
  if (file.mimeType.startsWith('text/')) return <FileText className={`${className} text-zinc-300`} />;
  return <File className={`${className} text-zinc-400`} />;
}

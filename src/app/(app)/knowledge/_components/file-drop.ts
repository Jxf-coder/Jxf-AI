/** 拖拽 / 选文件夹时把文件摊平成 { file, path } 列表（递归目录，最多 limit 个） */

export interface DroppedFile {
  file: File;
  path: string;
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath?: string;
  file?: (ok: (file: File) => void, err: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (ok: (entries: FsEntry[]) => void, err: (error: unknown) => void) => void;
  };
}

async function walk(entry: FsEntry, prefix: string, out: DroppedFile[], limit: number): Promise<void> {
  if (out.length >= limit) {
    return;
  }

  if (entry.isFile && entry.file) {
    const file = await new Promise<File | null>((resolve) => {
      entry.file?.(resolve, () => resolve(null));
    });
    if (file) {
      out.push({ file, path: `${prefix}${entry.name}` });
    }
    return;
  }

  if (entry.isDirectory && entry.createReader) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise<FsEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) {
        break;
      }
      for (const child of batch) {
        await walk(child, `${prefix}${entry.name}/`, out, limit);
        if (out.length >= limit) {
          return;
        }
      }
    }
  }
}

export async function filesFromDataTransfer(dataTransfer: DataTransfer, limit = 200): Promise<DroppedFile[]> {
  const out: DroppedFile[] = [];
  const items = Array.from(dataTransfer.items ?? []);
  const entries = items.map((item) => {
    const withEntry = item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null };
    return withEntry.webkitGetAsEntry?.() ?? null;
  });

  if (entries.some(Boolean)) {
    for (const entry of entries) {
      if (entry) {
        await walk(entry, "", out, limit);
      }
      if (out.length >= limit) {
        break;
      }
    }
    return out;
  }

  for (const file of Array.from(dataTransfer.files ?? [])) {
    out.push({ file, path: file.name });
    if (out.length >= limit) {
      break;
    }
  }
  return out;
}

/** <input type="file" multiple> / webkitdirectory 的结果 */
export function filesFromInput(files: FileList | null, limit = 200): DroppedFile[] {
  if (!files) {
    return [];
  }
  return Array.from(files)
    .slice(0, limit)
    .map((file) => ({
      file,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    }));
}

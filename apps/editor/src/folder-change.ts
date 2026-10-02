export const FOLDER_PATH_MIME = "application/x-mdbase-folder-path";

export interface FolderChangePlan {
  from: string;
  to: string;
  moves: Array<{ from: string; to: string }>;
  referenceCount: number;
  warnings: string[];
  collectionId?: string;
  epoch: number;
}
export interface FolderChangeProgress {
  completed: number;
  total: number;
  path: string;
  detail?: string;
}
export interface FolderChangeResult {
  moved: number;
  failures: Array<{ path: string; message: string }>;
  warnings?: string[];
}

export function folderChangeMoves(from: string, to: string, paths: readonly string[], filePaths: readonly string[]) {
  if (!validFolderPath(from) || !validFolderPath(to)) throw new Error("Use a collection-relative folder path without empty, . or .. segments.");
  if (from === to) throw new Error("Choose a different folder path.");
  if (to.startsWith(`${from}/`)) throw new Error("A folder cannot be moved inside itself.");
  if (filePaths.some((path) => path.startsWith(`${from}/`))) {
    throw new Error("This folder contains attachments. Moving them cannot yet preserve embedded file references. Move the notes individually instead; attachments will stay in place.");
  }
  const moves = paths.filter((path) => path.startsWith(`${from}/`))
    .map((path) => ({ from: path, to: `${to}${path.slice(from.length)}` }));
  if (!moves.length) throw new Error("There are no notes to move in this folder.");
  const occupied = new Set([...paths, ...filePaths]);
  if (occupied.has(to) || [...occupied].some((path) => path.startsWith(`${to}/`) && !path.startsWith(`${from}/`))) {
    throw new Error(`The destination folder “${to}” already exists. Choose another name or move its notes individually; folders are not merged automatically.`);
  }
  for (const move of moves) {
    if (occupied.has(move.to)) throw new Error(`A note or file already uses “${move.to}”. Nothing has moved.`);
  }
  return moves;
}

export function validFolderPath(path: string): boolean {
  return !!path && !path.includes("\\") && !/[\u0000-\u001f]/.test(path)
    && path.split("/").every((part) => !!part.trim() && part !== "." && part !== "..");
}

export function readNoteDragPaths(value: string): string[] {
  try {
    const paths: unknown = JSON.parse(value);
    return Array.isArray(paths) && paths.length > 0 && paths.every((path) => typeof path === "string" && path.toLocaleLowerCase().endsWith(".md") && validFolderPath(path))
      ? [...new Set(paths as string[])] : [];
  } catch { return []; }
}

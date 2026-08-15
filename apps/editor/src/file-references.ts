import { markdownReferences, type MarkdownReferenceFormat } from "./markdown-references";
import type { CollectionFile } from "./model";

export interface FileReference {
  from: number;
  to: number;
  target: string;
  label?: string;
  anchor?: string;
  format: MarkdownReferenceFormat;
  block: boolean;
  file?: CollectionFile;
}

/**
 * Resolves parsed embeds only against authority-provided file descriptors.
 */
export function fileReferences(
  source: string,
  files: readonly CollectionFile[],
  sourcePath?: string
): FileReference[] {
  return markdownReferences(source)
    .filter((reference) => reference.kind === "embed")
    .map(({ kind: _kind, ...reference }) => ({
      ...reference,
      file: resolveFileReference(reference.target, reference.format, files, sourcePath)
    }));
}

export function resolveFileReference(
  target: string,
  format: FileReference["format"],
  files: readonly CollectionFile[],
  sourcePath?: string
): CollectionFile | undefined {
  const decoded = decodeTarget(target);
  if (!decoded || externalScheme(decoded)) return undefined;
  const exact = descriptorAt(files, normalizePath(decoded));
  if (exact) return exact;

  const sourceFolder = sourcePath?.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
  if (format === "markdown" || decoded.startsWith("./") || decoded.startsWith("../")) {
    const relative = normalizePath(sourceFolder ? `${sourceFolder}/${decoded}` : decoded);
    return relative ? descriptorAt(files, relative) : undefined;
  }

  if (decoded.includes("/")) {
    const relative = normalizePath(sourceFolder ? `${sourceFolder}/${decoded}` : decoded);
    if (relative) {
      const match = descriptorAt(files, relative);
      if (match) return match;
    }
  }

  const filename = identity(decoded.split("/").at(-1) ?? "");
  if (!filename) return undefined;
  const matches = files.filter((file) => identity(file.path.split("/").at(-1) ?? "") === filename);
  return matches.length === 1 ? matches[0] : undefined;
}

export function fileAssetKey(file: CollectionFile): string {
  return `${file.fileId}:${file.revision}`;
}

export function isInlinePreviewable(file: CollectionFile): boolean {
  return file.mediaClass === "image"
    || file.mediaClass === "pdf"
    || file.mediaClass === "audio"
    || file.mediaClass === "video"
    || isTextPreviewable(file);
}

export function isTextPreviewable(file: CollectionFile): boolean {
  return Boolean(file.mediaType?.startsWith("text/"))
    || /\.(?:txt|md|mdx|csv|tsv|json|ya?ml|toml|ini|log|xml|html?|css|[cm]?[jt]sx?|py|rs|go|java|kt|swift|sh|zsh|fish|sql)$/iu.test(file.path);
}

function decodeTarget(value: string): string {
  let decoded = value.trim().replace(/^<|>$/g, "");
  const delimiter = Math.min(...[decoded.indexOf("#"), decoded.indexOf("?")].filter((index) => index >= 0));
  if (Number.isFinite(delimiter)) decoded = decoded.slice(0, delimiter);
  try { decoded = decodeURIComponent(decoded); } catch { /* Literal percent signs remain usable. */ }
  return decoded.replaceAll("\\", "/").replace(/^\/+/, "");
}

function normalizePath(value: string): string | undefined {
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}

function descriptorAt(files: readonly CollectionFile[], path: string | undefined): CollectionFile | undefined {
  if (!path) return undefined;
  const key = identity(path);
  return files.find((file) => identity(file.path) === key);
}

function identity(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function externalScheme(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) || value.startsWith("//");
}

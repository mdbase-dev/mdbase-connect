import type { MarkdownReferenceFormat } from "./markdown-references";
import type { CollectionFile } from "./model";

export function resolveFileReference(
  target: string,
  format: MarkdownReferenceFormat,
  files: readonly CollectionFile[],
  sourcePath?: string
): CollectionFile | undefined {
  const decoded = decodeTarget(target);
  if (!decoded || externalScheme(decoded)) return undefined;
  const rootRelative = decoded.startsWith("/");
  const normalizedTarget = decoded.replace(/^\/+/, "");
  if (rootRelative) return descriptorAt(files, normalizePath(normalizedTarget));

  const sourceFolder = sourcePath?.includes("/")
    ? sourcePath.slice(0, sourcePath.lastIndexOf("/"))
    : "";
  if (format === "markdown" || decoded.startsWith("./") || decoded.startsWith("../")) {
    const relative = normalizePath(sourceFolder ? `${sourceFolder}/${decoded}` : decoded);
    const relativeMatch = relative ? descriptorAt(files, relative) : undefined;
    if (relativeMatch || decoded.startsWith("./") || decoded.startsWith("../")) return relativeMatch;
    // Retain collection-root Markdown destinations used by older Editor content.
    return descriptorAt(files, normalizePath(normalizedTarget));
  }

  const exact = descriptorAt(files, normalizePath(normalizedTarget));
  if (exact) return exact;

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
  return decoded.replaceAll("\\", "/");
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

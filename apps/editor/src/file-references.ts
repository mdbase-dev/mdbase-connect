import { markdownLanguage } from "@codemirror/lang-markdown";
import type { CollectionFile } from "./model";

export interface FileReference {
  from: number;
  to: number;
  target: string;
  label?: string;
  format: "wikilink" | "markdown";
  block: boolean;
  file?: CollectionFile;
}

/**
 * Parses embeds with the editor's Markdown grammar, then resolves only against
 * authority-provided file descriptors. Code spans and fenced code are ignored
 * by construction because they do not produce Image syntax nodes.
 */
export function fileReferences(
  source: string,
  files: readonly CollectionFile[],
  sourcePath?: string
): FileReference[] {
  const references: FileReference[] = [];
  const cursor = markdownLanguage.parser.parse(source).cursor();
  const visit = () => {
    if (cursor.name === "Image") {
      const raw = source.slice(cursor.from, cursor.to);
      const parsed = raw.startsWith("![[")
        ? parseWikiReference(raw)
        : parseMarkdownReference(source, cursor.from, cursor.to);
      if (parsed) {
        references.push({
          from: cursor.from,
          to: cursor.to,
          ...parsed,
          block: isBlockReference(source, cursor.from, cursor.to),
          file: resolveFileReference(parsed.target, parsed.format, files, sourcePath)
        });
      }
    }
    if (cursor.firstChild()) {
      do visit(); while (cursor.nextSibling());
      cursor.parent();
    }
  };
  visit();
  return references;
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
    || file.mediaClass === "video";
}

function parseWikiReference(raw: string): Pick<FileReference, "target" | "label" | "format"> | undefined {
  if (!raw.endsWith("]]")) return undefined;
  const [rawTarget, rawLabel] = raw.slice(3, -2).split("|", 2);
  const target = rawTarget.split("#", 1)[0]?.trim();
  if (!target) return undefined;
  const label = rawLabel?.trim();
  return { target, ...(label ? { label } : {}), format: "wikilink" };
}

function parseMarkdownReference(
  source: string,
  from: number,
  to: number
): Pick<FileReference, "target" | "label" | "format"> | undefined {
  const node = markdownLanguage.parser.parse(source.slice(from, to)).topNode;
  let image = node.getChild("Paragraph")?.getChild("Image") ?? node.getChild("Image");
  if (!image) return undefined;
  const url = image.getChild("URL");
  if (!url) return undefined;
  const raw = source.slice(from, to);
  const target = source.slice(from + url.from, from + url.to).replace(/^<|>$/g, "").trim();
  if (!target) return undefined;
  const close = raw.indexOf("](");
  const label = close >= 2 ? raw.slice(2, close).replaceAll("\\]", "]").trim() : "";
  return { target, ...(label ? { label } : {}), format: "markdown" };
}

function isBlockReference(source: string, from: number, to: number): boolean {
  const lineStart = source.lastIndexOf("\n", Math.max(0, from - 1)) + 1;
  const lineEndIndex = source.indexOf("\n", to);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  return source.slice(lineStart, from).trim() === "" && source.slice(to, lineEnd).trim() === "";
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

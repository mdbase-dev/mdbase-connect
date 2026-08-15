import { markdownReferences, type MarkdownReferenceFormat } from "./markdown-references";
import { resolveFileReference } from "./file-reference-resolution";
import type { CollectionFile } from "./model";

export {
  fileAssetKey,
  isInlinePreviewable,
  isTextPreviewable,
  resolveFileReference
} from "./file-reference-resolution";

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

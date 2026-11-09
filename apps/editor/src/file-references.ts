import type { LinkTargets } from "./collection-links";
import { markdownReferences, type MarkdownReferenceFormat } from "./markdown-references";
import type { CollectionFile } from "./model";

export {
  fileAssetKey,
  isInlinePreviewable,
  isTextPreviewable
} from "./file-reference-resolution";

export interface FileReference {
  from: number;
  to: number;
  /** The embed as written, which the collection resolves. */
  raw: string;
  target: string;
  label?: string;
  anchor?: string;
  format: MarkdownReferenceFormat;
  block: boolean;
  file?: CollectionFile;
}

/**
 * Embeds in `source` with the listed file each one leads to, once the
 * collection has resolved it.
 */
export function fileReferences(
  source: string,
  files: readonly CollectionFile[],
  linkTargets: LinkTargets | undefined
): FileReference[] {
  return markdownReferences(source)
    .filter((reference) => reference.kind === "embed" && reference.target)
    .map(({ kind: _kind, ...reference }) => {
      const raw = source.slice(reference.from, reference.to);
      const target = linkTargets?.get(raw);
      const file = target?.kind === "file" ? files.find((candidate) => candidate.path === target.path) : undefined;
      return { ...reference, raw, ...(file ? { file } : {}) };
    });
}

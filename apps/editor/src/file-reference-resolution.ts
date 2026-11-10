import type { CollectionFile } from "./model";

export function fileAssetKey(file: CollectionFile): string {
  // A digest alone is not selection identity: profiles and confirmations can
  // change without new bytes, and IDs may be reused at a different path.
  return JSON.stringify([file.fileId, file.revision, file.contentDigest, file.path,
    file.size, file.contentProfile, file.confirmedSeq, file.mediaClass,
    file.mediaType, file.modifiedAt]);
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

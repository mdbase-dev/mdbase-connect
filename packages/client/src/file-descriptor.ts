import type { CollectionFileDescriptor as WireFile } from "@mdbase-dev/connect-protocol";

export interface CollectionFileDescriptor {
  fileId: string;
  path: string;
  revision: string;
  contentDigest: `sha256:${string}`;
  size: number;
  mediaType?: string;
  mediaClass: import("@mdbase-dev/connect-protocol").FileMediaClass;
  modifiedAt: string;
}

export function clientFileDescriptor(file: WireFile): CollectionFileDescriptor {
  return {
    fileId: file.file_id,
    path: file.path,
    revision: file.revision,
    contentDigest: file.content_digest,
    size: file.size,
    ...(file.media_type ? { mediaType: file.media_type } : {}),
    mediaClass: file.media_class,
    modifiedAt: file.modified_at
  };
}

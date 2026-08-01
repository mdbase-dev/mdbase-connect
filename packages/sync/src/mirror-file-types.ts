/** Exact local metadata used to compare a materialized binary safely. */
export interface MirrorBinaryInfo {
  size: number;
  content_digest: `sha256:${string}`;
}

/** Private, content-addressed cache outside the collection namespace. */
export interface MirrorBlobStore {
  has(contentDigest: `sha256:${string}`): Promise<boolean>;
  read(contentDigest: `sha256:${string}`): AsyncIterable<Uint8Array>;
  /** Atomic: a failed or partially consumed source must not become visible. */
  write(contentDigest: `sha256:${string}`, source: AsyncIterable<Uint8Array>): Promise<void>;
  remove(contentDigest: `sha256:${string}`): Promise<void>;
  /** Remove complete cached blobs not referenced by durable mirror state. */
  prune(retained: ReadonlySet<`sha256:${string}`>): Promise<void>;
}

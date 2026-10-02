import type {
  MdbaseConnection, MdbaseFileStatTarget, QueryMetadataInput, QueryMetadataRecord,
  QueryMetadataResult, RecordDocument, QueryRecord, QueryPage, QueryPagesOptions, JsonObject
} from "@mdbase-dev/connect";
import type { MdbaseCollectionClient } from "@mdbase-dev/connect/advanced";

const metadata: QueryMetadataInput = { output: "metadata", select: ["file.path"], includeBody: false };
const fileTarget: MdbaseFileStatTarget = { path: "Assets/book.pdf" };
// @ts-expect-error stat requires exactly one target.
const ambiguous: MdbaseFileStatTarget = { path: "Assets/book.pdf", fileId: "uuid" };
// @ts-expect-error metadata cannot include a body.
const bodyMetadata: QueryMetadataInput = { output: "metadata", includeBody: true };
// @ts-expect-error metadata requires an exact-source revision.
const incomplete: QueryMetadataRecord = { path: "a.md", types: [], values: {} };
void ambiguous; void bodyMetadata; void incomplete;

export async function compileFeatureCalls(connection: MdbaseConnection, client: MdbaseCollectionClient) {
  const supported = await connection.supportsAuthorityFeature("query-metadata-v1");
  if (!supported.ok || !supported.value) return;
  const result = await connection.query(metadata);
  if (result.ok) {
    const narrow: QueryMetadataResult = result.value;
    const row: QueryMetadataRecord | undefined = narrow.results[0];
    if (row) {
      const revision: string = row.revision;
      // @ts-expect-error a partial row is never a RecordDocument.
      const document: RecordDocument = row;
      // @ts-expect-error a partial row is not a normal query record.
      const ordinary: QueryRecord = row;
      // @ts-expect-error metadata omits frontmatter, not an empty map.
      void row.frontmatter;
      void revision; void document; void ordinary;
    }
  }
  for await (const page of connection.queryPages(metadata, { onProgress: page => {
    const revision: string | undefined = page.results[0]?.revision;
    void revision;
  } })) {
    if (page.ok) { const mode: "metadata" = page.value.output; void mode; }
  }
  const all = await connection.queryAll(metadata);
  if (all.ok) { const mode: "metadata" = all.value.output; void mode; }
  const metadataProgress: QueryPagesOptions<JsonObject, QueryMetadataRecord> = {
    onProgress: page => { const revision: string = page.results[0].revision; void revision; }
  };
  // @ts-expect-error ordinary queries cannot promise revision-required metadata callbacks.
  client.queryPages({}, metadataProgress);
  // @ts-expect-error metadata callbacks cannot assume full query record file facts.
  client.queryPages(metadata, { onProgress: (page: QueryPage) => { void page.results[0].file; } });
  const advanced = await client.query(metadata);
  if (advanced.ok) { const mode: "metadata" = advanced.value.output; void mode; }
  const stat = await connection.files.stat(fileTarget, { timeoutMs: 10_000 });
  if (stat.ok) void stat.value?.fileId;
  const features: readonly string[] = connection.authorityCapabilities;
  // @ts-expect-error connection capabilities are immutable.
  features.push("fiction");
}

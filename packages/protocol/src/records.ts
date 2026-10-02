export type JsonObject = Record<string, unknown>;

export interface CollectionFileMetadata extends JsonObject {
  name: string;
  folder: string;
  size: number;
  mtime: string;
  tags?: string[];
  links?: unknown[];
  embeds?: unknown[];
}

export interface DataContractViewIdentity {
  id: string;
  version: string;
  digest: string;
  type: string;
  implementation_digest: string;
}

/** Frontmatter members depend on the selected frontmatter_mode. */
export interface QueryRecord<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  /** Exact-source token; absent on authorities predating query-record-revisions-v1. */
  revision?: string;
  frontmatter?: Frontmatter;
  effective_frontmatter?: Frontmatter;
  body?: string;
  types: string[];
  file: Partial<CollectionFileMetadata> & { path?: string };
  values?: JsonObject;
  /** Present when the authority returned a normalized contract projection. */
  contract?: DataContractViewIdentity;
}

export const MAX_READ_MANY_PATHS = 100;
/** Ceiling for the serialized batch operation envelope; callers must split on overflow. */
export const MAX_READ_MANY_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface DataContractSelector {
  id: string;
  version: string;
  type?: string;
}

/** Existing read operation: exactly one target form; batch defaults differ from point reads. */
export type ReadInput = ({ path: string; paths?: never } | { path?: never; paths: string[] }) & {
  contract?: DataContractSelector;
  /** Batch default: true. Single-path defaults remain unchanged. */
  include_body?: boolean;
  /** Batch default: false. Contract projections cannot request exact source. */
  include_document?: boolean;
};

export type ReadManyDocumentItem<Frontmatter extends JsonObject = JsonObject> =
  | { path: string; status: "found"; record: RecordDocument<Frontmatter> }
  | { path: string; status: "missing" }
  | { path: string; status: "error"; error: { code: string; message: string } };

export interface ReadManyDocumentsResult<Frontmatter extends JsonObject = JsonObject> {
  /** One ordered item per input occurrence, including duplicates. */
  items: Array<ReadManyDocumentItem<Frontmatter>>;
}

/** Negotiated narrow row; omitted document fields are not empty fields. */
export interface QueryMetadataRecord {
  path: string;
  types: string[];
  revision: string;
  values: JsonObject;
  contract?: DataContractViewIdentity;
}

export interface QueryMetadataResult {
  output: "metadata";
  results: QueryMetadataRecord[];
  meta?: JsonObject;
}

/** An authoritative record or a field-limited data-contract projection. */
export interface RecordDocument<Frontmatter extends JsonObject = JsonObject> {
  path: string;
  revision: string;
  types: string[];
  frontmatter: Frontmatter;
  effective_frontmatter: Frontmatter;
  /** Omitted from contract-scoped results. */
  body?: string;
  /**
   * The exact UTF-8 Markdown source, including frontmatter delimiters,
   * comments, quoting, whitespace, line endings, and trailing newline.
   * Returned only when the operation requests it.
   */
  document?: string;
  file: Partial<CollectionFileMetadata> & { path?: string };
  /** Present when the authority returned a normalized contract projection. */
  contract?: DataContractViewIdentity;
}

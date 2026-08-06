import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parse, stringify } from "yaml";
import type {
  CollectionFileDescriptor,
  JsonObject,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import type { MirrorLocalIssue } from "./mirror-state.js";

const utf8 = new TextEncoder();
const YAML_AMBIGUOUS_WORDS = new Set(["null", "true", "false"]);
const INVALID_JSON_PROJECTION = Symbol("invalid-json-projection");

export function documentHash(document: string): string {
  return bytesToHex(sha256(utf8.encode(document)));
}

export function documentRevision(document: string): string {
  return `sha256:${documentHash(document)}`;
}

export function recordMarkdownDocument(record: SyncRecord): string {
  if (typeof record.document !== "string") {
    throw new SyncError(
      "invalid_authority_record",
      `Authority record ${record.path} omitted its exact Markdown document.`
    );
  }
  return record.document;
}

/** Serialize an optimistic local projection before it has an authority record. */
export function projectionMarkdownDocument(
  record: Pick<SyncRecord, "frontmatter" | "body">
): string {
  if (Object.keys(record.frontmatter).length === 0) {
    return record.body;
  }

  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = record.body ? `\n${record.body.replace(/^\n/, "")}` : "";
  return `---\n${yaml}\n---\n${body}`;
}

/** Compare the common scalar/flat-array subset without allocating a document. */
export function fastRecordDocumentMatches(document: string, record: SyncRecord): boolean | null {
  let offset = 0;
  let hasFrontmatter = false;
  for (const key in record.frontmatter) {
    if (!Object.prototype.hasOwnProperty.call(record.frontmatter, key)) continue;
    if (!hasFrontmatter) {
      hasFrontmatter = true;
      offset = consumeAt(document, "---\n", offset);
      if (offset < 0) return false;
    }
    const value: unknown = record.frontmatter[key];
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(key)) return null;
    const scalar = fastYamlScalar(value);
    if (scalar !== null) {
      offset = consumeAt(document, key, offset);
      if (offset < 0) return false;
      offset = consumeAt(document, ": ", offset);
      if (offset < 0) return false;
      offset = consumeAt(document, scalar, offset);
      if (offset < 0) return false;
      offset = consumeAt(document, "\n", offset);
      if (offset < 0) return false;
      continue;
    }
    if (!Array.isArray(value)) return null;
    if (value.length === 0) {
      offset = consumeAt(document, key, offset);
      if (offset < 0) return false;
      offset = consumeAt(document, ": []\n", offset);
      if (offset < 0) return false;
      continue;
    }
    offset = consumeAt(document, key, offset);
    if (offset < 0) return false;
    offset = consumeAt(document, ":\n", offset);
    if (offset < 0) return false;
    for (const item of value) {
      const rendered = fastYamlScalar(item);
      if (rendered === null) return null;
      offset = consumeAt(document, "  - ", offset);
      if (offset < 0) return false;
      offset = consumeAt(document, rendered, offset);
      if (offset < 0) return false;
      offset = consumeAt(document, "\n", offset);
      if (offset < 0) return false;
    }
  }
  if (!hasFrontmatter) return document === record.body;
  offset = consumeAt(document, "---\n", offset);
  if (offset < 0) return false;
  if (!record.body) return offset === document.length;
  const body = record.body.startsWith("\n") ? record.body.slice(1) : record.body;
  offset = consumeAt(document, "\n", offset);
  return offset >= 0
    && document.startsWith(body, offset)
    && offset + body.length === document.length;
}

export function parseMarkdown(document: string, _path: string): { frontmatter: JsonObject; body: string } {
  const match = document.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)$/m);
  if (!match) {
    return { frontmatter: {}, body: document };
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!, { mapAsMap: true });
  } catch {
    return { frontmatter: {}, body: document };
  }
  if (frontmatter === null && match[1]!.trim() === "") {
    return { frontmatter: {}, body: match[2] ?? "" };
  }
  const projection = jsonProjection(frontmatter, new Set());
  if (projection === INVALID_JSON_PROJECTION || !isJsonObject(projection)) {
    return { frontmatter: {}, body: document };
  }
  return { frontmatter: projection, body: match[2] ?? "" };
}

function jsonProjection(
  value: unknown,
  ancestors: Set<object>
): unknown | typeof INVALID_JSON_PROJECTION {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : INVALID_JSON_PROJECTION;
  if (!value || typeof value !== "object" || ancestors.has(value)) return INVALID_JSON_PROJECTION;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) {
        const projected = jsonProjection(item, ancestors);
        if (projected === INVALID_JSON_PROJECTION) return INVALID_JSON_PROJECTION;
        result.push(projected);
      }
      return result;
    }
    if (!(value instanceof Map)) return INVALID_JSON_PROJECTION;
    const result: Record<string, unknown> = {};
    for (const [key, item] of value) {
      if (typeof key !== "string") return INVALID_JSON_PROJECTION;
      const projected = jsonProjection(item, ancestors);
      if (projected === INVALID_JSON_PROJECTION) return INVALID_JSON_PROJECTION;
      Object.defineProperty(result, key, {
        value: projected,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fastYamlScalar(value: unknown): string | null {
  if (typeof value === "boolean" || value === null) return String(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9 _.-]*$/u.test(value)) {
    return null;
  }
  if (value.length <= 5 && YAML_AMBIGUOUS_WORDS.has(value.toLowerCase())) return null;
  return value;
}

function consumeAt(document: string, value: string, offset: number): number {
  return document.startsWith(value, offset) ? offset + value.length : -1;
}

export function mirrorLocalIssue(error: unknown, path: string): MirrorLocalIssue | null {
  if (!(error instanceof SyncError) || error.code !== "invalid_frontmatter") return null;
  return {
    path,
    code: "invalid_frontmatter",
    message: error.message
  };
}

export function frontmatterPatch(before: JsonObject, after: JsonObject): JsonObject {
  const patch: JsonObject = { ...after };
  for (const field of Object.keys(before)) {
    if (!(field in after)) patch[field] = null;
  }
  return patch;
}

export function authorityManifestDigest(entries: Array<{
  kind: "file" | "record" | "resource";
  path: string;
  identity: string;
  document_hash: string;
}>): string {
  const manifest = sha256.create().update(utf8.encode("mdbase-authority-manifest-v2\n"));
  for (const entry of [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1;
    return compareBytes(utf8.encode(left.path), utf8.encode(right.path));
  })) {
    manifest.update(utf8.encode(entry.kind));
    manifest.update(Uint8Array.of(0));
    manifest.update(utf8.encode(entry.path));
    manifest.update(Uint8Array.of(0));
    manifest.update(utf8.encode(entry.identity));
    manifest.update(Uint8Array.of(0));
    manifest.update(utf8.encode(entry.document_hash));
    manifest.update(Uint8Array.of(10));
  }
  return bytesToHex(manifest.digest());
}

export function authorityFileHash(file: CollectionFileDescriptor): string {
  const hash = sha256.create();
  for (const value of [
    "mdbase-authority-file-v1",
    file.content_digest,
    String(file.size),
    file.media_type ?? "",
    file.media_class
  ]) {
    hash.update(utf8.encode(value));
    hash.update(Uint8Array.of(0));
  }
  return bytesToHex(hash.digest());
}

export function authorityDocumentHash(revision: string): string {
  const hash = revision.startsWith("sha256:") ? revision.slice("sha256:".length) : revision;
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new SyncError(
      "invalid_authority_snapshot",
      "Authority manifests require exact SHA-256 document hashes."
    );
  }
  return hash;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

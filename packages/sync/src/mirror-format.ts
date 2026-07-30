import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parse, stringify } from "yaml";
import type { JsonObject, SyncRecord } from "@mdbase/connect-protocol";
import { SyncError } from "./sync-error.js";
import type { MirrorLocalIssue } from "./mirror-state.js";

const utf8 = new TextEncoder();
const YAML_AMBIGUOUS_WORDS = new Set(["null", "true", "false"]);

export function documentHash(document: string): string {
  return bytesToHex(sha256(utf8.encode(document)));
}

export function documentRevision(document: string): string {
  return `sha256:${documentHash(document)}`;
}

export function recordMarkdownDocument(record: SyncRecord): string {
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

export function parseMarkdown(document: string, path: string): { frontmatter: JsonObject; body: string } {
  const match = document.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)([\s\S]*)$/m);
  if (!match) {
    return { frontmatter: {}, body: document };
  }
  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!);
  } catch {
    throw new SyncError("invalid_frontmatter", `Writable mirror file ${path} has invalid YAML frontmatter.`);
  }
  if (frontmatter === null && match[1]!.trim() === "") {
    frontmatter = {};
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new SyncError("invalid_frontmatter", `Writable mirror file ${path} requires object frontmatter.`);
  }
  return { frontmatter: frontmatter as JsonObject, body: match[2] ?? "" };
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
  kind: "record" | "resource";
  path: string;
  identity: string;
  document_hash: string;
}>): string {
  const manifest = sha256.create().update(utf8.encode("mdbase-authority-manifest-v1\n"));
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

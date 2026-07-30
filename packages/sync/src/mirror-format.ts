import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parse, stringify } from "yaml";
import type { JsonObject, SyncRecord } from "@mdbase/connect-protocol";
import { SyncError } from "./sync-error.js";
import type { MirrorLocalIssue } from "./mirror-state.js";

const utf8 = new TextEncoder();

export function recordMarkdownDocument(record: SyncRecord): string {
  if (Object.keys(record.frontmatter).length === 0) {
    return record.body;
  }

  const yaml = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd();
  const body = record.body ? `\n${record.body.replace(/^\n/, "")}` : "";
  return `---\n${yaml}\n---\n${body}`;
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

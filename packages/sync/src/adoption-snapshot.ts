import { sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  AuthorityImportRecord,
  AuthorityImportSnapshot,
  CollectionContractDescriptor,
  SyncResourceDocument
} from "@mdbase-dev/connect-protocol";
import { AuthorityAdoptionError } from "./adoption-errors.js";
import { requiredUuid } from "./adoption-values.js";
import { authorityManifestDigest } from "./mirror-format.js";

const utf8 = new TextEncoder();

export interface PortableAuthorityResource {
  path: string;
  kind: SyncResourceDocument["kind"];
  document: string;
}

export interface PortableAuthorityRecord {
  path: string;
  document: string;
  recordId?: string;
}

export interface BuildPortableAuthoritySnapshotInput {
  collectionId: string;
  sourceHead?: number;
  specVersion: string;
  resources: PortableAuthorityResource[];
  records: PortableAuthorityRecord[];
  types?: AuthorityImportSnapshot["resources"]["types"];
  contracts?: CollectionContractDescriptor[];
}

/** Build the exact portable snapshot shape validated by mdbase-rs on import. */
export function buildPortableAuthoritySnapshot(
  input: BuildPortableAuthoritySnapshotInput
): AuthorityImportSnapshot {
  const collectionId = requiredUuid(input.collectionId, "Collection ID");
  const sourceHead = input.sourceHead ?? 0;
  if (!Number.isSafeInteger(sourceHead) || sourceHead < 0) {
    throw new AuthorityAdoptionError(
      "invalid_authority_snapshot",
      "Source head must be a non-negative integer."
    );
  }
  const paths = new Set<string>();
  const resources = input.resources.map((resource): SyncResourceDocument => {
    const path = portablePath(resource.path);
    if (!paths.add(path)) duplicatePath(path);
    if (!["configuration", "contract", "schema", "type", "view"].includes(resource.kind)) {
      throw new AuthorityAdoptionError(
        "invalid_authority_snapshot",
        `Unsupported collection resource kind for ${path}.`
      );
    }
    return {
      path,
      kind: resource.kind,
      revision: documentRevision(resource.document),
      document: resource.document
    };
  }).sort(compareResources);
  if (
    resources[0]?.path !== "mdbase.yaml"
    || resources[0].kind !== "configuration"
    || resources.filter(({ kind }) => kind === "configuration").length !== 1
  ) {
    throw new AuthorityAdoptionError(
      "invalid_authority_snapshot",
      "A portable snapshot requires one mdbase.yaml configuration resource."
    );
  }
  const records = input.records.map((record): AuthorityImportRecord => {
    const path = portablePath(record.path);
    if (!paths.add(path)) duplicatePath(path);
    return {
      record_id: record.recordId
        ? requiredUuid(record.recordId, `Record ID for ${path}`)
        : portableRecordId(collectionId, path),
      path,
      document: record.document
    };
  }).sort((left, right) => compareUtf8(left.path, right.path));
  const resourceRevision = lengthPrefixedDigest(
    resources.flatMap(({ path, revision }) => [path, revision])
  );
  const sourceRevision = lengthPrefixedDigest([
    ...resources.flatMap(({ path, revision }) => ["resource", path, revision]),
    ...records.flatMap((record) => ["record", record.path, documentRevision(record.document)])
  ]);
  const manifestDigest = authorityManifestDigest([
    ...resources.map(({ path, document }) => ({
      kind: "resource" as const,
      path,
      identity: "",
      document_hash: bytesToHex(sha256(utf8.encode(document)))
    })),
    ...records.map((record) => ({
      kind: "record" as const,
      path: record.path,
      identity: record.record_id,
      document_hash: bytesToHex(sha256(utf8.encode(record.document)))
    }))
  ]);
  return {
    protocol_version: 1,
    collection_id: collectionId,
    source_head: sourceHead,
    source_revision: sourceRevision,
    manifest_digest: manifestDigest,
    resources: {
      revision: resourceRevision,
      spec_version: input.specVersion,
      types: input.types ?? [],
      contracts: input.contracts ?? [],
      documents: resources
    },
    records
  };
}

/** Stable UUIDv5 identity for a pre-network record path. */
export function portableRecordId(collectionId: string, path: string): string {
  const namespace = uuidBytes(requiredUuid(collectionId, "Collection ID"));
  const digest = sha1(new Uint8Array([...namespace, ...utf8.encode(portablePath(path))]));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-`
    + `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function documentRevision(document: string): string {
  return `sha256:${bytesToHex(sha256(utf8.encode(document)))}`;
}

function lengthPrefixedDigest(values: string[]): string {
  const digest = sha256.create();
  for (const value of values) {
    const length = BigInt(utf8.encode(value).length);
    const prefix = new Uint8Array(8);
    new DataView(prefix.buffer).setBigUint64(0, length);
    digest.update(prefix);
    digest.update(utf8.encode(value));
  }
  return `sha256:${bytesToHex(digest.digest())}`;
}

function compareResources(left: SyncResourceDocument, right: SyncResourceDocument): number {
  if (left.kind === "configuration" && right.kind !== "configuration") return -1;
  if (right.kind === "configuration" && left.kind !== "configuration") return 1;
  return compareUtf8(left.path, right.path);
}

function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8.encode(left);
  const rightBytes = utf8.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function portablePath(value: string): string {
  const path = value.replaceAll("\\", "/");
  if (
    !path
    || path.startsWith("/")
    || path.endsWith("/")
    || path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new AuthorityAdoptionError(
      "invalid_authority_snapshot",
      `Collection path is unsafe: ${value}`
    );
  }
  return path;
}

function duplicatePath(path: string): never {
  throw new AuthorityAdoptionError(
    "invalid_authority_snapshot",
    `Collection snapshot contains the path more than once: ${path}`
  );
}

function uuidBytes(value: string): Uint8Array {
  return Uint8Array.from(value.replaceAll("-", "").match(/../g)!.map((byte) => Number.parseInt(byte, 16)));
}


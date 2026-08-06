import type {
  JsonObject,
  SyncRecord,
  SyncResourceDocument,
  SyncSession,
  SyncSnapshotRecord
} from "@mdbase-dev/connect-protocol";
import { fastRecordDocumentMatches, parseMarkdown } from "./mirror-format.js";
import {
  validateRecordPath,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import { portableMirrorPathKeyForValidatedPath } from "./portable-path.js";
import { SyncError } from "./sync-error.js";
import type { SyncTransport } from "./sync-types.js";

export interface ValidatedSnapshotRecord<
  Frontmatter extends JsonObject = JsonObject
> {
  record: SyncRecord<Frontmatter>;
  document: string;
  hash: string;
}

/** Stateful validation across every page of one authority snapshot. */
export class MirrorSnapshotValidator<
  Frontmatter extends JsonObject = JsonObject
> {
  private readonly recordIds = new Set<string>();
  private readonly physicalPaths = new Set<string>();

  constructor(
    private readonly pathPolicy: MirrorRecordPathPolicy,
    resources: readonly SyncResourceDocument[],
    private readonly digest: (document: string) => string
  ) {
    for (const resource of resources) {
      this.physicalPaths.add(portableMirrorPathKeyForValidatedPath(resource.path));
    }
  }

  validate(snapshot: SyncSnapshotRecord<Frontmatter>): ValidatedSnapshotRecord<Frontmatter> {
    const document = snapshot.document;
    const record: SyncRecord<Frontmatter> = snapshot;
    validateRecordPath(record.path, this.pathPolicy);
    if (this.recordIds.has(record.record_id)) {
      throw new SyncError(
        "invalid_snapshot",
        `Hosted snapshot repeats record identity ${record.record_id}.`
      );
    }
    this.recordIds.add(record.record_id);
    const physicalPath = portableMirrorPathKeyForValidatedPath(record.path);
    if (this.physicalPaths.has(physicalPath)) {
      throw new SyncError(
        "invalid_snapshot",
        `Hosted record path ${record.path} aliases another snapshot path on a supported filesystem.`
      );
    }
    this.physicalPaths.add(physicalPath);

    const hash = this.digest(document);
    if (
      record.revision.length !== "sha256:".length + hash.length
      || !record.revision.startsWith("sha256:")
      || !record.revision.endsWith(hash)
    ) {
      throw new SyncError(
        "invalid_snapshot",
        `Hosted record ${record.path} does not match its declared revision.`
      );
    }
    const fastDocumentMatches = fastRecordDocumentMatches(document, record);
    if (fastDocumentMatches !== true) {
      let parsed: ReturnType<typeof parseMarkdown>;
      try {
        parsed = parseMarkdown(document, record.path);
      } catch {
        throw new SyncError(
          "invalid_snapshot",
          `Hosted record ${record.path} is not valid Markdown.`
        );
      }
      if (
        !sameJson(parsed.frontmatter, record.frontmatter)
        || !bodyMatches(parsed.body, record.body)
      ) {
        throw new SyncError(
          "invalid_snapshot",
          `Hosted record ${record.path} does not match its declared document.`
        );
      }
    }
    return {
      record,
      document,
      hash
    };
  }
}

export function withoutSnapshotDocument<
  Frontmatter extends JsonObject = JsonObject
>(record: SyncRecord<Frontmatter>): SyncRecord<Frontmatter> {
  return record;
}

export async function visitSnapshotPages<
  Frontmatter extends JsonObject = JsonObject
>(
  transport: SyncTransport<Frontmatter>,
  session: SyncSession,
  visitor: (records: Array<SyncSnapshotRecord<Frontmatter>>) => Promise<void>
): Promise<void> {
  let page: string | undefined;
  const seenPages = new Set<string>();
  do {
    const snapshot = await transport.snapshot(session.snapshot_id, page);
    if (
      snapshot.protocol_version !== 1
      || snapshot.snapshot_id !== session.snapshot_id
      || snapshot.scope_epoch !== session.scope_epoch
      || snapshot.cursor !== session.head
    ) {
      throw new SyncError(
        "invalid_snapshot",
        "Authority snapshot boundary changed during download."
      );
    }
    await visitor(snapshot.records);
    page = snapshot.next_page;
    if (page !== undefined && seenPages.has(page)) {
      throw new SyncError("invalid_snapshot", "Authority snapshot repeated a page cursor.");
    }
    if (page !== undefined) seenPages.add(page);
  } while (page);
}

function bodyMatches(left: string, right: string): boolean {
  return left === right
    || left.startsWith("\n") && left.slice(1) === right
    || right.startsWith("\n") && right.slice(1) === left;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameJson(item, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftEntries = Object.entries(left);
  const rightRecord = right as Record<string, unknown>;
  return leftEntries.length === Object.keys(rightRecord).length
    && leftEntries.every(([key, value]) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key)
      && sameJson(value, rightRecord[key])
    );
}

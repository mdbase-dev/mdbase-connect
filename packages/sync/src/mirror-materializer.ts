import type { JsonObject, SyncRecord } from "@mdbase/connect-protocol";
import { MirrorDivergenceError } from "./mirror-errors.js";
import { recordMarkdownDocument } from "./mirror-format.js";
import {
  loadMirrorRecordPathPolicy,
  validateRecordPath,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import { assertRecordPhysicalPathAvailable } from "./mirror-physical-path.js";
import {
  type MirrorEntry,
  type MirrorFileSystem,
  type MirrorRuntime,
  type MirrorState
} from "./mirror-state.js";
import { withoutSnapshotDocument } from "./mirror-snapshot-validator.js";

export interface PutOptions {
  managedState?: MirrorState;
  acceptedHash?: string | null;
  preserveAcceptedDocument?: boolean;
  materialized?: { document: string; hash: string };
  physicalPathPreflighted?: boolean;
}

export class MirrorMaterializer {
  constructor(
    private readonly fileSystem: MirrorFileSystem,
    private readonly runtime: MirrorRuntime,
    private readonly mode: "read_only" | "read_write"
  ) {}

  async recordPathPolicy(state: MirrorState): Promise<MirrorRecordPathPolicy> {
    return loadMirrorRecordPathPolicy(
      Object.keys(state.resources ?? {}),
      () => this.fileSystem.read("mdbase.yaml")
    );
  }

  async put<Frontmatter extends JsonObject>(
    state: MirrorState,
    record: SyncRecord<Frontmatter>,
    options: PutOptions = {}
  ): Promise<void> {
    const {
      managedState = state,
      acceptedHash,
      preserveAcceptedDocument = false,
      materialized,
      physicalPathPreflighted = false
    } = options;
    validateRecordPath(record.path, await this.recordPathPolicy(state));
    if (materialized === undefined && !physicalPathPreflighted) {
      assertRecordPhysicalPathAvailable(
        record.path,
        record.record_id,
        Object.keys(state.resources ?? {}),
        Object.entries(state.records)
      );
    }
    const document = materialized?.document ?? recordMarkdownDocument(record);
    const existing = await this.fileSystem.read(record.path);
    const prior = managedState?.records[record.record_id];
    if (existing !== null && existing !== document) {
      const existingHash = this.runtime.digest(existing);
      const destinationBelongsToRecord = prior !== undefined
        && prior.path === record.path
        && existingHash === prior.hash;
      if (
        !destinationBelongsToRecord
        && (acceptedHash === undefined || existingHash !== acceptedHash)
      ) {
        throw new MirrorDivergenceError(record.record_id, record.path);
      }
    }
    if (prior && prior.path !== record.path) {
      await this.remove(managedState!, record.record_id, prior.path);
    }
    const acceptedLocalHash = preserveAcceptedDocument
      && typeof acceptedHash === "string"
      && existing !== null
      && this.runtime.digest(existing) === acceptedHash
      ? acceptedHash
      : null;
    if (acceptedLocalHash === null) {
      await this.fileSystem.write(record.path, document);
    }
    state.records[record.record_id] = {
      path: record.path,
      revision: record.revision,
      hash: acceptedLocalHash ?? materialized?.hash ?? this.runtime.digest(document),
      ...(this.mode === "read_write"
        ? { record: withoutSnapshotDocument(record) }
        : {})
    };
  }

  async remove(
    state: MirrorState,
    recordId: string,
    pathValue: string
  ): Promise<void> {
    const entry = state.records[recordId];
    const path = entry?.path ?? pathValue;
    validateRecordPath(path, await this.recordPathPolicy(state));
    const existing = await this.fileSystem.read(path);
    if (existing !== null && entry && this.runtime.digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(recordId, entry.path);
    }
    if (existing !== null) await this.fileSystem.remove(path);
    delete state.records[recordId];
  }

  async putResource(
    state: MirrorState,
    resource: { path: string; revision: string; document: string },
    managedState?: MirrorState
  ): Promise<void> {
    const existing = await this.fileSystem.read(resource.path);
    const prior = managedState?.resources?.[resource.path];
    if (
      existing !== null
      && existing !== resource.document
      && (!prior || this.runtime.digest(existing) !== prior.hash)
    ) {
      throw new MirrorDivergenceError(`resource:${resource.path}`, resource.path);
    }
    await this.fileSystem.write(resource.path, resource.document);
    state.resources ??= {};
    state.resources[resource.path] = {
      path: resource.path,
      revision: resource.revision,
      hash: this.runtime.digest(resource.document)
    };
  }

  async removeResource(
    state: MirrorState,
    pathValue: string,
    entry: MirrorEntry
  ): Promise<void> {
    const existing = await this.fileSystem.read(pathValue);
    if (existing !== null && this.runtime.digest(existing) !== entry.hash) {
      throw new MirrorDivergenceError(`resource:${pathValue}`, pathValue);
    }
    if (existing !== null) await this.fileSystem.remove(pathValue);
    if (state.resources) delete state.resources[pathValue];
  }
}

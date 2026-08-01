import type {
  CollectionFileDescriptor,
  JsonObject,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import { MirrorDivergenceError } from "./mirror-errors.js";
import { SyncError } from "./sync-error.js";
import { recordMarkdownDocument } from "./mirror-format.js";
import {
  loadMirrorRecordPathPolicy,
  validateRecordPath,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import {
  assertFilePhysicalPathAvailable,
  assertRecordPhysicalPathAvailable,
  physicalMirrorPathKey
} from "./mirror-physical-path.js";
import {
  sameBinaryInfo,
  validateCollectionFileDescriptor,
  verifiedFileBytes
} from "./mirror-files.js";
import {
  type MirrorEntry,
  type MirrorBlobStore,
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
    private readonly mode: "read_only" | "read_write",
    private readonly blobStore?: MirrorBlobStore
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
        Object.entries(state.records),
        Object.entries(state.files ?? {})
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

  async putFile(
    state: MirrorState,
    file: CollectionFileDescriptor,
    managedState: MirrorState = state
  ): Promise<void> {
    validateCollectionFileDescriptor(file);
    if (!this.blobStore) {
      throw new SyncError(
        "file_storage_unavailable",
        "Selected collection files require a content-addressed blob store adapter."
      );
    }
    assertFilePhysicalPathAvailable(file.path, file.file_id, state);
    state.files ??= {};
    const prior = managedState.files?.[file.file_id];
    const target = await this.fileSystem.inspectBinary(file.path);
    const targetPhysicalPath = physicalMirrorPathKey(file.path);
    const managedFileAtTarget = Object.values(managedState.files ?? {}).find(
      (entry) => physicalMirrorPathKey(entry.file.path) === targetPhysicalPath
    );
    const managedDocumentAtTarget = [
      ...Object.values(managedState.resources ?? {}),
      ...Object.values(managedState.records)
    ].find((entry) => physicalMirrorPathKey(entry.path) === targetPhysicalPath);
    const targetDocument = managedDocumentAtTarget
      ? await this.fileSystem.read(file.path)
      : null;
    const targetBelongsToPrior = prior?.file.path === file.path
      && sameBinaryInfo(target, prior.file);
    const targetBelongsToManagedPath = managedFileAtTarget !== undefined
      && sameBinaryInfo(target, managedFileAtTarget.file);
    const targetBelongsToManagedDocument = managedDocumentAtTarget !== undefined
      && targetDocument !== null
      && this.runtime.digest(targetDocument) === managedDocumentAtTarget.hash;
    if (
      target !== null
      && !sameBinaryInfo(target, file)
      && !targetBelongsToPrior
      && !targetBelongsToManagedPath
      && !targetBelongsToManagedDocument
    ) {
      throw new MirrorDivergenceError(file.file_id, file.path);
    }
    if (prior && prior.file.path !== file.path) {
      const priorInfo = await this.fileSystem.inspectBinary(prior.file.path);
      if (priorInfo !== null && !sameBinaryInfo(priorInfo, prior.file)) {
        throw new MirrorDivergenceError(file.file_id, prior.file.path);
      }
    }
    if (!sameBinaryInfo(target, file)) {
      await this.fileSystem.writeBinary(
        file.path,
        verifiedFileBytes(this.blobStore.read(file.content_digest), file)
      );
    }
    if (prior && prior.file.path !== file.path) {
      await this.fileSystem.remove(prior.file.path);
    }
    state.files[file.file_id] = { file };
  }

  async removeFile(state: MirrorState, fileId: string): Promise<void> {
    const entry = state.files?.[fileId];
    if (!entry) return;
    const local = await this.fileSystem.inspectBinary(entry.file.path);
    if (local !== null && !sameBinaryInfo(local, entry.file)) {
      throw new MirrorDivergenceError(fileId, entry.file.path);
    }
    if (local !== null) await this.fileSystem.remove(entry.file.path);
    delete state.files![fileId];
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

import type {
  DeleteFileRequest,
  MoveFileRequest,
  OpenFileUploadRequest,
  SyncMutationReceipt,
  SyncRecord
} from "@mdbase-dev/connect-protocol";
import { SyncError } from "./sync-error.js";
import { MirrorMaterializer } from "./mirror-materializer.js";
import { recordMarkdownDocument } from "./mirror-format.js";
import {
  sameBinaryInfo,
  validateCollectionFileDescriptor
} from "./mirror-files.js";
import type {
  DurableSyncReceipt,
  MirrorBlobStore,
  MirrorFileSystem,
  MirrorRuntime,
  MirrorState
} from "./mirror-state.js";
import type { SyncTransport } from "./sync-types.js";
import type {
  ExpectedObjectState,
  SyncAction,
  SyncFailure,
  SyncObjectRef
} from "./sync-model.js";
import {
  beginApplying,
  markBatchInterrupted,
  markEffectsComplete,
  recordActionReceipt,
  requireBatch,
  type SyncJournalStore
} from "./sync-journal.js";
import { syncFingerprint } from "./sync-plan-codec.js";

export interface SyncExecutionResult {
  status: "effects_complete" | "cancelled" | "stale" | "blocked";
  completed: number;
  failure?: SyncFailure;
}

interface ExecutorPorts {
  transport: SyncTransport;
  fileSystem: MirrorFileSystem;
  blobStore?: MirrorBlobStore;
  runtime: MirrorRuntime;
  mode: "read_only" | "read_write";
  store: SyncJournalStore;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Command-only executor. It cannot inspect, construct actions, re-plan, or
 * advance a checkpoint because none of those capabilities are in its ports.
 */
export class PlanOnlySyncExecutor {
  private readonly materializer: MirrorMaterializer;
  private readonly ownersByPath = new Map<string, SyncObjectRef>();
  private readonly pathsByOwner = new Map<string, string>();

  constructor(private readonly ports: ExecutorPorts) {
    this.materializer = new MirrorMaterializer(
      ports.fileSystem,
      ports.runtime,
      ports.mode,
      ports.blobStore
    );
  }

  async execute(state: MirrorState, signal?: AbortSignal): Promise<SyncExecutionResult> {
    const batch = requireBatch(state);
    this.indexPathOwners(state);
    const completedActions = new Set(batch.receipts.map((receipt) => receipt.action_id));
    await beginApplying(state, this.ports.store);
    while (batch.next_action < batch.plan.actions.length) {
      const action = batch.plan.actions[batch.next_action]!;
      if (action.command === "advance_checkpoint") {
        await markEffectsComplete(state, this.ports.store);
        return { status: "effects_complete", completed: batch.next_action };
      }
      if (signal?.aborted) {
        const failure = { code: "sync_cancelled", message: "Sync cancelled at an action boundary." };
        await markBatchInterrupted(state, "cancelled", failure, this.ports.store);
        return { status: "cancelled", completed: batch.next_action, failure };
      }
      const missingDependency = action.depends_on.find((dependency) =>
        !completedActions.has(dependency)
      );
      if (missingDependency) {
        const failure = {
          code: "invalid_mirror_state",
          message: `Action ${action.action_id} is missing dependency ${missingDependency}.`,
          action_id: action.action_id
        };
        await markBatchInterrupted(state, "blocked", failure, this.ports.store);
        return { status: "blocked", completed: batch.next_action, failure };
      }
      try {
        const receipt = await this.dispatch(state, action);
        await recordActionReceipt(state, receipt, this.ports.store);
        completedActions.add(receipt.action_id);
        this.ports.onProgress?.(batch.next_action, batch.plan.actions.length - 1);
      } catch (error) {
        const failure = failureFrom(error, action.action_id);
        await markBatchInterrupted(state, "blocked", failure, this.ports.store);
        return {
          status: failure.code === "sync_plan_stale" ? "stale" : "blocked",
          completed: batch.next_action,
          failure
        };
      }
    }
    throw new SyncError("invalid_mirror_state", "Prepared plan has no checkpoint action.");
  }

  private async dispatch(state: MirrorState, action: SyncAction): Promise<DurableSyncReceipt> {
    switch (action.command) {
      case "write_local":
        return this.writeLocal(state, action);
      case "move_local":
        return this.moveLocal(state, action);
      case "delete_local":
        return this.deleteLocal(state, action);
      case "put_remote":
        return this.putRemote(state, action);
      case "move_remote":
        return this.moveRemote(state, action);
      case "delete_remote":
        return this.deleteRemote(state, action);
      case "record_conflict":
        state.planned_conflicts ??= {};
        state.planned_conflicts[action.identity] = {
          decision_id: conflictDecisionId(
            action.entity,
            action.identity,
            action.local,
            action.remote,
            action.conflict_kind,
            this.ports.runtime.digest
          ),
          entity: action.entity,
          local: action.local,
          remote: action.remote,
          conflict_kind: action.conflict_kind
        };
        state.local_bindings ??= {};
        if (action.local.state === "exact") {
          state.local_bindings[action.identity] = {
            entity: action.entity,
            path: action.local.object.path
          };
        } else {
          delete state.local_bindings[action.identity];
        }
        this.rebaseConflict(state, action);
        return { action_id: action.action_id, status: "conflicted" };
      case "clear_conflict":
        delete state.planned_conflicts?.[action.identity];
        delete state.local_bindings?.[action.identity];
        return { action_id: action.action_id, status: "completed" };
      case "advance_checkpoint":
        throw new SyncError(
          "invalid_mirror_state",
          "The executor cannot dispatch checkpoint actions."
        );
    }
  }

  private rebaseConflict(
    state: MirrorState,
    action: Extract<SyncAction, { command: "record_conflict" }>
  ): void {
    const payloads = requireBatch(state).payloads;
    if (action.entity === "record") {
      if (action.remote.state === "absent") {
        delete state.records[action.identity];
        return;
      }
      const record = payloads.records[action.action_id];
      if (!record || record.revision !== action.remote.object.revision) throw missingPayload(action);
      assertExactDocument(record, this.ports.runtime, record.revision);
      state.records[action.identity] = {
        path: record.path,
        revision: record.revision,
        hash: action.local.state === "exact"
          ? action.local.object.payload_revision.replace(/^sha256:/u, "")
          : this.ports.runtime.digest(record.document),
        ...(this.ports.mode === "read_write" ? { record } : {})
      };
      return;
    }
    state.files ??= {};
    if (action.remote.state === "absent") {
      delete state.files[action.identity];
      return;
    }
    const file = payloads.files[action.action_id];
    if (!file || file.revision !== action.remote.object.revision) throw missingPayload(action);
    validateCollectionFileDescriptor(file);
    state.files[action.identity] = { file };
  }

  private async writeLocal(
    state: MirrorState,
    action: Extract<SyncAction, { command: "write_local" }>
  ): Promise<DurableSyncReceipt> {
    const targetOccupied = await this.ports.fileSystem.exists(action.target.path);
    if (!targetOccupied || !await this.matchesRef(action.target)) {
      await this.assertLocal(action.expected_local);
      await this.assertPathOwner(
        action.target.path,
        action.expected_path_owner,
        targetOccupied
      );
    }
    const payloads = requireBatch(state).payloads;
    if (action.target.entity === "record") {
      const record = payloads.records[action.action_id];
      if (!record || record.revision !== action.payload_revision) throw missingPayload(action);
      assertExactDocument(record, this.ports.runtime, action.payload_revision);
      await this.materializer.put(state, record, { inspectionPreflighted: true });
      this.installPathOwner(action.target);
      return { action_id: action.action_id, status: "completed" };
    }
    if (action.target.entity === "resource") {
      const resource = payloads.resources[action.action_id];
      if (!resource || resource.revision !== action.payload_revision) throw missingPayload(action);
      if (`sha256:${this.ports.runtime.digest(resource.document)}` !== resource.revision) {
        throw missingPayload(action);
      }
      await this.materializer.putResource(state, resource, state);
      this.installPathOwner(action.target);
      return { action_id: action.action_id, status: "completed" };
    }
    const file = payloads.files[action.action_id];
    if (!file || file.content_digest !== action.payload_revision) throw missingPayload(action);
    await this.materializer.putFile(state, file, state);
    this.installPathOwner(action.target);
    return { action_id: action.action_id, status: "completed" };
  }

  private async moveLocal(
    state: MirrorState,
    action: Extract<SyncAction, { command: "move_local" }>
  ): Promise<DurableSyncReceipt> {
    const alreadyMoved = await this.matchesRef({ ...action.source, path: action.target_path });
    if (!alreadyMoved) {
      await this.assertLocal(action.expected_source_owner);
      await this.assertPathOwner(action.target_path, action.expected_target_owner);
      await this.ports.fileSystem.move(action.source.path, action.target_path);
    }
    moveStateEntry(state, action.source, action.target_path);
    this.installPathOwner({ ...action.source, path: action.target_path });
    return { action_id: action.action_id, status: "completed" };
  }

  private async deleteLocal(
    state: MirrorState,
    action: Extract<SyncAction, { command: "delete_local" }>
  ): Promise<DurableSyncReceipt> {
    const exists = await this.matchesRef(action.target);
    if (exists) {
      await this.assertLocal(action.expected_local);
      if (action.target.entity === "record") {
        await this.materializer.remove(
          state,
          action.target.identity,
          action.target.path,
          { inspectionPreflighted: true }
        );
      } else if (action.target.entity === "resource") {
        const entry = state.resources?.[action.target.identity];
        if (entry) await this.materializer.removeResource(state, action.target.path, entry);
        else await this.ports.fileSystem.remove(action.target.path);
      } else {
        await this.materializer.removeFile(state, action.target.identity);
      }
    } else {
      removeStateEntry(state, action.target);
    }
    this.removePathOwner(action.target);
    return { action_id: action.action_id, status: "completed" };
  }

  private async putRemote(
    state: MirrorState,
    action: Extract<SyncAction, { command: "put_remote" }>
  ): Promise<DurableSyncReceipt> {
    // The immutable payload was sealed before preparation. Recovery must replay
    // that payload with the same idempotency key even if the live path changed.
    const payloads = requireBatch(state).payloads;
    if (action.target.entity === "record") {
      const mutation = payloads.mutations[action.action_id];
      const document = payloads.documents[action.action_id];
      if (!mutation || mutation.operation !== "put" || document === undefined) throw missingPayload(action);
      if (`sha256:${this.ports.runtime.digest(document)}` !== action.payload_revision) {
        throw new SyncError("sync_plan_stale", "Prepared local document payload no longer matches its revision.");
      }
      const receipt = await this.ports.transport.mutate(mutation);
      this.acceptRecordReceipt(state, action, receipt, document);
      return receiptResult(action.action_id, receipt);
    }
    if (action.target.entity === "resource") {
      throw new SyncError("invalid_sync_plan", "Authority resources are not writable mirror objects.");
    }
    const local = payloads.local_files[action.action_id];
    if (!local || !this.ports.blobStore || !this.ports.transport.uploadFile) throw missingPayload(action);
    const request: OpenFileUploadRequest = {
      protocol_version: 1,
      type: "open_file_upload",
      transfer_id: uuidFromAction(action.action_id),
      path: action.target.path,
      size: local.size,
      content_digest: local.content_digest,
      ...(local.media_type ? { media_type: local.media_type } : {}),
      ...(action.expected_remote.state === "exact"
        ? { if_revision: action.expected_remote.object.revision }
        : {})
    };
    const receipt = await this.ports.transport.uploadFile(
      request,
      this.ports.blobStore.read(local.content_digest)
    );
    validateCollectionFileDescriptor(receipt.file);
    if (
      receipt.transfer_id !== request.transfer_id
      || receipt.file.path !== action.target.path
      || receipt.file.content_digest !== local.content_digest
      || receipt.file.size !== local.size
    ) throw invalidReceipt(action);
    state.files ??= {};
    state.files[receipt.file.file_id] = { file: receipt.file };
    delete state.local_bindings?.[action.target.identity];
    return { action_id: action.action_id, status: "completed", file: receipt.file };
  }

  private async moveRemote(
    state: MirrorState,
    action: Extract<SyncAction, { command: "move_remote" }>
  ): Promise<DurableSyncReceipt> {
    if (action.source.entity === "record") {
      const mutation = requireBatch(state).payloads.mutations[action.action_id];
      if (!mutation || mutation.operation !== "move") throw missingPayload(action);
      const receipt = await this.ports.transport.mutate(mutation);
      this.acceptRecordReceipt(state, action, receipt);
      return receiptResult(action.action_id, receipt);
    }
    if (action.source.entity === "resource" || !this.ports.transport.moveFile) {
      throw new SyncError("invalid_sync_plan", "This remote move command is unsupported.");
    }
    const request: MoveFileRequest = {
      protocol_version: 1,
      type: "move_file",
      mutation_id: uuidFromAction(action.action_id),
      file_id: action.source.identity,
      if_revision: this.dependencyFileRevision(state, action)
        ?? (action.expected_source_owner.state === "exact"
          ? action.expected_source_owner.object.revision
          : action.source.revision),
      from_path: action.source.path,
      path: action.target_path,
      update_references: false
    };
    const receipt = await this.ports.transport.moveFile(request);
    validateCollectionFileDescriptor(receipt.file);
    if (
      receipt.mutation_id !== request.mutation_id
      || receipt.file.file_id !== action.source.identity
      || receipt.file.path !== action.target_path
    ) throw invalidReceipt(action);
    state.files ??= {};
    state.files[action.source.identity] = { file: receipt.file };
    delete state.local_bindings?.[action.source.identity];
    return { action_id: action.action_id, status: "completed", file: receipt.file };
  }

  private dependencyFileRevision(
    state: MirrorState,
    action: Extract<SyncAction, { command: "move_remote" }>
  ): string | undefined {
    if (!action.revision_from_dependency) return undefined;
    const receipt = requireBatch(state).receipts.find(
      ({ action_id }) => action_id === action.revision_from_dependency
    );
    if (!receipt?.file || receipt.file.file_id !== action.source.identity) {
      throw new SyncError(
        "invalid_mirror_state",
        `Move ${action.action_id} is missing its dependency file receipt.`
      );
    }
    return receipt.file.revision;
  }

  private async deleteRemote(
    state: MirrorState,
    action: Extract<SyncAction, { command: "delete_remote" }>
  ): Promise<DurableSyncReceipt> {
    if (action.target.entity === "record") {
      const mutation = requireBatch(state).payloads.mutations[action.action_id];
      if (!mutation || mutation.operation !== "delete") throw missingPayload(action);
      const receipt = await this.ports.transport.mutate(mutation);
      this.acceptRecordReceipt(state, action, receipt);
      return receiptResult(action.action_id, receipt);
    }
    if (action.target.entity === "resource" || !this.ports.transport.deleteFile) {
      throw new SyncError("invalid_sync_plan", "This remote delete command is unsupported.");
    }
    const request: DeleteFileRequest = {
      protocol_version: 1,
      type: "delete_file",
      mutation_id: uuidFromAction(action.action_id),
      file_id: action.target.identity,
      if_revision: action.expected_remote.state === "exact"
        ? action.expected_remote.object.revision
        : action.target.revision,
      path: action.target.path
    };
    const receipt = await this.ports.transport.deleteFile(request);
    if (
      receipt.mutation_id !== request.mutation_id
      || receipt.file_id !== action.target.identity
      || receipt.previous_path !== action.target.path
    ) throw invalidReceipt(action);
    delete state.files?.[action.target.identity];
    delete state.local_bindings?.[action.target.identity];
    return { action_id: action.action_id, status: "completed" };
  }

  private acceptRecordReceipt(
    state: MirrorState,
    action: Extract<SyncAction, { command: "put_remote" | "move_remote" | "delete_remote" }>,
    receipt: SyncMutationReceipt,
    acceptedDocument?: string
  ): void {
    const ref = "target" in action ? action.target : action.source;
    const identity = ref.identity;
    if (receipt.status === "applied" || receipt.status === "previously_applied") {
      if (receipt.record) {
        assertExactDocument(receipt.record, this.ports.runtime, receipt.record.revision);
        const existing = state.records[identity];
        state.records[identity] = {
          path: receipt.record.path,
          revision: receipt.record.revision,
          hash: acceptedDocument === undefined
            ? existing?.hash ?? this.ports.runtime.digest(receipt.record.document)
            : this.ports.runtime.digest(acceptedDocument),
          ...(this.ports.mode === "read_write" ? { record: receipt.record } : {})
        };
      } else {
        delete state.records[identity];
      }
      delete state.local_bindings?.[identity];
      return;
    }
    const current = receipt.status === "conflicted" ? receipt.conflict.current : undefined;
    if (current) assertExactDocument(current, this.ports.runtime, current.revision);
    const remote: ExpectedObjectState = current
      ? {
          state: "exact",
          object: {
            entity: "record",
            identity,
            path: current.path,
            revision: current.revision,
            payload_revision: current.revision
          }
        }
      : action.command === "move_remote"
        ? action.expected_source_owner
        : action.expected_remote;
    state.planned_conflicts ??= {};
    const conflictKind = receipt.status === "rejected" ? "rejected" : "both_changed";
    state.planned_conflicts[identity] = {
      decision_id: conflictDecisionId(
        "record",
        identity,
        action.expected_local,
        remote,
        conflictKind,
        this.ports.runtime.digest
      ),
      entity: "record",
      local: action.expected_local,
      remote,
      conflict_kind: conflictKind
    };
    state.local_bindings ??= {};
    if (action.expected_local.state === "exact") {
      state.local_bindings[identity] = {
        entity: "record",
        path: action.expected_local.object.path
      };
    }
    if (current) {
      state.records[identity] = {
        path: current.path,
        revision: current.revision,
        hash: action.expected_local.state === "exact"
          ? action.expected_local.object.payload_revision.replace(/^sha256:/u, "")
          : this.ports.runtime.digest(current.document),
        ...(this.ports.mode === "read_write" ? { record: current } : {})
      };
    }
  }

  private async assertLocal(expected: ExpectedObjectState): Promise<void> {
    if (expected.state === "absent") return;
    if (!await this.matchesRef(expected.object)) {
      throw new SyncError(
        "sync_plan_stale",
        `${expected.object.path} no longer matches the inspected revision.`
      );
    }
  }

  private async assertPathOwner(
    path: string,
    expected: ExpectedObjectState,
    observedExists?: boolean
  ): Promise<void> {
    const owner = this.ownersByPath.get(path);
    if (expected.state === "absent") {
      if (owner || (observedExists ?? await this.pathExists(path))) {
        throw new SyncError("sync_plan_stale", `${path} is no longer vacant.`);
      }
      return;
    }
    if (!owner || owner.entity !== expected.object.entity || owner.identity !== expected.object.identity) {
      throw new SyncError("sync_plan_stale", `${path} has a different path owner.`);
    }
  }

  private async matchesRef(ref: SyncObjectRef): Promise<boolean> {
    if (ref.entity === "file") {
      const info = await this.ports.fileSystem.inspectBinary(ref.path);
      return info !== null
        && info.content_digest === ref.payload_revision
        && (ref.size === undefined || info.size === ref.size);
    }
    const document = await this.ports.fileSystem.read(ref.path);
    return document !== null
      && `sha256:${this.ports.runtime.digest(document)}` === ref.payload_revision;
  }

  private async pathExists(path: string): Promise<boolean> {
    return this.ports.fileSystem.exists(path);
  }

  private indexPathOwners(state: MirrorState): void {
    this.ownersByPath.clear();
    this.pathsByOwner.clear();
    for (const [identity, entry] of Object.entries(state.records)) {
      this.installPathOwner({
        entity: "record",
        identity,
        path: entry.path,
        revision: entry.revision,
        payload_revision: `sha256:${entry.hash}`
      });
    }
    for (const [identity, entry] of Object.entries(state.resources ?? {})) {
      this.installPathOwner({
        entity: "resource",
        identity,
        path: entry.path,
        revision: entry.revision,
        payload_revision: `sha256:${entry.hash}`
      });
    }
    for (const [identity, entry] of Object.entries(state.files ?? {})) {
      this.installPathOwner({
        entity: "file",
        identity,
        path: entry.file.path,
        revision: entry.file.revision,
        payload_revision: entry.file.content_digest,
        size: entry.file.size
      });
    }
  }

  private installPathOwner(ref: SyncObjectRef): void {
    const key = `${ref.entity}:${ref.identity}`;
    const previous = this.pathsByOwner.get(key);
    if (previous !== undefined) this.ownersByPath.delete(previous);
    this.ownersByPath.set(ref.path, ref);
    this.pathsByOwner.set(key, ref.path);
  }

  private removePathOwner(ref: SyncObjectRef): void {
    const key = `${ref.entity}:${ref.identity}`;
    const path = this.pathsByOwner.get(key) ?? ref.path;
    this.ownersByPath.delete(path);
    this.pathsByOwner.delete(key);
  }
}

function conflictDecisionId(
  entity: "record" | "file",
  identity: string,
  local: ExpectedObjectState,
  remote: ExpectedObjectState,
  conflictKind: "both_changed" | "delete_vs_change" | "path_occupied" | "rejected",
  digest: (value: string) => string
): string {
  return syncFingerprint({ entity, identity, local, remote, conflict_kind: conflictKind }, digest);
}

function moveStateEntry(state: MirrorState, source: SyncObjectRef, target: string): void {
  if (source.entity === "record") {
    const entry = state.records[source.identity];
    if (entry) entry.path = target;
  } else if (source.entity === "resource") {
    const entry = state.resources?.[source.identity];
    if (entry) entry.path = target;
  } else {
    const entry = state.files?.[source.identity];
    if (entry) entry.file.path = target;
  }
}

function removeStateEntry(state: MirrorState, target: SyncObjectRef): void {
  if (target.entity === "record") delete state.records[target.identity];
  else if (target.entity === "resource") delete state.resources?.[target.identity];
  else delete state.files?.[target.identity];
}

function assertExactDocument(
  record: SyncRecord,
  runtime: MirrorRuntime,
  revision: string
): void {
  const document = recordMarkdownDocument(record);
  if (record.revision !== revision || `sha256:${runtime.digest(document)}` !== revision) {
    throw new SyncError("invalid_sync_response", "Record receipt does not match its exact document revision.");
  }
}

function receiptResult(actionId: string, receipt: SyncMutationReceipt): DurableSyncReceipt {
  if (receipt.status === "applied" || receipt.status === "previously_applied") {
    return {
      action_id: actionId,
      status: "completed",
      ...(receipt.record ? { record: receipt.record } : {})
    };
  }
  return { action_id: actionId, status: receipt.status };
}

function missingPayload(action: SyncAction): SyncError {
  return new SyncError(
    "sync_payload_incomplete",
    `Prepared action ${action.action_id} has no exact payload capability.`
  );
}

function invalidReceipt(action: SyncAction): SyncError {
  return new SyncError(
    "invalid_sync_response",
    `Authority receipt does not match prepared action ${action.action_id}.`
  );
}

function failureFrom(error: unknown, actionId: string): SyncFailure {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    code: error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "sync_action_failed",
    message: value.message,
    action_id: actionId
  };
}

function uuidFromAction(actionId: string): string {
  const hex = actionId.replace(/^sha256:/u, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

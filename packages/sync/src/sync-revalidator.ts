import { SyncError } from "./sync-error.js";
import { runtimeDocumentRevision } from "./mirror-format.js";
import type { MirrorFileSystem, MirrorRuntime, MirrorState } from "./mirror-state.js";
import type { ExpectedObjectState, SyncAction, SyncObjectRef } from "./sync-model.js";
import type { ReconciliationPlan } from "./sync-planner.js";

/**
 * Last read-only boundary before preparation. A prepared batch thereafter owns
 * immutable payloads and is recovered by replay, never by consulting live paths.
 */
export class PlanRevalidator {
  constructor(
    private readonly fileSystem: MirrorFileSystem,
    private readonly runtime: MirrorRuntime
  ) {}

  async validate(plan: ReconciliationPlan, state: MirrorState | null): Promise<void> {
    if (
      (state?.generation ?? 0) !== plan.checkpoint_generation
      || (state?.cursor ?? null) !== plan.base_cursor
      || (state?.scope_epoch ?? plan.scope_epoch) !== plan.scope_epoch
    ) throw stale("The durable checkpoint changed after inspection.");
    for (const action of plan.actions) {
      if (action.depends_on.length === 0) await this.validateAction(action);
    }
  }

  private async validateAction(action: SyncAction): Promise<void> {
    switch (action.command) {
      case "write_local":
        await this.validateExpected(action.expected_local);
        await this.validateExpectedAt(action.target.path, action.expected_path_owner);
        return;
      case "delete_local":
        await this.validateExpected(action.expected_local);
        await this.validateExpectedAt(action.target.path, action.expected_path_owner);
        return;
      case "move_local":
        await this.validateExpectedAt(action.source.path, action.expected_source_owner);
        await this.validateExpectedAt(action.target_path, action.expected_target_owner);
        return;
      case "put_remote":
      case "move_remote":
        await this.validateExpected(action.expected_local);
        return;
      case "delete_remote":
        await this.validateExpectedAt(action.target.path, action.expected_local);
        return;
      case "record_conflict":
        await this.validateExpected(action.local);
        return;
      case "clear_conflict":
        await this.validateExpected(action.expected_local);
        return;
      case "advance_checkpoint":
        return;
    }
  }

  async validateExpectedAt(path: string, expected: ExpectedObjectState): Promise<void> {
    if (expected.state === "absent") {
      if (await this.fileSystem.exists(path)) throw stale(`${path} is no longer vacant.`);
      return;
    }
    if (
      expected.object.path !== path
      || !await matchesLocalRef(this.fileSystem, this.runtime, expected.object, true)
    ) {
      throw stale(`${path} no longer has the inspected owner and bytes.`);
    }
  }

  async validateExpected(expected: ExpectedObjectState): Promise<void> {
    if (expected.state === "absent") return;
    if (!await matchesLocalRef(this.fileSystem, this.runtime, expected.object, true)) {
      throw stale(`${expected.object.path} no longer matches the inspected bytes.`);
    }
  }

}

export async function matchesLocalRef(
  fileSystem: MirrorFileSystem,
  runtime: MirrorRuntime,
  ref: SyncObjectRef,
  revalidating: boolean
): Promise<boolean> {
  if (ref.entity === "file") {
    const info = await fileSystem.inspectBinary(ref.path);
    return !!info
      && info.content_digest === ref.payload_revision
      && (ref.size === undefined || info.size === ref.size);
  }
  let read;
  try {
    read = await fileSystem.readText(ref.path);
  } catch (error) {
    if (
      error instanceof SyncError
      && error.code === "file_read_failed"
      && revalidating
    ) throw stale(error.message);
    throw error;
  }
  return (typeof read === "string" ? runtimeDocumentRevision(read, runtime) : read?.revision)
    === ref.payload_revision;
}

export function stale(message: string): SyncError {
  return new SyncError("sync_plan_stale", message);
}

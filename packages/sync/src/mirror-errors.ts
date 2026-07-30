import { SyncError } from "./sync-error.js";

export class MirrorDivergenceError extends SyncError {
  constructor(public readonly recordId: string, public readonly path: string) {
    super("mirror_diverged", `Local edits at ${path} must be resolved before the mirror can continue.`);
  }
}

export class MirrorInitializationConflictError extends SyncError {
  constructor(public readonly paths: string[]) {
    super(
      "mirror_initialization_conflict",
      `Existing files differ from remote Markdown: ${paths.join(", ")}. Move or reconcile them before syncing.`
    );
  }
}

export class WritableMirrorConflictError extends SyncError {
  constructor(public readonly recordId: string, message: string) {
    super("writable_mirror_conflict", message);
  }
}

export class WritableMirrorRejectedError extends SyncError {
  constructor(
    public readonly recordId: string,
    public readonly rejectionCode: string,
    message: string
  ) {
    super("writable_mirror_rejected", `${rejectionCode}: ${message}`);
  }
}

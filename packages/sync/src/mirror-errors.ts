import { SyncError } from "./sync-error.js";

export class MirrorDivergenceError extends SyncError {
  constructor(public readonly recordId: string, public readonly path: string) {
    super("mirror_diverged", `Local edits at ${path} must be resolved before the mirror can continue.`);
  }
}

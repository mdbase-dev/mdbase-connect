import { MirrorDivergenceError } from "./mirror-errors.js";
import {
  validateRecordPath,
  type MirrorRecordPathPolicy
} from "./mirror-path-policy.js";
import type {
  MirrorFileSystem,
  MirrorState
} from "./mirror-state.js";

export async function assertMirrorUndiverged(
  state: MirrorState,
  pathPolicy: MirrorRecordPathPolicy,
  fileSystem: MirrorFileSystem,
  digest: (value: string) => string
): Promise<void> {
  for (const [recordId, entry] of Object.entries(state.records)) {
    validateRecordPath(entry.path, pathPolicy);
    const value = await fileSystem.read(entry.path);
    if (value === null || digest(value) !== entry.hash) {
      throw new MirrorDivergenceError(recordId, entry.path);
    }
  }
  for (const [path, entry] of Object.entries(state.resources ?? {})) {
    const value = await fileSystem.read(entry.path);
    if (value === null || digest(value) !== entry.hash) {
      throw new MirrorDivergenceError(`resource:${path}`, entry.path);
    }
  }
}

import type { SelectiveSyncPolicy } from "@mdbase-dev/connect-protocol";
import {
  authorityDocumentHash,
  authorityFileHash,
  authorityManifestDigest
} from "./mirror-format.js";
import { assertMirrorUndiverged } from "./mirror-integrity.js";
import type { MirrorRecordPathPolicy } from "./mirror-path-policy.js";
import type {
  AuthorityPromotionManifest,
  MirrorFileSystem,
  MirrorRuntime,
  MirrorState
} from "./mirror-state.js";
import { SyncError } from "./sync-error.js";

interface PromotionInput {
  state: MirrorState;
  selectiveSync: SelectiveSyncPolicy;
  fileSystem: MirrorFileSystem;
  pathPolicy: MirrorRecordPathPolicy;
  digest: MirrorRuntime["digest"];
}

/** Verify a full converged projection and commit its identities and hashes. */
export async function buildAuthorityPromotionManifest(
  input: PromotionInput
): Promise<AuthorityPromotionManifest> {
  const { state, selectiveSync, fileSystem, pathPolicy, digest } = input;
  if (selectiveSync.excluded_folders.length > 0 || selectiveSync.file_classes.length !== 5) {
    throw new SyncError(
      "promotion_incomplete_file_projection",
      "Moving the source of truth requires every collection file class with no excluded folders."
    );
  }
  if (
    Object.keys(state.planned_conflicts ?? {}).length > 0
    || state.batch !== undefined
  ) {
    throw new SyncError(
      "promotion_not_converged",
      "Upload or resolve every local change before moving the source of truth."
    );
  }
  await assertMirrorUndiverged(state, pathPolicy, fileSystem, digest);
  const resourcePaths = new Set(Object.keys(state.resources ?? {}));
  const managedPaths = new Set(Object.values(state.records).map((entry) => entry.path));
  const unmanaged = (await fileSystem.listMarkdown(resourcePaths))
    .filter((path) => !managedPaths.has(path));
  if (unmanaged.length > 0) {
    throw new SyncError(
      "promotion_unmanaged_files",
      `Synchronize unmanaged Markdown before promotion: ${unmanaged.join(", ")}.`
    );
  }
  if (!fileSystem.listBinary) {
    throw new SyncError(
      "promotion_file_scan_unavailable",
      "Moving the source of truth requires binary file enumeration."
    );
  }
  const managedFiles = new Set(Object.values(state.files ?? {}).map((entry) => entry.file.path));
  const unmanagedFiles = (await fileSystem.listBinary(new Set([
    ...resourcePaths,
    ...managedPaths
  ]))).filter((path) => !managedFiles.has(path));
  if (unmanagedFiles.length > 0) {
    throw new SyncError(
      "promotion_unmanaged_files",
      `Synchronize unmanaged files before moving the source of truth: ${unmanagedFiles.join(", ")}.`
    );
  }
  return {
    cursor: state.cursor,
    digest: authorityManifestDigest([
      ...Object.entries(state.resources ?? {}).map(([path, entry]) => ({
        kind: "resource" as const,
        path,
        identity: "",
        document_hash: authorityDocumentHash(entry.hash)
      })),
      ...Object.entries(state.records).map(([recordId, entry]) => ({
        kind: "record" as const,
        path: entry.path,
        identity: recordId,
        document_hash: authorityDocumentHash(entry.hash)
      })),
      ...Object.values(state.files ?? {}).map(({ file }) => ({
        kind: "file" as const,
        path: file.path,
        identity: file.file_id,
        document_hash: authorityFileHash(file)
      }))
    ])
  };
}

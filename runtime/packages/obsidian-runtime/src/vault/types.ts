/**
 * TS mirror of the `FilePlatform` vocabulary in `crates/store-file/src/{platform,host}.rs`
 * (`FileOp`, `FileOpOutput`, `Capabilities`, `FileEvent`, ...). The byte
 * encoding across the WASM ABI belongs to the `mdbn-wasm` ABI; these are the
 * shapes the vault platform produces and consumes.
 */

/** `FsErrorKind`. */
export type FsErrorKind =
  | "NotFound"
  | "AlreadyExists"
  | "Busy"
  | "WrongKind"
  | "PermissionDenied"
  | "NoSpace"
  | "InvalidPath"
  | "Unsupported"
  | "BadHandle"
  | "Other";

/** `FsError`. */
export class FsError extends Error {
  constructor(
    readonly kind: FsErrorKind,
    readonly detail: string,
  ) {
    super(`${kind}(${detail})`);
    this.name = "FsError";
  }
}

/** `FileKind`. */
export type FileKind = "File" | "Dir" | "Other";

/** `FileMeta` (times in nanoseconds since the epoch, as `bigint`). */
export interface FileMeta {
  readonly kind: FileKind;
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint | null;
  readonly id: null;
}

/** `DirEntry`. */
export interface DirEntry {
  readonly name: string;
  readonly kind: FileKind;
}

/** `ReadResult`. */
export interface ReadResult {
  readonly bytes: Uint8Array;
  readonly meta: FileMeta;
}

/** `Guarded`. */
export type Guarded = { readonly kind: "Done" } | { readonly kind: "Mismatch"; readonly current: Uint8Array } | { readonly kind: "Missing" } | { readonly kind: "Exists" };

/** `FlushScope`. */
export type FlushScope = { readonly kind: "File"; readonly path: string } | { readonly kind: "Dir"; readonly path: string } | { readonly kind: "Barrier" } | { readonly kind: "Full" };

/** `SignalStrength`. */
export type SignalStrength = "Weak" | "Medium" | "Strong";

/** `ForeignSyncSignal`. */
export interface ForeignSyncSignal {
  readonly tool: string;
  readonly strength: SignalStrength;
  readonly evidence: string;
}

/** `PlatformEnvironment`. */
export interface PlatformEnvironment {
  readonly rootDisplay: string | null;
  readonly signals: readonly ForeignSyncSignal[];
}

/** `Capabilities`. */
export interface Capabilities {
  readonly replace: "Exchange" | "LockedInPlace" | "GuardedInPlace" | "ReadOnly";
  readonly exclusiveCreate: boolean;
  readonly durability: "Fsync" | "None";
  readonly case: "Sensitive" | "Insensitive";
  readonly fileIds: boolean;
  readonly mtimeResolutionNs: bigint;
  readonly events: "Precise" | "Hint";
  readonly transientMissing: boolean;
  readonly privateDir: string;
}

/** `FileOp` (the subset a `GuardedInPlace` platform serves; the rest are `Unsupported`). */
export type FileOp =
  | { readonly op: "Environment" }
  | { readonly op: "Stat"; readonly path: string }
  | { readonly op: "Read"; readonly path: string }
  | { readonly op: "ReadRange"; readonly path: string; readonly offset: number; readonly len: number }
  | { readonly op: "List"; readonly dir: string }
  | { readonly op: "CreateDirAll"; readonly dir: string }
  | { readonly op: "WriteNew"; readonly path: string; readonly bytes: Uint8Array; readonly durable: boolean }
  | { readonly op: "Append"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly op: "RenameNoreplace"; readonly from: string; readonly to: string }
  | { readonly op: "RemoveFile"; readonly path: string }
  | { readonly op: "Flush"; readonly scope: FlushScope }
  | { readonly op: "Exchange"; readonly a: string; readonly b: string }
  | { readonly op: "OtherHolders"; readonly path: string }
  | { readonly op: "CopyMetadata"; readonly from: string; readonly to: string }
  | { readonly op: "Lock" | "LockedRead" | "LockedOverwrite" | "LockedMoveAside" | "Unlock"; readonly [k: string]: unknown }
  | { readonly op: "GuardedReplace"; readonly path: string; readonly expect: Uint8Array; readonly new: Uint8Array }
  | { readonly op: "GuardedCreate"; readonly path: string; readonly bytes: Uint8Array }
  | { readonly op: "GuardedTrash"; readonly path: string; readonly expect: Uint8Array };

/** `FileOpOutput`. */
export type FileOpOutput =
  | { readonly kind: "Unit" }
  | { readonly kind: "Environment"; readonly value: PlatformEnvironment }
  | { readonly kind: "Meta"; readonly value: FileMeta }
  | { readonly kind: "Read"; readonly value: ReadResult }
  | { readonly kind: "Bytes"; readonly value: Uint8Array }
  | { readonly kind: "Entries"; readonly value: readonly DirEntry[] }
  | { readonly kind: "Guarded"; readonly value: Guarded }
  | { readonly kind: "Holders"; readonly value: "None" | "Some" | "Unknown" };

/** `FileOpResult`. */
export type FileOpResult = { readonly ok: true; readonly value: FileOpOutput } | { readonly ok: false; readonly error: FsError };

/** `FileEventKind`. */
export type FileEventKind = "Changed" | "Created" | "Removed" | "RenamedFrom" | "RenamedTo" | "Rescan";

/** `FileEvent`. */
export interface FileEvent {
  readonly kind: FileEventKind;
  readonly path: string;
  readonly id: null;
  readonly cookie: bigint | null;
}

/**
 * `RelPath::new` validation, plus a second line of defence for Windows vaults
 * (portable path confinement): `:` (drive letters, NTFS alternate data streams) and
 * control characters are refused here too, even though the core's path policy
 * already rejects them.
 */
export function checkRelPath(s: string): void {
  if (s === "") return;
  // eslint-disable-next-line no-control-regex
  const bad = s.startsWith("/") || s.endsWith("/") || s.includes("\\") || s.includes(":") || /[\u0000-\u001f\u007f]/.test(s) || s.split("/").some((seg) => seg === "" || seg === "." || seg === "..");
  if (bad) throw new FsError("InvalidPath", s);
}

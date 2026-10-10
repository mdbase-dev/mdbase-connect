/**
 * The editor fence: publishing into an open Obsidian editor instead of the file
 * (open-editor publication, `replica-client-api.md` §14,
 * `crates/store-file/src/fence.rs`).
 *
 * Obsidian's editor saves the whole buffer blindly about 2 s after the first
 * unsaved keystroke. Any write that lands on disk in that window is reverted,
 * however atomically it was made. So while a file is open, the replica's change
 * goes **through the buffer** as one minimal CodeMirror transaction, and the
 * editor's own save carries it to disk. This preserves one writer for an open
 * buffer instead of racing a vault-file write against a later editor save.
 * The buffer hash checks and conflict/hold paths below remain mandatory.
 *
 * Rules:
 * - **Never a blind write.** An edit is applied only to a buffer whose content
 *   hashes to the change's base.
 *   - If the buffer moved on (the user typed), `fence_apply` returns
 *     `buffer_changed` with the buffer, and the replica re-plans or holds.
 *   - The `EditorFence` trait form (`base`, `new`) instead three-way merges the
 *     change onto the buffer with the runtime's line merge. Any overlap with the
 *     user's edits is a `Conflict`: nothing is applied, and the store holds.
 * - **Check and dispatch in one tick.** Hashing is async (WebCrypto), so the
 *   buffer is compared again synchronously, right before the transaction is
 *   dispatched.
 * - **Dirty state.** It is only observable through private fields (`view.dirty`,
 *   `view.saving`, `view.lastSavedData`). They are pinned per Obsidian version in
 *   {@link PINNED}. On an unpinned version, the fields are probed by type, and if
 *   they don't look right the fence reports `Unknown`, so the store falls back to
 *   the quiet period. `editor.getValue() !== view.lastSavedData` is the reliable
 *   signal (editor dirty-state detection). `view.data` is not: it tracks the buffer within about 60 ms.
 */

import { sha256 } from "../util/hash.js";

/** The parts of Obsidian's `Editor` used. Offsets are UTF-16 code units. */
export interface EditorLike {
  getValue(): string;
  offsetToPos(offset: number): { line: number; ch: number };
  transaction(tx: { changes: { from: { line: number; ch: number }; to?: { line: number; ch: number }; text: string }[] }, origin?: string): void;
}

/** The parts of a `MarkdownView` used, including the private fields. */
export interface MarkdownViewLike {
  file: { path: string } | null;
  editor: EditorLike;
  /** Private. */
  dirty?: unknown;
  /** Private. */
  saving?: unknown;
  /** Private. */
  lastSavedData?: unknown;
}

/** The parts of `app.workspace` used. */
export interface WorkspaceLike {
  getLeavesOfType(type: "markdown"): { view: unknown }[];
  on(name: "layout-change" | "file-open" | "editor-change", cb: (...args: unknown[]) => void): unknown;
  offref(ref: unknown): void;
}

/** `EditorState` of the store's fence trait. */
export type EditorState = { readonly kind: "Closed" } | { readonly kind: "Open"; readonly dirty: boolean } | { readonly kind: "Unknown" };

/** `FenceOutcome` of the store's fence trait. */
export type FenceOutcome =
  | { readonly kind: "Applied" }
  | { readonly kind: "Conflict"; readonly buffer: string }
  | { readonly kind: "NotOpen" }
  | { readonly kind: "Unavailable" };

/** One `fence_report` entry (§14). */
export interface FenceReportEntry {
  readonly path: string;
  readonly dirty: boolean;
  readonly bufferHash: Uint8Array;
}

/** `fence_apply` result (§14): `applied: 0, not_open: 1, buffer_changed: 2`. */
export type FenceApplyResult = { readonly status: "applied" } | { readonly status: "not_open" } | { readonly status: "buffer_changed"; readonly buffer: string };

/** One edit `[start, end, insert]`, offsets in Unicode scalar values over the whole document. */
export type ScalarEdit = readonly [number, number, string];

/** Three-way line merge from `runtime.wasm` (`mdbn_core::merge::merge_body`): `null` on conflict. */
export type MergeFn = (base: string, ours: string, theirs: string) => string | null;

/**
 * Obsidian versions with pinned private fields (1.12.7 Linux, 1.13.7
 * Windows, 1.13.8 Android). Add a row after re-verifying on a new release with
 * the e2e fence suite.
 */
export const PINNED: readonly { readonly range: string; readonly fields: readonly ("dirty" | "saving" | "lastSavedData")[] }[] = [
  { range: "1.12", fields: ["dirty", "saving", "lastSavedData"] },
  { range: "1.13", fields: ["dirty", "saving", "lastSavedData"] },
];

/** Whether `apiVersion` (e.g. `1.13.8`) is pinned. */
export function isPinned(apiVersion: string): boolean {
  return PINNED.some((p) => apiVersion === p.range || apiVersion.startsWith(`${p.range}.`));
}

function asView(v: unknown): MarkdownViewLike | null {
  const m = v as MarkdownViewLike;
  return m && typeof m === "object" && m.editor && typeof m.editor.getValue === "function" && m.file ? m : null;
}

/** Private fields look as expected (probe for unpinned versions). */
function fieldsLookRight(v: MarkdownViewLike): boolean {
  return typeof v.dirty === "boolean" && typeof v.saving === "boolean" && typeof v.lastSavedData === "string";
}

/** Convert Unicode-scalar offsets in `s` to UTF-16 offsets (one pass for many offsets). */
export function scalarToUtf16(s: string, offsets: readonly number[]): number[] {
  const order = offsets.map((o, i) => [o, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(offsets.length);
  let scalar = 0;
  let u16 = 0;
  let k = 0;
  while (k < order.length) {
    const [want, idx] = order[k]!;
    if (want === scalar) {
      out[idx] = u16;
      k++;
      continue;
    }
    if (u16 >= s.length) throw new RangeError(`offset ${want} beyond the document (${scalar} scalars)`);
    const c = s.charCodeAt(u16);
    u16 += c >= 0xd800 && c <= 0xdbff && u16 + 1 < s.length ? 2 : 1;
    scalar++;
  }
  return out;
}

/** The minimal single replacement turning `a` into `b` (common prefix and suffix), in UTF-16 offsets. */
export function minimalChange(a: string, b: string): { from: number; to: number; text: string } | null {
  if (a === b) return null;
  let p = 0;
  const max = Math.min(a.length, b.length);
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  // Don't split a surrogate pair.
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { from: p, to: a.length - s, text: b.slice(p, b.length - s) };
}
const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** Apply scalar-offset edits to a string (for computing the expected result). */
export function applyScalarEdits(s: string, edits: readonly ScalarEdit[]): string {
  const sorted = [...edits].sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < sorted.length; i++) if (sorted[i]![0] < sorted[i - 1]![1]) throw new RangeError("overlapping edits");
  const u = scalarToUtf16(s, sorted.flatMap((e) => [e[0], e[1]]));
  let out = "";
  let at = 0;
  sorted.forEach((e, i) => {
    out += s.slice(at, u[2 * i]) + e[2];
    at = u[2 * i + 1]!;
  });
  return out + s.slice(at);
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

const enc = new TextEncoder();
const hashText = (s: string) => sha256(enc.encode(s));

/** The fence for one Obsidian window. */
export class ObsidianEditorFence {
  private readonly pinned: boolean;
  private refs: unknown[] = [];

  /**
   * @param apiVersion `apiVersion` from `obsidian`
   * @param merge      the runtime's line merge, for the `(base, new)` form
   */
  constructor(
    private readonly workspace: WorkspaceLike,
    apiVersion: string,
    private readonly merge: MergeFn | null = null,
  ) {
    this.pinned = isPinned(apiVersion);
  }

  /** Open markdown views of collection paths. */
  views(path?: string): MarkdownViewLike[] {
    const out: MarkdownViewLike[] = [];
    for (const leaf of this.workspace.getLeavesOfType("markdown")) {
      const v = asView(leaf.view);
      if (v && (path === undefined || v.file!.path === path)) out.push(v);
    }
    return out;
  }

  /** Whether one view has unsaved changes, or `null` when it can't tell. */
  private dirtyOf(v: MarkdownViewLike): boolean | null {
    if (!this.pinned && !fieldsLookRight(v)) return null;
    if (typeof v.lastSavedData !== "string") return null;
    return v.dirty === true || v.saving === true || v.editor.getValue() !== v.lastSavedData;
  }

  /** `EditorFence::state`. */
  state(path: string): EditorState {
    const vs = this.views(path);
    if (vs.length === 0) return { kind: "Closed" };
    let dirty = false;
    for (const v of vs) {
      const d = this.dirtyOf(v);
      if (d === null) return { kind: "Unknown" };
      dirty ||= d;
    }
    return { kind: "Open", dirty };
  }

  /** `fence_report` (§14): every open file with its dirty flag and buffer hash. */
  async report(): Promise<FenceReportEntry[]> {
    const out: FenceReportEntry[] = [];
    const seen = new Set<string>();
    for (const v of this.views()) {
      const path = v.file!.path;
      if (seen.has(path)) continue;
      seen.add(path);
      const s = this.state(path);
      out.push({ path, dirty: s.kind === "Open" ? s.dirty : true, bufferHash: await hashText(v.editor.getValue()) });
    }
    return out;
  }

  /**
   * `fence_apply` (§14): apply `edits` to every buffer of `path` whose content
   * hashes to `base`, giving `expected`.
   */
  async applyEdits(path: string, base: Uint8Array, edits: readonly ScalarEdit[], expected: Uint8Array): Promise<FenceApplyResult> {
    const vs = this.views(path);
    if (vs.length === 0) return { status: "not_open" };
    for (const v of vs) {
      const before = v.editor.getValue();
      const h = await hashText(before);
      if (eqBytes(h, expected)) continue; // already there (a split view of the same file)
      if (!eqBytes(h, base)) return { status: "buffer_changed", buffer: before };
      let next: string;
      try {
        next = applyScalarEdits(before, edits);
      } catch {
        return { status: "buffer_changed", buffer: before };
      }
      if (!eqBytes(await hashText(next), expected)) return { status: "buffer_changed", buffer: before };
      // Synchronous re-check and dispatch: no keystroke can land in between.
      if (v.editor.getValue() !== before) return { status: "buffer_changed", buffer: v.editor.getValue() };
      this.dispatch(v.editor, before, next);
    }
    return { status: "applied" };
  }

  /**
   * `EditorFence::apply` (store-file trait form): bring `base → new` into every
   * open buffer of `path`, merging with unsaved typing, or report a conflict.
   */
  async apply(path: string, base: string, next: string): Promise<FenceOutcome> {
    const vs = this.views(path);
    if (vs.length === 0) return { kind: "NotOpen" };
    for (const v of vs) {
      const buffer = v.editor.getValue();
      let target: string | null;
      if (buffer === next) continue;
      if (buffer === base) target = next;
      else if (this.merge) target = this.merge(base, buffer, next);
      else return { kind: "Conflict", buffer };
      if (target === null) return { kind: "Conflict", buffer };
      if (v.editor.getValue() !== buffer) return { kind: "Conflict", buffer: v.editor.getValue() };
      this.dispatch(v.editor, buffer, target);
    }
    return { kind: "Applied" };
  }

  private dispatch(editor: EditorLike, from: string, to: string): void {
    const c = minimalChange(from, to);
    if (!c) return;
    editor.transaction({ changes: [{ from: editor.offsetToPos(c.from), to: editor.offsetToPos(c.to), text: c.text }] }, "mdbase.sync");
  }

  /** Call `onChange` (debounced by the caller) when open files or dirty state may have changed. */
  watch(onChange: () => void): void {
    this.refs.push(this.workspace.on("layout-change", onChange), this.workspace.on("file-open", onChange), this.workspace.on("editor-change", onChange));
  }

  unwatch(): void {
    for (const r of this.refs.splice(0)) this.workspace.offref(r);
  }

  /** Whether this Obsidian version's private fields are pinned. */
  get isPinned(): boolean {
    return this.pinned;
  }
}

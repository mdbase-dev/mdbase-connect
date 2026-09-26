// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import type { JsonObject, MdbaseConnection, MutationProgress, WatchStatus } from "../../../api-candidate/index.js";

declare const connection: MdbaseConnection<JsonObject>;
declare const abortController: AbortController;
declare function renderProblem(problem: { message: string }): void;
declare function renderProgress(loaded: number): void;
declare function appendRows(rows: readonly unknown[]): void;
declare function applyChange(type: string, path: unknown): void;
declare function renderWatchStatus(status: WatchStatus): void;
declare function showImpact(references: unknown, warnings: unknown): void;
declare function renderMutationProgress(progress: MutationProgress): void;

export async function readQuery(): Promise<void> {
  const record = await connection.read({ path: "tasks/release.md" });
  if (!record.ok) return renderProblem(record.problem);

  const open = await connection.query({
    types: ["task"],
    where: 'status == "open" && due != null',
    orderBy: [{ field: "due", direction: "asc" }],
    limit: 100
  });
  if (!open.ok) return renderProblem(open.problem);
}

export async function pageQuery(): Promise<void> {
  let loaded = 0;
  for await (const page of connection.queryPages(
    { types: ["task"], where: 'status != "done"' },
    { firstPageSize: 100, pageSize: 1000, signal: abortController.signal }
  )) {
    if (!page.ok) return renderProblem(page.problem);
    appendRows(page.value.results);
    renderProgress(loaded += page.value.results.length);
  }
}

export async function createUpdate(): Promise<void> {
  const created = await connection.create({
    path: "tasks/release.md",
    type: "task",
    frontmatter: { type: "task", title: "Prepare release", status: "open" },
    body: "Release checklist."
  });
  if (!created.ok) return renderProblem(created.problem);

  const updated = await connection.update({
    path: created.value.path,
    patch: { status: "done" },
    ifRevision: created.value.revision
  });
  if (!updated.ok && updated.problem.code === "concurrent_modification") {
    // Changed since it was read: refresh, then let the user or domain logic decide.
  }
}

export async function watch(): Promise<void> {
  const lifetime = new AbortController();
  const opened = await connection.watch({ lifetimeSignal: lifetime.signal }, { timeoutMs: 20_000 });
  if (!opened.ok) return renderProblem(opened.problem);
  const unsubscribe = opened.value.subscribe(
    (change) => applyChange(change.type, change.payload.path),
    renderWatchStatus,
    renderProblem
  );
  // Leaving: unsubscribe(); opened.value.close();
  void unsubscribe;
}

export async function preflight(current: { revision: string }): Promise<void> {
  const preview = await connection.preflightRename({
    from: "tasks/release.md",
    to: "archive/release.md",
    updateRefs: true,
    ifRevision: current.revision
  });
  if (!preview.ok) return renderProblem(preview.problem);
  showImpact(preview.value.referencesAffected, preview.value.warnings);

  const renamed = await connection.renameWithProgress({
    from: preview.value.from,
    to: preview.value.to,
    updateRefs: true,
    ifRevision: current.revision
  }, {
    preflight: preview.value,
    signal: abortController.signal,
    onProgress: renderMutationProgress
  });
  if (!renamed.ok) renderProblem(renamed.problem);
}

export async function recover(): Promise<void> {
  for (const pending of connection.pendingMutations()) {
    const recovered = await pending.recover({ timeoutMs: 30_000 });
    if (!recovered.ok) renderProblem(recovered.problem);
  }
}

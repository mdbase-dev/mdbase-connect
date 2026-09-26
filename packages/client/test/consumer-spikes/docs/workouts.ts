// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import { session } from "./connect.js";

declare function renderProblem(problem: { message: string }): void;

const workout = { id: "workout.record", version: "1.0.0" };

export async function completeNextWorkout(): Promise<void> {
  const connection = session.connection();
  if (!connection) return;

  const page = await connection.query({ contract: workout, limit: 50 });
  if (!page.ok) return renderProblem(page.problem);

  const next = page.value.results
    .filter((row) => row.effectiveFrontmatter?.completed !== true)
    .sort((left, right) =>
      String(left.effectiveFrontmatter?.title).localeCompare(String(right.effectiveFrontmatter?.title))
    )[0];
  if (!next) return;

  // Read the record to learn its current revision, then update against it.
  const current = await connection.read({ path: next.path, contract: workout });
  if (!current.ok) return renderProblem(current.problem);

  const updated = await connection.update({
    path: current.value.path,
    contract: workout,
    patch: { completed: true },
    ifRevision: current.value.revision
  });
  if (!updated.ok && updated.problem.code === "concurrent_modification") {
    return completeNextWorkout(); // It changed elsewhere: start again from the current record.
  }
  if (!updated.ok) renderProblem(updated.problem);
}

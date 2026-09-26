// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import type { JsonObject, MdbaseConnection, UpdateInput } from "../../../api-candidate/index.js";

declare const connection: MdbaseConnection<JsonObject>;
declare const input: UpdateInput;
declare function renderDiagnostics(diagnostics: readonly JsonObject[]): void;
declare function renderProblem(code: string, recovery: string): void;

export async function update(): Promise<void> {
  const updated = await connection.update(input);
  if (!updated.ok) {
    if (updated.problem.code === "operation_invalid") {
      renderDiagnostics(updated.problem.details.diagnostics);
    } else {
      renderProblem(updated.problem.code, updated.problem.recovery);
    }
  }
}

// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import { session } from "./connect.js";

declare function renderProblem(problem: { message: string }): void;

export async function connectCollection(): Promise<void> {
  // Opens Connect to choose a collection; the manifest declares what is requested.
  const authorized = await session.authorize("choose");
  if (!authorized.ok) renderProblem(authorized.problem);
}

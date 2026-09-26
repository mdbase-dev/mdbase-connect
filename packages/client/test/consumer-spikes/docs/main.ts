// Mirrors an mdbase.dev SDK documentation example; keep it compiling.
import { connectCollection } from "./connect-button.js";
import { session } from "./connect.js";

declare function render(snapshot: ReturnType<typeof session.getSnapshot>): void;
declare function renderProblem(problem: { message: string }): void;

session.subscribe(() => render(session.getSnapshot()));

const started = await session.start({ timeoutMs: 20_000 });
if (!started.ok) renderProblem(started.problem);

if (location.pathname === "/auth/mdbase/callback") {
  const completed = await session.completeAuthorization(location.href, { timeoutMs: 15_000 });
  if (!completed.ok) renderProblem(completed.problem);
}

document
  .querySelector("[data-connect-mdbase]")
  ?.addEventListener("click", () => void connectCollection());

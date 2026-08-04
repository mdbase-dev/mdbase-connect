import {
  MdbaseConnect,
  MdbaseBrowserSelection,
  type JsonObject
} from "../../api-candidate/index.js";

interface WorkoutFrontmatter extends JsonObject {
  type: "workout";
  duration?: number;
}

export async function workoutsSpike(): Promise<void> {
  const connect = new MdbaseConnect<WorkoutFrontmatter>({
    serverUrl: new URL("https://connect.example"),
    manifest: new URL("https://workouts.example/.well-known/mdbase-app.json"),
    timeouts: { requestMs: 15_000 }
  });
  const session = connect.application({ selection: new MdbaseBrowserSelection() });
  const started = await session.start();
  if (!started.ok) return;
  const connection = session.connection();
  if (!connection) return;
  await connection.query({ types: ["workout"] });
  await connection.create({ path: "Workouts/one.md", frontmatter: { type: "workout" }, body: "" });
  await connection.update({ path: "Workouts/one.md", patch: { type: "workout", duration: 60 }, body: "" });
  await connection.delete({ path: "Workouts/one.md" });
  // @ts-expect-error beta.28 session factory is intentionally absent.
  connect.createApplicationSession({ selection: new MdbaseBrowserSelection() });
}

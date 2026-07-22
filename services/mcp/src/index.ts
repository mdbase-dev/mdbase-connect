import { buildApp } from "./app.js";
import { runtimeConfigFromEnv } from "./config.js";
import { createDatabase } from "./db.js";

const config = runtimeConfigFromEnv(process.env);
const db = await createDatabase();
const { app } = await buildApp({ db, config, revision: process.env.RENDER_GIT_COMMIT });

await app.listen({ host: config.host, port: config.port });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    await app.close();
    await db.end();
    process.exit(0);
  });
}

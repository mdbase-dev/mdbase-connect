/** Required entrypoint for the isolated admission profile, never the shared Worker.
 * Missing runtime configuration cannot fall back to ordinary actor routing.
 */
import worker, { HostedCollection as SharedHostedCollection } from "./worker.ts";
/** The required profile cannot acquire ordinary actor behavior even when ALL
 * configuration is missing (alarms/sockets do not pass through Worker.fetch). */
export class HostedCollection extends SharedHostedCollection {
  constructor(ctx: DurableObjectState, env: Env) { super(ctx, env, true); }
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const binding = (env as Env & { PITR_BINDING?: string }).PITR_BINDING;
    if (typeof binding !== "string" || binding.length === 0) return new Response("unavailable", { status: 503 });
    return worker.fetch(request, env);
  },
} satisfies ExportedHandler<Env>;

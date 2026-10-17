/**
 * Placement of newly created `COLLECTIONS` actors. A Durable Object is created
 * near its first caller and never moves, so a collection first reached from a
 * far-away control plane otherwise lives far from the log service and storage.
 *
 * `HOSTED_DO_LOCATION_HINT` is the default region (`oc`, `apac`, `wnam`, `enam`,
 * `weur`), passed as the Cloudflare location hint when a stub is created. Absent
 * or empty keeps the platform default (near the caller). Any other value is a
 * configuration error: the Worker refuses actor requests with 503 instead of
 * silently using the default.
 *
 * A collection's creating request (activation, migration admission) may name the
 * collection's region (`region`: one of the regions, or `default`) so the actor
 * is created next to the collection's log actor and storage. The control plane
 * takes it from the log service's `create_log` reply (key 2), so the log must
 * exist before the actor's first request (docs/ship/rollout.md §1.2). Every other request
 * uses the default. Hints only affect objects that do not exist yet; existing
 * actors stay put.
 */
export const DO_LOCATION_HINT_VAR = "HOSTED_DO_LOCATION_HINT";

const HINTS: ReadonlySet<string> = new Set(["oc", "apac", "wnam", "enam", "weur"]);

/** `null` = invalid configuration; `undefined` = platform default. */
export type LocationHint = DurableObjectLocationHint | undefined | null;

export function parseLocationHint(raw: unknown): LocationHint {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return undefined;
  return HINTS.has(value) ? value as DurableObjectLocationHint : null;
}

export function locationHint(env: object): LocationHint {
  return parseLocationHint((env as Record<string, unknown>)[DO_LOCATION_HINT_VAR]);
}

/** The named actor's stub, created with a valid (already checked) hint. */
export function namedStub<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: Pick<DurableObjectNamespace<T>, "idFromName" | "get">,
  name: string,
  hint: LocationHint,
): DurableObjectStub<T> {
  if (hint === null) throw new Error(`${DO_LOCATION_HINT_VAR} is not a location hint`);
  const id = namespace.idFromName(name);
  return hint === undefined ? namespace.get(id) : namespace.get(id, { locationHint: hint });
}

/** A creating request's `region`: `undefined` = absent or `default` (use the
 * configured default), `null` = invalid (refuse the request). */
export function parseRegion(raw: unknown): LocationHint {
  if (raw === undefined || raw === "default") return undefined;
  return typeof raw === "string" && HINTS.has(raw) ? raw as DurableObjectLocationHint : null;
}

import { exactNextPermissionCapabilities, projectNextAuthorizationGroups } from "@mdbase-dev/connect-protocol/next-authorization";
import type { ApplicationRequirements } from "../../application-requirements.js";
import type { DatabaseQueryable } from "../../database-types.js";
import { planCollectionGrant, type GrantPlan } from "../../grant-planner.js";
import { RequestValidationError } from "../../platform/http-errors.js";

export interface FreshLegacyAuthorization {
  requirements: ApplicationRequirements;
  requestedOperations: readonly string[];
}

function refusal(): never {
  throw new RequestValidationError("This app needs an update before it can connect. Try again after it updates.", {
    statusCode: 409, code: "application_reauthorization_required"
  });
}

/** Revalidate fresh legacy approval, not a replay or an existing grant mutation. */
export function freshLegacyNextOperations(input: FreshLegacyAuthorization, proposed: readonly string[]): string[] {
  if (input.requirements.capabilities?.contract_version !== 1 || proposed.some(operation => !input.requestedOperations.includes(operation))) return refusal();
  const offered = projectNextAuthorizationGroups(input.requirements, input.requestedOperations);
  if (offered.error) return refusal();
  const selected = offered.groups.filter(group => group.operations.every(operation => proposed.includes(operation)));
  if (offered.groups.some(group => group.required && !selected.includes(group))) return refusal();
  const operations = [...new Set(selected.flatMap(group => group.operations))];
  const files = input.requirements.files;
  if (files && !("actions" in files)) return refusal();
  if (!exactNextPermissionCapabilities(operations, files?.actions ?? [])) return refusal();
  return operations;
}

/** Fresh issuance front door. Legacy collections and v2 keep their current planner. */
export async function planFreshNextGrant(
  db: DatabaseQueryable,
  collection: string,
  input: Parameters<typeof planCollectionGrant>[0]
): Promise<{ plan: GrantPlan; legacy?: FreshLegacyAuthorization }> {
  if (input.requirements.capabilities?.contract_version !== 1) return { plan: planCollectionGrant(input) };
  const native = await db.query(
    "SELECT 1 FROM next_collections WHERE collection_id = $1 AND runtime = 'next' AND left_sync_at IS NULL FOR SHARE", [collection]
  );
  if (!native.rows.length) return { plan: planCollectionGrant(input) };
  const legacy = { requirements: input.requirements, requestedOperations: input.applicationOperationCeiling };
  const operations = freshLegacyNextOperations(legacy, input.requestedOperations);
  const plan = planCollectionGrant({ ...input, requestedOperations: operations as GrantPlan["operations"] });
  return { plan, legacy };
}

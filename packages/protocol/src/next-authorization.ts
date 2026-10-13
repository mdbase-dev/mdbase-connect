import { APPLICATION_CAPABILITY_DEFINITIONS, APPLICATION_CAPABILITY_V1_DEFINITIONS, APPLICATION_SETUP_OPERATIONS, type ApplicationCapabilityId } from "./capabilities.js";
import type { ApplicationRequirements, LegacyApplicationRequirements } from "./application-declaration.js";
import type { FileAction } from "./files.js";
import type { CollectionOperation } from "./operations.js";

/** Exact record/file pairs used by both consent and next policy publication. */
export const NEXT_CAPABILITY_FILE_ACTIONS: Partial<Record<ApplicationCapabilityId, readonly FileAction[]>> = {
  "collection.read": ["list", "read"], "records.create": ["add"],
  "records.edit": ["replace", "move"], "records.delete": ["delete"]
};

export interface NextAuthorizationGroup {
  id: ApplicationCapabilityId;
  operations: CollectionOperation[];
  fileActions: readonly FileAction[];
  required: boolean;
}

const UPDATE_REQUIRED = "This app needs an update before it can connect. Try again after it updates.";
const refuse = (): { groups: NextAuthorizationGroup[]; error: string } => ({ groups: [], error: UPDATE_REQUIRED });
const fileActions = new Set(["list", "read", "add", "replace", "move", "delete"]);
const equalSet = (left: readonly string[], right: readonly string[]) => {
  const a = new Set(left), b = new Set(right);
  return a.size === b.size && [...a].every(value => b.has(value));
};

type Requirements = {
  access?: ApplicationRequirements["access"];
  capabilities?: ApplicationRequirements["capabilities"] | LegacyApplicationRequirements["capabilities"];
  files?: ApplicationRequirements["files"] | LegacyApplicationRequirements["files"];
};

/** Fresh offers only. Never change the original declaration or a retained grant. */
export function projectNextAuthorizationGroups(
  requirements: Requirements,
  requested: readonly string[]
): { groups: NextAuthorizationGroup[]; error?: string } {
  const declaration = requirements.capabilities;
  if (!declaration || (declaration.contract_version !== 1 && declaration.contract_version !== 2)
      || !Array.isArray(declaration.required) || (declaration.optional !== undefined && !Array.isArray(declaration.optional))) return refuse();
  const legacy = declaration.contract_version === 1;
  if (legacy && requirements.access !== "full_collection") return refuse();
  const catalog = legacy ? APPLICATION_CAPABILITY_V1_DEFINITIONS : APPLICATION_CAPABILITY_DEFINITIONS;
  const ids = [...declaration.required, ...(declaration.optional ?? [])];
  if (ids.some(id => !Object.hasOwn(catalog, id)) || new Set(ids).size !== ids.length) return refuse();
  const files = requirements.files;
  if (files && (legacy
    ? !("actions" in files) || "required" in files || "optional" in files || !Array.isArray(files.actions)
    : !("required" in files) || "actions" in files || !Array.isArray(files.required)
      || (files.optional !== undefined && !Array.isArray(files.optional)))) return refuse();
  const requiredFiles: readonly FileAction[] = files ? "actions" in files ? files.actions : files.required : [];
  const declaredFiles: readonly FileAction[] = files ? "actions" in files ? files.actions : [...files.required, ...(files.optional ?? [])] : [];
  if (declaredFiles.some(action => !fileActions.has(action)) || new Set(declaredFiles).size !== declaredFiles.length) return refuse();
  const requestedSet = new Set(requested);
  const expansions = catalog as Readonly<Record<string, readonly CollectionOperation[]>>;
  const requiredOperations = new Set(declaration.required.flatMap(id => expansions[id] ?? []));
  if (legacy) {
    const allowed = new Set(ids.flatMap(id => expansions[id] ?? []));
    if (requested.some(operation => !allowed.has(operation as CollectionOperation))) return refuse();
    // A required file capability cannot disappear just because its operation
    // expansion is empty in the predecessor catalog.
    if (declaration.required.some(id => id.startsWith("files.") && !declaredFiles.includes(id.slice(6) as FileAction))) return refuse();
  }
  const candidates = legacy ? Object.keys(APPLICATION_CAPABILITY_DEFINITIONS) as ApplicationCapabilityId[] : ids as ApplicationCapabilityId[];
  const groups: NextAuthorizationGroup[] = [];
  for (const id of candidates) {
    const operations = [...APPLICATION_CAPABILITY_DEFINITIONS[id]] as CollectionOperation[];
    const pairedFiles = NEXT_CAPABILITY_FILE_ACTIONS[id] ?? [];
    const required = operations.some(operation => requiredOperations.has(operation)) || pairedFiles.some(action => requiredFiles.includes(action));
    if (id === "offline.replica" || !operations.every(operation => requestedSet.has(operation))
        || !pairedFiles.every(action => declaredFiles.includes(action))) {
      if (required) return refuse();
      continue;
    }
    if (legacy && id === "definitions.manage" && APPLICATION_SETUP_OPERATIONS.every(operation => requestedSet.has(operation))) operations.push(...APPLICATION_SETUP_OPERATIONS);
    groups.push({ id, operations, fileActions: pairedFiles, required });
  }
  const covered = new Set(groups.flatMap(group => group.operations));
  if ([...requiredOperations].some(operation => !covered.has(operation))
      || requiredFiles.some(action => !groups.some(group => group.fileActions.includes(action))) || groups.length === 0) return refuse();
  return { groups };
}

/** Exact projection: no dropping or rounding of stored/approved permissions. */
export function exactNextPermissionCapabilities(operations: readonly string[], files: readonly string[]): ApplicationCapabilityId[] | undefined {
  const groups = (Object.keys(APPLICATION_CAPABILITY_DEFINITIONS) as ApplicationCapabilityId[]).filter(id =>
    id !== "offline.replica" && APPLICATION_CAPABILITY_DEFINITIONS[id].every(operation => operations.includes(operation)));
  const expected: string[] = groups.flatMap(id => [...APPLICATION_CAPABILITY_DEFINITIONS[id]]);
  const setup = APPLICATION_SETUP_OPERATIONS.filter(operation => operations.includes(operation));
  if (setup.length) {
    if (setup.length !== APPLICATION_SETUP_OPERATIONS.length || !groups.includes("definitions.manage")) return undefined;
    expected.push(...setup);
  }
  if (!groups.length || !equalSet(expected, operations)
      || !equalSet(groups.flatMap(id => [...(NEXT_CAPABILITY_FILE_ACTIONS[id] ?? [])]), files)) return undefined;
  return groups.sort();
}

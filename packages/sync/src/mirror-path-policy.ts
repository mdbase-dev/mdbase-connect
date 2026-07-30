import type {
  JsonObject,
  SyncChange,
  SyncResourceDocument
} from "@mdbase/connect-protocol";
import { parse } from "yaml";
import { SyncError } from "./sync-error.js";
import { documentRevision, parseMarkdown } from "./mirror-format.js";
import {
  portableMirrorPathKey,
  portableMirrorPathKeyForValidatedPath,
  validatePortableMirrorPath
} from "./portable-path.js";

interface CollectionSettings {
  types_folder?: unknown;
  contracts_folder?: unknown;
  migrations_folder?: unknown;
  cache_folder?: unknown;
}

interface CollectionConfiguration {
  spec_version?: unknown;
  settings?: CollectionSettings;
}

export interface MirrorRecordPathPolicy {
  reservedFolders: ReadonlySet<string>;
  resourcePaths: ReadonlySet<string>;
}

export function validateSnapshotResources(
  resources: readonly SyncResourceDocument[]
): MirrorRecordPathPolicy {
  if (resources.length === 0) return defaultRecordPathPolicy(new Set());
  const paths = new Set<string>();
  const physicalPaths = new Map<string, string>();
  for (const resource of resources) {
    const physicalPath = portableMirrorPathKey(resource.path);
    const existing = physicalPaths.get(physicalPath);
    if (existing !== undefined) {
      throw new SyncError(
        "invalid_snapshot",
        `Hosted resource paths ${existing} and ${resource.path} alias on a supported filesystem.`
      );
    }
    physicalPaths.set(physicalPath, resource.path);
    if (paths.has(resource.path)) {
      throw new SyncError("invalid_snapshot", `Hosted snapshot repeats ${resource.path}.`);
    }
    if (resource.revision !== documentRevision(resource.document)) {
      throw new SyncError(
        "invalid_snapshot",
        `Hosted resource ${resource.path} does not match its declared revision.`
      );
    }
    paths.add(resource.path);
  }
  const configurations = resources.filter(
    (resource) => resource.kind === "configuration" && resource.path === "mdbase.yaml"
  );
  if (configurations.length !== 1) {
    throw new SyncError(
      "invalid_snapshot",
      "Hosted snapshot requires exactly one canonical mdbase.yaml resource."
    );
  }
  const policy = recordPathPolicy(configurations[0]!.document, paths);
  const settings = parseConfiguration(configurations[0]!.document).settings ?? {};
  const typesFolder = configuredFolder(settings.types_folder, "_types");
  const contractsFolder = configuredFolder(settings.contracts_folder, "_contracts");

  for (const resource of resources) {
    const extension = resource.path.split(".").at(-1);
    const components = resource.path.split("/");
    const hidden = components.some((component) => component.startsWith("."));
    let valid = false;
    if (resource.kind === "configuration") {
      valid = resource.path === "mdbase.yaml";
    } else if (resource.kind === "type") {
      valid = isBelow(resource.path, typesFolder)
        && extension === "md"
        && markdownKind(resource.document, resource.path) === "mdbase.type";
    } else if (resource.kind === "contract") {
      valid = isBelow(resource.path, contractsFolder)
        && extension === "md"
        && markdownKind(resource.document, resource.path) === "mdbase.contract";
    } else if (resource.kind === "schema") {
      const schema = parseJsonObject(resource.document);
      valid = !hidden
        && extension === "json"
        && components.some((component) => component === "schemas" || component === "_schemas")
        && schema !== null;
    } else if (resource.kind === "view") {
      valid = !hidden && extension === "base";
    }
    if (!valid) {
      throw new SyncError(
        "invalid_snapshot",
        `Hosted resource ${resource.path} is not valid for kind ${resource.kind}.`
      );
    }
  }
  return policy;
}

export function defaultRecordPathPolicy(
  resourcePaths: ReadonlySet<string>
): MirrorRecordPathPolicy {
  return {
    reservedFolders: new Set(["_types", "_contracts", "_types/_migrations", ".mdbase"]),
    resourcePaths
  };
}

export function recordPathPolicy(
  configurationDocument: string,
  resourcePaths: ReadonlySet<string>
): MirrorRecordPathPolicy {
  const settings = parseConfiguration(configurationDocument).settings ?? {};
  const typesFolder = configuredFolder(settings.types_folder, "_types");
  const reservedFolders = new Set([
    typesFolder,
    configuredFolder(settings.contracts_folder, "_contracts"),
    configuredFolder(settings.migrations_folder, `${typesFolder}/_migrations`),
    configuredFolder(settings.cache_folder, ".mdbase", true)
  ]);
  // Collection configuration is authority-owned. It may describe additional
  // local record formats, but it cannot grant a remote mirror permission to
  // materialize executable or processor-specific extensions.
  return {
    reservedFolders,
    resourcePaths
  };
}

export async function loadMirrorRecordPathPolicy(
  resourcePaths: string[],
  readConfiguration: () => Promise<string | null>
): Promise<MirrorRecordPathPolicy> {
  if (resourcePaths.length === 0) return defaultRecordPathPolicy(new Set());
  const configuration = await readConfiguration();
  if (configuration === null) {
    throw new SyncError(
      "invalid_mirror_state",
      "Mirror collection configuration is missing."
    );
  }
  return recordPathPolicy(configuration, new Set(resourcePaths));
}

export function validateRecordPath(path: string, policy: MirrorRecordPathPolicy): void {
  validatePortableMirrorPath(path);
  if (
    /(?:^|\/)\./u.test(path)
    || policy.resourcePaths.has(path)
    || isInReservedFolder(path, policy.reservedFolders)
    || !path.endsWith(".md")
  ) {
    throw new SyncError(
      "invalid_record_path",
      `Mirror record path ${path} is outside the configured record namespace.`
    );
  }
}

function isInReservedFolder(path: string, folders: ReadonlySet<string>): boolean {
  for (const folder of folders) {
    if (isBelow(path, folder)) return true;
  }
  return false;
}

export function filterRecordPaths(
  paths: readonly string[],
  policy: MirrorRecordPathPolicy
): string[] {
  return paths.filter((path) => {
    try {
      validateRecordPath(path, policy);
      return true;
    } catch {
      return false;
    }
  });
}

export function assertRecordPhysicalPathAvailable(
  path: string,
  recordId: string,
  resourcePaths: Iterable<string>,
  records: Iterable<[string, { path: string }]>
): void {
  const physicalPath = portableMirrorPathKeyForValidatedPath(path);
  for (const resourcePath of resourcePaths) {
    if (portableMirrorPathKeyForValidatedPath(resourcePath) === physicalPath) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror record path ${path} aliases authority resource ${resourcePath} on a supported filesystem.`
      );
    }
  }
  for (const [existingId, entry] of records) {
    if (
      (existingId !== recordId || entry.path !== path)
      && portableMirrorPathKeyForValidatedPath(entry.path) === physicalPath
    ) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror record paths ${entry.path} and ${path} alias on a supported filesystem.`
      );
    }
  }
}

export function assertNoPhysicalPathAliases(paths: Iterable<string>): void {
  const physicalPaths = new Map<string, string>();
  for (const path of paths) {
    const physicalPath = portableMirrorPathKeyForValidatedPath(path);
    const existing = physicalPaths.get(physicalPath);
    if (existing !== undefined && existing !== path) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror paths ${existing} and ${path} alias on a supported filesystem.`
      );
    }
    physicalPaths.set(physicalPath, path);
  }
}

export function preflightChangePhysicalPaths<
  Frontmatter extends JsonObject = JsonObject
>(
  events: Array<SyncChange<Frontmatter>>,
  policy: MirrorRecordPathPolicy,
  resources: Readonly<Record<string, { path: string }>>,
  records: Readonly<Record<string, { path: string }>>
): void {
  const targetPhysicalPaths = new Set<string>();
  for (const event of events) {
    if (event.type !== "put") continue;
    validateRecordPath(event.record.path, policy);
    targetPhysicalPaths.add(portableMirrorPathKey(event.record.path));
  }
  const occupiedTargets = new Map<
    string,
    { path: string; recordId: string | null }
  >();
  for (const path in resources) {
    if (!Object.prototype.hasOwnProperty.call(resources, path)) continue;
    const physicalPath = portableMirrorPathKey(path);
    if (targetPhysicalPaths.has(physicalPath)) {
      occupiedTargets.set(physicalPath, { path, recordId: null });
    }
  }
  for (const recordId in records) {
    if (!Object.prototype.hasOwnProperty.call(records, recordId)) continue;
    const path = records[recordId]!.path;
    const physicalPath = portableMirrorPathKey(path);
    if (targetPhysicalPaths.has(physicalPath)) {
      occupiedTargets.set(physicalPath, { path, recordId });
    }
  }
  const changedRecordPaths = new Map<string, string | null>();
  const currentRecordPath = (recordId: string): string | null =>
    changedRecordPaths.has(recordId)
      ? changedRecordPaths.get(recordId)!
      : records[recordId]?.path ?? null;
  for (const event of events) {
    if (event.type === "remove") {
      const prior = currentRecordPath(event.record_id);
      if (prior !== null) {
        const priorPhysicalPath = portableMirrorPathKey(prior);
        if (occupiedTargets.get(priorPhysicalPath)?.recordId === event.record_id) {
          occupiedTargets.delete(priorPhysicalPath);
        }
      }
      changedRecordPaths.set(event.record_id, null);
      continue;
    }
    const physicalPath = portableMirrorPathKey(event.record.path);
    const occupied = occupiedTargets.get(physicalPath);
    if (
      occupied !== undefined
      && (
        occupied.recordId !== event.record.record_id
        || occupied.path !== event.record.path
      )
    ) {
      throw new SyncError(
        "invalid_record_path",
        `Mirror paths ${occupied.path} and ${event.record.path} alias on a supported filesystem.`
      );
    }
    const prior = currentRecordPath(event.record.record_id);
    if (prior !== null) {
      const priorPhysicalPath = portableMirrorPathKey(prior);
      if (occupiedTargets.get(priorPhysicalPath)?.recordId === event.record.record_id) {
        occupiedTargets.delete(priorPhysicalPath);
      }
    }
    occupiedTargets.set(physicalPath, {
      path: event.record.path,
      recordId: event.record.record_id
    });
    changedRecordPaths.set(event.record.record_id, event.record.path);
  }
}

function parseConfiguration(document: string): CollectionConfiguration {
  let value: unknown;
  try {
    value = parse(document);
  } catch {
    throw new SyncError("invalid_snapshot", "Hosted mdbase.yaml is not valid YAML.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyncError("invalid_snapshot", "Hosted mdbase.yaml requires an object document.");
  }
  const configuration = value as CollectionConfiguration;
  if (typeof configuration.spec_version !== "string") {
    throw new SyncError("invalid_snapshot", "Hosted mdbase.yaml requires spec_version.");
  }
  return configuration;
}

function configuredFolder(value: unknown, fallback: string, allowHidden = false): string {
  const folder = typeof value === "string" ? value : fallback;
  validatePortableMirrorPath(folder);
  if (!allowHidden && folder.split("/").some((component) => component.startsWith("."))) {
    throw new SyncError("invalid_snapshot", `Collection control folder ${folder} must not be hidden.`);
  }
  return folder;
}

function isBelow(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

function parseJsonObject(document: string): object | null {
  try {
    const value: unknown = JSON.parse(document);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function markdownKind(document: string, path: string): unknown {
  try {
    return parseMarkdown(document, path).frontmatter.kind;
  } catch {
    return null;
  }
}

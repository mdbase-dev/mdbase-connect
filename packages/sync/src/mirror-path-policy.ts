import type { SyncResourceDocument } from "@mdbase-dev/connect-protocol";
import { parse } from "yaml";
import { SyncError } from "./sync-error.js";
import { documentRevision, parseMarkdown } from "./mirror-format.js";
import {
  portableMirrorPathKey,
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
    } else if (resource.kind === "lock") {
      valid = resource.path === "mdbase.lock.yaml"
        && isTypePackLock(resource.document);
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

function isTypePackLock(document: string): boolean {
  try {
    const value: unknown = parse(document);
    return value !== null
      && typeof value === "object"
      && !Array.isArray(value)
      && (value as Record<string, unknown>).kind === "mdbase.type-pack-lock"
      && (value as Record<string, unknown>).lock_version === 1
      && Array.isArray((value as Record<string, unknown>).packs);
  } catch {
    return false;
  }
}

function markdownKind(document: string, path: string): unknown {
  try {
    return parseMarkdown(document, path).frontmatter.kind;
  } catch {
    return null;
  }
}

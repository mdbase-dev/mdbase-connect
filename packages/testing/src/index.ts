import {
  operationsForApplicationCapabilities,
  type ApplicationCapabilityRequirements,
  type CollectionOperation,
  type FileCapability,
  type GrantScope,
  type MdbaseAppManifest
} from "@mdbase-dev/connect-protocol";

export interface MdbaseTestPage {
  addInitScript<Argument>(script: (argument: Argument) => void, argument: Argument): Promise<void>;
  evaluate<Argument>(script: (argument: Argument) => void, argument: Argument): Promise<unknown>;
}

export type MdbaseFixtureApplication =
  | { manifest: MdbaseAppManifest; manifestUrl?: never }
  | { manifestUrl: string; manifest: MdbaseAppManifest };

export interface MdbaseFixtureCollection {
  id: string;
  name: string;
  scope?: GrantScope;
  /** Override only to exercise reduced or stale grants. Defaults to manifest capabilities. */
  operations?: CollectionOperation[];
  fileCapability?: FileCapability;
}

export type MdbaseFixtureAuthority =
  | {
      kind: "hosted";
      operationsUrl: string;
      syncUrl: string;
      filesUrl: string;
      replicaId: string;
      accessToken?: string;
    }
  | { kind: "connector" };

export interface MdbaseBrowserFixtureOptions {
  serverUrl: string;
  application: MdbaseFixtureApplication;
  collection: MdbaseFixtureCollection;
  authority: MdbaseFixtureAuthority;
  accessToken?: string;
  expiresAt?: number;
  /** Begin with the browser's direct connector preference enabled. */
  directAccess?: "enabled" | "disabled";
}

export interface MdbaseBrowserFixtureController {
  /** Apply the fixture to the currently loaded app origin. */
  apply(page: MdbaseTestPage): Promise<void>;
  expire(page: MdbaseTestPage): Promise<void>;
  setOperations(page: MdbaseTestPage, operations: CollectionOperation[]): Promise<void>;
  remove(page: MdbaseTestPage): Promise<void>;
  isInstalled(page: MdbaseTestPage): Promise<boolean>;
}

interface BrowserFixtureSeed {
  indexKey: string;
  tokenKey: string;
  collectionId: string;
  directAccess?: "enabled" | "disabled";
  token: Record<string, unknown>;
}

/**
 * Install a real Connect authorization record before application code runs.
 * This package, rather than consumer tests, owns the private browser format.
 */
export async function installMdbaseBrowserFixture(
  page: MdbaseTestPage,
  options: MdbaseBrowserFixtureOptions
): Promise<MdbaseBrowserFixtureController> {
  const seed = fixtureSeed(options);
  await page.addInitScript(writeSeed, seed);
  return {
    apply: (target) => target.evaluate(writeSeed, seed).then(() => undefined),
    expire: (target) => target.evaluate(updateToken, {
      tokenKey: seed.tokenKey,
      patch: { expiresAt: Date.now() - 1 }
    }).then(() => undefined),
    setOperations: (target, operations) => target.evaluate(updateToken, {
      tokenKey: seed.tokenKey,
      patch: { operations }
    }).then(() => undefined),
    remove: (target) => target.evaluate(removeSeed, seed).then(() => undefined),
    isInstalled: async (target) => Boolean(await target.evaluate(hasSeed, seed))
  };
}

function fixtureSeed(options: MdbaseBrowserFixtureOptions): BrowserFixtureSeed {
  const manifestSource = "manifestUrl" in options.application
    ? options.application.manifestUrl
    : `bundle:${options.application.manifest.id}`;
  const prefix = `mdbase-connect:${stripTrailingSlash(options.serverUrl)}:${manifestSource}`;
  const requirements = options.application.manifest.requirements?.capabilities;
  const operations = options.collection.operations
    ?? operationsForManifest(requirements);
  const savedAt = Date.now();
  const accessToken = options.accessToken ?? "mdbase_test_application_access";
  return {
    indexKey: `${prefix}:connections`,
    tokenKey: `${prefix}:token:${options.collection.id}`,
    collectionId: options.collection.id,
    ...(options.directAccess ? { directAccess: options.directAccess } : {}),
    token: {
      version: 1,
      accessToken,
      clientId: options.application.manifest.id,
      collectionId: options.collection.id,
      collectionName: options.collection.name,
      operations,
      scope: options.collection.scope ?? { contracts: [], access: "full_collection" },
      expiresAt: options.expiresAt ?? savedAt + 60 * 60 * 1_000,
      savedAt,
      ...(options.collection.fileCapability
        ? { fileCapability: options.collection.fileCapability }
        : {}),
      ...(options.authority.kind === "hosted"
        ? {
            authority: {
              operationsUrl: options.authority.operationsUrl,
              syncUrl: options.authority.syncUrl,
              filesUrl: options.authority.filesUrl,
              replicaId: options.authority.replicaId,
              accessToken: options.authority.accessToken ?? "mdbase_test_authority_access"
            }
          }
        : {})
    }
  };
}

function operationsForManifest(
  requirements: ApplicationCapabilityRequirements | undefined
): CollectionOperation[] {
  if (!requirements) {
    throw new Error("Browser fixtures require a manifest semantic capability contract.");
  }
  return operationsForApplicationCapabilities(requirements);
}

function writeSeed(seed: BrowserFixtureSeed): void {
  localStorage.setItem(seed.indexKey, JSON.stringify({
    version: 1,
    collectionIds: [seed.collectionId]
  }));
  localStorage.setItem(seed.tokenKey, JSON.stringify(seed.token));
  if (seed.directAccess) {
    localStorage.setItem(`mdbase-connect:direct:${location.origin}`, seed.directAccess);
  }
}

function updateToken(input: { tokenKey: string; patch: Record<string, unknown> }): void {
  const current = JSON.parse(localStorage.getItem(input.tokenKey) ?? "null") as Record<string, unknown> | null;
  if (!current) throw new Error("The mdbase browser fixture is not installed on this origin.");
  localStorage.setItem(input.tokenKey, JSON.stringify({ ...current, ...input.patch }));
}

function removeSeed(seed: BrowserFixtureSeed): void {
  localStorage.removeItem(seed.tokenKey);
  localStorage.removeItem(seed.indexKey);
}

function hasSeed(seed: BrowserFixtureSeed): boolean {
  return localStorage.getItem(seed.tokenKey) !== null;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

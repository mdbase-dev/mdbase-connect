import { createHash } from "node:crypto";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import appManifestSchema from "../schemas/mdbase-app.schema.json" with { type: "json" };
import {
  isNativeRedirectUri,
  type ApplicationNotifications,
  type ApplicationProvisions,
  type ApplicationRequirements,
  type MdbaseAppManifest,
  type MdbasePortableAppManifest,
  type MdbaseWebAppManifest
} from "./index.js";

export const APPLICATION_MANIFEST_MAX_BYTES = 524_288;

export interface ManifestValidationIssue {
  path: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export type ManifestValidationResult =
  | { valid: true; issues: [] }
  | { valid: false; issues: ManifestValidationIssue[] };

export interface ManifestValidationOptions {
  /** Allow HTTP only for localhost/loopback developer web manifests. */
  allowLocal?: boolean;
  /** Maximum UTF-8 size of the complete declaration. */
  maxBytes?: number;
}

interface ValidatedManifestFields {
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
}

export type ValidatedWebAppManifest = Omit<
  MdbaseWebAppManifest,
  keyof ValidatedManifestFields
> & ValidatedManifestFields;

export type ValidatedPortableAppManifest = Omit<
  MdbasePortableAppManifest,
  keyof ValidatedManifestFields
> & ValidatedManifestFields;

export type ValidatedAppManifest =
  | ValidatedWebAppManifest
  | ValidatedPortableAppManifest;

export class AppManifestValidationError extends Error {
  constructor(public readonly issues: ManifestValidationIssue[]) {
    super(`Invalid application manifest: ${formatManifestValidationIssues(issues)}`);
    this.name = "AppManifestValidationError";
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  // `required` may name properties declared by an enclosing oneOf branch.
  strictRequired: false
});
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020;
addFormats(ajv);
ajv.addSchema(appManifestSchema);
const appManifestValidator = requiredValidator(String(appManifestSchema.$id));

/**
 * Validate the complete bundled application declaration accepted by Connect.
 *
 * This is the canonical runtime validator used by the server and developer
 * tooling. Keep structural rules in the published JSON Schema and cross-field
 * rules here; consumers must not maintain parallel manifest validators.
 */
export function validateAppManifest(
  value: unknown,
  options: ManifestValidationOptions = {}
): ManifestValidationResult {
  const sizeIssue = validateSerializedSize(
    value,
    options.maxBytes ?? APPLICATION_MANIFEST_MAX_BYTES
  );
  if (sizeIssue) return invalid([sizeIssue]);

  const candidate = options.allowLocal ? localManifestSchemaCandidate(value) : value;
  const schemaResult = validationResult(appManifestValidator, candidate);
  if (!schemaResult.valid) return schemaResult;

  const issues = [
    ...validateManifestOrigins(value, options.allowLocal === true),
    ...validateCapabilityRequirements(value),
    ...validateProvisionRequirements(value),
    ...validateConfigurationSetup(value)
  ];
  return issues.length === 0 ? { valid: true, issues: [] } : invalid(issues);
}

/** Validate, normalize optional sections, and return an isolated declaration. */
export function parseAppManifest(
  value: unknown,
  options: ManifestValidationOptions = {}
): ValidatedAppManifest {
  const result = validateAppManifest(value, options);
  if (!result.valid) throw new AppManifestValidationError(result.issues);
  const manifest = structuredClone(value) as MdbaseAppManifest;
  return {
    ...manifest,
    requirements: {
      contracts: [],
      configuration: [],
      ...manifest.requirements
    },
    provisions: {
      type_packs: [],
      configuration: [],
      ...manifest.provisions
    },
    notifications: manifest.notifications ?? { criteria: [] }
  } as ValidatedAppManifest;
}

export function formatManifestValidationIssues(
  issues: readonly ManifestValidationIssue[]
): string {
  return issues.map((issue) => `${issue.path || "/"} ${issue.message}`).join("; ");
}

function requiredValidator(reference: string): ValidateFunction {
  const validate = ajv.getSchema(reference);
  if (!validate) throw new Error(`Canonical schema is unavailable: ${reference}`);
  return validate;
}

function validationResult(
  validate: ValidateFunction,
  value: unknown
): ManifestValidationResult {
  if (validate(value)) return { valid: true, issues: [] };
  const issues = (validate.errors ?? []).map(validationIssue);
  const specific = issues.filter((issue) => issue.keyword !== "oneOf");
  return invalid(specific.length > 0 ? specific : issues);
}

function validationIssue(error: ErrorObject): ManifestValidationIssue {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return {
      path: joinPointer(error.instancePath, params.missingProperty),
      keyword: error.keyword,
      message: "is required",
      params
    };
  }
  if (
    error.keyword === "additionalProperties"
    && typeof params.additionalProperty === "string"
  ) {
    return {
      path: joinPointer(error.instancePath, params.additionalProperty),
      keyword: error.keyword,
      message: "is not allowed",
      params
    };
  }
  return {
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "is invalid",
    params
  };
}

function joinPointer(parent: string, child: string): string {
  const escaped = child.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${parent}/${escaped}`;
}

function validateSerializedSize(
  value: unknown,
  maxBytes: number
): ManifestValidationIssue | undefined {
  const jsonIssue = validateJsonValue(value, "", new WeakSet<object>());
  if (jsonIssue) return jsonIssue;
  try {
    const serialized = JSON.stringify(value);
    const bytes = new TextEncoder().encode(serialized).byteLength;
    return bytes <= maxBytes
      ? undefined
      : issue(
          "/",
          "maxBytes",
          `must not exceed ${maxBytes} UTF-8 bytes`,
          { maxBytes, actualBytes: bytes }
        );
  } catch {
    return issue("/", "json", "must be serializable as JSON");
  }
}

function validateJsonValue(
  value: unknown,
  path: string,
  ancestors: WeakSet<object>
): ManifestValidationIssue | undefined {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
  ) return undefined;
  if (typeof value !== "object") {
    return issue(path || "/", "json", "must be a JSON value");
  }
  if (ancestors.has(value)) {
    return issue(path || "/", "json", "must not contain circular references");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return issue(path || "/", "json", "must be a plain JSON object");
  }
  ancestors.add(value);
  const entries = Array.isArray(value)
    ? value.map((item, index) => [String(index), item] as const)
    : Object.entries(value);
  for (const [key, child] of entries) {
    const childIssue = validateJsonValue(child, joinPointer(path, key), ancestors);
    if (childIssue) return childIssue;
  }
  ancestors.delete(value);
  return undefined;
}

function validateManifestOrigins(
  value: unknown,
  allowLocal: boolean
): ManifestValidationIssue[] {
  const manifest = asObject(value);
  if (manifest.distribution === "portable") {
    if (manifest.project_url === undefined) {
      return manifest.icon === undefined
        ? []
        : [issue("/icon", "origin", "requires a project_url on the same origin")];
    }
    try {
      const project = new URL(String(manifest.project_url));
      if (project.protocol !== "https:") {
        return [issue("/project_url", "protocol", "must use HTTPS")];
      }
      if (
        manifest.icon !== undefined
        && new URL(String(manifest.icon)).origin !== project.origin
      ) {
        return [issue("/icon", "origin", "must use the project_url origin")];
      }
      return [];
    } catch {
      return [issue("/", "url", "contains an invalid URL")];
    }
  }

  try {
    const homepage = new URL(String(manifest.homepage));
    if (!secureOrAllowedLocal(homepage, allowLocal)) {
      return [issue(
        "/homepage",
        "protocol",
        "must use HTTPS (or loopback HTTP in local mode)"
      )];
    }
    for (const [index, redirect] of (manifest.redirect_uris as unknown[]).entries()) {
      const url = new URL(String(redirect));
      if (url.origin === homepage.origin && !secureOrAllowedLocal(url, allowLocal)) {
        return [issue(
          `/redirect_uris/${index}`,
          "protocol",
          "must use HTTPS (or loopback HTTP in local mode)"
        )];
      }
      const nativeAllowed = nativeRedirectMatchesApplication(
        url,
        String(manifest.id)
      );
      if (url.origin !== homepage.origin && !nativeAllowed) {
        return [issue(
          `/redirect_uris/${index}`,
          "origin",
          "must use the homepage origin or a private-use scheme matching the application ID"
        )];
      }
    }
    if (
      manifest.icon !== undefined
      && new URL(String(manifest.icon)).origin !== homepage.origin
    ) {
      return [issue("/icon", "origin", "must use the homepage origin")];
    }
    return [];
  } catch {
    return [issue("/", "url", "contains an invalid URL")];
  }
}

function nativeRedirectMatchesApplication(url: URL, applicationId: string): boolean {
  const scheme = url.protocol.slice(0, -1);
  return isNativeRedirectUri(url)
    && (scheme === applicationId || scheme.startsWith(`${applicationId}.`));
}

function validateProvisionRequirements(value: unknown): ManifestValidationIssue[] {
  const manifest = asObject(value);
  const requirements = asObject(manifest.requirements);
  const requiredContracts = Array.isArray(requirements.contracts)
    ? requirements.contracts
    : [];
  const required = new Set(requiredContracts.map((contract) => {
    const value = asObject(contract);
    return `${value.id}@${value.version}`;
  }));
  const provisions = asObject(manifest.provisions);
  const packs = Array.isArray(provisions.type_packs) ? provisions.type_packs : [];
  const issues: ManifestValidationIssue[] = [];
  for (const [packIndex, provisionValue] of packs.entries()) {
    const provision = asObject(provisionValue);
    const providedContracts = Array.isArray(provision.provides)
      ? provision.provides
      : [];
    for (const providedValue of providedContracts) {
      const provided = asObject(providedValue);
      if (!required.has(`${provided.id}@${provided.version}`)) {
        issues.push(issue(
          `/provisions/type_packs/${packIndex}/provides`,
          "contractRequirement",
          "may only contain contracts required by the application"
        ));
      }
    }
    const packManifest = asObject(provision.manifest);
    const declaredResources = Array.isArray(packManifest.resources)
      ? packManifest.resources.map(asObject)
      : [];
    const embeddedResources = Array.isArray(provision.resources)
      ? provision.resources.map(asObject)
      : [];
    const embedded = new Map(
      embeddedResources.map((resource) => [String(resource.source), resource.document])
    );
    if (
      embedded.size !== embeddedResources.length
      || new Set(declaredResources.map((resource) => String(resource.source))).size
        !== declaredResources.length
      || declaredResources.length !== embeddedResources.length
    ) {
      issues.push(issue(
        `/provisions/type_packs/${packIndex}/resources`,
        "resourceSet",
        "must match manifest source paths exactly"
      ));
      continue;
    }
    for (const [resourceIndex, resource] of declaredResources.entries()) {
      const source = String(resource.source);
      const document = embedded.get(source);
      if (typeof document !== "string") {
        issues.push(issue(
          `/provisions/type_packs/${packIndex}/resources`,
          "resourceSet",
          `is missing manifest source ${source}`
        ));
        continue;
      }
      const digest = `sha256:${createHash("sha256").update(document).digest("hex")}`;
      if (digest !== resource.digest) {
        issues.push(issue(
          `/provisions/type_packs/${packIndex}/manifest/resources/${resourceIndex}/digest`,
          "digest",
          "does not match the embedded document"
        ));
      }
    }
  }
  return issues;
}

function validateConfigurationSetup(value: unknown): ManifestValidationIssue[] {
  const manifest = asObject(value);
  const requirements = asObject(manifest.requirements);
  const provisions = asObject(manifest.provisions);
  const requiredValues = Array.isArray(requirements.configuration)
    ? requirements.configuration
    : [];
  const provisionValues = Array.isArray(provisions.configuration)
    ? provisions.configuration
    : [];
  const issues: ManifestValidationIssue[] = [];
  const required = new Map<string, { path: string; value: unknown; index: number }>();
  for (const [index, candidate] of requiredValues.entries()) {
    const requirement = asObject(candidate);
    const id = String(requirement.id);
    const path = String(requirement.path);
    const pathError = configurationPointerError(path);
    if (pathError) {
      issues.push(issue(
        `/requirements/configuration/${index}/path`,
        "configurationPointer",
        pathError
      ));
    }
    if (required.has(id)) {
      issues.push(issue(
        `/requirements/configuration/${index}/id`,
        "uniqueRequirement",
        `duplicates configuration requirement ${id}`
      ));
    } else {
      required.set(id, { path, value: requirement.value, index });
    }
  }
  const linked = new Set<string>();
  const contributionKeys = new Set<string>();
  for (const [index, candidate] of provisionValues.entries()) {
    const provision = asObject(candidate);
    const requirementId = String(provision.requirement);
    const path = String(provision.path);
    const pathError = configurationPointerError(path);
    if (pathError) {
      issues.push(issue(
        `/provisions/configuration/${index}/path`,
        "configurationPointer",
        pathError
      ));
    }
    const requirement = required.get(requirementId);
    if (!requirement) {
      issues.push(issue(
        `/provisions/configuration/${index}/requirement`,
        "configurationRequirement",
        `references unknown configuration requirement ${requirementId}`
      ));
      continue;
    }
    if (linked.has(requirementId)) {
      issues.push(issue(
        `/provisions/configuration/${index}/requirement`,
        "uniqueProvision",
        `configuration requirement ${requirementId} may have exactly one provision`
      ));
    }
    linked.add(requirementId);
    if (path !== requirement.path) {
      issues.push(issue(
        `/provisions/configuration/${index}/path`,
        "configurationRequirement",
        `must equal /requirements/configuration/${requirement.index}/path`
      ));
    }
    if (JSON.stringify(provision.value) !== JSON.stringify(requirement.value)) {
      issues.push(issue(
        `/provisions/configuration/${index}/value`,
        "configurationRequirement",
        `must equal /requirements/configuration/${requirement.index}/value`
      ));
    }
    const contributionKey = `${path}\0${JSON.stringify(provision.value)}`;
    if (contributionKeys.has(contributionKey)) {
      issues.push(issue(
        `/provisions/configuration/${index}`,
        "uniqueContribution",
        "duplicates another configuration path and value contribution"
      ));
    }
    contributionKeys.add(contributionKey);
  }
  for (const [id, requirement] of required) {
    if (!linked.has(id)) {
      issues.push(issue(
        `/requirements/configuration/${requirement.index}`,
        "configurationProvision",
        `requires one provision linked by id ${id}`
      ));
    }
  }
  return issues;
}

function configurationPointerError(path: string): string | undefined {
  if (!path.startsWith("/") || new TextEncoder().encode(path).byteLength > 1024) {
    return "must be a bounded RFC 6901 JSON pointer";
  }
  const encoded = path.slice(1).split("/");
  if (encoded.length < 2 || encoded.length > 16) {
    return "must address a value below an x-* extension namespace";
  }
  const segments: string[] = [];
  for (const value of encoded) {
    if (/~(?:[^01]|$)/u.test(value)) return "contains an invalid RFC 6901 escape";
    const segment = value.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      segment.length === 0
      || segment === "-"
      || /^\d+$/u.test(segment)
      || [...segment].some((character) => /\p{Cc}/u.test(character))
    ) return "contains a disallowed object-key segment";
    segments.push(segment);
  }
  return /^x-[a-z0-9][a-z0-9-]*$/u.test(segments[0]!)
    ? undefined
    : "must be inside a top-level x-* extension namespace";
}

function validateCapabilityRequirements(value: unknown): ManifestValidationIssue[] {
  const manifest = asObject(value);
  const requirements = asObject(manifest.requirements);
  const capabilities = asObject(requirements.capabilities);
  if (Object.keys(capabilities).length === 0) return [];
  const required = Array.isArray(capabilities.required)
    ? capabilities.required.map(String)
    : [];
  const optional = Array.isArray(capabilities.optional)
    ? capabilities.optional.map(String)
    : [];
  const issues: ManifestValidationIssue[] = [];
  const overlap = optional.find((capability) => required.includes(capability));
  if (overlap) {
    issues.push(issue(
      "/requirements/capabilities/optional",
      "disjoint",
      `must not repeat required capability ${overlap}`
    ));
  }
  const declared = new Set([...required, ...optional]);
  const provisions = asObject(manifest.provisions);
  if (
    Array.isArray(requirements.contracts)
    && requirements.contracts.length > 0
    && requirements.access !== "full_collection"
    && !required.includes("definitions.contracts.current")
  ) {
    issues.push(issue(
      "/requirements/capabilities/required",
      "contractCapability",
      "must require definitions.contracts.current for contract-scoped requirements"
    ));
  }
  if (declared.has("definitions.type-pack.apply")) {
    if (requirements.access !== "full_collection") {
      issues.push(issue(
        "/requirements/access",
        "typePackAccess",
        "must be full_collection for definitions.type-pack.apply"
      ));
    }
  }
  if (
    Array.isArray(provisions.type_packs)
    && provisions.type_packs.length > 0
    && !required.includes("collection.setup.apply")
  ) {
      issues.push(issue(
        "/requirements/capabilities/required",
        "collectionSetupCapability",
        "must require collection.setup.apply when bundled type packs are declared"
      ));
  }
  const hasConfigurationProvisions = Array.isArray(provisions.configuration)
    && provisions.configuration.length > 0;
  const hasSetupProvisions = hasConfigurationProvisions
    || (Array.isArray(provisions.type_packs) && provisions.type_packs.length > 0);
  if (hasConfigurationProvisions && !required.includes("collection.setup.apply")) {
    issues.push(issue(
      "/requirements/capabilities/required",
      "collectionSetupCapability",
      "must require collection.setup.apply when configuration provisions are declared"
    ));
  }
  if (declared.has("collection.setup.apply")) {
    if (requirements.access !== "full_collection") {
      issues.push(issue(
        "/requirements/access",
        "collectionSetupAccess",
        "must be full_collection for collection.setup.apply"
      ));
    }
    if (!hasSetupProvisions) {
      issues.push(issue(
        "/provisions",
        "collectionSetupProvision",
        "must declare a configuration provision or type pack for collection.setup.apply"
      ));
    }
  }
  if (
    declared.has("notifications.background-delivery")
    && !Array.isArray(asObject(manifest.notifications).criteria)
  ) {
    issues.push(issue(
      "/notifications/criteria",
      "notificationCapability",
      "must be declared for notifications.background-delivery"
    ));
  }
  const fileRequirement = asObject(requirements.files);
  const fileActions = Array.isArray(fileRequirement.actions)
    ? new Set(fileRequirement.actions.map(String))
    : new Set<string>();
  for (const action of ["list", "read", "add", "replace", "move", "delete"]) {
    const capability = `files.${action}`;
    if (declared.has(capability) !== fileActions.has(action)) {
      issues.push(issue(
        "/requirements/capabilities",
        "fileCapability",
        `${capability} and requirements.files.actions.${action} must be declared together`
      ));
    }
  }
  return issues;
}

function localManifestSchemaCandidate(value: unknown): unknown {
  const source = asObject(value);
  if (source.distribution === "portable") return value;
  // Only URL fields need a schema-safe local substitute. A shallow copy keeps
  // non-JSON values visible to the schema instead of silently dropping them.
  const object = { ...source };
  for (const field of ["homepage", "icon"] as const) {
    if (typeof object[field] === "string") {
      object[field] = schemaSafeLocalUrl(object[field]);
    }
  }
  if (Array.isArray(object.redirect_uris)) {
    object.redirect_uris = object.redirect_uris.map((url) =>
      typeof url === "string" ? schemaSafeLocalUrl(url) : url
    );
  }
  return object;
}

function schemaSafeLocalUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && isLoopback(url.hostname)) url.protocol = "https:";
    return url.href;
  } catch {
    return value;
  }
}

function secureOrAllowedLocal(url: URL, allowLocal: boolean): boolean {
  return url.protocol === "https:"
    || (allowLocal && url.protocol === "http:" && isLoopback(url.hostname));
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]"
    || hostname === "::1";
}

function invalid(issues: ManifestValidationIssue[]): ManifestValidationResult {
  return { valid: false, issues };
}

function issue(
  path: string,
  keyword: string,
  message: string,
  params: Record<string, unknown> = {}
): ManifestValidationIssue {
  return { path, keyword, message, params };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

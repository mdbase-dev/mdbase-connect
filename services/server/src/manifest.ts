import { createHash } from "node:crypto";
import type {
  ApplicationNotifications,
  ApplicationProvisions,
  ApplicationRequirements
} from "@mdbase/connect-protocol";
import { isNativeRedirectUri } from "@mdbase/connect-protocol";
import { z } from "zod";

export { isNativeRedirectUri };

const contractSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
  version: z.number().int().positive()
}).strict();
const applicationIdSchema = z.string()
  .min(5)
  .max(150)
  .regex(
    /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){2,}$/,
    "Application IDs must use a lower-case reverse-domain identifier."
  );
const contractsSchema = z.array(contractSchema).max(20).refine(
  (contracts) => new Set(contracts.map((contract) => `${contract.id}@${contract.version}`)).size === contracts.length,
  "Contracts must be unique."
);
const requirementsSchema = z.object({
  contracts: contractsSchema,
  access: z.enum(["contract", "full_collection"]).optional(),
  collection_kind: z.literal("hosted").optional()
}).strict().default({ contracts: [] });
const notificationCriterionSchema = z.object({
  id: contractSchema.shape.id,
  event: contractSchema,
  if: z.object({ $expr: z.string().min(1).max(4_096) }).strict().optional(),
  debounce: z.string().regex(/^[0-9]+(?:ms|s|m|h|d)$/).optional(),
  minimum_interval: z.string().regex(/^[0-9]+(?:ms|s|m|h|d)$/).optional(),
  presentation: z.object({
    title: z.string().min(1).max(80),
    body: z.string().max(160).optional(),
    tag: z.string().min(1).max(80).optional()
  }).strict()
}).strict();
const nativeNotificationDeliverySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("managed_fcm"),
    firebase_project_id: z.string()
      .min(6)
      .max(63)
      .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/)
  }).strict(),
  z.object({
    mode: z.literal("webhook"),
    url: z.url().refine((value) => new URL(value).protocol === "https:", "Webhook URL must use HTTPS.")
  }).strict()
]);
const manifestFields = {
  manifest_version: z.literal(1),
  id: applicationIdSchema,
  name: z.string().trim().min(1).max(100),
  requirements: requirementsSchema,
  provisions: z.object({
    types: z.array(z.object({
      name: z.string().trim().min(1).max(100),
      path: z.string().trim().min(1).max(240).optional(),
      document: z.string().min(1).max(131_072),
      provides: contractsSchema
    }).strict()).max(20)
  }).strict().default({ types: [] }),
  notifications: z.object({
    criteria: z.array(notificationCriterionSchema).max(50).refine(
      (criteria) => new Set(criteria.map((criterion) => criterion.id)).size === criteria.length,
      "Notification criterion IDs must be unique."
    ),
    native_delivery: nativeNotificationDeliverySchema.optional()
  }).strict().default({ criteria: [] })
} as const;
const webManifestSchema = z.object({
  ...manifestFields,
  distribution: z.literal("web").optional(),
  homepage: z.url(),
  icon: z.url().optional(),
  redirect_uris: z.array(z.url()).min(1).max(10)
}).strict();
const portableManifestSchema = z.object({
  ...manifestFields,
  distribution: z.literal("portable"),
  project_url: z.url().optional(),
  icon: z.url().optional()
}).strict();
const manifestSchema = z.union([
  webManifestSchema,
  portableManifestSchema
]).superRefine(validateProvisionContracts);

interface AppManifestBase {
  manifest_version: 1;
  id: string;
  name: string;
  requirements: ApplicationRequirements;
  provisions: ApplicationProvisions;
  notifications: ApplicationNotifications;
}

export interface WebAppManifest extends AppManifestBase {
  distribution?: "web";
  homepage: string;
  icon?: string;
  redirect_uris: string[];
}

export interface PortableAppManifest extends AppManifestBase {
  distribution: "portable";
  project_url?: string;
  icon?: string;
}

export type AppManifest = WebAppManifest | PortableAppManifest;

export interface RegisteredApplicationManifest {
  manifest: AppManifest;
  canonicalIdentity: string;
}

export class ApplicationManifestError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApplicationManifestError";
  }
}

export function registerApplicationManifest(
  value: unknown,
  allowInsecure = false
): RegisteredApplicationManifest {
  try {
    const sourceText = JSON.stringify(value);
    if (sourceText.length > 524_288) {
      throw new ApplicationManifestError("Application declaration is too large.");
    }
    const parsed = manifestSchema.parse(value);
    validateManifestIdentity(parsed, allowInsecure);
    const manifest: AppManifest = parsed;
    const digest = createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex");
    return {
      manifest,
      canonicalIdentity: `bundle:${parsed.id}:sha256:${digest}`
    };
  } catch (error) {
    throw asManifestError(error);
  }
}

function validateProvisionContracts(
  manifest: {
    requirements: ApplicationRequirements;
    provisions: ApplicationProvisions;
  },
  context: z.RefinementCtx
): void {
  const required = new Set(manifest.requirements.contracts.map((contract) => `${contract.id}@${contract.version}`));
  for (const [typeIndex, provision] of manifest.provisions.types.entries()) {
    for (const provided of provision.provides) {
      if (!required.has(`${provided.id}@${provided.version}`)) {
        context.addIssue({
          code: "custom",
          path: ["provisions", "types", typeIndex, "provides"],
          message: "Type provisions may only provide contracts required by the application."
        });
      }
    }
  }
}

function validateManifestIdentity(
  manifest: z.infer<typeof manifestSchema>,
  allowInsecure: boolean
): void {
  if (manifest.distribution === "portable") {
    if (manifest.requirements.collection_kind === "hosted") {
      throw new ApplicationManifestError(
        "Portable applications cannot request hosted-only collection access."
      );
    }
    if (manifest.project_url) {
      const project = new URL(manifest.project_url);
      if (project.protocol !== "https:") {
        throw new ApplicationManifestError("Portable application project URLs must use HTTPS.");
      }
      if (manifest.icon && new URL(manifest.icon).origin !== project.origin) {
        throw new ApplicationManifestError(
          "Portable application icons must use the project URL origin."
        );
      }
    } else if (manifest.icon) {
      throw new ApplicationManifestError(
        "Portable application icons require a project URL on the same origin."
      );
    }
    return;
  }
  const homepage = new URL(manifest.homepage);
  const developmentOrigin = allowInsecure
    && homepage.protocol === "http:"
    && isLoopbackName(homepage.hostname);
  if (homepage.protocol !== "https:" && !developmentOrigin) {
    throw new ApplicationManifestError("Application homepages must use HTTPS.");
  }
  if (manifest.icon && new URL(manifest.icon).origin !== homepage.origin) {
    throw new ApplicationManifestError("Application icons must use the homepage origin.");
  }
  for (const redirect of manifest.redirect_uris) {
    const redirectUrl = new URL(redirect);
    if (["http:", "https:"].includes(redirectUrl.protocol)) {
      if (redirectUrl.origin !== homepage.origin) {
        throw new ApplicationManifestError(
          "Web redirect URIs must use the application homepage origin."
        );
      }
      if (redirectUrl.protocol !== "https:" && !developmentOrigin) {
        throw new ApplicationManifestError("Web redirect URIs must use HTTPS.");
      }
      continue;
    }
    const scheme = redirectUrl.protocol.slice(0, -1);
    if (
      !isNativeRedirectUri(redirectUrl)
      || (scheme !== manifest.id && !scheme.startsWith(`${manifest.id}.`))
    ) {
      throw new ApplicationManifestError(
        "Native redirect URI schemes must match the bundled application ID."
      );
    }
  }
}

function asManifestError(error: unknown): ApplicationManifestError {
  if (error instanceof ApplicationManifestError) return error;
  if (error instanceof z.ZodError) {
    return new ApplicationManifestError(
      error.issues[0]?.message
        ? `Application declaration is invalid: ${error.issues[0].message}`
        : "Application declaration is invalid.",
      { cause: error }
    );
  }
  return new ApplicationManifestError("Application declaration is invalid.", {
    cause: error instanceof Error ? error : undefined
  });
}

function isLoopbackName(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

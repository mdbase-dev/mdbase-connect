import { isNativeRedirectUri } from "@mdbase-dev/connect-protocol";
import {
  AppManifestValidationError,
  formatManifestValidationIssues,
  parseVersionedAppManifest,
  type ManifestValidationIssue,
  type VersionedAppManifest
} from "@mdbase-dev/connect-protocol/manifest";
import { canonicalSha256 } from "./canonical-json.js";

export { isNativeRedirectUri };

export type AppManifest = VersionedAppManifest["manifest"];

export type RegisteredApplicationManifest = VersionedAppManifest & {
  digest: string;
  canonicalIdentity: string;
  familyIdentity: string;
};

export class ApplicationManifestError extends Error {
  constructor(
    message: string,
    public readonly issues: ManifestValidationIssue[] = [],
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ApplicationManifestError";
  }
}

/**
 * Parse and identify a bundled application declaration without persisting it.
 * The canonical validator is shared with public developer tooling so a
 * declaration cannot pass supported CI and fail a matching Connect server.
 */
export function registerApplicationManifest(
  value: unknown,
  allowInsecure = false
): RegisteredApplicationManifest {
  try {
    const declaration = parseVersionedAppManifest(value, { allowLocal: allowInsecure });
    const { manifest } = declaration;
    const digest = canonicalSha256(manifest).slice("sha256:".length);
    return {
      ...declaration,
      digest,
      canonicalIdentity: `bundle:${manifest.id}:sha256:${digest}`,
      familyIdentity: `bundle:${manifest.id}`
    };
  } catch (error) {
    if (error instanceof AppManifestValidationError) {
      throw new ApplicationManifestError(
        `Application declaration is invalid: ${formatManifestValidationIssues(error.issues)}`,
        error.issues,
        { cause: error }
      );
    }
    throw new ApplicationManifestError(
      "Application declaration is invalid.",
      [],
      { cause: error instanceof Error ? error : undefined }
    );
  }
}

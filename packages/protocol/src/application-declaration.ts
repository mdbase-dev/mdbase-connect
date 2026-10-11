import type { ApplicationFileRequirement, LegacyApplicationFileRequirement } from "./files.js";
import type { ApplicationCapabilityRequirements, LegacyApplicationCapabilityRequirements } from "./capabilities.js";
import type { ContractRequirement, TypePackProvision } from "./type-packs.js";
import type { ConfigurationProvision, ConfigurationRequirement } from "./collection-setup.js";

export interface NotificationCriterion {
  /** Stable, manifest-owned identifier selected by an installation. */
  id: string;
  /** Runtime event contract evaluated at the collection authority. */
  event: ContractRequirement;
  /** Canonical mdbase CEL. Event content never leaves the authority for evaluation. */
  if?: { $expr: string };
  debounce?: string;
  minimum_interval?: string;
  /** Static Web Push copy. Dynamic record content is intentionally unsupported. */
  presentation: {
    title: string;
    body?: string;
    tag?: string;
  };
}

export type NativeNotificationDelivery =
  | {
      /**
       * Connect sends through FCM using revocable, least-privilege authority
       * granted by the application's Firebase project.
       */
      mode: "managed_fcm";
      firebase_project_id: string;
    }
  | {
      /**
       * Connect sends a signed, content-free signal to infrastructure operated
       * by the application developer. That infrastructure owns APNs/FCM.
       */
      mode: "webhook";
      url: string;
    };

export interface ApplicationNotifications {
  criteria: NotificationCriterion[];
  /** Optional native delivery route. Web Push registration remains independent. */
  native_delivery?: NativeNotificationDelivery;
}

/**
 * The declaration bundled with an application build and registered inline.
 *
 * `id` is stable presentation metadata rather than proof of a publisher. Each
 * exact declaration is independently identified and authorized by Connect.
 */
export type CanonicalApplicationRequirements = Omit<
  ApplicationRequirements,
  "access" | "contracts"
> & {
  access: "full_collection";
  contracts: [];
};

interface MdbaseAppManifestBase {
  manifest_version: 1;
  id: string;
  name: string;
  requirements: CanonicalApplicationRequirements;
  provisions?: ApplicationProvisions;
  notifications?: ApplicationNotifications;
}

export interface MdbaseWebAppManifest extends MdbaseAppManifestBase {
  /** Omitted by existing v1 declarations; explicit `web` is equivalent. */
  distribution?: "web";
  homepage: string;
  icon?: string;
  redirect_uris: string[];
}

export interface MdbasePortableAppManifest extends MdbaseAppManifestBase {
  /**
   * A downloaded, publisher-unverified application opened from a local file.
   * Portable declarations use device authorization and never claim a web origin.
   */
  distribution: "portable";
  /** Optional HTTPS page where the user can inspect the project or source. */
  project_url?: string;
  /** Optional HTTPS icon on the project URL's origin. */
  icon?: string;
}

export type MdbaseAppManifest =
  | MdbaseWebAppManifest
  | MdbasePortableAppManifest;

export interface ApplicationRequirements {
  contracts: ContractRequirement[];
  /** Collection extension values required before the application is ready. */
  configuration?: ConfigurationRequirement[];
  /** Versioned semantic intent compiled by Connect into exact operations. */
  capabilities?: ApplicationCapabilityRequirements;
  /**
   * Collection boundary request. New declarations must explicitly use
   * `full_collection`; omitted and `contract` remain parseable only for legacy
   * diagnosis and reauthorization.
   */
  access?: "contract" | "full_collection";
  /** Restrict authorization to durable provider-backed collections. */
  collection_kind?: "hosted";
  /** Explicit identity consent. Omission discloses no account metadata. */
  people?: import("./people.js").ApplicationPeopleRequirement;
  /** First-class non-Markdown file access requested independently of records. */
  files?: ApplicationFileRequirement;
}

export type LegacyApplicationRequirements = Omit<ApplicationRequirements, "capabilities" | "files" | "access" | "people"> & {
  access: "full_collection";
  capabilities?: LegacyApplicationCapabilityRequirements;
  files?: LegacyApplicationFileRequirement;
};

export type LegacyMdbaseWebAppManifest = Omit<MdbaseWebAppManifest, "requirements"> & {
  requirements: LegacyApplicationRequirements;
};
export type LegacyMdbasePortableAppManifest = Omit<MdbasePortableAppManifest, "requirements"> & {
  requirements: LegacyApplicationRequirements;
};
export type LegacyMdbaseAppManifest = LegacyMdbaseWebAppManifest | LegacyMdbasePortableAppManifest;

export interface ApplicationProvisions {
  type_packs: TypePackProvision[];
  /** Narrow semantic changes that may satisfy configuration requirements. */
  configuration?: ConfigurationProvision[];
}

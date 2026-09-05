import type { LegacyApplicationCapabilityRequirements } from "./capabilities.js";
import type { FileAction, FileScope } from "./files.js";
import type {
  ApplicationRequirements,
  MdbasePortableAppManifest,
  MdbaseWebAppManifest
} from "./index.js";

/** Frozen predecessor file declaration; never translate this into v2 intent. */
export interface LegacyApplicationFileRequirement {
  actions: FileAction[];
  scope: FileScope;
}

export type LegacyApplicationRequirements = Omit<
  ApplicationRequirements, "capabilities" | "files" | "access"
> & {
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
export type LegacyMdbaseAppManifest =
  | LegacyMdbaseWebAppManifest
  | LegacyMdbasePortableAppManifest;

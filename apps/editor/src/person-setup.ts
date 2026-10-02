import type { CollectionContractImplementationDescriptor, TypePackAssessment, TypePackProvision, TypePackResourceDiff } from "@mdbase-dev/connect";
import provisionUrl from "./person-setup.pack.json?url";
import { loadTypePackProvision } from "./contract-catalog";

// Exact canonical mdbase.contact 1.3.0 provision, bundled so this guided setup
// does not depend on catalog publication or availability. Shared resources keep
// their canonical pack ownership; never synthesize a competing Person pack.
export function loadPersonSetup(signal?: AbortSignal) {
  return loadTypePackProvision({
    id: "mdbase.contact", version: "1.3.0", resourceCount: 7, provisionUrl,
    digest: "sha256:48fc070ae00c61ab5b20b9ffb385d20d2a468328da07e45e67c99602b05d02e8",
    provides: [
      { id: "mdbase.person", version: "2.0.0", digest: "sha256:f16c462a1fd422f44ed055002f8476ec53c164107647fec782aeb74adeab2f9d" },
      { id: "mdbase.contact", version: "1.0.0", digest: "sha256:49cfe15403dfc741a693e89a2f4d2857de306f391d02cb03e67bfaf0aa1d6b0d" }
    ]
  }, { signal });
}

/** The bundled Person starter, which an older starter at the same path can be upgraded to. */
const PERSON_STARTER = { target: "_types/person.md", version: 3 } as const;

/** An older Person starter in place, offered for a reviewed upgrade before creating a record. */
export function outdatedPersonStarter(implementations: readonly CollectionContractImplementationDescriptor[]) {
  return implementations.find((implementation) =>
    implementation.typePath === PERSON_STARTER.target && implementation.typeVersion < PERSON_STARTER.version);
}

interface PersonStarterUpgrade {
  target: string;
  /** The collection edited the old starter; the engine's clean three-way merge keeps those edits. */
  merged: boolean;
}

/** A seed type replaced through the provision's own reviewed `upgrade_from` baseline. */
function starterUpgrade(provision: TypePackProvision, resource: TypePackResourceDiff): PersonStarterUpgrade | undefined {
  const seed = provision.manifest.resources.find((candidate) => candidate.source === resource.source && candidate.target === resource.target);
  if (resource.action !== "update" || resource.kind !== "type" || resource.mode !== "seed" || seed?.kind !== "type" || seed.mode !== "seed") return undefined;
  if (!seed.upgrade_from || resource.installedDigest !== seed.upgrade_from.digest) return undefined;
  return { target: resource.target, merged: resource.currentDigest !== resource.installedDigest };
}

export function requireGuidedPersonSetup(provision: TypePackProvision, assessment: TypePackAssessment) {
  // This guided flow adds missing definitions, records ownership of identical
  // existing bytes, or upgrades an older Person starter the pack declares it
  // supersedes. Other updates, adoptions, and downgrades belong in Types.
  const unsafe = assessment.resources.find((resource) =>
    (["update", "delete", "conflict"].includes(resource.action) && !starterUpgrade(provision, resource))
    || (resource.action === "adopt" && resource.currentDigest !== resource.digest));
  if (!assessment.applicable || assessment.status === "downgrade" || unsafe) {
    throw new Error(unsafe?.reason ?? "These definitions need review in Types. No files have been changed.");
  }
  const person = assessment.resources.find((resource) => resource.target === PERSON_STARTER.target);
  const upgrade = person && starterUpgrade(provision, person);
  if (person?.action !== "create" && !upgrade) {
    throw new Error("A Person type already exists but needs compatible mappings. Review it in Types; this setup will not replace it.");
  }
  return { upgrade };
}

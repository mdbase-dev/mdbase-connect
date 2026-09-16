import type { TypePackAssessment } from "@mdbase-dev/connect";
import provisionUrl from "./person-setup.pack.json?url";
import { loadTypePackProvision } from "./contract-catalog";

// Exact canonical mdbase.contact 1.1.0 provision, bundled so this guided setup
// does not depend on catalog publication or availability. Shared resources keep
// their canonical pack ownership; never synthesize a competing Person pack.
export function loadPersonSetup(signal?: AbortSignal) {
  return loadTypePackProvision({
    id: "mdbase.contact", version: "1.1.0", resourceCount: 6, provisionUrl,
    digest: "sha256:14bba55df0574401b46ae08e5ef1e41e615d1477f70c3cc202eb9ff179287864",
    provides: [
      { id: "mdbase.person", version: "1.0.0", digest: "sha256:cda32ead27eaf70440efe3fadd8b5334df9af82f378b2af1bc786f7ab0bd0fc3" },
      { id: "mdbase.contact", version: "1.0.0", digest: "sha256:49cfe15403dfc741a693e89a2f4d2857de306f391d02cb03e67bfaf0aa1d6b0d" }
    ]
  }, { signal });
}

export function requireAdditivePersonSetup(assessment: TypePackAssessment) {
  // This guided flow only adds missing definitions or records ownership of
  // identical existing bytes. General upgrades/adoptions belong in Types.
  const unsafe = assessment.resources.find((resource) =>
    ["update", "delete", "conflict"].includes(resource.action)
    || (resource.action === "adopt" && resource.currentDigest !== resource.digest));
  if (!assessment.applicable || unsafe) {
    throw new Error(unsafe?.reason ?? "These definitions need review in Types. No files have been changed.");
  }
  if (assessment.resources.find((resource) => resource.source === "types/person/1.md")?.action !== "create") {
    throw new Error("A Person type already exists but needs compatible mappings. Review it in Types; this setup will not replace it.");
  }
}

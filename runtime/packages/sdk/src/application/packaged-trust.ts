import type {AppBundledReleaseTrust} from "../app-host/cloud-copy-bootstrap.js";
import {mdbaseError} from "../errors.js";

/** TypeScript alone cannot produce an authenticated SDK release. The packaging
 * build replaces this refusal module ONLY with canonical BUILD-verifier output.
 * No roots, environment context or runtime-discovery fallback lives here. */
export function appReleaseTrust(): AppBundledReleaseTrust {
  throw mdbaseError("unavailable", "LAB trust unavailable", "application_lab_trust_unavailable");
}

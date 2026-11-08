/**
 * `@mdbase-dev/sdk/manifest`: build-time validation of an application's
 * `mdbase-app.json` declaration with the same validator Connect uses.
 *
 * Use it in build scripts and tests, not in the running app: it carries the
 * precompiled manifest schema. The running app declares itself through
 * `MdbaseConnect`, which validates the same declaration internally.
 */
export {
  AppManifestValidationError,
  formatManifestValidationIssues,
  parseAppManifest,
  validateAppManifest,
  type ManifestValidationIssue,
  type ManifestValidationOptions,
  type ManifestValidationResult,
  type ValidatedAppManifest,
} from "@mdbase-dev/connect-protocol/manifest";
/** The `event` of a notification criterion that fires on an app's own timers. */
export { MDBASE_TIMER_FIRED_CONTRACT } from "@mdbase-dev/connect-protocol";

// Fixed vocabularies only. Never serialize SDK messages/details/frames/IDs.
const codes = new Set(["invalid_request", "invalid_record", "not_found", "conflict", "unauthenticated", "forbidden", "collection_invalid", "unavailable", "rate_limited", "quota_exceeded", "too_large", "upgrade_required", "outcome_unknown", "cancelled", "internal"]);
const recovery = new Set(["fix_request", "refresh", "resolve_conflict", "reauthorize", "repair_collection", "retry", "free_space", "upgrade", "resolve_outcome", "none", "contact_support"]);
const reasons = new Set(["not_a_resource_path", "revision", "path_taken", "catalog_invalid", "invalid_catalog", "base_required", "invalid_path", "invalid_type", "missing_contract", "missing_schema", "unsupported_schema", "resource_not_found"]);
const states = new Set(["pending", "confirmed", "rejected", "unknown"]);
const published = new Set(["publishing", "published", "not_published"]);
const statuses = new Set(["applied", "merged", "conflicted"]);
const pick = (set, value) => value === undefined ? "absent" : set.has(value) ? value : "redacted_unknown";
export function validateScenarioMode(mode) {
  if (mode !== "full_ui" && mode !== "negative_initialization") throw new Error("invalid LAB UI mode");
  return mode;
}
export function shouldRunUI(mode) { return validateScenarioMode(mode) === "full_ui"; }
export function problemSummary(problem) {
  return { code: pick(codes, problem?.code), recovery: pick(recovery, problem?.recovery), reason: pick(reasons, problem?.reason),
    hasIssues: Array.isArray(problem?.issues) && problem.issues.length > 0,
    issueCountCapped: Array.isArray(problem?.issues) ? Math.min(problem.issues.length, 8) : 0 };
}
export function receiptSummary(write) {
  const r = write?.receipt;
  return { state: pick(states, r?.state), publication: pick(published, r?.published), status: pick(statuses, r?.status), ...problemSummary(r?.problem) };
}
export function errorSummary(error) { return problemSummary(error); }
export function appendDiagnostic(target, phase, disposition, summary) {
  if (target.length < 8) target.push({ phase, disposition, ...summary });
}
export function ownedCreationPath(nonce) {
  if (typeof nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)) throw new Error("invalid LAB nonce");
  // TaskNotes strips square brackets from the fixed [test] title in filenames.
  return `test tasknotes-ui-${nonce}.md`;
}
export function creationDisposition(expectedPath, actualPath, sdkAttempts, publications) {
  const creationPathMatched = actualPath === expectedPath;
  const sdkCreateRouted = sdkAttempts.includes(expectedPath);
  const createPublished = Number.isSafeInteger(publications) && publications > 0;
  const errorCode = !creationPathMatched ? "unexpected_created_path" : !sdkCreateRouted ? "record_create_not_routed" : !createPublished ? "record_create_not_published" : "";
  return { creationPathMatched, sdkCreateRouted, createPublished, errorCode };
}
const scenarioCodes = new Set(["unexpected_created_path", "record_create_not_routed", "record_create_not_published"]);
export class LabScenarioError extends Error {
  constructor(code) {
    const safe = scenarioCodes.has(code) ? code : "full_ui_service_blocked";
    super(safe);
    this.code = safe;
  }
}

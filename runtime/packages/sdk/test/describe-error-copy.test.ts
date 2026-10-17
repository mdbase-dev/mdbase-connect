// Copy snapshot: the user-facing copy for collection availability and access.
// A change here is a product copy change; review it as one.
import { expect, it } from "vitest";
import { COLLECTION_UNAVAILABLE_REASONS, collectionUnavailableError } from "../src/collection-availability.js";
import { describeError } from "../src/describe-error.js";
import { mdbaseError } from "../src/errors.js";

const CODES = [
  "collection_unavailable", "moved_to_next_runtime", "collection_moved", "update_required", "account_suspended",
  "people_access", "people_unsupported", "forbidden", "not_found", "unavailable",
  "approval_required", "capability_missing", "setup_required", "contract_missing", "contract_mismatch", "incompatible",
  "catalog_invalid", "type_invalid", "collection_invalid", "open_failed", "application_selection_not_approved",
] as const;
// Words that are internal terms, not ones people see in mdbase.
const JARGON = /\b(replica|grant|native|runtime|relay|daemon|cloud copy|e2e|token|manifest)\b/i;

function copy(input: unknown) {
  const d = describeError(input)!;
  return { key: d.key, title: d.title, message: d.message, action: d.action, actionLabel: d.actionLabel };
}

it("describes collection availability and access in plain, specific copy", () => {
  const snapshot: Record<string, ReturnType<typeof copy>> = {};
  // Availability as an open error carries the same copy as the availability itself.
  for (const reason of COLLECTION_UNAVAILABLE_REASONS) {
    snapshot[`availability:${reason}`] = copy({ state: "unavailable", reason });
    expect(copy(collectionUnavailableError(reason))).toEqual(snapshot[`availability:${reason}`]);
  }
  for (const code of CODES) snapshot[code] = copy(code);
  snapshot["error:people_permission_declined"] = copy(mdbaseError("forbidden", "people access was refused", "people_permission_declined"));
  for (const [name, entry] of Object.entries(snapshot)) {
    expect(`${name}: ${entry.title} ${entry.message} ${entry.actionLabel ?? ""}`).not.toMatch(JARGON);
    // An action other than waiting or none always has a label people can press.
    if (entry.action !== "wait" && entry.action !== "none") expect(entry.actionLabel, name).toBeTruthy();
  }
  expect(snapshot).toMatchSnapshot();
});

it("keeps developer detail out of user copy", () => {
  const d = describeError({ state: "unavailable", reason: "no_device_registered" })!;
  expect(d.developerMessage).toContain("no_device_registered");
  expect(`${d.title} ${d.message}`).not.toContain("no_device_registered");
  expect(d.message).toContain("turn on sync");
});

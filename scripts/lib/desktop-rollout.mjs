// Staged desktop rollout: a small signed document per release tag, served by the
// mdbase updates Worker. Published GitHub releases stay immutable at 100%; this
// document is the only thing that changes as a release widens. Clients verify it
// with the same tag-bound Sigstore identity as the release itself.
import assert from "node:assert/strict";

export const rolloutSchema = "mdbase-desktop-rollout/1";
/** Audience of the GitHub Actions OIDC token the Worker accepts for writes. */
export const rolloutAudience = "https://updates.mdbase.dev";
export const rolloutPath = "/desktop/v1/rollout/";

/**
 * The stages a release moves through. `held` halts a release for everyone,
 * early access included; installations that already took it keep it.
 */
export const stages = {
  held: { early_access: false, percentage: 0 },
  early: { early_access: true, percentage: 0 },
  5: { early_access: true, percentage: 5 },
  25: { early_access: true, percentage: 25 },
  100: { early_access: true, percentage: 100 }
};
export const wideningOrder = ["early", "5", "25", "100"];

/** Each stage is held at least this long before the coordinator widens it. */
export const stageMinimumMs = 6 * 60 * 60 * 1000;
/** Releases considered for widening, newest first: older ones are already at 100% in practice. */
export const wideningWindow = 4;

const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function rolloutDocument(tag, stage, now = new Date()) {
  assert.match(tag, tagPattern, "Invalid release tag.");
  assert(Object.hasOwn(stages, stage), `Unknown rollout stage ${stage}; expected ${Object.keys(stages).join(", ")}.`);
  return {
    schema: rolloutSchema,
    tag,
    version: tag.slice(1),
    issued_at: now.toISOString(),
    ...stages[stage]
  };
}

/** Exactly the bytes that are signed, uploaded and served. */
export function rolloutBytes(document) {
  return `${JSON.stringify(document)}\n`;
}

export function parseRollout(text, tag) {
  const value = JSON.parse(text);
  assert(value && typeof value === "object" && !Array.isArray(value), "Rollout document must be an object.");
  assert.deepEqual(Object.keys(value).sort(), ["early_access", "issued_at", "percentage", "schema", "tag", "version"]);
  assert.equal(value.schema, rolloutSchema);
  assert.equal(value.tag, tag);
  assert.equal(value.tag, `v${value.version}`);
  assert(Number.isFinite(Date.parse(value.issued_at)), "Rollout issued_at is not a timestamp.");
  assert.equal(typeof value.early_access, "boolean");
  assert(Number.isFinite(value.percentage) && value.percentage >= 0 && value.percentage <= 100, "Invalid rollout percentage.");
  return value;
}

/** The named stage of a document, or null for a combination no stage uses. */
export function stageOf(document) {
  for (const [name, stage] of Object.entries(stages)) {
    if (stage.early_access === document.early_access && stage.percentage === document.percentage) return name;
  }
  return null;
}

/**
 * What the coordinator should do with one release's rollout. It only ever moves a
 * release one step along `wideningOrder`, never out of `held` or an unnamed stage:
 * those are people's decisions, as is `DESKTOP_ROLLOUT_HELD`.
 */
export function wideningPlan({ document, held = false, now = Date.now() }) {
  if (!document) return { operation: "none", reason: "no rollout document" };
  const stage = stageOf(document);
  if (stage === "100") return { operation: "none", reason: "complete" };
  if (stage === "held") return { operation: "none", reason: "held by its rollout document" };
  if (stage === null) return { operation: "none", reason: "set by hand outside the widening stages" };
  if (held) return { operation: "none", reason: "DESKTOP_ROLLOUT_HELD is set" };
  const age = now - Date.parse(document.issued_at);
  if (!Number.isFinite(age) || age < 0) throw new Error(`Invalid rollout issue time for ${document.tag}.`);
  if (age < stageMinimumMs) return { operation: "wait", reason: `stage ${stage} is younger than six hours` };
  return { operation: "widen", stage: wideningOrder[wideningOrder.indexOf(stage) + 1] };
}

/** The rollout service origin, or null when staged rollout is not enabled. */
export function rolloutService(value) {
  if (value === undefined || value === "") return null;
  const url = new URL(value);
  assert.equal(url.protocol, "https:", "The rollout service must use HTTPS.");
  assert.equal(url.pathname, "/", "The rollout service is an origin, without a path.");
  return url.origin;
}

export function rolloutUrl(service, tag) {
  assert.match(tag, tagPattern, "Invalid release tag.");
  return `${service}${rolloutPath}${tag}.json`;
}

/** A truthy repository variable: unset and empty are false; anything but true/false is refused. */
export function variableSet(value, name) {
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true, false or unset.`);
}

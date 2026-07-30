const gateIdPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const allowedStatuses = new Set(["required", "complete"]);

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function evaluateReleaseReadiness(manifest, { stable = false } = {}) {
  const failures = [];

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return {
      failures: ["Release-readiness manifest must be a JSON object."],
      incomplete: []
    };
  }
  if (manifest.schemaVersion !== 1) {
    failures.push("Release-readiness schemaVersion must be 1.");
  }
  if (!Array.isArray(manifest.gates) || manifest.gates.length === 0) {
    failures.push("Release-readiness manifest must define at least one gate.");
    return { failures, incomplete: [] };
  }

  const ids = new Set();
  const incomplete = [];
  for (const [index, gate] of manifest.gates.entries()) {
    const label = `gates[${index}]`;
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      failures.push(`${label} must be an object.`);
      continue;
    }
    if (!nonEmptyString(gate.id) || !gateIdPattern.test(gate.id)) {
      failures.push(`${label}.id must be a lowercase kebab-case identifier.`);
    } else if (ids.has(gate.id)) {
      failures.push(`Release-readiness gate ID ${gate.id} is duplicated.`);
    } else {
      ids.add(gate.id);
    }
    if (!nonEmptyString(gate.title)) failures.push(`${label}.title is required.`);
    if (!nonEmptyString(gate.owner)) failures.push(`${label}.owner is required.`);
    if (!allowedStatuses.has(gate.status)) {
      failures.push(`${label}.status must be "required" or "complete".`);
    }
    if (!Array.isArray(gate.evidence) || gate.evidence.some((item) => !nonEmptyString(item))) {
      failures.push(`${label}.evidence must be an array of non-empty references.`);
    }
    if (!nonEmptyString(gate.notes)) failures.push(`${label}.notes is required.`);

    if (gate.status === "complete" && gate.evidence?.length === 0) {
      failures.push(`${label} cannot be complete without evidence.`);
    }
    if (gate.status !== "complete") incomplete.push(gate);
  }

  if (stable && incomplete.length > 0) {
    failures.push(
      `Stable release is blocked by ${incomplete.length} incomplete readiness gate(s): ` +
      incomplete.map((gate) => gate.id ?? "<invalid-id>").join(", ")
    );
  }

  return { failures, incomplete };
}

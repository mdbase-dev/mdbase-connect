import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST_IMAGE = /^(ghcr\.io\/mdbase-dev\/[a-z0-9-]+)@(sha256:[0-9a-f]{64})$/;
const ID = /^[a-z0-9-]+$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$/;
const COMPONENT_FIELDS = new Set([
  "id", "required", "kind", "image", "dockerfile", "context", "platform",
  "attestationType",
]);

function requireObject(value, name, failures) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${name} must be an object`);
    return false;
  }
  return true;
}

function requireExactFields(value, allowed, name, failures) {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) failures.push(`${name} has unknown field ${field}`);
  }
}

export async function validateReleaseComponents(contract, { root = process.cwd() } = {}) {
  const failures = [];
  if (!requireObject(contract, "release contract", failures)) return failures;
  requireExactFields(contract, new Set([
    "$schema", "schemaVersion", "repository", "publication",
    "sourceDependencies", "components",
  ]), "release contract", failures);

  if (contract.schemaVersion !== 1) failures.push("schemaVersion must be 1");
  if (contract.repository !== "mdbase-dev/mdbase-connect") {
    failures.push("repository must be mdbase-dev/mdbase-connect");
  }

  if (requireObject(contract.publication, "publication", failures)) {
    requireExactFields(contract.publication, new Set([
      "workflow", "artifactName", "certificateIdentity", "certificateIssuer",
    ]), "publication", failures);
    if (contract.publication.workflow !== "publish-images.yml") {
      failures.push("publication.workflow must be publish-images.yml");
    }
    if (contract.publication.artifactName !== "release-bundle") {
      failures.push("publication.artifactName must be release-bundle");
    }
    const expectedIdentity =
      "https://github.com/mdbase-dev/mdbase-connect/.github/workflows/" +
      "publish-images.yml@refs/heads/main";
    if (contract.publication.certificateIdentity !== expectedIdentity) {
      failures.push("publication.certificateIdentity is not the trusted main workflow");
    }
    if (contract.publication.certificateIssuer !==
      "https://token.actions.githubusercontent.com") {
      failures.push("publication.certificateIssuer is not GitHub Actions OIDC");
    }
  }

  const dependencyIds = new Set();
  if (!Array.isArray(contract.sourceDependencies) ||
      contract.sourceDependencies.length === 0) {
    failures.push("sourceDependencies must be a non-empty array");
  } else {
    for (const [index, dependency] of contract.sourceDependencies.entries()) {
      const name = `sourceDependencies[${index}]`;
      if (!requireObject(dependency, name, failures)) continue;
      requireExactFields(dependency, new Set(["id", "revisionFile"]), name, failures);
      if (!ID.test(dependency.id ?? "")) failures.push(`${name}.id is invalid`);
      if (dependencyIds.has(dependency.id)) failures.push(`duplicate dependency ${dependency.id}`);
      dependencyIds.add(dependency.id);
      if (typeof dependency.revisionFile !== "string" ||
          path.isAbsolute(dependency.revisionFile) ||
          dependency.revisionFile.includes("..")) {
        failures.push(`${name}.revisionFile must be a repository-relative path`);
        continue;
      }
      try {
        const revision = (await readFile(path.join(root, dependency.revisionFile), "utf8")).trim();
        if (!SHA.test(revision)) failures.push(`${name}.revisionFile must contain a full commit`);
      } catch {
        failures.push(`${name}.revisionFile does not exist`);
      }
    }
  }
  if (!dependencyIds.has("mdbase-rs")) failures.push("mdbase-rs source dependency is required");

  const componentIds = new Set();
  const images = new Set();
  if (!Array.isArray(contract.components) || contract.components.length === 0) {
    failures.push("components must be a non-empty array");
  } else {
    for (const [index, component] of contract.components.entries()) {
      const name = `components[${index}]`;
      if (!requireObject(component, name, failures)) continue;
      requireExactFields(component, COMPONENT_FIELDS, name, failures);
      if (!ID.test(component.id ?? "")) failures.push(`${name}.id is invalid`);
      if (componentIds.has(component.id)) failures.push(`duplicate component ${component.id}`);
      componentIds.add(component.id);
      if (component.required !== true) failures.push(`${name}.required must be true`);
      if (component.kind !== "oci-image") failures.push(`${name}.kind must be oci-image`);
      if (!/^ghcr\.io\/mdbase-dev\/[a-z0-9-]+$/.test(component.image ?? "")) {
        failures.push(`${name}.image must be an immutable-release GHCR repository`);
      }
      if (images.has(component.image)) failures.push(`duplicate image ${component.image}`);
      images.add(component.image);
      if (typeof component.dockerfile !== "string" ||
          !/^deploy\/docker\/Dockerfile\.[A-Za-z0-9-]+$/.test(component.dockerfile)) {
        failures.push(`${name}.dockerfile is invalid`);
      } else {
        try {
          await access(path.join(root, component.dockerfile));
        } catch {
          failures.push(`${name}.dockerfile does not exist`);
        }
      }
      if (component.context !== ".") failures.push(`${name}.context must be .`);
      if (component.platform !== "linux/amd64") {
        failures.push(`${name}.platform must be linux/amd64`);
      }
      if (component.attestationType !==
          "https://mdbase.dev/attestations/release-image/v1") {
        failures.push(`${name}.attestationType is unsupported`);
      }
    }
  }

  for (const id of ["connect", "hosted-provider", "mcp", "client"]) {
    if (!componentIds.has(id)) failures.push(`required component ${id} is missing`);
  }
  return failures;
}

export function githubMatrix(contract) {
  return {
    include: contract.components.map((component) => ({
      component: component.id,
      package: component.image.split("/").at(-1),
      dockerfile: component.dockerfile,
      context: component.context,
      platform: component.platform,
    })),
  };
}

export async function readComponentRecords(directory) {
  const records = [];
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(entry.parentPath, entry.name);
    records.push(JSON.parse(await readFile(file, "utf8")));
  }
  return records;
}

export function buildReleaseBundle(contract, records, metadata) {
  const failures = [];
  const byId = new Map();
  for (const record of records) {
    if (!requireObject(record, "component record", failures)) continue;
    requireExactFields(record, new Set(["component", "commit", "image"]),
      "component record", failures);
    if (byId.has(record.component)) failures.push(`duplicate component record ${record.component}`);
    byId.set(record.component, record);
  }

  const components = [];
  for (const expected of contract.components) {
    const record = byId.get(expected.id);
    if (!record) {
      failures.push(`required component record ${expected.id} is missing`);
      continue;
    }
    if (record.commit !== metadata.commit) {
      failures.push(`${expected.id} record has a different source commit`);
    }
    const match = DIGEST_IMAGE.exec(record.image ?? "");
    if (!match || match[1] !== expected.image) {
      failures.push(`${expected.id} record has an invalid image identity`);
      continue;
    }
    components.push({
      id: expected.id,
      image: record.image,
      platform: expected.platform,
      attestationType: expected.attestationType,
    });
  }
  for (const id of byId.keys()) {
    if (!contract.components.some((component) => component.id === id)) {
      failures.push(`unknown component record ${id}`);
    }
  }
  if (!SHA.test(metadata.commit ?? "")) failures.push("bundle commit is invalid");
  if (!VERSION.test(metadata.version ?? "")) failures.push("bundle version is invalid");
  if (!SHA.test(metadata.mdbaseRsRevision ?? "")) {
    failures.push("bundle mdbase-rs revision is invalid");
  }
  for (const field of ["qualificationRunId", "qualificationRunAttempt",
    "publicationRunId", "publicationRunAttempt"]) {
    if (!Number.isSafeInteger(metadata[field]) || metadata[field] < 1) {
      failures.push(`${field} must be a positive integer`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));

  return {
    schemaVersion: 1,
    repository: contract.repository,
    commit: metadata.commit,
    version: metadata.version,
    sourceDependencies: { "mdbase-rs": metadata.mdbaseRsRevision },
    qualification: {
      workflow: "server-ci.yml",
      runId: metadata.qualificationRunId,
      runAttempt: metadata.qualificationRunAttempt,
    },
    publication: {
      workflow: contract.publication.workflow,
      runId: metadata.publicationRunId,
      runAttempt: metadata.publicationRunAttempt,
    },
    components,
  };
}

export function validateReleaseBundle(contract, bundle) {
  const failures = [];
  if (!requireObject(bundle, "release bundle", failures)) return failures;
  requireExactFields(bundle, new Set([
    "schemaVersion", "repository", "commit", "version", "sourceDependencies",
    "qualification", "publication", "components",
  ]), "release bundle", failures);
  if (bundle.schemaVersion !== 1) failures.push("bundle schemaVersion must be 1");
  if (bundle.repository !== contract.repository) failures.push("bundle repository is invalid");
  if (!SHA.test(bundle.commit ?? "")) failures.push("bundle commit is invalid");
  if (!VERSION.test(bundle.version ?? "")) failures.push("bundle version is invalid");
  if (!SHA.test(bundle.sourceDependencies?.["mdbase-rs"] ?? "")) {
    failures.push("bundle mdbase-rs revision is invalid");
  }
  for (const [name, identity] of [["qualification", bundle.qualification],
    ["publication", bundle.publication]]) {
    if (!requireObject(identity, name, failures)) continue;
    if (!Number.isSafeInteger(identity.runId) || identity.runId < 1) {
      failures.push(`${name}.runId is invalid`);
    }
    if (!Number.isSafeInteger(identity.runAttempt) || identity.runAttempt < 1) {
      failures.push(`${name}.runAttempt is invalid`);
    }
  }
  if (bundle.qualification?.workflow !== "server-ci.yml") {
    failures.push("qualification workflow is invalid");
  }
  if (bundle.publication?.workflow !== contract.publication.workflow) {
    failures.push("publication workflow is invalid");
  }
  try {
    buildReleaseBundle(contract, (bundle.components ?? []).map((component) => ({
      component: component.id,
      commit: bundle.commit,
      image: component.image,
    })), {
      commit: bundle.commit,
      version: bundle.version,
      mdbaseRsRevision: bundle.sourceDependencies?.["mdbase-rs"],
      qualificationRunId: bundle.qualification?.runId,
      qualificationRunAttempt: bundle.qualification?.runAttempt,
      publicationRunId: bundle.publication?.runId,
      publicationRunAttempt: bundle.publication?.runAttempt,
    });
  } catch (error) {
    failures.push(...error.message.split("\n"));
  }
  for (const component of bundle.components ?? []) {
    const expected = contract.components.find(({ id }) => id === component.id);
    if (expected && (component.platform !== expected.platform ||
        component.attestationType !== expected.attestationType)) {
      failures.push(`${component.id} metadata does not match the release contract`);
    }
  }
  return [...new Set(failures)];
}

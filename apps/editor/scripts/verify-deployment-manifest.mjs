import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
const expectedHomepage = process.argv[3];
const expectedConnectOrigin = process.argv[4];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!source || !expectedHomepage) {
    throw new Error(
      "Usage: node scripts/verify-deployment-manifest.mjs <path-or-url> <expected-homepage> [expected-connect-origin]"
    );
  }
  await verifyManifest(source, expectedHomepage, expectedConnectOrigin, {
    attempts: positiveInteger(process.env.MDBASE_MANIFEST_VERIFY_ATTEMPTS, 1),
    delayMs: nonNegativeInteger(process.env.MDBASE_MANIFEST_VERIFY_DELAY_MS, 0)
  });
}

export async function verifyManifest(
  source,
  expectedHomepage,
  expectedConnectOrigin,
  { attempts = 1, delayMs = 0 } = {}
) {
  let failure;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const manifest = await loadManifest(source, attempt);
      assertEditorManifest(manifest, expectedHomepage, expectedConnectOrigin);
      console.log(`Verified editor file access in ${source}`);
      return;
    } catch (error) {
      failure = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw failure;
}

export function assertEditorManifest(manifest, expectedHomepage, expectedConnectOrigin) {
  const capabilities = manifest?.requirements?.capabilities;
  const version = capabilities?.contract_version === undefined ? 1 : capabilities.contract_version;
  const required = capabilities?.required;
  const files = manifest?.requirements?.files;
  // Check Editor-specific file intent in the original declared semantics.
  // Optional v2 actions and legacy field names cannot satisfy required access.
  const actions = version === 2 ? files?.required : files?.actions;
  const scope = files?.scope;
  const problems = [];

  if (manifest?.homepage !== expectedHomepage) problems.push(`homepage must be ${expectedHomepage}`);
  if (!Array.isArray(manifest?.redirect_uris) || manifest.redirect_uris[0] !== expectedHomepage) {
    problems.push(`first redirect URI must be ${expectedHomepage}`);
  }
  if (expectedConnectOrigin) {
    const callback = new URL(expectedHomepage);
    callback.searchParams.set("server", new URL(expectedConnectOrigin).origin);
    if (!manifest?.redirect_uris?.includes(callback.href)) {
      problems.push(`redirect URIs must include ${callback.href}`);
    }
  }
  if (manifest?.requirements?.access !== "full_collection") problems.push("access must be full_collection");
  if (version === 1) {
    if (!Array.isArray(required) || !required.includes("files.list")) problems.push("files.list capability is required");
    if (!Array.isArray(required) || !required.includes("files.read")) problems.push("files.read capability is required");
  } else if (version === 2) {
    if (files && Object.hasOwn(files, "actions")) problems.push("v2 file requirements must not contain legacy actions");
  } else {
    problems.push("unsupported capability contract version");
  }
  if (!Array.isArray(actions) || !actions.includes("list")) problems.push("file list action is required");
  if (!Array.isArray(actions) || !actions.includes("read")) problems.push("file read action is required");
  if (scope?.kind !== "collection") problems.push("file scope must cover the collection");

  if (problems.length > 0) {
    throw new Error(`Editor manifest does not provide binary file access: ${problems.join("; ")}.`);
  }
}

async function loadManifest(source, attempt) {
  if (/^https?:\/\//u.test(source)) {
    const url = new URL(source);
    url.searchParams.set("deployment-check", `${Date.now()}-${attempt}`);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`Could not load ${source}: HTTP ${response.status}.`);
    return response.json();
  }
  return JSON.parse(await readFile(source, "utf8"));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { appendFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const api = "https://manage.devcenter.microsoft.com/v1.0/my/applications";
const submissionId = /^[0-9]{1,30}$/;
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function configuration(env) {
  const config = {
    product: env.WINDOWS_STORE_PRODUCT_ID,
    identity: env.WINDOWS_STORE_IDENTITY_NAME,
    publisher: env.WINDOWS_STORE_PUBLISHER,
    tenant: env.WINDOWS_STORE_TENANT_ID,
    client: env.WINDOWS_STORE_CLIENT_ID
  };
  if (!/^[A-Z0-9]{12}$/.test(config.product ?? "") ||
      !config.identity || !config.publisher ||
      !guid.test(config.tenant ?? "") || !guid.test(config.client ?? "")) {
    throw new Error("Store identity and Entra federation configuration are required");
  }
  return config;
}

export function checkApplication(app, config) {
  if (app.id !== config.product || app.packageIdentityName !== config.identity ||
      app.publisherName !== config.publisher) throw new Error("Store application identity mismatch");
  if (app.pendingApplicationSubmission != null) {
    throw new Error("Existing Store submission: reconcile it manually; never delete or overwrite it in CI");
  }
  if (!submissionId.test(app.lastPublishedApplicationSubmission?.id ?? "")) {
    throw new Error("Publish the first complete submission in Partner Center before enabling CI uploads");
  }
  return app.lastPublishedApplicationSubmission.id;
}

function versionParts(value) {
  if (!/^\d+\.\d+\.\d+\.0$/.test(value ?? "")) throw new Error("Invalid Store package version");
  const parts = value.split(".").map(Number);
  if (!parts[0] || parts.some(n => n > 65535)) throw new Error("Invalid Store package version");
  return parts;
}

function newer(candidate, previous) {
  const a = versionParts(candidate);
  const b = versionParts(previous);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function packageUpdate(submission, fileName, version) {
  versionParts(version);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.appx$/.test(fileName) ||
      !submissionId.test(submission.id ?? "") ||
      submission.status !== "PendingCommit" ||
      submission.targetPublishMode !== "Immediate" ||
      !submission.listings || !Object.keys(submission.listings).length ||
      submission.packageDeliveryOptions?.isMandatoryUpdate === true ||
      !Array.isArray(submission.applicationPackages) || !submission.applicationPackages.length) {
    throw new Error("Store submission is not an eligible published-listing clone");
  }
  const packages = submission.applicationPackages.map(pkg => {
    if (pkg.architecture?.toLowerCase() !== "x64" || pkg.fileStatus !== "Uploaded" ||
        !newer(version, pkg.version)) {
      throw new Error("Expected only published x64 packages older than this release");
    }
    return { ...pkg, fileStatus: "PendingDelete" };
  });
  // Preserve the published listing, pricing, markets and rollout policy. Only
  // replace the existing x64 packages. New architectures need deliberate review.
  const result = structuredClone(submission);
  result.applicationPackages = [...packages, {
    fileName, fileStatus: "PendingUpload", minimumDirectXVersion: "None", minimumSystemRam: "None"
  }];
  return result;
}

export function uploadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Invalid Store upload destination"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
      !/^[a-z0-9]+\.blob\.core\.windows\.net$/.test(url.hostname) ||
      !url.searchParams.has("sig")) throw new Error("Invalid Store upload destination");
  return url.href;
}

// Never retry a write, follow redirects, log response bodies, tokens or SAS URLs.
// A lost response after a mutation is UNKNOWN and needs Partner Center inspection.
export async function request(fetcher, stage, url, options = {}, json = true) {
  try {
    const response = await fetcher(url, {
      ...options, redirect: "error", signal: AbortSignal.timeout(stage === "upload" ? 600_000 : 30_000)
    });
    if (!response.ok) throw new Error("http");
    return json ? await response.json() : undefined;
  } catch {
    throw new Error(`Store ${stage} failed; inspect Partner Center before retrying (write outcome may be unknown)`);
  }
}

export async function authenticate(config, env, fetcher) {
  const oidc = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  oidc.searchParams.set("audience", "api://AzureADTokenExchange");
  const assertion = await request(fetcher, "federation", oidc, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` }
  });
  if (typeof assertion.value !== "string" || !assertion.value) throw new Error("GitHub federation token missing");
  const token = await request(fetcher, "authentication",
    `https://login.microsoftonline.com/${config.tenant}/oauth2/v2.0/token`, {
      method: "POST",
      body: new URLSearchParams({
        client_id: config.client,
        grant_type: "client_credentials",
        scope: "https://manage.devcenter.microsoft.com/.default",
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion.value
      })
    });
  if (typeof token.access_token !== "string" || !token.access_token) throw new Error("Store access token missing");
  return token.access_token;
}

export async function submit({ config, token, fileName, version, zipBody, zipSize,
  fetcher = fetch, verifyPublication, record }) {
  const root = `${api}/${config.product}`;
  const headers = { Authorization: `Bearer ${token}` };
  const call = (stage, path = "", options = {}) => request(fetcher, stage, root + path, {
    ...options, headers: { ...headers, ...options.headers }
  });
  const app = await call("application preflight");
  const predecessor = checkApplication(app, config);
  const previous = await call("published submission", `/submissions/${predecessor}`);
  if (previous.id !== predecessor || previous.status !== "Published") {
    throw new Error("Store predecessor is not the exact published submission");
  }
  // Validate the exact published package set before making any remote change.
  packageUpdate({ ...previous, status: "PendingCommit" }, fileName, version);
  await verifyPublication();
  if (checkApplication(await call("application fence"), config) !== predecessor) {
    throw new Error("Published Store submission changed during preflight");
  }
  await record({ phase: "create-intent", product: config.product, version });
  const draft = await call("create", "/submissions", { method: "POST" });
  if (!submissionId.test(draft.id ?? "")) throw new Error("Store returned no attributable submission ID; reconcile manually");
  await record({ phase: "created", product: config.product, submission: draft.id, version });
  const updated = packageUpdate(draft, fileName, version);
  const destination = uploadUrl(draft.fileUploadUrl);
  // Only this invocation's newly created draft can ever be updated or committed.
  const path = `/submissions/${draft.id}`;
  const result = await call("update", path, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updated)
  });
  if (result.id !== draft.id) throw new Error("Updated Store submission identity mismatch");
  await request(fetcher, "upload", destination, {
    method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "x-ms-version": "2021-12-02",
      "Content-Type": "application/zip", "Content-Length": String(zipSize) },
    body: zipBody, duplex: "half"
  }, false);
  await record({ phase: "uploaded", product: config.product, submission: draft.id, version });
  const owner = await call("submission ownership fence");
  if (owner.pendingApplicationSubmission?.id !== draft.id ||
      checkApplication({ ...owner, pendingApplicationSubmission: null }, config) !== predecessor) {
    throw new Error("Store submission ownership changed; refusing to commit");
  }
  await verifyPublication();
  await record({ phase: "commit-intent", product: config.product, submission: draft.id, version });
  await call("commit", `${path}/commit`, { method: "POST" });
  const status = await call("status", `${path}/status`);
  const accepted = new Set(["CommitStarted", "PreProcessing", "Certification", "Release", "Publishing", "Published"]);
  if (!accepted.has(status.status)) throw new Error("Store submission not accepted; inspect its status in Partner Center");
  await record({ phase: status.status, product: config.product, submission: draft.id, version });
  return { submission: draft.id, status: status.status };
}

async function main() {
  const env = process.env;
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      !env.GITHUB_REF?.startsWith("refs/tags/v") || env.GITHUB_REPOSITORY !== "mdbase-dev/mdbase-connect") {
    throw new Error("Store uploads require the guarded tagged Desktop Release workflow");
  }
  const config = configuration(env);
  const directory = resolve("store-artifacts");
  const packages = (await readdir(directory)).filter(name => name.endsWith(".appx"));
  if (packages.length !== 1) throw new Error("Expected exactly one verified Store AppX");
  const fileName = packages[0];
  if (basename(fileName) !== fileName || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.appx$/.test(fileName)) throw new Error("Unsafe package name");
  const version = `1.0.${env.GITHUB_RUN_NUMBER}.0`;
  versionParts(version);
  const archive = resolve(env.RUNNER_TEMP, "windows-store-upload.zip");
  execFileSync("zip", ["-j", archive, resolve(directory, fileName)], { stdio: "ignore" });
  const zipSize = (await stat(archive)).size;
  const token = await authenticate(config, env, fetch);
  const result = await submit({ config, token, fileName, version, zipSize, zipBody: createReadStream(archive),
    verifyPublication: () => execFileSync(process.execPath, ["scripts/verify-client-publication.mjs"], { stdio: "inherit" }),
    record: async evidence => {
      const line = JSON.stringify({ ...evidence, commit: env.GITHUB_SHA, run: env.GITHUB_RUN_ID });
      await appendFile("windows-store-submission.jsonl", line + "\n", { mode: 0o600 });
      console.log(line);
    }
  });
  await appendFile(env.GITHUB_STEP_SUMMARY,
    `Store submission ${result.submission}: **${result.status}**. Certification and availability are asynchronous; this is not proof the update is live.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

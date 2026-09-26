import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { authenticate, checkApplication, configuration, packageUpdate, request, submit, uploadUrl } from "../submit-windows-store.mjs";

const config = { product: "9MT616XM0NND", identity: "CallumAlpass.mdbaseconnect", publisher: "CN=test" };
const app = () => ({ id: config.product, packageIdentityName: config.identity, publisherName: config.publisher,
  lastPublishedApplicationSubmission: { id: "100" }, pendingApplicationSubmission: null });
const draft = () => ({ id: "101", status: "PendingCommit", targetPublishMode: "Immediate",
  pricing: { priceId: "Free", marketSpecificPricings: {} }, visibility: "Public",
  listings: { "en-us": { baseListing: { title: "mdbase connect", images: [{ fileStatus: "Uploaded" }] } } },
  fileUploadUrl: "https://productingestionbin1.blob.core.windows.net/ingestion/test?sig=private",
  packageDeliveryOptions: { isMandatoryUpdate: false, packageRollout: { isPackageRollout: false } },
  applicationPackages: [{ id: "1", architecture: "X64", version: "1.0.10.0", fileStatus: "Uploaded", fileName: "old.appx" }]
});

test("configuration requires complete identity and federated Entra IDs", () => {
  assert.throws(() => configuration({}));
  assert.equal(configuration({ WINDOWS_STORE_PRODUCT_ID: config.product,
    WINDOWS_STORE_IDENTITY_NAME: config.identity, WINDOWS_STORE_PUBLISHER: config.publisher,
    WINDOWS_STORE_TENANT_ID: "00000000-0000-0000-0000-000000000001",
    WINDOWS_STORE_CLIENT_ID: "00000000-0000-0000-0000-000000000002" }).product, config.product);
});

test("first publication, every existing draft, and wrong app identity block automation", () => {
  assert.equal(checkApplication(app(), config), "100");
  for (const change of [
    { id: "9OTHERAPP000" }, { publisherName: "other" }, { packageIdentityName: "other" },
    { lastPublishedApplicationSubmission: null }, { pendingApplicationSubmission: {} },
    { pendingApplicationSubmission: { id: "101" } }
  ]) assert.throws(() => checkApplication({ ...app(), ...change }, config));
});

test("only packages change; listing, pricing and rollout survive exactly", () => {
  const original = draft();
  const result = packageUpdate(original, "connect.appx", "1.0.11.0");
  assert.equal(original.applicationPackages[0].fileStatus, "Uploaded");
  assert.equal(result.applicationPackages[0].fileStatus, "PendingDelete");
  assert.equal(result.applicationPackages[1].fileStatus, "PendingUpload");
  assert.deepEqual({ ...result, applicationPackages: [] }, { ...original, applicationPackages: [] });
  for (const version of ["1.0.10.0", "1.0.9.0", "1.0.65536.0", "1.0.11.1", "0.0.11.0"]) {
    assert.throws(() => packageUpdate(original, "connect.appx", version));
  }
  for (const file of ["../connect.appx", "-connect.appx", "connect.exe"]) {
    assert.throws(() => packageUpdate(original, file, "1.0.11.0"));
  }
  for (const change of [{ status: "Certification" }, { targetPublishMode: "Manual" },
    { applicationPackages: [] }, { listings: {} }, { packageDeliveryOptions: { isMandatoryUpdate: true } },
    { applicationPackages: [{ ...original.applicationPackages[0], architecture: "ARM64" }] },
    { applicationPackages: [{ ...original.applicationPackages[0], fileStatus: "PendingUpload" }] }]) {
    assert.throws(() => packageUpdate({ ...original, ...change }, "connect.appx", "1.0.11.0"));
  }
});

test("upload destinations cannot redirect credentials to another host", () => {
  assert.equal(uploadUrl(draft().fileUploadUrl), draft().fileUploadUrl);
  for (const url of ["http://a.blob.core.windows.net/?sig=x", "https://evil.test/?sig=x",
    "https://a.blob.core.windows.net.evil.test/?sig=x", "https://user@a.blob.core.windows.net/?sig=x",
    "https://a.blob.core.windows.net:444/?sig=x", "not-a-url", "https://a.blob.core.windows.net/"]) {
    assert.throws(() => uploadUrl(url));
  }
});

function scenario(overrides = {}) {
  const calls = [], evidence = [];
  let verifies = 0;
  const responses = [app(), { ...draft(), id: "100", status: "Published" }, app(), draft(), draft(), null,
    { ...app(), pendingApplicationSubmission: { id: "101" } }, { status: "CommitStarted" }, { status: "PreProcessing" }];
  const options = {
    config, token: "private-token", fileName: "connect.appx", version: "1.0.11.0", zipBody: "zip", zipSize: 3,
    verifyPublication: async () => { verifies++; }, record: async value => evidence.push(value),
    fetcher: async (url, options) => {
      calls.push({ url: String(url), ...options });
      const index = calls.length - 1;
      if (overrides.failAt === index) throw new Error("private-token private SAS URL");
      return { ok: true, json: async () => overrides.responses?.[index] ?? responses[index] };
    }
  };
  return { options, calls, evidence, verifies: () => verifies };
}

test("exact created submission is uploaded and committed only after two production guards", async () => {
  const s = scenario();
  assert.deepEqual(await submit(s.options), { submission: "101", status: "PreProcessing" });
  assert.equal(s.verifies(), 2);
  assert.deepEqual(s.calls.map(c => c.method ?? "GET"), ["GET", "GET", "GET", "POST", "PUT", "PUT", "GET", "POST", "GET"]);
  assert.ok(s.calls.every(c => c.redirect === "error"));
  assert.equal(s.calls[5].headers.Authorization, undefined);
  assert.equal(s.calls[5].headers["x-ms-blob-type"], "BlockBlob");
  assert.ok(s.calls[4].url.endsWith("/submissions/101"));
  assert.ok(s.calls[7].url.endsWith("/submissions/101/commit"));
  assert.doesNotMatch(JSON.stringify(s.evidence), /private|sig=|fileUploadUrl|listings/);
});

test("concurrent draft or predecessor change stops before POST", async () => {
  for (const changed of [ { ...app(), pendingApplicationSubmission: { id: "102" } },
    { ...app(), lastPublishedApplicationSubmission: { id: "102" } } ]) {
    const s = scenario({ responses: { 2: changed } });
    await assert.rejects(submit(s.options));
    assert.equal(s.calls.length, 3);
  }
});

test("unknown writes are never retried or cleaned up destructively", async () => {
  for (const failAt of [3, 4, 5, 6, 7, 8]) {
    const s = scenario({ failAt });
    await assert.rejects(submit(s.options), error => {
      assert.doesNotMatch(error.message, /private-token|SAS URL/);
      return /outcome may be unknown/.test(error.message);
    });
    assert.equal(s.calls.length, failAt + 1);
    assert.ok(!s.calls.some(c => c.method === "DELETE"));
  }
});

test("failed production fence never commits", async () => {
  const s = scenario();
  let count = 0;
  s.options.verifyPublication = () => { if (++count === 2) throw new Error("production moved"); };
  await assert.rejects(submit(s.options), /production moved/);
  assert.equal(s.calls.length, 7);
});

test("changed draft ownership cannot reach commit", async () => {
  const s = scenario({ responses: { 6: { ...app(), pendingApplicationSubmission: { id: "102" } } } });
  await assert.rejects(submit(s.options), /ownership changed/);
  assert.equal(s.calls.length, 7);
});

test("federation exchanges a GitHub assertion without long-lived credentials", async () => {
  const calls = [];
  const token = await authenticate({ tenant: "tenant", client: "client" }, {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.actions.githubusercontent.com/token?test=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-request-token"
  }, async (url, options) => {
    calls.push({ url: String(url), ...options });
    return { ok: true, json: async () => calls.length === 1 ? { value: "assertion" } : { access_token: "short-lived" } };
  });
  assert.equal(token, "short-lived");
  assert.equal(new URL(calls[0].url).searchParams.get("audience"), "api://AzureADTokenExchange");
  assert.equal(calls[1].body.get("scope"), "https://manage.devcenter.microsoft.com/.default");
  assert.equal(calls[1].body.get("client_assertion"), "assertion");
  assert.equal(calls[1].body.has("client_secret"), false);
  assert.equal(calls[1].headers, undefined);
});

test("HTTP errors and malformed response bodies are redacted", async () => {
  for (const response of [{ ok: false }, { ok: true, json: () => { throw new Error("secret"); } }]) {
    await assert.rejects(request(async () => response, "create", "https://example.test"), /Store create failed/);
  }
});

test("workflow gates Store writes behind public release, exact provenance, environment and global serialization", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/desktop-release.yml", import.meta.url), "utf8");
  const job = workflow.split("  publish-windows-store:\n")[1].split("  website-update:\n")[0];
  assert.match(job, /needs: publish/);
  assert.match(job, /environment: windows-store/);
  assert.match(job, /WINDOWS_STORE_SUBMISSION_ENABLED == 'true'/);
  assert.match(job, /group: windows-store-publication\n      cancel-in-progress: false/);
  assert.match(job, /id-token: write/);
  assert.match(job, /name: windows-store-submission\n          path: store-artifacts/);
  assert.ok(job.indexOf("cosign verify-blob") < job.indexOf("node scripts/submit-windows-store.mjs"));
  assert.doesNotMatch(job, /client.secret|--run-id|run-id:/i);
  assert.match(workflow, /WINDOWS_STORE_LIVE.*true/);
});

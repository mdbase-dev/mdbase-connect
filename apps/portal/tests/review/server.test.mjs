import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewServer } from "./server.mjs";
import { authorizationId, pairingId } from "./scenarios.mjs";

async function harness(context) {
  const server = reviewServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const select = async (name, latency = 0, cookie = "") => {
    const response = await fetch(`${origin}/__review/scenario/${name}?latency=${latency}`, { redirect: "manual", headers: { cookie } });
    assert.equal(response.status, 302);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const request = (cookie, path, method = "GET", body) => fetch(`${origin}${path}`, {
    method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {})
  });
  const read = async (cookie, path = "/v1/me") => {
    const response = await request(cookie, path);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { origin, select, request, read };
}

test("scenario cookies isolate mutations and reselection resets only that browser", async context => {
  const { select, request, read } = await harness(context);
  const first = await select("typical-account");
  const second = await select("typical-account");
  assert.equal((await request(first, "/v1/hosted/collections/hosted-0", "PATCH", { display_name: "Coastal archive" })).status, 200);
  assert.equal((await read(first)).hosted_collections[0].display_name, "Coastal archive");
  assert.equal((await read(second)).hosted_collections[0].display_name, "Shared research library");
  const reset = await select("typical-account", 0, first);
  assert.equal((await request(first, "/v1/me")).status, 401);
  assert.equal((await read(reset)).hosted_collections[0].display_name, "Shared research library");
  assert.equal((await request(reset, "/v1/not-implemented")).status, 501);
});

test("creation, approval, sharing and revocation update subsequent reads", async context => {
  const { select, request, read } = await harness(context);
  const cookie = await select("typical-account");
  const created = await (await request(cookie, "/v1/hosted/collections", "POST", { display_name: "Bird observations" })).json();
  assert.ok((await read(cookie)).hosted_collections.some(collection => collection.id === created.collection.id));
  assert.equal((await request(cookie, `/v1/authorization-requests/${authorizationId}/approve`, "POST", { collection_id: created.collection.id, operations: ["read"] })).status, 200);
  assert.equal((await read(cookie, `/v1/authorization-requests/${authorizationId}/status`)).status, "approved");
  const grant = (await read(cookie)).grants.at(-1);
  assert.equal(grant.collection_id, created.collection.id);
  const revoked = await (await request(cookie, "/v1/grants/revoke-batch", "POST", { grant_ids: [grant.id] })).json();
  assert.deepEqual(revoked.results, [{ grant_id: grant.id, status: "revoked" }]);
  assert.equal((await read(cookie)).grants.at(-1).revocation_status, "revoked");
  await request(cookie, "/v1/hosted/collections/hosted-0/members/member-sam", "PATCH", { role: "viewer" });
  assert.equal((await read(cookie, "/v1/hosted/collections/hosted-0/members")).members[1].role, "viewer");
  await request(cookie, "/v1/hosted/collections/hosted-0/members/member-sam", "DELETE");
  assert.equal((await read(cookie, "/v1/hosted/collections/hosted-0/members")).members.length, 2);
  const invitation = await (await request(cookie, "/v1/hosted/collections/hosted-0/invitations", "POST", { email: "alex@coastal.example", role: "editor" })).json();
  await request(cookie, `/v1/hosted/collections/hosted-0/invitations/${invitation.invitation.id}`, "DELETE");
  assert.deepEqual((await read(cookie, "/v1/hosted/collections/hosted-0/invitations")).invitations, []);
});

test("pairing creation resumes its identity and approval persists", async context => {
  const { select, request, read } = await harness(context);
  const cookie = await select("pairing-create-new");
  const path = `/v1/pairing-requests/${pairingId}`;
  const result = await (await request(cookie, `${path}/collections`, "POST", { display_name: "Reader highlights" })).json();
  assert.equal(result.collection_id, "creation-reader");
  await request(cookie, `${path}/approve`, "POST", { selected_collection_id: result.collection_id, collection_ids: [result.collection_id], create_collections: false });
  const { pairing } = await read(cookie, path);
  assert.ok(pairing.approved_at);
  assert.equal(pairing.creation.completed, true);
  assert.equal(pairing.selected_collection_id, result.collection_id);
  const cancelled = await select("pairing-fresh");
  await request(cancelled, `${path}/deny`, "POST");
  assert.equal((await request(cancelled, path)).status, 404);
});

test("local auth cannot redirect to external providers and applies latency", async context => {
  const { origin, select, request, read } = await harness(context);
  const cookie = await select("anonymous", 60);
  assert.equal((await request(cookie, "/v1/me")).status, 401);
  const started = performance.now();
  const github = await fetch(`${origin}/auth/github?return_to=https://github.com/login`, { headers: { cookie }, redirect: "manual" });
  assert.equal(github.headers.get("location"), "/collections");
  assert.ok(performance.now() - started >= 50);
  assert.equal((await read(cookie)).user.name, "Maya Chen");
  await request(cookie, `/auth/google?return_to=${encodeURIComponent(`${origin}/pair/${pairingId}`)}`);
  const google = await (await request(cookie, "/auth/google/callback", "POST", { credential: "local-review-only" })).json();
  assert.equal(google.redirect_to, `/pair/${pairingId}`);
  const feedback = await fetch(`${origin}/v1/feedback`, { method: "POST", body: JSON.stringify({ message: "The collection picker is useful." }) });
  assert.equal(feedback.status, 201);
});

test("review configuration and onboarding expose the demo Editor handoff", async context => {
  const { select, read, request } = await harness(context);
  const cookie = await select("typical-account");
  const { editor_url } = await read(cookie, "/v1/ui-configuration");
  assert.equal(new URL(editor_url).searchParams.get("demo"), "300");
  assert.equal(new URL(editor_url).hostname, "127.0.0.1");
  const ready = await request(cookie, "/v1/onboarding/starter-collection", "POST", {});
  assert.equal((await ready.json()).editor_url, editor_url);
});

test("OAuth signup previews agreements without a session and completes at getting started", async context => {
  const { origin, select, request, read } = await harness(context);
  for (const provider of ["github", "google"]) {
    for (const target of ["/", "/collections", `/pair/${pairingId}`]) {
      const cookie = await select("signup");
      const started = await fetch(`${origin}/auth/${provider}?return_to=${encodeURIComponent(target)}`, { headers: { cookie }, redirect: "manual" });
      const destination = provider === "github" ? started.headers.get("location")
        : (await (await request(cookie, "/auth/google/callback", "POST", { credential: "local-review-only" })).json()).redirect_to;
      assert.equal(destination, `/signup?external=1&return_to=${encodeURIComponent(target)}`);
      assert.equal((await request(cookie, "/v1/me")).status, 401);
      const preview = await (await request(cookie, "/v1/auth/external/signup/preview", "POST", {})).json();
      assert.equal(preview.email, "maya@chen.example");
      const body = { proof_id: preview.proof_id, name: "Maya Chen", terms_version: "1", privacy_version: "1", product_updates: false };
      assert.equal((await request(cookie, "/v1/auth/external/signup", "POST", { ...body, terms_version: "old" })).status, 400);
      assert.equal((await request(cookie, "/v1/me")).status, 401);
      const completed = await (await request(cookie, "/v1/auth/external/signup", "POST", body)).json();
      assert.equal(completed.redirect_to, target === "/" ? "/getting-started" : target);
      assert.equal((await read(cookie)).user.name, "Maya Chen");
    }
  }
});

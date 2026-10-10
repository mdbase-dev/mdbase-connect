import assert from "node:assert/strict";

/** Real portal UI against synthetic APIs, using the audit's ONE isolated browser.
 * Covers consent payloads, not native installation/runtime acceptance. */
export async function auditPortalInstallationApproval(localPage, origin) {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const created = "33333333-3333-4333-8333-333333333333";
  const base = {
    connector_name: "TaskNotes", approved_at: null, installation_device: true,
    kind: "app-runtime", account_selected: true, account_selection_confirmed: true,
    account_email: "fixture@example.test", attested: true, fingerprint: "ab".repeat(32),
    app_origin: "https://tasknotes.example.test", requested_create_collections: true,
    approved_create_collections: false, can_create_collection: true, creation: null,
    collections: [
      {collection_id: first, display_name: "Personal notes", role: "owner"},
      {collection_id: second, display_name: "Work notes", role: "owner"}
    ]
  };
  const page = await localPage();
  let pairing = structuredClone(base), posts = [], failCreation = false, loseApproval = false;
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.route("**/v1/pairing-requests/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "GET") return route.fulfill({json: {pairing}});
    const body = request.postDataJSON();
    posts.push({path, body});
    if (path.endsWith("/collections")) {
      pairing.creation = {collection_id: created, display_name: body.display_name, completed: !failCreation};
      if (failCreation) return route.fulfill({status: 503, json: {error: "creation_incomplete", message: "Collection creation is incomplete."}});
      pairing.collections.push({collection_id: created, display_name: body.display_name, role: "owner"});
      return route.fulfill({json: {collection_id: created, display_name: body.display_name}});
    }
    assert.ok(path.endsWith("/approve"), "only explicit creation/approval mutations occur");
    pairing.approved_at = new Date().toISOString();
    if (loseApproval) return route.abort("failed");
    return route.fulfill({json: {ok: true}});
  });
  const url = `${origin}/pair/00000000-0000-4000-8000-000000000001`;
  const picker = () => page.getByRole("combobox", {name: "Open in TaskNotes", exact: true});
  const approve = () => page.getByRole("button", {name: "Approve", exact: true});
  const load = async () => {
    pairing = structuredClone(base); posts = []; failCreation = false; loseApproval = false;
    await page.goto(url); await picker().waitFor();
  };
  const choose = async name => {
    await picker().click(); await page.getByRole("option", {name, exact: true}).click();
  };
  const done = () => page.getByRole("heading", {name: "Access approved", exact: true}).waitFor();
  try {
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({colorScheme});
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({width, height: 1000});
        await load(); await choose("Personal notes");
        assert.equal(await picker().count(), 1);
        assert.equal(await page.getByRole("checkbox").count(), 0, "extra consent waits behind Advanced");
        assert.doesNotMatch(await page.locator("body").innerText(), /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.ok(await approve().evaluate(element => element.getBoundingClientRect().height) >= 44);
      }
    }
    await load();
    pairing.account_email = null; pairing.account_provider = "github"; pairing.account_login = "original";
    await page.reload(); await picker().waitFor();
    await page.getByText("Account: GitHub account @original", {exact: true}).waitFor();
    await load(); await choose("Personal notes");
    await choose("Work notes"); await approve().click(); await done();
    assert.deepEqual(posts.map(post => post.body), [{fingerprint: base.fingerprint, collection_ids: [second], create_collections: true, selected_collection_id: second}], "changing the picker does not silently accumulate access");
    await load(); await choose("Personal notes");
    await page.getByText("Advanced: allow more collections", {exact: true}).click();
    await page.getByRole("checkbox", {name: "Work notes", exact: true}).check();
    await approve().click(); await done();
    assert.deepEqual([...posts[0].body.collection_ids].sort(), [first, second].sort());
    await load();
    Object.assign(pairing, {scope_only: true, retained_collection_ids: [first], retained_create_collections: true});
    await page.reload(); await picker().waitFor(); await choose("Work notes");
    await approve().click(); await done();
    assert.deepEqual(posts.map(post => post.body), [{fingerprint: base.fingerprint, collection_ids: [second], create_collections: false, selected_collection_id: second}], "additive consent neither withdraws nor re-grants retained access");
    await load(); await choose("New collection…");
    await page.getByLabel("New collection name", {exact: true}).fill("New notes");
    await approve().click(); await done();
    assert.equal(posts.length, 2);
    assert.ok(posts[0].path.endsWith("/collections"));
    assert.deepEqual(posts[0].body, {display_name: "New notes"});
    assert.deepEqual(posts[1].body, {fingerprint: base.fingerprint, collection_ids: [created], create_collections: true, selected_collection_id: created});
    await load(); await choose("New collection…");
    await page.getByLabel("New collection name").fill("Original name");
    failCreation = true; await approve().click(); await page.getByRole("alert").waitFor();
    assert.equal(posts.length, 1);
    assert.equal(await page.getByLabel("New collection name").inputValue(), "Original name");
    assert.equal(await page.getByLabel("New collection name").getAttribute("readonly"), "");
    await page.waitForTimeout(1200);
    assert.equal(posts.length, 1, "read-only reconciliation never resubmits uncertain creation");
    failCreation = false; await approve().click(); await done();
    assert.deepEqual(posts.slice(0, 2).map(post => post.body), [{display_name: "Original name"}, {display_name: "Original name"}], "explicit retry resumes the original name/target");
    await load(); await choose("Personal notes"); loseApproval = true;
    await approve().click(); await done();
    assert.equal(posts.length, 1, "lost approval reply is observed, not replayed");
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.setViewportSize({width: 640, height: 1000});
    await load(); await choose("Personal notes");
    await page.evaluate(() => {document.documentElement.style.zoom = "2";});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
  } finally {await page.close();}
}

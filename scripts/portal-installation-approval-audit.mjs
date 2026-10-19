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
    if (request.method() === "GET") {
      const hint = new URL(request.url()).searchParams.get("collection_hint");
      return route.fulfill({json: {pairing: {...pairing, collection_hint: pairing.account_selection_confirmed && pairing.collections.some(collection => collection.collection_id === hint) ? hint : null}}});
    }
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
  const picker = () => page.getByRole("listbox", {name: "Open in TaskNotes", exact: true});
  const selectedLabel = () => picker().locator("option:checked").innerText();
  const approve = () => page.getByRole("button", {name: "Approve", exact: true});
  const load = async hint => {
    pairing = structuredClone(base); posts = []; failCreation = false; loseApproval = false;
    await page.goto(`${url}${hint ? `?collection_hint=${hint}` : ""}`); await picker().waitFor();
  };
  const choose = async name => { await picker().selectOption({label: name}); };
  const done = () => page.getByRole("heading", {name: "Access approved", exact: true}).waitFor();
  try {
    // The inline native list replaces the popover: no upward-flipping layer can
    // cover its filter, including in a short approval popup with a long catalog.
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({colorScheme, reducedMotion: "no-preference"});
      for (const viewport of [{width: 639, height: 444}, {width: 390, height: 844}, {width: 320, height: 568}]) {
        await page.setViewportSize(viewport); await load();
        pairing.collections.push(...Array.from({length: 61}, (_, index) => ({
          collection_id: `${index.toString(16).padStart(8, "0")}-4444-4444-8444-444444444444`,
          display_name: `Fixture collection ${index}`, role: "owner"
        })));
        await page.reload(); await picker().waitFor(); await picker().focus();
        await picker().evaluate(list => list.scrollIntoView({block: "center"}));
        const appearance = await picker().evaluate(list => {
          const box = list.getBoundingClientRect();
          return {rows: list.size, width: box.width, height: box.height,
            fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight};
        });
        assert.ok(appearance.rows > 1, "the collection list is inline, not a dropdown");
        assert.ok(appearance.width > 0 && appearance.height > 0 && appearance.fits, "long picker is bounded by the popup viewport");
        const search = page.getByRole("searchbox", {name: "Find a collection", exact: true});
        assert.equal(await search.evaluate(input => {
          const box = input.getBoundingClientRect();
          return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === input;
        }), true, "collection search stays pointer-reachable while the long picker is open; Escape is not required");
        await search.click(); await search.fill("fixture collection 60");
        assert.equal(await picker().locator("option").count(), 3, "filter leaves only the disabled placeholder, creation and the matching collection");
        assert.equal(await picker().inputValue(), "", "filtering never chooses a collection");
        await page.getByRole("option", {name: "Fixture collection 60", exact: true}).waitFor();
        await search.fill("");
        assert.equal(await picker().locator("option").count(), pairing.collections.length + 2, "clearing search restores the full catalog");
        await picker().focus(); await page.keyboard.press("p");
        assert.equal(await picker().inputValue(), first, "native keyboard navigation selects Personal notes");
        await page.keyboard.press("Enter");
        assert.equal(posts.length, 0, "focus, filtering and keyboard selection never approve or create a collection");
      }
    }
    for (const colorScheme of ["light", "dark"]) {
      await page.emulateMedia({colorScheme});
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({width, height: 1000});
        await load(); await choose("Personal notes");
        assert.equal(await picker().count(), 1);
        assert.equal(await page.getByRole("checkbox").count(), 0, "extra consent waits behind Advanced");
        assert.doesNotMatch(await page.locator("body").innerText(), /[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/i);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await approve().isEnabled(), true, "picked collection enables approval");
        assert.deepEqual(await approve().evaluate(element => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = "var(--color-accent)";
          probe.style.color = "var(--color-on-accent)";
          element.after(probe);
          const actual = getComputedStyle(element), expected = getComputedStyle(probe);
          const state = [element.disabled, actual.backgroundColor === expected.backgroundColor, actual.color === expected.color];
          probe.remove();
          return state;
        }), [false, true, true], "enabled approval immediately uses the filled primary colors, never disabled gray");
        assert.ok(await approve().evaluate(element => element.getBoundingClientRect().height) >= 44);
      }
    }
    await load(first);
    assert.equal(await picker().inputValue(), first, "eligible link target is preselected");
    assert.equal(posts.length, 0, "a hint never triggers approval");
    await choose("Work notes"); await approve().click(); await done();
    assert.deepEqual(posts.map(post => post.body), [{fingerprint: base.fingerprint, collection_ids: [second], create_collections: true, selected_collection_id: second}], "choose another overrides the requested hint without granting it");
    await load(created);
    assert.equal(await picker().inputValue(), "", "unavailable hint does not reveal a name or select another collection");
    assert.equal(await approve().isEnabled(), false);
    assert.equal(posts.length, 0);
    await load(first);
    pairing.creation = {collection_id: created, display_name: "Original name", completed: false};
    await page.reload(); await picker().waitFor();
    assert.equal(await selectedLabel(), "Create a new collection…", "original creation overrides a hint");
    assert.equal(await page.getByLabel("New collection name", {exact: true}).inputValue(), "Original name", "original creation keeps the server's name");
    assert.equal(await page.getByLabel("New collection name", {exact: true}).getAttribute("readonly"), "");
    assert.equal(posts.length, 0);
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
    await load(); await choose("Create a new collection…");
    await page.getByLabel("New collection name", {exact: true}).fill("New notes");
    await approve().click(); await done();
    assert.equal(posts.length, 2);
    assert.ok(posts[0].path.endsWith("/collections"));
    assert.deepEqual(posts[0].body, {display_name: "New notes"});
    assert.deepEqual(posts[1].body, {fingerprint: base.fingerprint, collection_ids: [created], create_collections: true, selected_collection_id: created});
    await load(); await choose("Create a new collection…");
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
    await load();
    Object.assign(pairing, {collections: [], requested_create_collections: false, can_create_collection: false, timer_declaration: {environment: "lab", digest: "cd".repeat(32)}});
    await page.reload(); await picker().waitFor();
    assert.equal(await page.getByText("Advanced: allow more collections").count(), 0, "no empty additional-access section");
    const reminders = page.getByRole("checkbox", {name: "Allow TaskNotes to send you reminders", exact: true});
    assert.deepEqual(await reminders.evaluate(element => [element.getBoundingClientRect().height <= 24, element.closest("label").getBoundingClientRect().height >= 44]), [true, true], "reminder checkbox keeps its size; its label is the 44px target");
    await load(); await page.getByText("Advanced: allow more collections", {exact: true}).click();
    assert.equal(await page.getByRole("group", {name: "Additional collection access", exact: true}).evaluate(element => getComputedStyle(element).borderTopStyle), "none", "additional access is not outlined like a text field");
    await page.setViewportSize({width: 640, height: 1000});
    await load(); await choose("Personal notes");
    await page.evaluate(() => {document.documentElement.style.zoom = "2";});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.deepEqual(errors, []);
  } finally {await page.close();}
}

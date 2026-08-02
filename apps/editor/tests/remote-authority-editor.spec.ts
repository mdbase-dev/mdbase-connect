import { expect, test, type Page, type Route } from "@playwright/test";

const collectionId = "10000000-0000-4000-8000-000000000001";
const replicaId = "20000000-0000-4000-8000-000000000002";
const grantId = "30000000-0000-4000-8000-000000000003";
const secondCollectionId = "10000000-0000-4000-8000-000000000011";
const secondReplicaId = "20000000-0000-4000-8000-000000000012";
const secondGrantId = "30000000-0000-4000-8000-000000000013";
const providerOrigin = "https://sync.mdbase.dev";

test("chooses a remote authority collection and performs CRUD through its provider", async ({ page }) => {
  const authority = new RemoteAuthorityHarness(page);
  await authority.install();

  await page.goto("/");
  await expect(page.getByText("Choose the collection you want to write in.")).toBeVisible();
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Choose a collection" }).click();
  const approval = await popupPromise;
  await expect(approval).toHaveURL(/connect\.mdbase\.dev\/oauth\/authorize/);
  const collection = approval.getByRole("combobox", { name: "Collection" });
  await expect(collection).toHaveValue(collectionId);
  await expect(collection).toContainText("Hosted writing · Hosted by mdbase");
  await approval.getByRole("button", { name: "Allow access" }).click();

  await expect(page.getByRole("heading", { name: "Hosted writing" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome to hosted writing");

  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("A hosted draft");
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("A hosted draft");

  await page.getByRole("textbox", { name: "Note body" }).fill("Stored directly on mdbase.");
  await expect.poll(() => authority.operations.filter((operation) => operation === "update").length).toBe(1);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "A hosted draft.md" }).click();
  const path = page.getByRole("textbox", { name: "Markdown path" });
  await path.fill("Writing/A hosted draft.md");
  await path.press("Enter");
  await expect(page.getByRole("button", { name: "Writing/A hosted draft.md" })).toBeVisible();

  await page.getByLabel("More note actions").click();
  await page.getByRole("menuitem", { name: "Delete note" }).click();
  const confirmation = page.getByRole("alert");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome to hosted writing");
  await expect(page.getByRole("option", { name: /A hosted draft/ })).toHaveCount(0);

  await expect.poll(() => new Set(authority.operations)).toEqual(new Set([
    "changes",
    "create",
    "delete",
    "describe",
    "query",
    "read",
    "rename",
    "update"
  ]));
  expect(authority.controlPlaneOperations).toBe(0);
});

test("returns to the newly chosen remote authority when switching collections", async ({ page }) => {
  const authority = new RemoteAuthorityHarness(page);
  await authority.install();

  await page.goto("/");
  const firstPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Choose a collection" }).click();
  const firstApproval = await firstPopupPromise;
  await firstApproval.getByRole("button", { name: "Allow access" }).click();
  await expect(page.getByRole("heading", { name: "Hosted writing" })).toBeVisible();

  await page.getByRole("button", {
    name: "Switch collection, current collection Hosted writing"
  }).click();
  const secondPopupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Choose another collection" }).click();

  const secondApproval = await secondPopupPromise;
  const collection = secondApproval.getByRole("combobox", { name: "Collection" });
  await collection.selectOption(secondCollectionId);
  await secondApproval.getByRole("button", { name: "Allow access" }).click();

  await expect(page).toHaveURL(new RegExp(`collection=${secondCollectionId}`));
  await expect(page.getByRole("heading", { name: "Research" })).toBeVisible();
});

interface AuthorityRecord {
  path: string;
  frontmatter: Record<string, unknown>;
  effective_frontmatter: Record<string, unknown>;
  body: string;
  types: string[];
  revision: string;
  file: {
    name: string;
    folder: string;
    size: number;
    mtime: string;
    tags: string[];
    links: string[];
    embeds: string[];
  };
}

class RemoteAuthorityHarness {
  readonly operations: string[] = [];
  controlPlaneOperations = 0;
  private sequence = 1;
  private proofPublicKey: string | null = null;
  private readonly authorizations = new Map<string, {
    redirectUri: string;
    state: string;
    collectionId?: string;
  }>();
  private readonly records = new Map<string, AuthorityRecord>();

  constructor(private readonly page: Page) {
    const welcome = this.document(
      "Welcome.md",
      "# Welcome to hosted writing\n\nThis Markdown is authoritative on mdbase.\n",
      {}
    );
    this.records.set(welcome.path, welcome);
  }

  async install() {
    await this.page.context().route("https://connect.mdbase.dev/**", (route) => this.control(route));
    await this.page.context().route(`${providerOrigin}/**`, (route) => this.provider(route));
  }

  private async control(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/v1/apps/register") {
      expect(request.postDataJSON()).toMatchObject({
        manifest: {
          manifest_version: 1,
          id: "dev.mdbase.editor"
        }
      });
      return json(route, {
        application: {
          id: "40000000-0000-4000-8000-000000000004",
          manifest_digest: "0".repeat(64),
          name: "mdbase editor",
          homepage: "http://127.0.0.1:4174/",
          requirements: { contracts: [], access: "full_collection" }
        }
      });
    }
    if (url.pathname === "/oauth/authorization_request") {
      const form = new URLSearchParams(request.postData() ?? "");
      const proof = JSON.parse(form.get("application_authorization") ?? "null");
      const authorizationId = proof.binding.authorization_id as string;
      this.proofPublicKey = proof.binding.grant_signing_public_key;
      this.authorizations.set(authorizationId, {
        redirectUri: form.get("redirect_uri")!,
        state: form.get("state")!
      });
      return json(route, {
        authorization_id: authorizationId,
        authorization_uri: `https://connect.mdbase.dev/oauth/authorize?request_id=${authorizationId}`,
        expires_in: 600,
        interval: 1
      });
    }
    if (url.pathname === "/oauth/authorize") {
      const authorizationId = url.searchParams.get("request_id")!;
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: authorizationPage(authorizationId)
      });
    }
    if (url.pathname === "/test/approve") {
      const authorization = this.authorizations.get(url.searchParams.get("request_id")!);
      if (!authorization) return json(route, { error: "not_found" }, 404);
      authorization.collectionId = url.searchParams.get("collection_id")!;
      return json(route, { ok: true });
    }
    if (url.pathname === "/oauth/authorization_status") {
      const form = new URLSearchParams(request.postData() ?? "");
      const authorization = this.authorizations.get(form.get("authorization_id")!);
      if (!authorization?.collectionId) {
        return json(route, {
          error: "authorization_pending",
          error_description: "The user has not completed the authorization request."
        }, 400);
      }
      const callback = new URL(authorization.redirectUri);
      callback.searchParams.set(
        "code",
        authorization.collectionId === secondCollectionId
          ? "hosted-code-second"
          : "hosted-code"
      );
      callback.searchParams.set("state", authorization.state);
      return json(route, { authorization_redirect: callback.href });
    }
    if (url.pathname === "/oauth/token") {
      const code = new URLSearchParams(request.postData() ?? "").get("code");
      const selectedSecondCollection = code === "hosted-code-second";
      return json(route, {
        access_token: "control-plane-access",
        refresh_token: "control-plane-refresh",
        token_type: "Bearer",
        expires_in: 3_600,
        refresh_expires_in: 2_592_000,
        collection_id: selectedSecondCollection ? secondCollectionId : collectionId,
        collection_name: selectedSecondCollection ? "Research" : "Hosted writing",
        operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"],
        scope: { contracts: [], access: "full_collection" },
        grant_id: selectedSecondCollection ? secondGrantId : grantId,
        encryption: null,
        authority: {
          operations_url: `${providerOrigin}/v1/authorities/${selectedSecondCollection ? secondCollectionId : collectionId}/operations`,
          sync_url: `${providerOrigin}/v1/authorities/${selectedSecondCollection ? secondCollectionId : collectionId}/sync`,
          files_url: `${providerOrigin}/v1/authorities/${selectedSecondCollection ? secondCollectionId : collectionId}/files`,
          replica_id: selectedSecondCollection ? secondReplicaId : replicaId,
          access_token: selectedSecondCollection ? "remote-authority-access-second" : "remote-authority-access",
          proof_public_key: this.proofPublicKey
        }
      });
    }
    if (url.pathname.includes("/operations/")) this.controlPlaneOperations += 1;
    return route.abort("failed");
  }

  private async provider(route: Route) {
    const request = route.request();
    const selectedSecondCollection = request.headers().authorization === "Bearer remote-authority-access-second";
    expect([
      "Bearer remote-authority-access",
      "Bearer remote-authority-access-second"
    ]).toContain(request.headers().authorization);
    const operation = new URL(request.url()).pathname.split("/").at(-1)!;
    const operationRequest = request.postDataJSON() as {
      protocol_version?: unknown;
      request_id?: unknown;
      input?: unknown;
    };
    expect(operationRequest.protocol_version).toBe(1);
    expect(operationRequest.request_id).toEqual(expect.any(String));
    const requestId = String(operationRequest.request_id);
    const input = object(operationRequest.input);
    this.operations.push(operation);

    if (operation === "describe") return providerResult(route, requestId, {
      protocol_version: 1,
      collection_id: selectedSecondCollection ? secondCollectionId : collectionId,
      display_name: selectedSecondCollection ? "Research" : "Hosted writing",
      spec_version: "0.3.0",
      operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"],
      change_cursor: this.sequence,
      types: [],
      contracts: [],
      configuration: {
        spec_version: "0.3.0",
        settings: { types_folder: "_types", validation: "error" }
      }
    });
    if (operation === "changes") return providerResult(route, requestId, {
      cursor: this.sequence,
      events: [],
      has_more: false
    });
    if (operation === "query") {
      const includeBody = input.include_body === true;
      const records = [...this.records.values()].map((record) => summary(record, includeBody));
      return providerResult(route, requestId, envelope({
        results: records,
        meta: { total_count: records.length, has_more: false }
      }));
    }
    if (operation === "read") {
      return providerResult(
        route,
        requestId,
        envelope(this.record(String(input.path))),
      );
    }
    if (operation === "create") {
      const record = this.document(
        String(input.path),
        typeof input.body === "string" ? input.body : "",
        object(input.frontmatter)
      );
      this.records.set(record.path, record);
      return providerResult(route, requestId, envelope(record));
    }
    if (operation === "update") {
      const current = this.record(String(input.path));
      const record = this.document(
        current.path,
        typeof input.body === "string" ? input.body : current.body,
        { ...current.frontmatter, ...object(input.patch ?? input.fields) }
      );
      this.records.set(record.path, record);
      return providerResult(route, requestId, envelope(record));
    }
    if (operation === "rename") {
      const from = String(input.from);
      const current = this.record(from);
      if (input.dry_run === true) {
        return providerResult(route, requestId, envelope({
          from,
          to: String(input.to),
          dry_run: true,
          would_rename: true,
          references_affected: []
        }));
      }
      const record = this.document(String(input.to), current.body, current.frontmatter);
      this.records.delete(from);
      this.records.set(record.path, record);
      return providerResult(route, requestId, envelope({ ...record, from }));
    }
    if (operation === "delete") {
      const path = String(input.path);
      this.record(path);
      if (input.dry_run === true) {
        return providerResult(route, requestId, envelope({
          path,
          deleted: false,
          dry_run: true,
          would_delete: true,
          broken_links: []
        }));
      }
      this.records.delete(path);
      return providerResult(
        route,
        requestId,
        envelope({ path, deleted: true, broken_links: [] }),
      );
    }
    if (operation === "validate") {
      return providerResult(
        route,
        requestId,
        envelope({ path: input.path }),
      );
    }
    return json(route, { error: { code: "unsupported_operation", message: operation } }, 400);
  }

  private record(path: string): AuthorityRecord {
    const record = this.records.get(path);
    if (!record) throw new Error(`Hosted test record not found: ${path}`);
    return record;
  }

  private document(path: string, body: string, frontmatter: Record<string, unknown>): AuthorityRecord {
    const slash = path.lastIndexOf("/");
    const revision = `authority-${this.sequence++}`;
    return {
      path,
      frontmatter,
      effective_frontmatter: structuredClone(frontmatter),
      body,
      types: typeof frontmatter.type === "string" ? [frontmatter.type] : [],
      revision,
      file: {
        name: path.slice(slash + 1),
        folder: slash < 0 ? "" : path.slice(0, slash),
        size: new TextEncoder().encode(body).byteLength,
        mtime: new Date(1_780_000_000_000 + this.sequence * 1_000).toISOString(),
        tags: [],
        links: [],
        embeds: []
      }
    };
  }
}

function authorizationPage(authorizationId: string): string {
  return `<!doctype html>
    <html><body>
      <main>
        <h1>Choose a collection</h1>
        <label>Collection
          <select aria-label="Collection">
            <option value="${collectionId}">Hosted writing · Hosted by mdbase</option>
            <option value="${secondCollectionId}">Research · Hosted by mdbase</option>
          </select>
        </label>
        <button id="allow">Allow access</button>
      </main>
      <script>
        document.getElementById("allow").addEventListener("click", async () => {
          const collection = document.querySelector("select").value;
          await fetch("/test/approve?request_id=${authorizationId}&collection_id=" + encodeURIComponent(collection));
          document.querySelector("main").innerHTML = "<h1>Access approved</h1><p>Return to the application.</p>";
        });
      </script>
    </body></html>`;
}

function envelope<Result>(result: Result) {
  return { valid: true, diagnostics: [], result };
}

function summary(record: AuthorityRecord, includeBody: boolean) {
  const { revision: _revision, body, ...value } = record;
  const projected = {
    ...value,
    file: { ...value.file, path: value.path }
  };
  return includeBody ? { ...projected, body } : projected;
}

function object(value: unknown): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function providerResult(route: Route, requestId: string, result: unknown) {
  return json(route, {
    protocol_version: 1,
    request_id: requestId,
    ok: true,
    result,
  });
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

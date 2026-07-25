import { expect, test, type Page, type Route } from "@playwright/test";

const collectionId = "10000000-0000-4000-8000-000000000001";
const replicaId = "20000000-0000-4000-8000-000000000002";
const grantId = "30000000-0000-4000-8000-000000000003";
const providerOrigin = "https://sync.mdbase.dev";

test("chooses a hosted collection and performs CRUD through its provider", async ({ page }) => {
  const hosted = new HostedCollectionHarness(page);
  await hosted.install();

  await page.goto("/");
  await expect(page.getByText("Open a local or hosted mdbase collection and write.")).toBeVisible();
  await page.getByRole("button", { name: "Choose a collection" }).click();

  await expect(page).toHaveURL(/connect\.mdbase\.dev\/oauth\/authorize/);
  const collection = page.getByRole("combobox", { name: "Collection" });
  await expect(collection).toHaveValue(collectionId);
  await expect(collection).toContainText("Hosted writing · Hosted by mdbase");
  await page.getByRole("button", { name: "Allow access" }).click();

  await expect(page.getByRole("heading", { name: "Hosted writing" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome to hosted writing");

  await page.getByRole("button", { name: "New note" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("A hosted draft");
  await page.getByRole("button", { name: "Create note" }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("A hosted draft");

  await page.getByRole("textbox", { name: "Note body" }).fill("Stored directly on mdbase.");
  await expect.poll(() => hosted.operations.filter((operation) => operation === "update").length).toBe(1);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "A hosted draft.md" }).click();
  const path = page.getByRole("textbox", { name: "Markdown path" });
  await path.fill("Writing/A hosted draft.md");
  await path.press("Enter");
  await expect(page.getByRole("button", { name: "Writing/A hosted draft.md" })).toBeVisible();

  await page.getByLabel("More note actions").click();
  await page.getByRole("button", { name: "Delete note" }).click();
  const confirmation = page.getByRole("alert");
  await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue("Welcome to hosted writing");
  await expect(page.getByRole("option", { name: /A hosted draft/ })).toHaveCount(0);

  await expect.poll(() => new Set(hosted.operations)).toEqual(new Set([
    "changes",
    "create",
    "delete",
    "describe",
    "query",
    "read",
    "rename",
    "update"
  ]));
  expect(hosted.controlPlaneOperations).toBe(0);
});

interface HostedRecord {
  path: string;
  frontmatter: Record<string, unknown>;
  raw_frontmatter: Record<string, unknown>;
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

class HostedCollectionHarness {
  readonly operations: string[] = [];
  controlPlaneOperations = 0;
  private sequence = 1;
  private readonly records = new Map<string, HostedRecord>();

  constructor(private readonly page: Page) {
    const welcome = this.document(
      "Welcome.md",
      "# Welcome to hosted writing\n\nThis Markdown is authoritative on mdbase.\n",
      {}
    );
    this.records.set(welcome.path, welcome);
  }

  async install() {
    await this.page.route("https://connect.mdbase.dev/**", (route) => this.control(route));
    await this.page.route(`${providerOrigin}/**`, (route) => this.provider(route));
  }

  private async control(route: Route) {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/v1/apps/register") {
      expect(request.postDataJSON()).toMatchObject({
        manifest: {
          manifest_version: 3,
          id: "dev.mdbase.editor"
        }
      });
      return json(route, {
        application: {
          id: "40000000-0000-4000-8000-000000000004",
          name: "mdbase editor",
          homepage: "http://127.0.0.1:4174/"
        }
      });
    }
    if (url.pathname === "/oauth/authorize") {
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: authorizationPage(url)
      });
    }
    if (url.pathname === "/oauth/token") {
      return json(route, {
        access_token: "control-plane-access",
        refresh_token: "control-plane-refresh",
        token_type: "Bearer",
        expires_in: 3_600,
        refresh_expires_in: 2_592_000,
        collection_id: collectionId,
        operations: ["describe", "changes", "read", "query", "validate", "create", "update", "delete", "rename"],
        scope: { contracts: [] },
        grant_id: grantId,
        encryption: null,
        hosted: {
          provider_url: providerOrigin,
          replica_id: replicaId,
          access_token: "hosted-provider-access"
        }
      });
    }
    if (url.pathname.includes("/operations/")) this.controlPlaneOperations += 1;
    return route.abort("failed");
  }

  private async provider(route: Route) {
    const request = route.request();
    expect(request.headers().authorization).toBe("Bearer hosted-provider-access");
    const operation = new URL(request.url()).pathname.split("/").at(-1)!;
    const input = request.postDataJSON() as Record<string, unknown>;
    this.operations.push(operation);

    if (operation === "describe") return providerResult(route, {
      protocol_version: 2,
      collection_id: collectionId,
      display_name: "Hosted writing",
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
    if (operation === "changes") return providerResult(route, {
      cursor: this.sequence,
      events: [],
      has_more: false
    });
    if (operation === "query") {
      const includeBody = input.include_body === true;
      const records = [...this.records.values()].map((record) => summary(record, includeBody));
      return providerResult(route, envelope({
        results: records,
        meta: { total_count: records.length, has_more: false }
      }));
    }
    if (operation === "read") {
      return providerResult(route, envelope(this.record(String(input.path))));
    }
    if (operation === "create") {
      const record = this.document(
        String(input.path),
        typeof input.body === "string" ? input.body : "",
        object(input.frontmatter)
      );
      this.records.set(record.path, record);
      return providerResult(route, envelope(record));
    }
    if (operation === "update") {
      const current = this.record(String(input.path));
      const record = this.document(
        current.path,
        typeof input.body === "string" ? input.body : current.body,
        { ...current.frontmatter, ...object(input.patch ?? input.fields) }
      );
      this.records.set(record.path, record);
      return providerResult(route, envelope(record));
    }
    if (operation === "rename") {
      const from = String(input.from);
      const current = this.record(from);
      if (input.dry_run === true) {
        return providerResult(route, envelope({
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
      return providerResult(route, envelope({ ...record, from }));
    }
    if (operation === "delete") {
      const path = String(input.path);
      this.record(path);
      if (input.dry_run === true) {
        return providerResult(route, envelope({
          path,
          deleted: false,
          dry_run: true,
          would_delete: true,
          broken_links: []
        }));
      }
      this.records.delete(path);
      return providerResult(route, envelope({ path, deleted: true, broken_links: [] }));
    }
    if (operation === "validate") return providerResult(route, envelope({ path: input.path }));
    return json(route, { error: { code: "unsupported_operation", message: operation } }, 400);
  }

  private record(path: string): HostedRecord {
    const record = this.records.get(path);
    if (!record) throw new Error(`Hosted test record not found: ${path}`);
    return record;
  }

  private document(path: string, body: string, frontmatter: Record<string, unknown>): HostedRecord {
    const slash = path.lastIndexOf("/");
    const revision = `hosted-${this.sequence++}`;
    return {
      path,
      frontmatter,
      raw_frontmatter: frontmatter,
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

function authorizationPage(url: URL): string {
  const redirectUri = JSON.stringify(url.searchParams.get("redirect_uri"));
  const state = JSON.stringify(url.searchParams.get("state"));
  return `<!doctype html>
    <html><body>
      <main>
        <h1>Choose a collection</h1>
        <label>Collection
          <select aria-label="Collection">
            <option value="${collectionId}">Hosted writing · Hosted by mdbase</option>
          </select>
        </label>
        <button id="allow">Allow access</button>
      </main>
      <script>
        document.getElementById("allow").addEventListener("click", () => {
          const callback = new URL(${redirectUri});
          callback.searchParams.set("code", "hosted-code");
          callback.searchParams.set("state", ${state});
          location.href = callback.href;
        });
      </script>
    </body></html>`;
}

function envelope<Result>(result: Result) {
  return { valid: true, diagnostics: [], result };
}

function summary(record: HostedRecord, includeBody: boolean) {
  const { revision: _revision, raw_frontmatter: _rawFrontmatter, body, ...value } = record;
  return includeBody ? { ...value, body } : value;
}

function object(value: unknown): Record<string, unknown> {
  return value && !Array.isArray(value) && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
}

function providerResult(route: Route, result: unknown) {
  return json(route, { ok: true, result });
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

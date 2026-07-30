import type {
  JsonObject,
  SyncChangesPage,
  SyncMutation,
  SyncMutationReceipt,
  SyncSession,
  SyncSnapshotPage
} from "@mdbase/connect-protocol";
import { SyncError } from "./sync-error.js";
import type { SyncTransport } from "./sync-types.js";

export class HttpSyncTransport<Frontmatter extends JsonObject = JsonObject> implements SyncTransport<Frontmatter> {
  private readonly syncUrl: string;
  constructor(syncUrl: string, private readonly replicaToken: string) {
    let endpoint: URL;
    try {
      endpoint = new URL(syncUrl);
    } catch {
      throw new SyncError("invalid_sync_url", "Sync URL must be an absolute authority endpoint.");
    }
    if (!secureHttpEndpoint(endpoint)
        || endpoint.username
        || endpoint.password
        || endpoint.search
        || endpoint.hash
        || !/^\/v1\/authorities\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/sync\/?$/i.test(endpoint.pathname)) {
      throw new SyncError(
        "invalid_sync_url",
        "Sync URL must identify one HTTPS authority sync endpoint, except on loopback."
      );
    }
    this.syncUrl = endpoint.href.replace(/\/$/, "");
  }

  openSession(): Promise<SyncSession> {
    return this.request("POST", "sessions");
  }
  snapshot(snapshotId: string, page?: string): Promise<SyncSnapshotPage<Frontmatter>> {
    const query = new URLSearchParams({ snapshot_id: snapshotId });
    if (page) query.set("page", page);
    return this.request("GET", `snapshot?${query}`);
  }
  changes(after: number, limit = 200): Promise<SyncChangesPage<Frontmatter>> {
    return this.request("GET", `changes?${new URLSearchParams({ after: String(after), limit: String(limit) })}`);
  }
  mutate(mutation: SyncMutation): Promise<SyncMutationReceipt<Frontmatter>> {
    return this.request("POST", "mutations", mutation);
  }

  private async request<Result>(method: string, path: string, body?: unknown): Promise<Result> {
    const response = await fetch(`${this.syncUrl}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.replicaToken}`,
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const value = await response.json();
    if (!response.ok) throw new SyncError(value?.error?.code ?? "sync_failed", value?.error?.message ?? "Sync request failed.");
    return value as Result;
  }
}

function secureHttpEndpoint(url: URL): boolean {
  return url.protocol === "https:"
    || (
      url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    );
}

import type { FileCapability } from "@mdbase-dev/connect-protocol";
import { connectError, MdbaseConnectError } from "./errors.js";
import type { CollectionDescription, ConnectRequestOptions } from "./operation-types.js";
import { ALL_CONNECT_PROBLEM_CODES, captureConnectOutcome, type ConnectOutcome } from "./outcomes.js";
import { withRequestBudget } from "./request-budget.js";
import { SharedOperationMap } from "./shared-operation.js";

const AUTHORITY_FEATURES = new Set([
  "files-stat-v1", "query-record-revisions-v1", "read-many-documents-v1",
  "query-metadata-v1", "contract-query-v1", "link-resolution-options-v1"
]);
const EMPTY_CAPABILITIES: readonly string[] = Object.freeze([]);

/** Optional response member: absence is legacy; malformed presence is a failure. */
export function authorityCapabilities(value: unknown): readonly string[] {
  if (value === undefined) return EMPTY_CAPABILITIES;
  if (!Array.isArray(value) || value.some(id => typeof id !== "string")) {
    throw connectError("invalid_operation_response", "The authority returned invalid feature capabilities.");
  }
  return Object.freeze([...new Set(value.filter(id => AUTHORITY_FEATURES.has(id)))]);
}

interface Discovery {
  /** Changes with authorization/authority replacement and direct/relay route. Never persisted. */
  lifetime(): string;
  operations(): readonly string[];
  fileCapability(): FileCapability | null;
  describe(options: ConnectRequestOptions): Promise<ConnectOutcome<CollectionDescription>>;
  filesPage(folder: string | undefined, signal: AbortSignal): Promise<readonly string[]>;
}

/** One authority discovery cache per connection, never a global or persisted registry. */
export class AuthorityFeatures {
  private lifetime: string | undefined;
  private generation = 0;
  private cached: readonly string[] | undefined;
  private readonly pending = new SharedOperationMap<readonly string[]>();

  constructor(private readonly discovery: Discovery, private readonly timeoutMs: number | null) {}

  get capabilities(): readonly string[] {
    this.refreshLifetime();
    return this.cached ?? EMPTY_CAPABILITIES;
  }

  supports(id: string, options?: ConnectRequestOptions): Promise<ConnectOutcome<boolean>> {
    return captureConnectOutcome(() => withRequestBudget(options, this.timeoutMs, async budget => {
      if (!AUTHORITY_FEATURES.has(id)) return false;
      while (true) {
        this.refreshLifetime();
        const generation = this.generation;
        const capabilities = this.cached ?? await this.pending.run(
          String(generation), { signal: budget.signal, timeoutMs: null }, null,
          signal => this.discover(signal)
        );
        this.refreshLifetime();
        // A successful discovery can itself select a direct route. Rediscover on
        // the current route, rather than borrowing evidence from a retired one.
        if (generation !== this.generation) continue;
        if (!budget.signal.aborted) this.cached = capabilities;
        return capabilities.includes(id);
      }
    }), ALL_CONNECT_PROBLEM_CODES);
  }

  invalidate(): void {
    this.cached = undefined;
    this.lifetime = undefined;
  }

  refreshLifetime(): void {
    const lifetime = this.discovery.lifetime();
    if (lifetime === this.lifetime) return;
    this.lifetime = lifetime;
    this.generation += 1;
    this.cached = undefined;
  }

  private async discover(signal: AbortSignal): Promise<readonly string[]> {
    if (this.discovery.operations().includes("describe")) {
      const outcome = await this.discovery.describe({ signal, timeoutMs: null, coordination: { coalesce: false } });
      if (!outcome.ok) throw new MdbaseConnectError(outcome.problem);
      return authorityCapabilities(outcome.value.authorityCapabilities);
    }
    const capability = this.discovery.fileCapability();
    if (capability?.actions.includes("list")) {
      const folder = capability.scope.kind === "selected_folders" ? capability.scope.folders[0] : undefined;
      const capabilities = await this.discovery.filesPage(folder, signal);
      // File-only discovery is evidence for file features, never native queries.
      return Object.freeze(capabilities.filter(id => id === "files-stat-v1"));
    }
    // Consumer: legacy grants without describe/file-list permission. Remove when
    // the minimum authority/consumer pins and N-1 rollback/cache windows close.
    return EMPTY_CAPABILITIES;
  }
}

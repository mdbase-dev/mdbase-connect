import type { CollectionDescription as WireDescription } from "@mdbase-dev/connect-protocol";
import type { CollectionDescription, DescribeOptions, MdbaseCollectionTransport } from "./operation-types.js";
import {
  COLLECTION_DESCRIPTION_PROBLEM_CODES,
  captureConnectOutcome,
  connectSuccess,
  type CollectionDescriptionProblemCode,
  type ConnectOutcome
} from "./outcomes.js";
import { withRequestBudget } from "./request-budget.js";
import { wireCollectionDescription } from "./query-wire.js";

/** One collection's description lifecycle; no background observer or persisted schema state. */
export class CollectionDescriptionCache {
  private generation = 0;
  private description?: { value: CollectionDescription; expiresAt: number };
  private describing?: Promise<ConnectOutcome<CollectionDescription, CollectionDescriptionProblemCode>>;

  constructor(private readonly transport: MdbaseCollectionTransport, private readonly requestTimeoutMs: number | null) {}

  get schemaGeneration(): number { return this.generation; }

  invalidate(): void {
    this.generation += 1;
    this.description = undefined;
    this.describing = undefined;
  }

  describe(options: DescribeOptions = {}): Promise<ConnectOutcome<CollectionDescription, CollectionDescriptionProblemCode>> {
    return captureConnectOutcome(() => withRequestBudget(options, this.requestTimeoutMs, async () => {
      if (!options.fresh && this.description && Date.now() < this.description.expiresAt) {
        return connectSuccess(this.description.value);
      }
      if (!this.describing) {
        this.description = undefined;
        const generation = this.generation;
        // The shared load has its own budget. Cancelling one waiter cannot cancel another.
        const request = captureConnectOutcome(() => withRequestBudget({}, this.requestTimeoutMs, (budget) =>
          this.transport.operation<WireDescription>("describe", {}, { signal: budget.signal, timeoutMs: this.requestTimeoutMs })
        ), COLLECTION_DESCRIPTION_PROBLEM_CODES).then((outcome) => {
          if (!outcome.ok) return outcome;
          const value = wireCollectionDescription(outcome.value);
          if (this.generation === generation) this.description = { value, expiresAt: Date.now() + 60_000 };
          return connectSuccess(value, outcome.diagnostics);
        }).finally(() => {
          if (this.describing === request) this.describing = undefined;
        });
        this.describing = request;
      }
      return this.describing;
    }), COLLECTION_DESCRIPTION_PROBLEM_CODES).then((outcome) => outcome.ok ? outcome.value : outcome);
  }
}

import {
  isMutatingOperation,
  type CollectionOperation
} from "@mdbase-dev/connect-protocol";
import { connectError } from "./errors.js";
import type {
  ConnectRequestOptions,
  MdbaseCollectionTransport,
  RequestCoordinationOptions
} from "./operation-types.js";
import {
  requestAbortReason,
  requestOptionsWithinBudget,
  withCooperativeRequestBudget,
  type RequestBudget
} from "./request-budget.js";

const DEFAULT_FOREGROUND_CAPACITY = 4;
const DEFAULT_QUEUE_CAPACITY = 32;

interface CoordinatorLimits {
  foregroundCapacity?: number;
  foregroundQueueCapacity?: number;
  mutationQueueCapacity?: number;
}

interface QueuedRequest {
  readonly budget: RequestBudget;
  run: () => Promise<unknown>;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: unknown) => void;
  started: boolean;
  settled: boolean;
}

/** One bounded request owner for a selected connection. */
export class CollectionRequestCoordinator implements MdbaseCollectionTransport {
  private readonly foregroundCapacity: number;
  private readonly foregroundQueueCapacity: number;
  private readonly mutationQueueCapacity: number;
  private readonly foregroundQueue: QueuedRequest[] = [];
  private readonly mutationQueue: QueuedRequest[] = [];
  private readonly identicalReads = new Map<string, Promise<unknown>>();
  private readonly latestFamilies = new Map<string, AbortController>();
  private activeForeground = 0;
  private mutationActive = false;

  constructor(
    private readonly transport: MdbaseCollectionTransport,
    private readonly requestTimeoutMs: number | null,
    limits: CoordinatorLimits = {}
  ) {
    this.foregroundCapacity = positiveCapacity(
      limits.foregroundCapacity,
      DEFAULT_FOREGROUND_CAPACITY
    );
    this.foregroundQueueCapacity = positiveCapacity(
      limits.foregroundQueueCapacity,
      DEFAULT_QUEUE_CAPACITY
    );
    this.mutationQueueCapacity = positiveCapacity(
      limits.mutationQueueCapacity,
      DEFAULT_QUEUE_CAPACITY
    );
  }

  operation<Result>(
    operation: CollectionOperation,
    input: unknown,
    options: ConnectRequestOptions = {}
  ): Promise<Result> {
    const read = !isMutatingOperation(operation, input);
    const coordination = validatedCoordination(options.coordination, read);
    const coalesceKey = read
      && coordination.coalesce !== false
      && !coordination.latestWins
      && options.signal === undefined
      ? stableRequestKey(operation, input, options.timeoutMs)
      : undefined;
    if (coalesceKey) {
      const existing = this.identicalReads.get(coalesceKey);
      if (existing) return existing as Promise<Result>;
    }

    const request = withCooperativeRequestBudget(
      options,
      this.requestTimeoutMs,
      (budget) => this.schedule<Result>(operation, input, options, coordination, read, budget)
    );
    if (coalesceKey) {
      this.identicalReads.set(coalesceKey, request);
      void request.finally(() => {
        if (this.identicalReads.get(coalesceKey) === request) {
          this.identicalReads.delete(coalesceKey);
        }
      }).catch(() => undefined);
    }
    return request;
  }

  private schedule<Result>(
    operation: CollectionOperation,
    input: unknown,
    options: ConnectRequestOptions,
    coordination: RequestCoordinationOptions,
    read: boolean,
    budget: RequestBudget
  ): Promise<Result> {
    const replacement = coordination.latestWins
      ? this.replaceLatest(coordination.family as string)
      : undefined;
    const combined = combineSignals(budget.signal, replacement?.signal);
    const { coordination: _coordination, ...transportOptions } = options;
    const withinBudget = requestOptionsWithinBudget(
      { ...transportOptions, timeoutMs: null },
      budget
    );
    const run = () => this.transport.operation<Result>(operation, input, {
      ...withinBudget,
      signal: combined.signal
    });
    const queue = read ? this.foregroundQueue : this.mutationQueue;
    const capacity = read ? this.foregroundQueueCapacity : this.mutationQueueCapacity;
    if (queue.length >= capacity) {
      combined.dispose();
      this.releaseLatest(coordination.family, replacement);
      return Promise.reject(connectError(
        "connector_busy",
        "The selected connection request queue is full.",
        { operationOutcome: "not_sent", status: 503 }
      ));
    }

    return new Promise<Result>((resolve, reject) => {
      const queued: QueuedRequest = {
        budget,
        run,
        resolve: (result) => resolve(result as Result),
        reject,
        started: false,
        settled: false
      };
      const abortQueued = () => {
        if (queued.started || queued.settled) return;
        queued.settled = true;
        queued.reject(requestAbortReason(combined.signal));
        combined.dispose();
        this.releaseLatest(coordination.family, replacement);
      };
      combined.signal.addEventListener("abort", abortQueued, { once: true });
      const originalRun = queued.run;
      queued.run = async () => {
        combined.signal.removeEventListener("abort", abortQueued);
        try {
          if (combined.signal.aborted) throw requestAbortReason(combined.signal);
          return await originalRun();
        } finally {
          combined.dispose();
          this.releaseLatest(coordination.family, replacement);
        }
      };
      queue.push(queued);
      this.pump();
    });
  }

  private replaceLatest(family: string): AbortController {
    const replacement = new AbortController();
    this.latestFamilies.get(family)?.abort(connectError(
      "operation_cancelled",
      "A newer request replaced this read before it changed the collection.",
      { operationOutcome: "not_sent" }
    ));
    this.latestFamilies.set(family, replacement);
    return replacement;
  }

  private releaseLatest(family: string | undefined, controller: AbortController | undefined) {
    if (family && controller && this.latestFamilies.get(family) === controller) {
      this.latestFamilies.delete(family);
    }
  }

  private pump() {
    while (this.activeForeground < this.foregroundCapacity) {
      const request = nextLive(this.foregroundQueue);
      if (!request) break;
      this.activeForeground += 1;
      this.start(request, () => {
        this.activeForeground -= 1;
        this.pump();
      });
    }
    if (!this.mutationActive) {
      const request = nextLive(this.mutationQueue);
      if (request) {
        this.mutationActive = true;
        this.start(request, () => {
          this.mutationActive = false;
          this.pump();
        });
      }
    }
  }

  private start(request: QueuedRequest, release: () => void) {
    request.started = true;
    void request.run().then(
      (result) => {
        if (!request.settled) {
          request.settled = true;
          request.resolve(result);
        }
      },
      (error) => {
        if (!request.settled) {
          request.settled = true;
          request.reject(error);
        }
      }
    ).finally(release);
  }
}

function nextLive(queue: QueuedRequest[]): QueuedRequest | undefined {
  while (queue.length > 0) {
    const request = queue.shift() as QueuedRequest;
    if (!request.settled) return request;
  }
  return undefined;
}

function validatedCoordination(
  coordination: RequestCoordinationOptions | undefined,
  read: boolean
): RequestCoordinationOptions {
  const resolved = coordination ?? {};
  if (resolved.latestWins && !read) {
    throw new TypeError("latestWins coordination is available only for read operations.");
  }
  if (resolved.latestWins && !resolved.family?.trim()) {
    throw new TypeError("latestWins coordination requires a non-empty family.");
  }
  return resolved;
}

function stableRequestKey(
  operation: CollectionOperation,
  input: unknown,
  timeoutMs: number | null | undefined
): string {
  return `${operation}:${timeoutMs === undefined ? "default" : String(timeoutMs)}:${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? String(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function combineSignals(
  primary: AbortSignal,
  secondary?: AbortSignal
): { signal: AbortSignal; dispose(): void } {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abortPrimary = () => controller.abort(primary.reason);
  const abortSecondary = () => controller.abort(secondary.reason);
  if (primary.aborted) abortPrimary();
  else primary.addEventListener("abort", abortPrimary, { once: true });
  if (secondary.aborted) abortSecondary();
  else secondary.addEventListener("abort", abortSecondary, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", abortPrimary);
      secondary.removeEventListener("abort", abortSecondary);
    }
  };
}

function positiveCapacity(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError("Request coordinator capacities must be positive safe integers.");
  }
  return resolved;
}

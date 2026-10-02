import type { CollectionChange, MdbaseWatchSubscription, WatchInput, WatchOptions, WatchStatus } from "./operation-types.js";
import type { ConnectOutcome } from "./outcomes.js";

export interface ResolvedWatchRetryOptions {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  maxAttempts?: number;
}

export function watchRetryPolicy(
  options: WatchOptions["retry"]
): ResolvedWatchRetryOptions | undefined {
  if (options === false) return undefined;
  return {
    initialDelayMs: Math.max(0, options?.initialDelayMs ?? 500),
    maxDelayMs: Math.max(0, options?.maxDelayMs ?? 15_000),
    multiplier: Math.max(1, options?.multiplier ?? 2),
    ...(options?.maxAttempts === undefined
      ? {}
      : { maxAttempts: Math.max(0, options.maxAttempts) })
  };
}

export class CollectionWatchSubscription implements MdbaseWatchSubscription {
  private readonly changes = new Set<(change: CollectionChange) => void>();
  private readonly statuses = new Set<(status: WatchStatus) => void>();
  private readonly problems = new Set<(problem: import("@mdbase-dev/connect-protocol").ConnectProblem) => void>();
  private readonly controller = new AbortController();
  private removeLifetimeAbort?: () => void;
  private currentStatus: WatchStatus;
  private currentProblem: import("@mdbase-dev/connect-protocol").ConnectProblem | null = null;
  private pendingChanges: CollectionChange[];

  constructor(
    private readonly watch: (options: WatchOptions) => AsyncIterable<ConnectOutcome<CollectionChange>>,
    cursor: number,
    private readonly input: WatchInput,
    pendingChanges: CollectionChange[],
    private readonly watchStartTimeoutMs: number | null
  ) {
    this.pendingChanges = [...pendingChanges];
    this.currentStatus = { state: "connected", cursor, recovered: false };
    const lifetimeSignal = input.lifetimeSignal;
    if (lifetimeSignal?.aborted) this.close();
    else if (lifetimeSignal) {
      const close = () => this.close();
      lifetimeSignal.addEventListener("abort", close, { once: true });
      this.removeLifetimeAbort = () => lifetimeSignal.removeEventListener("abort", close);
    }
    if (!this.controller.signal.aborted) void this.run(cursor);
  }

  get status(): WatchStatus { return this.currentStatus; }
  get problem(): import("@mdbase-dev/connect-protocol").ConnectProblem | null { return this.currentProblem; }

  subscribe(
    listener: (change: CollectionChange) => void,
    onStatus?: (status: WatchStatus) => void,
    onProblem?: (problem: import("@mdbase-dev/connect-protocol").ConnectProblem) => void
  ): () => void {
    this.changes.add(listener);
    if (onStatus) {
      this.statuses.add(onStatus);
      onStatus(this.currentStatus);
    }
    if (onProblem) {
      this.problems.add(onProblem);
      if (this.currentProblem) onProblem(this.currentProblem);
    }
    for (const change of this.pendingChanges) listener(change);
    this.pendingChanges = [];
    return () => {
      this.changes.delete(listener);
      if (onStatus) this.statuses.delete(onStatus);
      if (onProblem) this.problems.delete(onProblem);
    };
  }

  close(): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    this.removeLifetimeAbort?.();
    this.removeLifetimeAbort = undefined;
    const cursor = "cursor" in this.currentStatus ? this.currentStatus.cursor : undefined;
    this.publishStatus({ state: "closed", ...(cursor === undefined ? {} : { cursor }) });
  }

  private async run(cursor: number): Promise<void> {
    let firstStatus = true;
    const iterator = this.watch({
      cursor,
      pollIntervalMs: this.input.pollIntervalMs,
      retry: this.input.retry,
      signal: this.controller.signal,
      timeoutMs: this.watchStartTimeoutMs,
      onStatus: (status) => {
        if (firstStatus && status.state === "connecting") {
          firstStatus = false;
          return;
        }
        firstStatus = false;
        this.publishStatus(status);
      }
    });
    try {
      for await (const outcome of iterator) {
        if (this.controller.signal.aborted) return;
        if (!outcome.ok) {
          this.currentProblem = outcome.problem;
          for (const listener of this.problems) listener(outcome.problem);
          return;
        }
        for (const listener of this.changes) listener(outcome.value);
      }
    } finally {
      if (!this.controller.signal.aborted) this.close();
    }
  }

  private publishStatus(status: WatchStatus): void {
    this.currentStatus = status;
    for (const listener of this.statuses) listener(status);
  }
}

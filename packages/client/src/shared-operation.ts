import type { ConnectRequestOptions } from "./operation-types.js";
import { requestAbortReason, withRequestBudget } from "./request-budget.js";

interface SharedOperation<Result> {
  promise: Promise<Result>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
}

export class SharedOperationMap<Result> {
  private readonly operations = new Map<string, SharedOperation<Result>>();

  run(
    key: string,
    options: ConnectRequestOptions | undefined,
    defaultTimeoutMs: number | null,
    start: (signal: AbortSignal) => Promise<Result>
  ): Promise<Result> {
    if (options?.signal?.aborted) return Promise.reject(requestAbortReason(options.signal));
    const operation = this.operations.get(key) ?? this.begin(key, start);
    return this.wait(key, operation, options, defaultTimeoutMs);
  }

  private begin(key: string, start: (signal: AbortSignal) => Promise<Result>): SharedOperation<Result> {
    const controller = new AbortController();
    const operation: SharedOperation<Result> = {
      controller,
      waiters: 0,
      settled: false,
      promise: undefined as never
    };
    operation.promise = Promise.resolve()
      .then(() => start(controller.signal))
      .finally(() => {
        operation.settled = true;
        if (this.operations.get(key) === operation) this.operations.delete(key);
      });
    this.operations.set(key, operation);
    return operation;
  }

  private async wait(
    key: string,
    operation: SharedOperation<Result>,
    options: ConnectRequestOptions | undefined,
    defaultTimeoutMs: number | null
  ): Promise<Result> {
    operation.waiters += 1;
    try {
      return await withRequestBudget(options, defaultTimeoutMs, () => operation.promise);
    } finally {
      operation.waiters -= 1;
      if (operation.waiters === 0 && !operation.settled && this.operations.get(key) === operation) {
        this.operations.delete(key);
        operation.controller.abort();
      }
    }
  }
}

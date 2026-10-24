/** Browser apps use supported relay/hosted routes. The authenticated plugin
 * localhost link is not a browser transport: do not expose its file/token or
 * broaden its Origin check to implement a compatibility permission prompt. */
export interface AppBrowserDirectAccessSnapshot {
  readonly status: "unsupported";
}
export interface AppBrowserDirectAccessOptions {
  readonly signal?: AbortSignal;
}
const unsupported: AppBrowserDirectAccessSnapshot = Object.freeze({status: "unsupported"});
/** Shared no-I/O compatibility port. Unsupported is not a connection failure or
 * a claim about the active route; consumers continue on their supported route
 * without an error banner or a nonfunctional local-network permission control. */
export const appBrowserDirectAccess = Object.freeze({
  snapshot(): AppBrowserDirectAccessSnapshot { return unsupported; },
  async check(options: AppBrowserDirectAccessOptions = {}): Promise<AppBrowserDirectAccessSnapshot> {
    options.signal?.throwIfAborted(); return unsupported;
  },
  async request(options: AppBrowserDirectAccessOptions = {}): Promise<AppBrowserDirectAccessSnapshot> {
    options.signal?.throwIfAborted(); return unsupported;
  },
  disable(): void { /* No browser direct route has been enabled. */ },
});

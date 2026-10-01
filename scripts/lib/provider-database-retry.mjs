import { delay } from "./test-runtime.mjs";

// Only the provider's explicit transaction-abort contract permits replay.
// Transport failures and generic 503s can have unknown effects and are not
// retried. Return the last response so the caller keeps its normal diagnostics.
export async function retryProviderDatabaseRequest(send, sleep = delay) {
  for (let attempt = 0; ; attempt++) {
    const response = await send();
    if (attempt === 4
        || response.status !== 503
        || response.body?.error?.code !== "provider_database_retryable") {
      return response;
    }
    await sleep(25 * 2 ** attempt);
  }
}

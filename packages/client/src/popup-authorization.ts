import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { abortableDelay } from "./async.js";
import type {
  MdbaseAuthorizeOptions,
  MdbaseAuthorizationOutcome,
  MdbaseAuthorizationResult,
  MdbaseConnection
} from "./connection.js";
import type { GrantKeyStore } from "./crypto.js";
import { MdbaseConnectError, connectError, serverConnectError } from "./errors.js";
import type {
  Application,
  StoredAuthorization,
  StoredAuthorizationCompletion
} from "./internal-types.js";
import { parseStored } from "./runtime-utils.js";

export async function prepareAuthorizationWindow(input: {
  options: MdbaseAuthorizeOptions;
  portableDeclared: boolean;
  navigate?: (url: string) => void | Promise<void>;
  register(signal: AbortSignal): Promise<Application>;
}): Promise<{ application: Application; popup: Window | null }> {
  if (typeof location === "undefined" && !input.navigate && !input.options.openVerification) {
    throw connectError("browser_required", "Authorization navigation requires a browser environment.");
  }
  const popupRequested = input.options.presentation === "popup" || input.portableDeclared;
  const popup = popupRequested
    && !input.options.openVerification
    && !input.navigate
    && typeof window !== "undefined"
    ? window.open("", "mdbase-connect-authorization", "popup,width=620,height=760")
    : null;
  try {
    return {
      application: await input.register(input.options.signal!),
      popup
    };
  } catch (error) {
    popup?.close();
    throw error;
  }
}

export async function waitForPopupAuthorization<Frontmatter extends JsonObject>(input: {
  storage: Storage;
  storagePrefix: string;
  state: string;
  pending: StoredAuthorization;
  popup: Window;
  signal: AbortSignal;
  keyStore: GrantKeyStore;
  connection(collectionId: string): MdbaseConnection<Frontmatter> | null;
}): Promise<MdbaseAuthorizationOutcome<Frontmatter>> {
  const completionKey = authorizationCompletionKey(input.storagePrefix, input.state);
  try {
    while (true) {
      const completion = parseStored<StoredAuthorizationCompletion>(input.storage.getItem(completionKey));
      if (completion?.version === 1) {
        input.storage.removeItem(completionKey);
        if (completion.status === "failed") {
          throw serverConnectError(completion.code, completion.message, {
            details: completion.returnTo ? { return_to: completion.returnTo } : undefined
          });
        }
        const connection = input.connection(completion.collectionId);
        if (!connection) {
          throw connectError("invalid_callback", "Authorization completed without a usable saved connection.");
        }
        return {
          kind: "connected",
          connection,
          ...(completion.returnTo ? { returnTo: completion.returnTo } : {})
        };
      }
      // Cross-origin opener isolation may report a live Connect window as
      // closed. Shared callback state, abort, or the request budget owns exit.
      await abortableDelay(200, input.signal);
    }
  } finally {
    input.popup.close();
    input.storage.removeItem(completionKey);
    const pendingKey = `${input.storagePrefix}:pending:${input.state}`;
    const outstanding = parseStored<StoredAuthorization>(input.storage.getItem(pendingKey));
    if (outstanding?.state === input.state) {
      input.storage.removeItem(pendingKey);
      if (input.pending.keyHandle) await input.keyStore.delete(input.pending.keyHandle);
    }
  }
}

export function publishPopupAuthorizationCompletion<Frontmatter extends JsonObject>(input: {
  storage: Storage;
  storagePrefix: string;
  state: string;
  pending: StoredAuthorization | null;
  popupAttempt: boolean;
  completion: Promise<MdbaseAuthorizationResult<Frontmatter>>;
}): Promise<MdbaseAuthorizationResult<Frontmatter>> {
  return input.completion.then((result) => {
    if (input.popupAttempt) writeCompletion(input, {
      version: 1,
      status: "connected",
      collectionId: result.connection.collectionId,
      ...(result.returnTo ? { returnTo: result.returnTo } : {})
    });
    if (input.popupAttempt) closeCallbackWindow();
    return result;
  }).catch((error: unknown) => {
    if (input.popupAttempt) writeCompletion(input, {
      version: 1,
      status: "failed",
      code: error instanceof MdbaseConnectError ? error.code : "invalid_callback",
      message: error instanceof Error ? error.message : "Authorization could not be completed.",
      ...(input.pending?.returnTo ? { returnTo: input.pending.returnTo } : {})
    });
    if (input.popupAttempt) closeCallbackWindow();
    throw error;
  });
}

function writeCompletion(
  input: Pick<Parameters<typeof publishPopupAuthorizationCompletion>[0], "storage" | "storagePrefix" | "state">,
  completion: StoredAuthorizationCompletion
): void {
  input.storage.setItem(
    authorizationCompletionKey(input.storagePrefix, input.state),
    JSON.stringify(completion)
  );
}

function authorizationCompletionKey(storagePrefix: string, state: string): string {
  return `${storagePrefix}:completion:${state}`;
}

function closeCallbackWindow(): void {
  if (typeof window !== "undefined" && typeof window.close === "function") window.close();
}

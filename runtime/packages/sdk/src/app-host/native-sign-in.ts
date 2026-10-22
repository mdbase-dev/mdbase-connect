import { nativeCompletionFromToken, type NativeCompletion } from "../app-grant/native-completion.js";

/** SDK-owned metadata only; original pairing bearer and both custodians stay put. */
export interface AppNativeAuthorizationContext {
  readonly requestId: string; readonly accountId: string; readonly appId: string;
  readonly challenge: string; readonly authorizationId?: string;
}
export interface AppNativePreparation {
  readonly authorizationId: string; readonly applicationId: string; readonly manifestDigest: string;
}
export interface AppNativeSelection {
  readonly requestId: string; readonly authorizationRequestId: string; readonly collectionId: string;
}
export interface AppNativeAuthorizationPort {
  prepare(context: AppNativeAuthorizationContext, signal: AbortSignal): Promise<AppNativePreparation>;
  finish(selection: AppNativeSelection, signal: AbortSignal): Promise<NativeCompletion>;
  cancel(): void;
}
/** Revalidate transported/protected completion metadata. Original OAuth issuer
 * has already checked the original keys/PKCE; this does not manufacture authority. */
export function boundNativeCompletion(value: NativeCompletion, selection: AppNativeSelection, account: string, app: string, origin: string, digest: string): NativeCompletion {
  return nativeCompletionFromToken({ native_completion: value, collection_id: selection.collectionId, grant_id: value?.grant_id, application_origin: origin }, {
    accountId: account, authorizationRequestId: selection.authorizationRequestId, applicationId: app,
    applicationOrigin: origin, collectionId: selection.collectionId, manifestDigest: digest,
    declarationId: value?.application_declaration_id, applicationInstallationId: value?.application_installation_id,
    grantSigningPublicKey: value?.grant_signing_public_key, clientNoisePublicKey: value?.client_noise_public_key,
  });
}

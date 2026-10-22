/**
 * `@mdbase-dev/sdk/app-grant`: open Private collections from a web app. The app asks
 * for a grant once (OAuth PKCE in a popup, with a client Noise key the person's
 * computer attests), then reaches the collection through the relay to one of the
 * account's online computers. See `grant-store.ts` for what is stored and how.
 */
export {
  MdbaseAppGrants,
  deliverAppGrantCallback,
  mergeCollectionEntries,
  type AppGrantCallbackPort,
  type AppGrantPopup,
  type MdbaseAppGrantsOptions,
  type MdbaseAuthorizeOptions,
  type MdbasePrepareAuthorizationOptions,
  type MdbasePreparedAuthorization,
  type MdbaseCollectionEntry,
  type MdbaseCollectionRole,
  type MdbasePrivateCollection,
  type MdbaseWaitOptions,
} from "./client.js";
export type { MdbasePrivateSetup, MdbasePrivateSetupStatus } from "./setup.js";
export type { MdbaseSetupPlan, MdbaseSetupPlanOptions, MdbaseSetupRecord, MdbaseSetupChange, MdbaseSetupConflict } from "../application/setup.js";
export {
  indexedDbAppGrantStore,
  memoryAppGrantStore,
  type AppGrantStore,
  type IndexedDbAppGrantStoreOptions,
  type StoredAppGrant,
  type StoredAppIdentity,
} from "./grant-store.js";
export {
  COLLECTION_UNAVAILABLE_REASONS,
  isCollectionUnavailableReason,
  parseCollectionAvailability,
  type CollectionAvailability,
  type CollectionUnavailableReason,
} from "../collection-availability.js";

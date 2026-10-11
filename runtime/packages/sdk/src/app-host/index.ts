/** Optional first-party app-host lifecycle/data helpers. No bootstrap defaults
 * or complete durable replica factory; NOT a third-party grant attachment. */
export { attachAppLocalFacade, appLocalConnector } from "./local-facade.js";
export type { AppLocalScope, AppLocalConnector } from "./local-facade.js";
export { APP_BASES_PROFILE, encodeAppBasesRequest, decodeAppBasesCell, decodeAppBasesResult, encodeAppBasesDiscoveryRequest, encodeAppBasesSourceRequest, decodeAppBasesDiscoveryResult, decodeAppBasesSourceResult } from "./bases-wire.js";
export type { AppBasesRequest, AppBasesCell, AppBasesScalar, AppBasesDescriptor, AppBasesRow, AppBasesResult, AppBasesWindow, AppBasesWindowInfo, AppBasesGroupPlacement, AppBasesDiscoveryRequest, AppBasesDiscoveryResult, AppBasesSourceRequest, AppBasesSourceResult } from "./bases-wire.js";
export type { AppBasesPage, AppBasesPagesOptions } from "./bases-pages.js";
export { verifyAppHandover } from "./handover.js";
export type { AppHandoverOptions, AppVerifiedHandover } from "./handover.js";
export { AppCpDeviceRegistration, AppDeviceRegistrationError } from "./device-registration.js";
export type { AppCpDeviceSession, AppDeviceCustodyPersistence } from "./device-registration.js";
export { AppWebDeviceKeyCustody } from "./device-key-custody.js";
export type { AppDeviceKeyCustodyPin, AppDeviceKeyProtectedStore, AppOpenOriginalDeviceOptions } from "./device-key-custody.js";
export { AppIndexedDbDeviceKeyProvider } from "./device-key-provider.js";
export type { AppIndexedDbDeviceKeyProviderOptions } from "./device-key-provider.js";
export { AppIndexedDbDeviceKeyProtectedStore } from "./device-key-idb.js";
export type { AppIndexedDbDeviceKeyOptions } from "./device-key-idb.js";
export { AppWebNoiseCustody } from "./noise-custody.js";
export { AppIndexedDbNoiseProtectedStore } from "./noise-idb.js";
export type { AppIndexedDbNoiseOptions } from "./noise-idb.js";
export type { AppNoiseProtectedStore, AppRestoredNoiseCustody } from "./noise-custody.js";
export { AppCpCloudCopyBootstrap, AppCloudCopyBootstrapError } from "./cloud-copy-bootstrap.js";
export type { AppBundledReleaseTrust, AppCpCloudCopySession, AppCloudCopyOperation, AppCloudCopyBootstrapMetadata, AppCloudCopyAdoptionOptions, AppCloudCopyOutcome, AppCloudCopyBootstrapPersistence } from "./cloud-copy-bootstrap.js";
export { AppCpLogAuthority, AppCpAuthorityError } from "./cp-authority.js";
export type { AppCpSession } from "./cp-authority.js";
export { AppCpPeopleAuthority } from "./cp-people.js";
export type { AppCpPeopleOptions } from "./cp-people.js";
export { AppHttpLogTransport, AppHttpLogError } from "./http-log.js";
export type { AppLogHttpAuthority, AppLogHttpProof, AppLogHttpOptions } from "./http-log.js";
export { AppWasmRuntime, AppStrictDeviceApprovalError } from "./wasm-runtime.js";
export type { AppBootstrap, AppCpConnectorPin, AppHandoverSource, AppDeviceIdentityPin, AppDeviceBootstrap, AppCollectionBootstrap, AppDeviceRegistrationReceipt, AppCloudCopyCollectionPin, AppPrivateCollectionPin, AppPrivateDeviceEnrolProof, AppPrivateEnrolOperationMarker, AppPrivateCollectionOpen, AppDevicePublicIdentity, AppNoiseCustodyResult, AppCpEnrolProof, AppRuntimeObservations, AppSqlMemory, AppSqlLifetime } from "./wasm-runtime.js";
export { AppLogPump, AppLogHostError } from "./log-pump.js";
export type { AppLogCall, AppLogRuntime, AppLogTransport } from "./log-pump.js";
export {
  appSaveState,
  appMutationSaveState,
  appStoragePolicy,
  UNSYNCED_STORAGE_WARNING,
} from "./status.js";
export type {
  AppStoragePolicy,
  AppSaveState,
  AppReplicaReadiness,
  PersistencePort,
} from "./status.js";
export { probeAppStorage } from "./storage-probe.js";
export type {
  AppStorageProbe,
  AppStorageProbeEnvironment,
  ProbeDirectory,
  ProbeSyncHandle,
} from "./storage-probe.js";
export { AppReplicaOwnerError, appReplicaLockName, appInstallationLockName, acquireAppReplicaLease, acquireAppInstallationLease, openOwnedAppWorker } from "./owner.js";
export type { AppInstallationScope, AppInstallationCustodyAuthority, AppReplicaScope, AppLockPort, AppReplicaLease, AppOwnedWorker, OwnedAppWorker } from "./owner.js";
/** Explicit first-party app composition; no default trust/authority/backend. */
export { selectAppEnvironment } from "./app-environment.js";
export type { AppEnvironmentSelection } from "./app-environment.js";
export { createAppWebCollectionAdapter, openAppWebCollectionClient, AppWebCollectionError } from "./web-collection.js";
export type { AppWebCollectionHandoff, AppWebNativeCollection, AppWebCollectionAdapterOptions, AppWebCollectionClient } from "./web-collection.js";
export { appCollectionControlClient, AppCollectionControlError } from "./collection-control.js";
export type { AppCollectionControlBinding, AppCollectionControlClient } from "./collection-control.js";
export { createAppCollectionPeople } from "./collection-people.js";
export { AppCollectionSetupJournal, AppCollectionSetupError, decode as decodeAppCollectionSetupIntent, modelPackPlan as appModelPackPlan, modelResourcePlan as appModelResourcePlan } from "./collection-setup-journal.js";
export type { AppCollectionSetupJournalOptions } from "./collection-setup-journal.js";
export { MODEL_SETUP_LIMITS as APP_COLLECTION_SETUP_LIMITS } from "./collection-setup-types.js";
export type { ModelSetupScope as AppModelSetupScope, ModelSetupPhase as AppModelSetupPhase, ModelSetupIntent as AppModelSetupIntent, ModelPackPlan as AppModelPackPlan, ModelResourcePlan as AppModelResourcePlan, ModelResourceSetupJournal as AppModelResourceSetupJournal, ModelSetupJournal as AppModelSetupJournal, ModelPackSetupIntent as AppModelPackSetupIntent, ModelPackOperation as AppModelPackOperation, ModelResourceSetupIntent as AppModelResourceSetupIntent, ModelResourceSetupRoundIntent as AppModelResourceSetupRoundIntent, ResourceSetupIntent as AppResourceSetupIntent, LegacyModelSetupIntent as AppLegacyModelSetupIntent } from "./collection-setup-types.js";
export { AppCollectionJoinLedger, AppCollectionJoinError } from "./collection-join-ledger.js";
export type { AppCollectionJoinLedgerOptions, AppCollectionJoinAttempt } from "./collection-join-ledger.js";
export { AppProtectedInstallationSignIn, AppInstallationSignInError } from "./installation-sign-in.js";
export type { AppInstallationSignInOptions, AppInstallationSignInView, AppInstallationCollectionConsentView, AppInstallationCollection, AppInstallationCollectionSelection } from "./installation-sign-in.js";
export { appBrowserDirectAccess } from "./browser-direct-access.js";
export type { AppBrowserDirectAccessOptions, AppBrowserDirectAccessSnapshot } from "./browser-direct-access.js";
export type { AppWebSignInProblemDetail } from "./web-sign-in-problem.js";
export { AppWebSignInSession } from "./web-sign-in-session.js";
export type { AppWebSignInSessionOptions, AppWebSignInSnapshot, AppWebCollectionConnection, AppWebSignInPortal } from "./web-sign-in-session.js";
export { AppWebCloudCopyHost, AppCloudCopyHostError } from "./cloud-copy-host.js";
export type { AppCloudCopyHostSession, AppCloudCopyHostRelease } from "./cloud-copy-host.js";

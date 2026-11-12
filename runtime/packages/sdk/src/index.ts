/**
 * @mdbase-dev/sdk: the TS SDK for replicas
 * (`docs/contracts/replica-client-api.md`).
 *
 * The root entry is for an app: the application entry (`createMdbase`, which
 * validates the app's manifest declaration), the collection API
 * (`./collection-api.js`), people, timers, notifications, holds and error
 * copy. Code that makes its own connection imports `./thin-client`.
 */
export * from "./collection-api.js";
export { MdbasePeopleClient, PERSON_CONTRACT, sameIdentity } from "./people.js";
export type { AccountIdentity, AccountProfile, CurrentAccount, CollectionMemberProfile, PersonRecord, InvalidPersonRecord, PersonResolution, PeopleDirectory, PeopleRequestOptions, PeopleDirectoryOptions, PeopleAuthority } from "./people.js";
export { TimersApi } from "./timers.js";
export type {
  AppTimersPort, DesiredTimer, Timer, TimerRequestOptions, TimerReconcileInput,
  TimerList, TimerReconciliation, TimerCancellation, TimerChannelRegistration,
  TimerOperationIdentity, TimerRecoverableReconcileInput, TimerOperationReceipt, TimerOperationLookup,
  WebPushChannelOptions, FcmChannelOptions,
} from "./timers.js";
export {
  MDBASE_NOTIFICATION_TYPE, MDBASE_NOTIFICATION_CLICK, parseMdbasePush, parseMdbaseNativeNotification,
  readMdbaseNotificationData, showMdbaseNotification, handleMdbasePush, handleMdbaseNotificationClick,
} from "./notifications.js";
export type {
  MdbaseNotification, MdbaseNotificationPresentation, MdbaseNotificationClickMessage, MdbaseNotificationDisplayOptions,
  HandleMdbasePushOptions, HandleMdbaseNotificationClickOptions,
} from "./notifications.js";
export { HOLD_COMPARE_SCHEME, HOLD_TITLE, describeHold, holdCompareLink, holdNotice, parseHoldCompareLink, syncStatusText } from "./holds.js";
export type { DescribeHoldOptions, HoldAction, HoldActionOption, HoldPresentation } from "./holds.js";
export {
  describeError,
  describeDiagnostic,
  problemCodeOf,
  PROBLEM_CODES,
  type ProblemCode,
  type DescribeErrorOptions,
  type MdbaseProblemMessages,
  type MdbaseErrorAction,
  type MdbaseErrorDescription,
} from "./describe-error.js";
export { parseVersion, compareVersions, versionRelation } from "./semver.js";
export type { MdbaseVersion, MdbaseVersionRelation } from "./semver.js";
export { applicationPhase, isReadyPhase, SLOW_OPENING_MS } from "./application/phase.js";
export type { MdbasePhase, MdbasePhaseKind, MdbaseProblem, MdbaseCollectionSummary, MdbaseApprovalOutcome, ApplicationPhaseOptions as MdbasePhaseOptions } from "./application/phase.js";
export {createMdbase} from "./application/front-door.js";
export type {Mdbase,MdbaseSnapshot,MdbaseSetupResult} from "./application/front-door.js";
export type {MdbaseTransferItem,MdbaseTransferMap,MdbaseTransferPlan,MdbaseTransferProgress,MdbaseTransferResult} from "./application/unsynced-transfer.js";
export type {MdbaseTransferOptions,MdbaseTransferPlanOptions} from "./application/entry.js";
export {effectiveCapabilities} from "./application/capabilities.js";
export type {MdbaseApplicationCapability,MdbaseApplicationCapabilities} from "./application/capabilities.js";
export type {MdbaseApplicationConnection,MdbaseApplicationRequestOptions,MdbaseCollectionDeleteOptions,MdbaseSignOutOptions,MdbaseUnlockSecret,MdbaseOptions,MdbaseSignInOpener,
  MdbaseApplicationFacet,MdbaseApplicationProblem,MdbaseApplicationAssessment,MdbaseUnavailableType,MdbaseApplicationFacetSnapshot,MdbaseApplicationReadinessSnapshot,MdbaseLinks} from "./application/entry.js";
export type {MdbaseSetupPlan,MdbaseSetupPlanOptions,MdbaseSetupRecord,MdbaseSetupChange,MdbaseSetupChangeKind,MdbaseSetupConflict,MdbaseSetupRefusalCode} from "./application/setup.js";
export type {MdbaseAccessRequest,MdbaseAccessRequestOptions,MdbaseAccessResult} from "./application/file-access.js";
export type {ApplicationCollectionSelectionSnapshot as MdbaseApplicationSelectionSnapshot,ApplicationCollectionSelectionState as MdbaseApplicationSelectionState} from "./application/collection-selection.js";
export type {MdbaseApplicationDeclaration,ApplicationStorageDeclaration,ApplicationJson} from "./application/declaration.js";

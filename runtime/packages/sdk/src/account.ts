/**
 * `@mdbase-dev/sdk/account`: the private (E2E) multi-device enrolment surface (AK1 §7).
 * Separate from the root entry because it carries Argon2id, Ed25519 and the strength
 * meter, which the thin client never loads.
 */
export {
  AccountKeyError, BUNDLE_VERSION, DEFAULT_KDF, MAX_BUNDLE_BYTES, MAX_PASSWORD_BYTES, MIN_PASSWORD_CHARS, checkKdfParams,
  accountKeyRewrapDigest, checkPassword, checkRecoveryKey, decodeBundle, deriveAccountKeyProof, deriveRecoveryDevice, domainHash, encodeBundle, formatRecoveryKey,
  generateRecoveryKey, inlineArgon2id, keyId, normalizePassword, openBundle, parseRecoveryKey, recoverySign, sealBundle, signAccountKeyRewrap,
  wipe, wipeRecoveryDevice,
} from "./account-key.js";
export type {
  AccountKeyErrorCode, AccountKeyProof, Argon2idRunner, Bundle, Entropy, KdfParams, OpenOptions, RecoveryDevice, SealOptions,
} from "./account-key.js";
export { PrivateAccount, memorySecretStore } from "./private-account.js";
export type {
  AccountKeyControlPort, AccountKeyMode, AccountKeyReplicaPort, AccountSecretStore, PrivateAccountPorts, PrivateAccountRequestOptions,
  PrivateAccountStatus, SetupResult, StrictPendingTarget, StrictResult, UnlockResult,
} from "./private-account.js";
export { passwordStrength } from "./strength.js";
export type { Strength } from "./strength.js";

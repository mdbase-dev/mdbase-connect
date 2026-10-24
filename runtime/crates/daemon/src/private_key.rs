//! `mdbase private …`: the account key (AK1,
//! account-key bundle design) for private (end-to-end)
//! collections.
//!
//! The account secret `R` is generated here, sealed under the user's encryption
//! password (Argon2id, off the async executor), and stored at the control plane only
//! as that sealed bundle. On this device `R` is kept in the OS credential store
//! (`account-key.<account>`), never in a file. Each private collection's account-key
//! device is derived from `R`; the replicas key it (setup) or key themselves from it
//! (unlock).

use std::collections::BTreeSet;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use mdbn_replica::crypto::account_key::{self, AccountKeyError, Bundle};
use mdbn_replica::crypto::recovery::RecoveryKey;
use mdbn_replica::replica::AccountKeyRefusal;
use serde_json::{Value, json};
use zeroize::{Zeroize, Zeroizing};

use super::{Daemon, cloud_refusal};
use crate::authority::Incarnation;
use crate::control::{ControlError, PrivateSecret};
use crate::registry::SyncMode;
use crate::runtime::AccountKeyOp;

/// How long setup and unlock wait for a collection's replica to catch up.
const WAIT: Duration = Duration::from_secs(60);

/// How long an unlock waits for a just-joined or just-opened replica to apply the
/// collection's policy before reporting `not_ready` (retried in the background).
const READY_WAIT: Duration = Duration::from_secs(10);

/// Poll interval while waiting for a replica to become ready.
const READY_POLL: Duration = Duration::from_millis(500);

/// The only credential-store backend that may hold `R` (or SAS requester state).
const CUSTODY_BACKEND: &str = "keychain";

use mdbn_local_host::OsEntropy;

/// Accounts whose stored `R` is in an uncertain state in this process (a write,
/// delete or readback that did not confirm, or malformed stored bytes). Every
/// account-key operation for them is refused until the daemon restarts: nothing is
/// overwritten or cleaned up on an assumed rollback.
static POISONED: Mutex<BTreeSet<[u8; 16]>> = Mutex::new(BTreeSet::new());

fn poison(account: &[u8; 16]) {
    if let Ok(mut p) = POISONED.lock() {
        p.insert(*account);
    }
}

fn poisoned(account: &[u8; 16]) -> bool {
    // A poisoned lock is itself uncertainty: refuse.
    POISONED.lock().map_or(true, |p| p.contains(account))
}

fn custody_uncertain() -> ControlError {
    ControlError::unavailable(
        "account_key_uncertain",
        "the stored account key could not be confirmed; restart the daemon, then unlock again",
    )
}

fn key_error(e: AccountKeyError) -> ControlError {
    match e {
        AccountKeyError::WeakPassword => ControlError::invalid(
            "weak_password",
            "use at least 12 characters; a longer passphrase is better",
        ),
        AccountKeyError::PasswordTooLong => {
            ControlError::invalid("password_too_long", "the password is too long")
        }
        AccountKeyError::WrongSecret => {
            ControlError::invalid("wrong_secret", "wrong password or recovery key")
        }
        AccountKeyError::Params | AccountKeyError::Encoding => ControlError::unavailable(
            "account_key_unsupported",
            "the stored account key is not a supported format",
        ),
    }
}

/// A stable snake_case code for an account-key refusal (control responses, logs).
pub(crate) fn refusal_code(e: AccountKeyRefusal) -> &'static str {
    match e {
        AccountKeyRefusal::NotPrivate => "not_private",
        AccountKeyRefusal::NotReady => "not_ready",
        AccountKeyRefusal::NotEnrolled => "device_not_enrolled",
        AccountKeyRefusal::NotAuthorized => "not_authorized",
        AccountKeyRefusal::DeviceMissing => "account_key_not_enrolled",
        AccountKeyRefusal::EnrolmentMismatch => "account_key_enrolment_mismatch",
        AccountKeyRefusal::NotKeyed => "account_key_not_keyed",
        AccountKeyRefusal::NoWrap => "account_key_no_wrap",
        AccountKeyRefusal::Inconsistent => "account_key_inconsistent",
        AccountKeyRefusal::Failed => "account_key_failed",
        AccountKeyRefusal::OutcomeUnknown => "outcome_unknown",
    }
}

/// An unlock refusal meaning no device holding `R` has keyed this collection's
/// account-key device yet (password mode): retryable, never a failure of the
/// collection. In strict mode the same refusals mean the account key was revoked.
pub(crate) fn pending_account_key(e: AccountKeyRefusal) -> bool {
    matches!(
        e,
        AccountKeyRefusal::DeviceMissing | AccountKeyRefusal::NotKeyed | AccountKeyRefusal::NoWrap
    )
}

/// An unlock refusal meaning this replica is not ready to evaluate it yet (no
/// policy applied, installing a snapshot, or this device's enrolment not applied
/// yet: just joined or opened). Never settled: the unlock is retried shortly.
pub(crate) fn not_ready(e: AccountKeyRefusal) -> bool {
    matches!(
        e,
        AccountKeyRefusal::NotReady | AccountKeyRefusal::NotEnrolled
    )
}

/// This device's own state in a collection is settled (nothing for the background
/// to retry soon). `not_ready`, `waiting`, `unlocking`, `opening` and `not_serving`
/// are not.
fn device_settled(device: &str) -> bool {
    matches!(device, "unlocked" | "pending_account_key" | "refused")
}

/// How long after a background unlock the next may start: shortly while the
/// replica was not ready yet, otherwise throttled.
fn unlock_retry(device: &str) -> Duration {
    match device {
        "not_ready" | "waiting" => NOT_READY_RETRY,
        _ => UNLOCK_RETRY,
    }
}

/// Run unlock attempts while the replica answers "not ready yet", for at most
/// [`READY_WAIT`]; any other answer (or the deadline) ends the wait.
async fn until_ready<F, Fut, T>(mut attempt: F) -> Result<T, AccountKeyRefusal>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T, AccountKeyRefusal>>,
{
    let deadline = tokio::time::Instant::now() + READY_WAIT;
    loop {
        match attempt().await {
            Err(e) if not_ready(e) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(READY_POLL).await;
            }
            out => return out,
        }
    }
}

/// The typed per-collection state of a finished unlock attempt.
fn unlock_outcome(
    out: Result<(&'static str, Option<String>), AccountKeyRefusal>,
    strict: bool,
) -> (&'static str, Option<String>) {
    match out {
        Ok(done) => done,
        Err(e) if pending_account_key(e) && !strict => {
            ("pending_account_key", Some(refusal_code(e).into()))
        }
        Err(e) if pending_account_key(e) => ("refused", Some("account_key_revoked".into())),
        Err(AccountKeyRefusal::NotEnrolled) => ("waiting", Some("device_not_enrolled".into())),
        Err(AccountKeyRefusal::NotReady) => ("not_ready", Some("not_ready".into())),
        Err(e) => ("refused", Some(refusal_code(e).into())),
    }
}

/// The account-key device of one private collection, as this daemon last saw it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum AkDevice {
    /// Enrolled exactly as derived from `R`, and keyed: any device of the account
    /// unlocks with the password alone.
    Keyed,
    /// Not keyed yet, and this device cannot key it here (not keyed itself, or not
    /// an editor); a device holding `R` that can will.
    PendingAccountKey,
    /// This device is not an active member device here yet (joining, catching up).
    Waiting,
    /// Transient (control plane not ready or unreachable, runtime not serving, not
    /// applied yet): retried in the background.
    Retrying(String),
    /// Refused with a typed reason; retried only after a change (or the next pass).
    Refused(String),
}

impl AkDevice {
    fn state(&self) -> &'static str {
        match self {
            AkDevice::Keyed => "keyed",
            AkDevice::PendingAccountKey => "pending_account_key",
            AkDevice::Waiting => "waiting",
            AkDevice::Retrying(_) => "retrying",
            AkDevice::Refused(_) => "refused",
        }
    }

    fn error(&self) -> Option<&str> {
        match self {
            AkDevice::Retrying(e) | AkDevice::Refused(e) => Some(e),
            _ => None,
        }
    }

    /// Nothing for the background to retry soon (a pending or refused collection is
    /// re-checked on the slow cadence, or when woken).
    fn settled(&self) -> bool {
        !matches!(self, AkDevice::Waiting | AkDevice::Retrying(_))
    }
}

/// A control-plane refusal of the account-key device enrolment, as a typed state.
/// Only the server's short error code is kept (never a message or a body).
fn enrol_refusal(e: &crate::cloud::CloudError) -> AkDevice {
    use crate::cloud::CloudError;
    let code = |c: &str| {
        let safe = !c.is_empty()
            && c.len() <= 64
            && c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_');
        if safe {
            c.to_string()
        } else {
            "enrolment_refused".to_string()
        }
    };
    match e {
        CloudError::Network(_) => AkDevice::Retrying("sync_unreachable".into()),
        CloudError::Server(s, c) if *s >= 500 || c == "not_ready" => AkDevice::Retrying(code(c)),
        CloudError::Server(_, c) => AkDevice::Refused(code(c)),
        CloudError::Unauthenticated => AkDevice::Refused("not_signed_in".into()),
        CloudError::Local(_) => AkDevice::Retrying("account_changed".into()),
    }
}

/// What this daemon last saw of one private collection's account key.
struct AkEntry {
    /// This device's own key: `unlocked`, `pending_account_key`, `unlocking`, …
    device: &'static str,
    device_error: Option<String>,
    account_key: AkDevice,
    /// The last background unlock this daemon started here (throttle).
    last_unlock: Option<Instant>,
}

/// Background re-unlocks of a collection this device holds `R` for, at most this often.
const UNLOCK_RETRY: Duration = Duration::from_secs(120);

/// Background re-unlocks of a collection whose replica was not ready yet.
const NOT_READY_RETRY: Duration = Duration::from_secs(5);

/// Per-daemon account-key reconciliation state (RAM only; nothing secret).
#[derive(Default)]
pub(crate) struct AccountKeys {
    /// Run a reconciliation pass now (enable, join, unlock, setup).
    wake: tokio::sync::Notify,
    /// One pass at a time: the background task, setup and unlock.
    pass: tokio::sync::Mutex<()>,
    entries: Mutex<std::collections::BTreeMap<String, AkEntry>>,
}

impl AccountKeys {
    /// Ask the background task for a pass (coalesced).
    pub(crate) fn wake(&self) {
        self.wake.notify_one();
    }

    /// Record a collection's state; log a safe line when it changed.
    fn record(
        &self,
        id: &str,
        device: &'static str,
        device_error: Option<String>,
        account_key: AkDevice,
        unlock_started: bool,
    ) {
        let Ok(mut entries) = self.entries.lock() else {
            return;
        };
        let prev = entries.get(id);
        let changed = prev.is_none_or(|p| {
            p.device != device || p.device_error != device_error || p.account_key != account_key
        });
        if changed {
            tracing::info!(
                collection = %id,
                device = device,
                device_error = device_error.as_deref().unwrap_or(""),
                account_key = account_key.state(),
                account_key_error = account_key.error().unwrap_or(""),
                "private collection account key"
            );
        }
        let last_unlock = if unlock_started {
            Some(Instant::now())
        } else {
            prev.and_then(|p| p.last_unlock)
        };
        entries.insert(
            id.to_string(),
            AkEntry {
                device,
                device_error,
                account_key,
                last_unlock,
            },
        );
    }

    fn unlock_due(&self, id: &str) -> bool {
        self.entries.lock().is_ok_and(|e| {
            e.get(id).is_none_or(|e| {
                e.last_unlock
                    .is_none_or(|t| t.elapsed() >= unlock_retry(e.device))
            })
        })
    }

    /// The status display for these collections.
    fn report(&self, ids: &[String]) -> Vec<Value> {
        let entries = self.entries.lock().ok();
        ids.iter()
            .map(|id| match entries.as_ref().and_then(|e| e.get(id)) {
                Some(e) => entry_json(id, e.device, e.device_error.as_deref(), &e.account_key),
                None => {
                    json!({ "collection": id, "state": "unchecked", "account_key": "unchecked" })
                }
            })
            .collect()
    }
}

fn entry_json(id: &str, device: &str, device_error: Option<&str>, ak: &AkDevice) -> Value {
    let mut v = json!({ "collection": id, "state": device, "account_key": ak.state() });
    if let Some(e) = device_error {
        v["error"] = json!(e);
    }
    if let Some(e) = ak.error() {
        v["account_key_error"] = json!(e);
    }
    v
}

fn account_changed() -> ControlError {
    ControlError::new(
        "unauthenticated",
        "account_changed",
        "current paired account required",
    )
}

/// The process-wide KDF slot: one Argon2id at a time, so the KDF's peak memory is
/// bounded by one bundle's parameters (≤ 24 MiB) however many requests arrive.
static KDF: LazyLock<Arc<tokio::sync::Mutex<()>>> =
    LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));

/// Run KDF-bound work off the async executor. The slot is held by the blocking task
/// itself, so a cancelled caller cannot release it while the work still runs: the
/// next KDF starts only after this one has finished (cancel joins the slot).
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, ControlError> {
    let slot = KDF.clone().lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let _slot = slot;
        f()
    })
    .await
    .map_err(|_| ControlError::internal("key derivation task"))
}

/// A password from the request, held in a zeroizing buffer for the KDF.
fn password_of(p: &PrivateSecret) -> Option<Zeroizing<String>> {
    p.password.as_ref().map(|s| Zeroizing::new(s.clone()))
}

fn secret_name(account: &[u8; 16]) -> String {
    format!("account-key.{}", crate::secrets::uuid_string(account))
}

/// `R` from the credential store. Malformed stored bytes poison the account (never
/// silently "not unlocked").
fn read_r(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
) -> Result<Option<RecoveryKey>, ControlError> {
    if poisoned(account) {
        return Err(custody_uncertain());
    }
    let raw = store
        .get(&secret_name(account))
        .map_err(|e| ControlError::unavailable("credential_store_unavailable", e.to_string()))?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let Ok(mut bytes) = <[u8; 32]>::try_from(raw.as_slice()) else {
        poison(account);
        return Err(ControlError::unavailable(
            "account_key_corrupt",
            "the stored account key is malformed; restart the daemon, then unlock with the recovery key",
        ));
    };
    let r = RecoveryKey::from_bytes(bytes);
    bytes.zeroize();
    Ok(Some(r))
}

/// Store `R` and read it back. Anything short of an exact readback poisons the
/// account: the stored state is unknown, so nothing may use or overwrite it.
fn store_r(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
    r: &RecoveryKey,
) -> Result<(), ControlError> {
    if poisoned(account) {
        return Err(custody_uncertain());
    }
    let name = secret_name(account);
    if store.set(&name, r.expose()).is_err() {
        poison(account);
        return Err(custody_uncertain());
    }
    match store.get(&name) {
        Ok(Some(back)) if back.as_slice() == r.expose() => Ok(()),
        _ => {
            poison(account);
            Err(custody_uncertain())
        }
    }
}

/// Delete `R` and confirm it is gone (else poison).
fn delete_r(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
) -> Result<(), ControlError> {
    if poisoned(account) {
        return Err(custody_uncertain());
    }
    let name = secret_name(account);
    if store.delete(&name).is_err() {
        poison(account);
        return Err(custody_uncertain());
    }
    match store.get(&name) {
        Ok(None) => Ok(()),
        _ => {
            poison(account);
            Err(custody_uncertain())
        }
    }
}

fn strict_name(account: &[u8; 16]) -> String {
    format!(
        "account-key-strict.{}",
        crate::secrets::uuid_string(account)
    )
}

/// The key id of the account key that was current
/// when strict mode was requested (or seen requested) on this device. While it
/// is recorded, no account-key device derived from that key is ever enrolled or
/// keyed, whatever the control plane later reports about the mode: a control
/// plane that kept the old password bundle (and could guess the password) must
/// not get R-derived recovery devices into new private collections by claiming
/// "password" again. Neither setup nor unlock can clear this intent. Leaving
/// strict mode stays on HOLD until an intent-bound native transition is available.
fn read_strict(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
) -> Result<Option<[u8; 32]>, ControlError> {
    let raw = store
        .get(&strict_name(account))
        .map_err(|e| ControlError::unavailable("credential_store_unavailable", e.to_string()))?;
    match raw {
        None => Ok(None),
        // Malformed: fail closed (every key counts as strict-requested).
        Some(b) => Ok(Some(
            <[u8; 32]>::try_from(b.as_slice()).unwrap_or([0xff; 32]),
        )),
    }
}

/// Record the strict marker and read it back; anything else refuses (the
/// control plane is not asked for strict without it).
fn store_strict(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
    key_id: &[u8; 32],
) -> Result<(), ControlError> {
    if poisoned(account) {
        return Err(custody_uncertain());
    }
    let name = strict_name(account);
    if store.set(&name, key_id).is_err() {
        poison(account);
        return Err(custody_uncertain());
    }
    match store.get(&name) {
        Ok(Some(back)) if back.as_slice() == key_id => Ok(()),
        _ => {
            poison(account);
            Err(custody_uncertain())
        }
    }
}

/// Bind strict custody to the actual local key, never a control-plane key claim.
/// Repair old markers even when the CP already reports strict. A mismatch or
/// changed local key blocks every key; an existing all-key marker is never narrowed.
fn record_strict_for_local_key(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
    cp_key_id: Option<[u8; 32]>,
    expected_local: Option<[u8; 32]>,
) -> Result<(), ControlError> {
    let local = read_r(store, account)?;
    let local_id = local.as_ref().map(|r| account_key::key_id(r).0);
    let previous = read_strict(store, account)?;
    let changed = local_id != expected_local
        || matches!((cp_key_id, local_id), (Some(cp), Some(local)) if cp != local);
    let marker = if changed || previous == Some([0xff; 32]) {
        [0xff; 32]
    } else {
        local_id.unwrap_or([0xff; 32])
    };
    store_strict(store, account, &marker)?;
    if changed {
        return Err(ControlError::unavailable(
            "strict_changed",
            "the account key changed; strict keying remains blocked; query status",
        ));
    }
    Ok(())
}

/// Whether strict mode was requested for this key (fail closed on a malformed
/// marker or an unreadable store).
fn strict_blocks(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
    _r: &RecoveryKey,
) -> bool {
    if poisoned(account) {
        return true;
    }
    match read_strict(store, account) {
        Ok(None) => false,
        // A different key alone is not proof of an authorized fresh setup.
        Ok(Some(_)) => true,
        Err(_) => true,
    }
}

/// Conservative unlock policy: a CP password claim or native prompt cannot
/// discard recorded intent. Own-device unlocking remains separate from R-device
/// keying; leaving strict requires a separately qualified intent-bound flow.
fn unlock_keeps_strict(
    cp_mode: &str,
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
    r: &RecoveryKey,
) -> bool {
    cp_mode != "password" || strict_blocks(store, account, r)
}

fn account_keying_current(
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
    expected: [u8; 32],
) -> bool {
    read_r(store, account).is_ok_and(|local| {
        local.as_ref().is_some_and(|r| {
            account_key::key_id(r).0 == expected && !strict_blocks(store, account, r)
        })
    })
}

/// Whether the background pass may enrol and key account-key devices from `r`:
/// only the account's CURRENT key, in password mode, and never a key that
/// strict mode was requested for, whatever the control plane now reports.
fn keys_in_background(
    cp_mode: &str,
    cp_key_id: Option<[u8; 32]>,
    r: &RecoveryKey,
    store: &dyn crate::secrets::SecretStore,
    account: &[u8; 16],
) -> bool {
    cp_mode == "password"
        && cp_key_id == Some(account_key::key_id(r).0)
        && !strict_blocks(store, account, r)
}

impl Daemon {
    /// The account incarnation, the sync context and this device's identity, with
    /// the credential store checked to be the OS keychain.
    fn account_parts(
        &self,
    ) -> Result<
        (
            crate::collections::SyncCtx,
            Incarnation,
            Arc<crate::secrets::DeviceIdentity>,
        ),
        ControlError,
    > {
        if self.secrets.backend() != CUSTODY_BACKEND {
            return Err(ControlError::unavailable(
                "credential_store_unsupported",
                "private collections need the OS keychain",
            ));
        }
        let (ctx, _trust) = self.sync_parts()?;
        let inc = self.authority.incarnation().ok_or_else(account_changed)?;
        let identity = self
            .identity
            .get()
            .ok_or_else(|| {
                ControlError::unavailable("device_identity_missing", "keychain device unavailable")
            })?
            .clone();
        if identity.device_id != inc.device.0 {
            return Err(account_changed());
        }
        if poisoned(&inc.account.0) {
            return Err(custody_uncertain());
        }
        Ok((ctx, inc, identity))
    }

    /// The incarnation is still the current one.
    fn still(&self, inc: Incarnation) -> Result<(), ControlError> {
        (self.authority.incarnation() == Some(inc))
            .then_some(())
            .ok_or_else(account_changed)
    }

    /// The incarnation is still the current one (checked around every cloud await).
    fn current_account(
        &self,
        inc: Incarnation,
    ) -> impl Fn() -> Result<(), String> + Send + Sync + '_ {
        move || {
            (self.authority.incarnation() == Some(inc))
                .then_some(())
                .ok_or_else(|| "account_changed".to_string())
        }
    }

    fn account_keying_guard(
        &self,
        inc: Incarnation,
        r: &RecoveryKey,
    ) -> crate::runtime::AccountKeyGuard {
        let authority = self.authority.clone();
        let secrets = self.secrets.clone();
        let expected = account_key::key_id(r).0;
        Arc::new(move || {
            authority.incarnation() == Some(inc)
                && account_keying_current(&*secrets, &inc.account.0, expected)
        })
    }

    /// This account's private collections hosted here: (ID, runtime).
    async fn private_runtimes(
        &self,
        account: &[u8; 16],
    ) -> Vec<(String, Option<Arc<crate::runtime::Runtime>>)> {
        let account = crate::secrets::uuid_string(account);
        let inner = self.inner.lock().await;
        inner
            .hosts
            .iter()
            .filter(|h| {
                h.entry().mode == SyncMode::SyncedE2e
                    && h.entry().owner_account.as_deref() == Some(account.as_str())
            })
            .map(|h| (h.entry().id.clone(), h.runtime()))
            .collect()
    }

    fn stored_account_key(&self, account: &[u8; 16]) -> Result<Option<RecoveryKey>, ControlError> {
        read_r(&*self.secrets, account)
    }

    fn store_account_key(&self, account: &[u8; 16], r: &RecoveryKey) -> Result<(), ControlError> {
        store_r(&*self.secrets, account, r)
    }

    fn delete_account_key(&self, account: &[u8; 16]) -> Result<(), ControlError> {
        delete_r(&*self.secrets, account)
    }

    /// Poll a collection's account-key operation until it stops answering "not yet"
    /// (the replica has not applied the enrolment or the wrap yet).
    async fn account_key_op(
        runtime: &crate::runtime::Runtime,
        r: &RecoveryKey,
        op: fn(RecoveryKey) -> AccountKeyOp,
        wait_keyed: bool,
        current: Option<&crate::runtime::AccountKeyGuard>,
    ) -> Result<bool, AccountKeyRefusal> {
        let deadline = Instant::now() + WAIT;
        loop {
            // A stopped runtime may or may not have run it: unknown, never Failed.
            if current.is_some_and(|current| !current()) {
                return Err(AccountKeyRefusal::NotAuthorized);
            }
            let out = match current {
                Some(current) => {
                    runtime
                        .account_key_guarded(op(r.clone()), current.clone())
                        .await
                }
                None => runtime.account_key(op(r.clone())).await,
            }
            .unwrap_or(Err(AccountKeyRefusal::OutcomeUnknown));
            if current.is_some_and(|current| !current()) {
                return Err(AccountKeyRefusal::OutcomeUnknown);
            }
            let retry = match &out {
                Err(AccountKeyRefusal::DeviceMissing)
                | Err(AccountKeyRefusal::NotKeyed)
                | Err(AccountKeyRefusal::NoWrap) => true,
                Ok(false) if wait_keyed => true,
                _ => false,
            };
            if !retry || Instant::now() >= deadline {
                return out;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }

    /// Poll a runtime until `op` answers true (`Ok(Some(true))`), the deadline
    /// passes (`Ok(Some(false))`), it refuses for good (`Err`), or the runtime
    /// stopped (`Ok(None)`: unknown).
    async fn wait_true(
        runtime: &crate::runtime::Runtime,
        op: impl Fn() -> AccountKeyOp,
    ) -> Result<Option<bool>, AccountKeyRefusal> {
        let deadline = Instant::now() + WAIT;
        loop {
            match runtime.account_key(op()).await {
                Some(Ok(true)) => return Ok(Some(true)),
                None => return Ok(None),
                Some(Err(e)) => return Err(e),
                Some(Ok(false)) if Instant::now() >= deadline => return Ok(Some(false)),
                Some(Ok(false)) => tokio::time::sleep(Duration::from_millis(500)).await,
            }
        }
    }

    /// `private.status`.
    pub(super) async fn private_status(&self) -> Result<Value, ControlError> {
        // Metadata only: status never spends the account's bundle-fetch budget.
        let (ctx, inc, _identity) = self.account_parts()?;
        let account = inc.account.0;
        let current = self.current_account(inc);
        let record = ctx
            .cloud
            .account_key_status(&current)
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        let stored = self.stored_account_key(&account)?;
        // Unlocked means this device holds the account's CURRENT key, not any key.
        let unlocked = match (&stored, record.key_id) {
            (Some(r), Some(k)) => account_key::key_id(r).0 == k,
            _ => false,
        };
        let strict_pending = record.mode == "strict" && record.complete != Some(true);
        let hosted: Vec<String> = self
            .private_runtimes(&account)
            .await
            .into_iter()
            .map(|(id, _)| id)
            .collect();
        Ok(json!({
            "mode": record.mode,
            "version": record.version,
            "unlocked": unlocked,
            "strict_pending": strict_pending,
            "strict_complete": record.mode == "strict" && record.complete == Some(true),
            "account_key_kept": stored.is_some(),
            "collections": record.pending,
            // Per hosted private collection: this device's key and the account-key
            // device (`keyed`, `pending_account_key`, `retrying`, …), as last seen.
            "account_key_devices": self.account_keys.report(&hosted),
        }))
    }

    /// `private.setup`: generate `R`, keep it in the keychain, seal and store the
    /// bundle, key every private collection.
    pub(super) async fn private_setup(&self, p: PrivateSecret) -> Result<Value, ControlError> {
        let password = password_of(&p).ok_or_else(|| {
            ControlError::invalid("password_required", "set an encryption password")
        })?;
        account_key::check_password(&password).map_err(key_error)?;
        let (ctx, inc, identity) = self.account_parts()?;
        let account = inc.account.0;
        let current = self.current_account(inc);
        let record = ctx
            .cloud
            .account_key_status(&current)
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        if record.mode == "password" {
            return Err(ControlError::invalid(
                "already_set_up",
                "this account already has an account key; unlock this device instead",
            ));
        }
        let stored = self.stored_account_key(&account)?;
        let r = match (record.mode.as_str(), stored) {
            // A key kept while strict mode completes must not be replaced yet.
            ("strict", Some(_)) => {
                return Err(ControlError::invalid(
                    "strict_pending",
                    "strict mode has not completed; run `mdbase private strict` again first",
                ));
            }
            // A previous setup stored R but its bundle never landed: reuse it, so a
            // retry never strands a key another device may already hold.
            ("none", Some(r)) => r,
            _ => {
                let r = RecoveryKey::generate(&mut OsEntropy);
                // R is in the keychain (read back) before anything leaves the device.
                self.store_account_key(&account, &r)?;
                r
            }
        };
        let sealed = {
            let r = r.clone();
            let acct = mdbn_wire::common::B16(account);
            blocking(move || account_key::seal(&r, &password, &acct, &mut OsEntropy)).await?
        }
        .map_err(key_error)?;
        self.still(inc)?;
        // A first bundle (none or strict): device proof plus R's proof key.
        let proof = account_key::proof_signer(&r, &mdbn_wire::common::B16(account));
        ctx.cloud
            .account_key_put(
                &ctx.connector_id,
                &account,
                record.version,
                &sealed.key_id.0,
                &sealed.to_bytes(),
                &proof,
                false,
                &identity,
                &current,
            )
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        // Setup cannot erase any strict intent, including one published while
        // its cloud request was in flight. Per-collection live guards refuse
        // recovery-device keying until explicit native password confirmation.
        let collections = self
            .key_private_collections(&ctx, inc, &identity, &r)
            .await?;
        // The recovery key is shown only to the incarnation that created it.
        self.still(inc)?;
        Ok(json!({
            "recovery_key": r.to_text().as_str(),
            "key_id": crate::secrets::hex(&sealed.key_id.0),
            "collections": collections,
        }))
    }

    /// Enrol and key this account's account-key device in every hosted private
    /// collection (setup). Same per-collection step as the background pass.
    async fn key_private_collections(
        &self,
        ctx: &crate::collections::SyncCtx,
        inc: Incarnation,
        identity: &crate::secrets::DeviceIdentity,
        r: &RecoveryKey,
    ) -> Result<Vec<Value>, ControlError> {
        let _pass = self.account_keys.pass.lock().await;
        let mut out = Vec::new();
        for (id, runtime) in self.private_runtimes(&inc.account.0).await {
            self.still(inc)?;
            let ak = match &runtime {
                Some(rt) => {
                    self.ensure_account_key_device(ctx, inc, identity, r, &id, rt)
                        .await?
                }
                None => AkDevice::Retrying("not_serving".into()),
            };
            let mut v = entry_json(&id, "unchecked", None, &ak);
            v["keyed"] = json!(ak == AkDevice::Keyed);
            self.account_keys.record(&id, "unchecked", None, ak, false);
            out.push(v);
        }
        self.account_keys.wake();
        Ok(out)
    }

    /// Enrol (control plane, proof of possession; idempotent) and key this
    /// collection's account-key device when it is not keyed yet and this device may
    /// key it. Errors only when the account changed; everything else is a state.
    async fn ensure_account_key_device(
        &self,
        ctx: &crate::collections::SyncCtx,
        inc: Incarnation,
        identity: &crate::secrets::DeviceIdentity,
        r: &RecoveryKey,
        id: &str,
        runtime: &crate::runtime::Runtime,
    ) -> Result<AkDevice, ControlError> {
        let Some(collection) = crate::attest::uuid_bytes(id) else {
            return Ok(AkDevice::Refused("collection_id".into()));
        };
        let current_key = self.account_keying_guard(inc, r);
        self.still(inc)?;
        if !current_key() {
            return Ok(AkDevice::Refused("strict_mode".into()));
        }
        let status = runtime
            .account_key_guarded(AccountKeyOp::Status(r.clone()), current_key.clone())
            .await;
        self.still(inc)?;
        if !current_key() {
            return Ok(AkDevice::Refused("strict_mode".into()));
        }
        let enrolled = match status {
            None => return Ok(AkDevice::Retrying("not_serving".into())),
            Some(Ok(true)) => return Ok(AkDevice::Keyed),
            Some(Ok(false)) => true,
            Some(Err(AccountKeyRefusal::DeviceMissing)) => false,
            Some(Err(AccountKeyRefusal::NotEnrolled)) => return Ok(AkDevice::Waiting),
            Some(Err(AccountKeyRefusal::NotReady)) => {
                return Ok(AkDevice::Retrying("not_ready".into()));
            }
            Some(Err(e)) => return Ok(AkDevice::Refused(refusal_code(e).into())),
        };
        // Enrol only where this device can then key it: never leave an enrolled,
        // unkeyed account-key device behind on purpose.
        let can_key = runtime
            .account_key_guarded(AccountKeyOp::CanKey, current_key.clone())
            .await;
        self.still(inc)?;
        if !current_key() {
            return Ok(AkDevice::Refused("strict_mode".into()));
        }
        match can_key {
            None => return Ok(AkDevice::Retrying("not_serving".into())),
            Some(Ok(true)) => {}
            Some(Ok(false)) => return Ok(AkDevice::PendingAccountKey),
            Some(Err(AccountKeyRefusal::NotEnrolled)) => return Ok(AkDevice::Waiting),
            Some(Err(AccountKeyRefusal::NotReady)) => {
                return Ok(AkDevice::Retrying("not_ready".into()));
            }
            Some(Err(e)) => return Ok(AkDevice::Refused(refusal_code(e).into())),
        }
        self.still(inc)?;
        if !enrolled {
            let account_current = self.current_account(inc);
            let current = || {
                account_current()?;
                current_key()
                    .then_some(())
                    .ok_or_else(|| "strict_keying_blocked".to_owned())
            };
            let rk = r.derive(&mdbn_wire::common::B16(collection));
            let enrol = ctx
                .cloud
                .account_key_device_enrol(
                    &ctx.connector_id,
                    &inc.account.0,
                    &collection,
                    &rk,
                    identity,
                    &current,
                )
                .await;
            drop(rk);
            self.still(inc)?;
            if !current_key() {
                // The request might have reached the CP before the fence changed.
                return Ok(AkDevice::Retrying("outcome_unknown".into()));
            }
            if let Err(e) = enrol {
                return Ok(enrol_refusal(&e));
            }
        }
        // Wait for the enrolment to apply here, key it, and wait for the grant to
        // apply.
        let keyed =
            match Self::account_key_op(runtime, r, AccountKeyOp::Key, false, Some(&current_key))
                .await
            {
                Ok(_) => {
                    Self::account_key_op(runtime, r, AccountKeyOp::Status, true, Some(&current_key))
                        .await
                }
                Err(e) => Err(e),
            };
        self.still(inc)?;
        Ok(match keyed {
            Ok(true) => AkDevice::Keyed,
            Ok(false) => AkDevice::Retrying("account_key_grant_not_applied".into()),
            Err(AccountKeyRefusal::DeviceMissing) => {
                AkDevice::Retrying("account_key_enrolment_not_applied".into())
            }
            Err(AccountKeyRefusal::NotAuthorized) => AkDevice::PendingAccountKey,
            Err(AccountKeyRefusal::OutcomeUnknown) => AkDevice::Retrying("outcome_unknown".into()),
            Err(AccountKeyRefusal::NotReady) => AkDevice::Retrying("not_ready".into()),
            Err(e) => AkDevice::Refused(refusal_code(e).into()),
        })
    }

    /// This device's own unlock of one collection from `R`: start it and wait for
    /// the applied end state. Always a typed state, never a failed collection. A
    /// replica that has not applied the policy yet (just joined or opened) is waited
    /// for, bounded by [`READY_WAIT`], then reported `not_ready` (retried shortly in
    /// the background), never as a settled refusal.
    async fn unlock_collection(
        id: &str,
        runtime: &crate::runtime::Runtime,
        r: &RecoveryKey,
        strict: bool,
    ) -> (&'static str, Option<String>) {
        let out = until_ready(|| Self::unlock_attempt(id, runtime, r)).await;
        unlock_outcome(out, strict)
    }

    /// One unlock: start it and wait for the applied end state, or its refusal.
    async fn unlock_attempt(
        id: &str,
        runtime: &crate::runtime::Runtime,
        r: &RecoveryKey,
    ) -> Result<(&'static str, Option<String>), AccountKeyRefusal> {
        Self::account_key_op(runtime, r, AccountKeyOp::Unlock, false, None).await?;
        match Self::wait_true(runtime, || AccountKeyOp::Unlocked).await? {
            Some(true) => Ok(("unlocked", None)),
            Some(false) => Ok(("pending", None)),
            None => {
                tracing::warn!(collection = %id, "private unlock: the collection stopped serving");
                Ok(("not_serving", Some("runtime_stopped".into())))
            }
        }
    }

    /// `private.unlock`: recover `R` (password or recovery key) and key this device.
    pub(super) async fn private_unlock(&self, p: PrivateSecret) -> Result<Value, ControlError> {
        let (ctx, inc, identity) = self.account_parts()?;
        let account = inc.account.0;
        let current = self.current_account(inc);
        let record = ctx
            .cloud
            .account_key_fetch(&ctx.connector_id, &account, &identity, &current)
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        let bundle = match &record.bundle {
            Some((b, _)) => Some(Bundle::from_bytes(b).map_err(key_error)?),
            None => None,
        };
        let r = match (&p.recovery_key, password_of(&p), &bundle) {
            (Some(text), _, b) => {
                let r = RecoveryKey::from_text(text).map_err(|_| {
                    ControlError::invalid("wrong_secret", "that is not a recovery key")
                })?;
                if let Some(b) = b {
                    account_key::check_recovery_key(&r, b).map_err(key_error)?;
                }
                r
            }
            (None, Some(password), Some(b)) => {
                let b = b.clone();
                let acct = mdbn_wire::common::B16(account);
                blocking(move || account_key::open(&b, &password, &acct))
                    .await?
                    .map_err(key_error)?
            }
            (None, Some(_), None) => {
                return Err(ControlError::invalid(
                    "no_account_key",
                    "this account has no account key (strict mode or not set up)",
                ));
            }
            (None, None, _) => {
                return Err(ControlError::invalid(
                    "secret_required",
                    "enter the encryption password or the recovery key",
                ));
            }
        };
        self.still(inc)?;
        // Never replace a different stored key: without a bundle (strict mode) the
        // given key is unverified here, and a stored one may be a pending strict key.
        if let Some(stored) = self.stored_account_key(&account)?
            && stored.expose() != r.expose()
            && bundle.is_none()
        {
            return Err(ControlError::invalid(
                "account_key_mismatch",
                "this device already holds a different account key",
            ));
        }
        self.store_account_key(&account, &r)?;
        if record.mode == "strict" {
            record_strict_for_local_key(
                &*self.secrets,
                &account,
                record.key_id,
                Some(account_key::key_id(&r).0),
            )?;
            self.still(inc)?;
        }
        // HOLD: unlock never clears intent based on a stale native prompt or CP
        // password claim. Current guards also catch intent published after this
        // snapshot; own-device unlock can continue without R-device keying.
        let strict = unlock_keeps_strict(record.mode.as_str(), &*self.secrets, &account, &r);
        // Success is the authenticated end state: this device keyed in the applied
        // policy and trusting its key, not the local install or a queued grant. Every
        // private collection of the account hosted here is covered, whenever it was
        // created: where this device is (or becomes) keyed it also keys the
        // account-key device; where no device holding R has keyed it yet the
        // collection reports `pending_account_key` and keeps serving.
        let _pass = self.account_keys.pass.lock().await;
        let mut out = Vec::new();
        for (id, runtime) in self.private_runtimes(&account).await {
            self.still(inc)?;
            let Some(runtime) = runtime else {
                let ak = AkDevice::Retrying("not_serving".into());
                self.account_keys
                    .record(&id, "not_serving", None, ak.clone(), false);
                out.push(entry_json(&id, "not_serving", None, &ak));
                continue;
            };
            let (state, error) = Self::unlock_collection(&id, &runtime, &r, strict).await;
            self.still(inc)?;
            let ak = match state {
                "unlocked" if !strict => {
                    self.ensure_account_key_device(&ctx, inc, &identity, &r, &id, &runtime)
                        .await?
                }
                "unlocked" => AkDevice::Refused("strict_mode".into()),
                "pending_account_key" => AkDevice::PendingAccountKey,
                "waiting" => AkDevice::Waiting,
                _ => AkDevice::Retrying(error.clone().unwrap_or_else(|| state.into())),
            };
            out.push(entry_json(&id, state, error.as_deref(), &ak));
            self.account_keys.record(&id, state, error, ak, true);
        }
        self.still(inc)?;
        self.account_keys.wake();
        let complete = out.iter().all(|c| c["state"] == "unlocked");
        Ok(json!({ "complete": complete, "collections": out }))
    }

    /// `private.password`: re-seal the same `R` under a new password.
    pub(super) async fn private_password(&self, p: PrivateSecret) -> Result<Value, ControlError> {
        let password = password_of(&p)
            .ok_or_else(|| ControlError::invalid("password_required", "enter the new password"))?;
        account_key::check_password(&password).map_err(key_error)?;
        let (ctx, inc, identity) = self.account_parts()?;
        let account = inc.account.0;
        let current = self.current_account(inc);
        let r = match &p.recovery_key {
            Some(text) => RecoveryKey::from_text(text)
                .map_err(|_| ControlError::invalid("wrong_secret", "that is not a recovery key"))?,
            None => self.stored_account_key(&account)?.ok_or_else(|| {
                ControlError::invalid(
                    "locked",
                    "unlock this device first, or give the recovery key",
                )
            })?,
        };
        let record = ctx
            .cloud
            .account_key_status(&current)
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        let Some(key_id) = record.key_id.filter(|_| record.mode == "password") else {
            return Err(ControlError::invalid(
                "no_account_key",
                "this account has no account key (strict mode or not set up)",
            ));
        };
        if account_key::key_id(&r).0 != key_id {
            return Err(key_error(AccountKeyError::WrongSecret));
        }
        let sealed = {
            let r = r.clone();
            let acct = mdbn_wire::common::B16(account);
            blocking(move || account_key::seal(&r, &password, &acct, &mut OsEntropy)).await?
        }
        .map_err(key_error)?;
        self.still(inc)?;
        // Replacing the bundle: R signs the rewrap digest (Connect #635).
        let proof = account_key::proof_signer(&r, &mdbn_wire::common::B16(account));
        let version = ctx
            .cloud
            .account_key_put(
                &ctx.connector_id,
                &account,
                record.version,
                &sealed.key_id.0,
                &sealed.to_bytes(),
                &proof,
                true,
                &identity,
                &current,
            )
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        self.store_account_key(&account, &r)?;
        Ok(json!({ "version": version }))
    }

    /// Background account-key keying (AK1 §3.1 step 3): while this device holds the
    /// account's current `R`, every hosted private collection of the account, also
    /// one created, enabled or joined after setup, gets its account-key device
    /// enrolled and keyed by this device when it can, and this device unlocks from
    /// `R` where it is not keyed yet. Idempotent and resumable: each pass starts
    /// from the replicas' applied state; woken by enable, join, setup and unlock.
    pub(super) async fn account_key_reconcile(self: Arc<Self>) {
        let mut stop = self.shutdown.subscribe();
        let mut delay = Duration::from_secs(5);
        loop {
            tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                _ = self.account_keys.wake.notified() => {}
                _ = tokio::time::sleep(delay) => {}
            }
            let pass = tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                p = self.account_key_pass() => p,
            };
            delay = match pass {
                Ok(true) => Duration::from_secs(300),
                Ok(false) => Duration::from_secs(20),
                Err(_) => Duration::from_secs(60),
            };
        }
    }

    /// One reconciliation pass. `Ok(true)`: nothing left to do.
    async fn account_key_pass(&self) -> Result<bool, ControlError> {
        let (ctx, inc, identity) = self.account_parts()?;
        let account = inc.account.0;
        let Some(r) = self.stored_account_key(&account)? else {
            // Not set up or unlocked on this device: nothing to key with.
            return Ok(true);
        };
        let runtimes = self.private_runtimes(&account).await;
        if runtimes.is_empty() {
            return Ok(true);
        }
        let _pass = self.account_keys.pass.lock().await;
        // Only the account's CURRENT key, in password mode, is ever enrolled: never
        // a key kept while strict completes, nor a rotated one (metadata only; not
        // on the bundle-fetch budget).
        let current = self.current_account(inc);
        let record = ctx
            .cloud
            .account_key_status(&current)
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        // Reconcile EVERY observed strict, including an old marker after reopen.
        if record.mode == "strict" {
            record_strict_for_local_key(
                &*self.secrets,
                &account,
                record.key_id,
                Some(account_key::key_id(&r).0),
            )?;
            self.still(inc)?;
        }
        if !keys_in_background(&record.mode, record.key_id, &r, &*self.secrets, &account) {
            return Ok(true);
        }
        let mut settled = true;
        for (id, runtime) in runtimes {
            self.still(inc)?;
            let Some(runtime) = runtime else {
                self.account_keys.record(
                    &id,
                    "not_serving",
                    None,
                    AkDevice::Retrying("not_serving".into()),
                    false,
                );
                settled = false;
                continue;
            };
            // This device's own key first: a device that holds R but waits for a
            // key here (joined after unlocking) unlocks itself, throttled. A device
            // not waiting for a key (the creator before its initial rekey) is left
            // alone.
            let (device, error, started) = match runtime.account_key(AccountKeyOp::Unlocked).await {
                Some(Ok(true)) => ("unlocked", None, false),
                None => ("not_serving", None, false),
                Some(state) => {
                    let waiting = runtime.status().await.is_some_and(|s| {
                        s.incidents
                            .iter()
                            .any(|i| i.kind == mdbn_wire::client::IncidentKind::WaitingForKey)
                    });
                    // An unlock refused only because the replica was not ready yet
                    // is retried shortly, waiting or not.
                    let retry = waiting || matches!(state, Err(e) if not_ready(e));
                    match state {
                        _ if retry && self.account_keys.unlock_due(&id) => {
                            let (s, e) = Self::unlock_collection(&id, &runtime, &r, false).await;
                            (s, e, true)
                        }
                        Err(AccountKeyRefusal::NotReady) => {
                            ("not_ready", Some("not_ready".into()), false)
                        }
                        Err(AccountKeyRefusal::NotEnrolled) => {
                            ("waiting", Some("device_not_enrolled".into()), false)
                        }
                        Err(e) if pending_account_key(e) => {
                            ("pending_account_key", Some(refusal_code(e).into()), false)
                        }
                        Err(e) => ("refused", Some(refusal_code(e).into()), false),
                        Ok(_) if waiting => ("unlocking", None, false),
                        Ok(_) => ("opening", None, false),
                    }
                }
            };
            self.still(inc)?;
            let ak = self
                .ensure_account_key_device(&ctx, inc, &identity, &r, &id, &runtime)
                .await?;
            settled &= ak.settled() && device_settled(device);
            self.account_keys.record(&id, device, error, ak, started);
        }
        Ok(settled)
    }

    /// Whether every private collection of the account hosted here has R's
    /// account-key device revoked and rekeyed (or never enrolled) in its applied
    /// policy. A collection not serving counts as not yet.
    async fn strict_applied_locally(&self, account: &[u8; 16], r: &RecoveryKey) -> bool {
        for (id, runtime) in self.private_runtimes(account).await {
            let (Some(runtime), Some(collection)) = (runtime, crate::attest::uuid_bytes(&id))
            else {
                return false;
            };
            // The policy is applied here (this device keyed in it), so "never
            // enrolled" below is an answer, not a replica that has not caught up.
            if runtime.account_key(AccountKeyOp::Unlocked).await != Some(Ok(true)) {
                return false;
            }
            let device = r.derive(&mdbn_wire::common::B16(collection)).device;
            if runtime
                .account_key(AccountKeyOp::RevokedAndRekeyed(device))
                .await
                != Some(Ok(true))
            {
                return false;
            }
        }
        true
    }

    /// Automatically attest from every online private member replica, including
    /// collections other than the one hosted by the device that requested strict.
    pub(super) async fn strict_witness_reports(self: Arc<Self>) {
        let mut stop = self.shutdown.subscribe();
        let mut offset = 0usize;
        loop {
            tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            }
            tokio::select! {
                _ = stop.wait_for(|s| *s) => break,
                _ = self.strict_witness_tick(offset) => {}
            }
            offset = offset.wrapping_add(1);
        }
    }

    async fn strict_witness_tick(&self, offset: usize) -> Result<(), ControlError> {
        let (ctx, inc, identity) = self.account_parts()?;
        let mut runtimes = self.private_runtimes(&inc.account.0).await;
        if !runtimes.is_empty() {
            let len = runtimes.len();
            runtimes.rotate_left(offset % len);
        }
        for (collection, runtime) in runtimes {
            let Some(runtime) = runtime else { continue };
            let collection = crate::attest::uuid_bytes(&collection)
                .ok_or_else(|| ControlError::internal("collection identity"))?;
            let source = self
                .authority
                .source(mdbn_wire::common::B16(collection))
                .map_err(|_| account_changed())?;
            let current = || {
                self.current_account(inc)()?;
                source
                    .current_synced()
                    .map_err(|_| "collection_changed".to_string())
            };
            let response = match ctx
                .cloud
                .strict_witness_request(&ctx.connector_id, &collection, None, &identity, &current)
                .await
            {
                Ok(r) => r,
                Err(_) => continue,
            };
            current().map_err(|_| account_changed())?;
            let pending = response
                .get("pending")
                .and_then(Value::as_array)
                .filter(|p| p.len() <= 1024)
                .ok_or_else(|| ControlError::internal("strict targets"))?;
            // Successful reports disappear from the CP list, so a bounded tick
            // progresses even for accounts with many targets.
            let mut submitted = 0;
            for target in pending {
                let uuid = |name| {
                    target
                        .get(name)
                        .and_then(Value::as_str)
                        .and_then(crate::attest::uuid_bytes)
                        .filter(|u| *u != [0; 16])
                };
                let number = |name| {
                    target
                        .get(name)
                        .and_then(Value::as_u64)
                        .filter(|n| *n > 0 && *n < (1 << 53))
                };
                let (
                    Some(account),
                    Some(recovery),
                    Some(target_collection),
                    Some(version),
                    Some(revoked_at),
                ) = (
                    uuid("account_id"),
                    uuid("recovery_device"),
                    uuid("collection_id"),
                    number("strict_version"),
                    number("revoked_at"),
                )
                else {
                    return Err(ControlError::internal("strict target identity"));
                };
                if target_collection != collection {
                    return Err(ControlError::internal("strict target collection"));
                }
                current().map_err(|_| account_changed())?;
                let witness = runtime
                    .strict_witness(
                        mdbn_wire::common::B16(account),
                        mdbn_wire::common::B16(recovery),
                        version,
                        revoked_at,
                    )
                    .await;
                current().map_err(|_| account_changed())?;
                if let Some(witness) = witness {
                    submitted += 1;
                    // The CP accepts only this immutable applied statement. An
                    // unknown HTTP outcome is retried by querying pending targets,
                    // never by pretending it was not sent or signing new state.
                    let _ = ctx
                        .cloud
                        .strict_witness_request(
                            &ctx.connector_id,
                            &collection,
                            Some(&witness),
                            &identity,
                            &current,
                        )
                        .await;
                    current().map_err(|_| account_changed())?;
                    // One query + at most five reports per collection per minute.
                    if submitted >= 5 {
                        break;
                    }
                }
            }
        }
        Ok(())
    }

    /// `private.strict`: R is removed only after the CP aggregates every required
    /// replica-applied witness. Local hosting coverage is irrelevant to completion.
    pub(super) async fn private_strict(&self) -> Result<Value, ControlError> {
        let (ctx, inc, identity) = self.account_parts()?;
        let account = inc.account.0;
        let current = self.current_account(inc);
        let mut record = ctx
            .cloud
            .account_key_status(&current)
            .await
            .map_err(cloud_refusal)?;
        self.still(inc)?;
        let recovery = self.stored_account_key(&account)?;
        let expected_local = recovery.as_ref().map(|r| account_key::key_id(r).0);
        let mark_current = |cp_key_id| {
            self.still(inc)?;
            let result =
                record_strict_for_local_key(&*self.secrets, &account, cp_key_id, expected_local);
            self.still(inc)?;
            result
        };
        // Before /strict, including repair of an already-strict old marker.
        mark_current(record.key_id)?;
        if record.mode != "strict" {
            let (version, _) = ctx
                .cloud
                .account_key_strict(
                    &ctx.connector_id,
                    &account,
                    record.version,
                    &identity,
                    &current,
                )
                .await
                .map_err(cloud_refusal)?;
            mark_current(record.key_id)?;
            record = ctx
                .cloud
                .account_key_status(&current)
                .await
                .map_err(cloud_refusal)?;
            mark_current(record.key_id)?;
            if record.mode != "strict" || record.version != version {
                return Err(ControlError::unavailable(
                    "strict_changed",
                    "the account key changed; query status",
                ));
            }
        }
        self.still(inc)?;
        let cp_complete = record.complete == Some(true);
        // The control plane's `complete` is not enough to drop R: every
        // private collection hosted here must show, in its own applied policy,
        // R's account-key device revoked and rekeyed (or never enrolled).
        let local = match (cp_complete, recovery.as_ref()) {
            (true, Some(r)) => self.strict_applied_locally(&account, r).await,
            _ => true,
        };
        // Do not delete a replacement key using the old key's applied witness.
        mark_current(record.key_id)?;
        let complete = cp_complete && local;
        if complete {
            self.delete_account_key(&account)?;
        }
        let error = if record.complete.is_none() {
            Some("strict_witnesses_unavailable")
        } else if cp_complete && !local {
            Some("strict_not_applied_here")
        } else {
            None
        };
        Ok(json!({
            "version": record.version, "complete": complete, "account_key_kept": !complete,
            "collections": record.pending,
            "error": error,
        }))
    }
}

#[cfg(test)]
mod custody_tests {
    use super::*;
    use crate::secrets::{SecretError, SecretStore};
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    /// A store whose writes, deletes and readbacks can be made to lie or fail.
    #[derive(Default)]
    struct Flaky {
        map: Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
        drop_writes: AtomicBool,
        fail_writes: AtomicBool,
        keep_on_delete: AtomicBool,
    }

    impl SecretStore for Flaky {
        fn get(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
            Ok(self
                .map
                .lock()
                .unwrap()
                .get(name)
                .cloned()
                .map(Zeroizing::new))
        }
        fn set(&self, name: &str, value: &[u8]) -> Result<(), SecretError> {
            if self.fail_writes.load(Ordering::SeqCst) {
                return Err(SecretError::Unavailable("refused".into()));
            }
            if !self.drop_writes.load(Ordering::SeqCst) {
                self.map.lock().unwrap().insert(name.into(), value.to_vec());
            }
            Ok(())
        }
        fn delete(&self, name: &str) -> Result<(), SecretError> {
            if !self.keep_on_delete.load(Ordering::SeqCst) {
                self.map.lock().unwrap().remove(name);
            }
            Ok(())
        }
        fn backend(&self) -> &'static str {
            "keychain"
        }
    }

    /// A distinct account per test (the poison set is process-wide).
    fn account() -> [u8; 16] {
        static N: AtomicU32 = AtomicU32::new(1);
        let mut a = [0xa5; 16];
        a[..4].copy_from_slice(&N.fetch_add(1, Ordering::SeqCst).to_be_bytes());
        a
    }

    #[test]
    fn stored_key_round_trips_and_deletes_with_readback() {
        let (s, a) = (Flaky::default(), account());
        let r = RecoveryKey::from_bytes([7; 32]);
        assert!(read_r(&s, &a).unwrap().is_none());
        store_r(&s, &a, &r).unwrap();
        assert_eq!(read_r(&s, &a).unwrap().unwrap().expose(), r.expose());
        delete_r(&s, &a).unwrap();
        assert!(read_r(&s, &a).unwrap().is_none());
        assert!(!poisoned(&a));
    }

    #[test]
    fn unconfirmed_write_poisons_and_refuses_everything_after() {
        for setup in [
            |s: &Flaky| s.drop_writes.store(true, Ordering::SeqCst),
            |s: &Flaky| s.fail_writes.store(true, Ordering::SeqCst),
        ] {
            let (s, a) = (Flaky::default(), account());
            setup(&s);
            assert!(store_r(&s, &a, &RecoveryKey::from_bytes([1; 32])).is_err());
            assert!(poisoned(&a));
            // No read, overwrite or cleanup on an assumed rollback.
            s.drop_writes.store(false, Ordering::SeqCst);
            s.fail_writes.store(false, Ordering::SeqCst);
            assert!(read_r(&s, &a).is_err());
            assert!(store_r(&s, &a, &RecoveryKey::from_bytes([2; 32])).is_err());
            assert!(delete_r(&s, &a).is_err());
            assert!(s.map.lock().unwrap().get(&secret_name(&a)).is_none());
        }
    }

    #[test]
    fn malformed_stored_key_is_corrupt_not_absent() {
        let (s, a) = (Flaky::default(), account());
        s.map.lock().unwrap().insert(secret_name(&a), vec![1; 31]);
        let Err(e) = read_r(&s, &a) else {
            panic!("malformed must not read as absent")
        };
        assert_eq!(e.reason.as_deref(), Some("account_key_corrupt"));
        assert!(poisoned(&a));
    }

    /// A control plane that never completes strict mode and then reports
    /// "password" again (with the old key id, which is public) must not resume
    /// background keying of R-derived account-key devices.
    #[test]
    fn strict_requested_blocks_background_keying_whatever_the_cp_reports() {
        let (s, a) = (Flaky::default(), account());
        let r = RecoveryKey::from_bytes([9; 32]);
        let k = account_key::key_id(&r).0;
        // Before strict: the current key in password mode is keyed.
        assert!(keys_in_background("password", Some(k), &r, &s, &a));
        assert!(!keys_in_background("strict", None, &r, &s, &a));
        // Strict requested (marker persisted before the /strict call).
        store_strict(&s, &a, &k).unwrap();
        assert!(!keys_in_background("password", Some(k), &r, &s, &a));
        assert!(strict_blocks(&s, &a, &r));
        // Even locally generated fresh setup preserves every existing intent.
        let fresh = RecoveryKey::from_bytes([10; 32]);
        let fk = account_key::key_id(&fresh).0;
        assert!(!keys_in_background("password", Some(fk), &fresh, &s, &a));
        store_r(&s, &a, &fresh).unwrap();
        assert!(!keys_in_background("password", Some(fk), &fresh, &s, &a));
        assert_eq!(read_strict(&s, &a).unwrap(), Some(k));
        // Fresh setup without any strict intent still keys normally.
        let unmarked = account();
        store_r(&s, &unmarked, &fresh).unwrap();
        assert!(keys_in_background(
            "password",
            Some(fk),
            &fresh,
            &s,
            &unmarked
        ));
        // Fail closed: a malformed marker or an unreadable store blocks.
        s.map.lock().unwrap().insert(strict_name(&a), vec![1, 2, 3]);
        assert!(!keys_in_background("password", Some(fk), &fresh, &s, &a));
        struct Broken;
        impl SecretStore for Broken {
            fn get(&self, _: &str) -> Result<Option<Zeroizing<Vec<u8>>>, SecretError> {
                Err(SecretError::Unavailable("locked".into()))
            }
            fn set(&self, _: &str, _: &[u8]) -> Result<(), SecretError> {
                Err(SecretError::Unavailable("locked".into()))
            }
            fn delete(&self, _: &str) -> Result<(), SecretError> {
                Err(SecretError::Unavailable("locked".into()))
            }
            fn backend(&self) -> &'static str {
                "keychain"
            }
        }
        assert!(!keys_in_background("password", Some(k), &r, &Broken, &a));
        // The marker must be durable before strict is requested: a write that
        // does not read back refuses.
        let (s2, a2) = (Flaky::default(), account());
        s2.drop_writes.store(true, Ordering::SeqCst);
        assert!(store_strict(&s2, &a2, &k).is_err());
        assert!(store_strict(&Broken, &a2, &k).is_err());
    }

    #[test]
    fn strict_marker_binds_local_key_and_repairs_previous_marker() {
        let (s, a) = (Flaky::default(), account());
        let r = RecoveryKey::from_bytes([41; 32]);
        let k = account_key::key_id(&r).0;
        store_r(&s, &a, &r).unwrap();
        store_strict(&s, &a, &[42; 32]).unwrap();
        for cp in [None, Some(k)] {
            record_strict_for_local_key(&s, &a, cp, Some(k)).unwrap();
            assert_eq!(read_strict(&s, &a).unwrap(), Some(k));
            assert!(strict_blocks(&s, &a, &r));
        }
    }

    #[test]
    fn strict_marker_mismatch_or_changed_local_key_blocks_all_without_deleting_r() {
        for local_changed in [false, true] {
            let (s, a) = (Flaky::default(), account());
            let r = RecoveryKey::from_bytes([43; 32]);
            let k = account_key::key_id(&r).0;
            store_r(&s, &a, &r).unwrap();
            let expected = if local_changed {
                Some([44; 32])
            } else {
                Some(k)
            };
            let remote = if local_changed {
                Some(k)
            } else {
                Some([44; 32])
            };
            assert!(record_strict_for_local_key(&s, &a, remote, expected).is_err());
            assert_eq!(read_strict(&s, &a).unwrap(), Some([0xff; 32]));
            assert_eq!(read_r(&s, &a).unwrap().unwrap().expose(), r.expose());
            assert!(strict_blocks(&s, &a, &r));
            assert!(strict_blocks(&s, &a, &RecoveryKey::from_bytes([45; 32])));
        }
    }

    #[test]
    fn strict_marker_without_local_key_or_with_all_key_marker_stays_fail_closed() {
        let (s, a) = (Flaky::default(), account());
        record_strict_for_local_key(&s, &a, Some([46; 32]), None).unwrap();
        assert_eq!(read_strict(&s, &a).unwrap(), Some([0xff; 32]));
        let r = RecoveryKey::from_bytes([47; 32]);
        let k = account_key::key_id(&r).0;
        store_r(&s, &a, &r).unwrap();
        record_strict_for_local_key(&s, &a, Some(k), Some(k)).unwrap();
        assert_eq!(read_strict(&s, &a).unwrap(), Some([0xff; 32]));
        assert!(strict_blocks(&s, &a, &r));
    }

    #[test]
    fn uncertain_strict_marker_write_fences_even_a_cached_local_key() {
        for drop_write in [false, true] {
            let (s, a) = (Flaky::default(), account());
            let r = RecoveryKey::from_bytes([48; 32]);
            let k = account_key::key_id(&r).0;
            store_r(&s, &a, &r).unwrap();
            if drop_write {
                s.drop_writes.store(true, Ordering::SeqCst);
            } else {
                s.fail_writes.store(true, Ordering::SeqCst);
            }
            assert!(record_strict_for_local_key(&s, &a, Some(k), Some(k)).is_err());
            assert!(poisoned(&a));
            assert!(strict_blocks(&s, &a, &r));
            assert!(read_r(&s, &a).is_err());
        }
    }

    #[test]
    fn reopened_strict_reconciles_old_marker_before_any_background_keying() {
        let (s, a) = (Flaky::default(), account());
        let r = RecoveryKey::from_bytes([49; 32]);
        let k = account_key::key_id(&r).0;
        store_r(&s, &a, &r).unwrap();
        store_strict(&s, &a, &[50; 32]).unwrap();
        s.drop_writes.store(true, Ordering::SeqCst);
        assert!(record_strict_for_local_key(&s, &a, Some(k), Some(k)).is_err());
        assert!(poisoned(&a));
        // Model loss of this account's process-local poison on reopening the same
        // durable store, without deleting/changing its key or old marker.
        POISONED.lock().unwrap().remove(&a);
        s.drop_writes.store(false, Ordering::SeqCst);
        assert!(strict_blocks(&s, &a, &r), "old marker remains fail-closed");
        record_strict_for_local_key(&s, &a, Some(k), Some(k)).unwrap();
        assert_eq!(read_strict(&s, &a).unwrap(), Some(k));
        assert!(!keys_in_background("password", Some(k), &r, &s, &a));
        assert_eq!(read_r(&s, &a).unwrap().unwrap().expose(), r.expose());
    }

    #[tokio::test]
    async fn live_keying_fence_rechecks_marker_poison_and_local_identity_after_await() {
        let (s, a) = (Flaky::default(), account());
        let r = RecoveryKey::from_bytes([51; 32]);
        let k = account_key::key_id(&r).0;
        store_r(&s, &a, &r).unwrap();
        assert!(account_keying_current(&s, &a, k));
        tokio::task::yield_now().await;
        store_strict(&s, &a, &k).unwrap();
        assert!(!account_keying_current(&s, &a, k));
        assert_eq!(read_strict(&s, &a).unwrap(), Some(k));
        let unmarked = account();
        store_r(&s, &unmarked, &r).unwrap();
        assert!(account_keying_current(&s, &unmarked, k));
        let replacement = RecoveryKey::from_bytes([52; 32]);
        store_r(&s, &unmarked, &replacement).unwrap();
        assert!(!account_keying_current(&s, &unmarked, k));
        let fresh = account_key::key_id(&replacement).0;
        assert!(account_keying_current(&s, &unmarked, fresh));
        poison(&unmarked);
        assert!(!account_keying_current(&s, &unmarked, fresh));
    }

    #[tokio::test]
    async fn fresh_setup_preserves_old_and_new_intents_for_its_current_key() {
        let (s, a) = (Flaky::default(), account());
        let fresh = RecoveryKey::from_bytes([53; 32]);
        let k = account_key::key_id(&fresh).0;
        store_strict(&s, &a, &[0xff; 32]).unwrap();
        store_r(&s, &a, &fresh).unwrap();
        assert!(!account_keying_current(&s, &a, k));
        assert_eq!(read_strict(&s, &a).unwrap(), Some([0xff; 32]));
        // Model a strict writer publishing NEW intent for setup's exact held R
        // during cloud completion. Setup's subsequent keying cannot delete it.
        tokio::task::yield_now().await;
        store_strict(&s, &a, &k).unwrap();
        assert!(!account_keying_current(&s, &a, k));
        assert!(!keys_in_background("password", Some(k), &fresh, &s, &a));
        assert_eq!(read_strict(&s, &a).unwrap(), Some(k));
        assert_eq!(read_r(&s, &a).unwrap().unwrap().expose(), fresh.expose());
        assert!(strict_blocks(&s, &a, &fresh));
    }

    #[tokio::test]
    async fn unlock_holds_old_and_new_intent_instead_of_clearing_a_stale_prompt() {
        let (s, a) = (Flaky::default(), account());
        let r = RecoveryKey::from_bytes([54; 32]);
        let k = account_key::key_id(&r).0;
        store_r(&s, &a, &r).unwrap();
        assert!(!unlock_keeps_strict("password", &s, &a, &r));
        store_strict(&s, &a, &k).unwrap();
        assert!(unlock_keeps_strict("password", &s, &a, &r));
        // Even an affirmative stale prompt would have no marker-clear path.
        tokio::task::yield_now().await;
        let replacement = RecoveryKey::from_bytes([55; 32]);
        let fresh = account_key::key_id(&replacement).0;
        store_r(&s, &a, &replacement).unwrap();
        store_strict(&s, &a, &fresh).unwrap();
        assert!(unlock_keeps_strict("password", &s, &a, &r));
        assert!(unlock_keeps_strict("password", &s, &a, &replacement));
        assert!(!account_keying_current(&s, &a, k));
        assert!(!account_keying_current(&s, &a, fresh));
        assert_eq!(read_strict(&s, &a).unwrap(), Some(fresh));
        assert_eq!(
            read_r(&s, &a).unwrap().unwrap().expose(),
            replacement.expose()
        );
    }

    #[test]
    fn delete_that_leaves_the_key_poisons() {
        let (s, a) = (Flaky::default(), account());
        store_r(&s, &a, &RecoveryKey::from_bytes([3; 32])).unwrap();
        s.keep_on_delete.store(true, Ordering::SeqCst);
        assert!(delete_r(&s, &a).is_err());
        assert!(poisoned(&a));
    }

    /// A cancelled caller does not release the KDF slot: the next KDF starts only
    /// after the abandoned one finished, so at most one runs at a time.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cancelled_kdf_keeps_the_slot_until_it_finishes() {
        let running = Arc::new(AtomicU32::new(0));
        let peak = Arc::new(AtomicU32::new(0));
        let work = |running: Arc<AtomicU32>, peak: Arc<AtomicU32>| {
            move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(300));
                running.fetch_sub(1, Ordering::SeqCst);
            }
        };
        let first = blocking(work(running.clone(), peak.clone()));
        // Cancel the first caller while its KDF runs.
        assert!(
            tokio::time::timeout(Duration::from_millis(50), first)
                .await
                .is_err()
        );
        blocking(work(running.clone(), peak.clone())).await.unwrap();
        assert_eq!(peak.load(Ordering::SeqCst), 1);
    }
}

#[cfg(test)]
mod autokey_tests {
    use super::*;
    use crate::cloud::CloudError;

    /// Every refusal has a stable typed code; only "not keyed yet" ones are
    /// `pending_account_key` never reports `unknown` or `failed`.
    #[test]
    fn refusals_are_typed_and_only_missing_keys_are_pending() {
        use AccountKeyRefusal::*;
        let all = [
            NotPrivate,
            NotReady,
            NotEnrolled,
            NotAuthorized,
            DeviceMissing,
            EnrolmentMismatch,
            NotKeyed,
            NoWrap,
            Inconsistent,
            Failed,
            OutcomeUnknown,
        ];
        let codes: BTreeSet<_> = all.iter().map(|e| refusal_code(*e)).collect();
        assert_eq!(codes.len(), all.len(), "codes are distinct");
        assert!(
            codes
                .iter()
                .all(|c| c.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
        );
        assert_eq!(refusal_code(DeviceMissing), "account_key_not_enrolled");
        let pending: Vec<_> = all
            .into_iter()
            .filter(|e| pending_account_key(*e))
            .collect();
        assert_eq!(pending, vec![DeviceMissing, NotKeyed, NoWrap]);
        let ready: Vec<_> = all.into_iter().filter(|e| not_ready(*e)).collect();
        assert_eq!(ready, vec![NotReady, NotEnrolled]);
        assert_eq!(refusal_code(NotReady), "not_ready");
    }

    /// An unlock ~130 ms after join was refused `not_private`
    /// because B had not applied the policy yet, and was treated as settled (keyed
    /// 5 min 22 s later). A not-ready replica is now waited for (bounded) and keyed
    /// within seconds; a genuine `not_private` is still one settled refusal.
    #[tokio::test(start_paused = true)]
    async fn unlock_right_after_join_waits_for_the_policy_not_minutes() {
        let start = tokio::time::Instant::now();
        let mut attempts = 0;
        let out = until_ready(|| {
            attempts += 1;
            let n = attempts;
            async move {
                // The policy applies after ~1.2 s.
                if n <= 3 {
                    Err(AccountKeyRefusal::NotReady)
                } else {
                    Ok(("unlocked", None))
                }
            }
        })
        .await;
        assert_eq!(unlock_outcome(out, false), ("unlocked", None));
        assert!(
            start.elapsed() < Duration::from_secs(3),
            "{:?}",
            start.elapsed()
        );

        // B's enrolment not applied yet is not-ready too.
        let mut n = 0;
        let out = until_ready(|| {
            n += 1;
            let k = n;
            async move {
                if k == 1 {
                    Err(AccountKeyRefusal::NotEnrolled)
                } else {
                    Ok(("unlocked", None::<String>))
                }
            }
        })
        .await;
        assert_eq!(out, Ok(("unlocked", None)));

        // Never ready within the bound: typed `not_ready`, not settled, retried
        // shortly by the background pass.
        let start = tokio::time::Instant::now();
        let out = until_ready(|| async {
            Err::<(&'static str, Option<String>), _>(AccountKeyRefusal::NotReady)
        })
        .await;
        assert!(start.elapsed() >= READY_WAIT && start.elapsed() <= READY_WAIT + READY_POLL);
        let (state, error) = unlock_outcome(out, false);
        assert_eq!((state, error.as_deref()), ("not_ready", Some("not_ready")));
        assert!(!device_settled(state));
        assert_eq!(unlock_retry(state), NOT_READY_RETRY);
        assert!(NOT_READY_RETRY <= Duration::from_secs(20));

        // A genuine cloud-copy collection: refused at once, typed and settled.
        let start = tokio::time::Instant::now();
        let mut calls = 0;
        let out = until_ready(|| {
            calls += 1;
            async { Err::<(&'static str, Option<String>), _>(AccountKeyRefusal::NotPrivate) }
        })
        .await;
        assert_eq!(calls, 1);
        assert_eq!(start.elapsed(), Duration::ZERO);
        let (state, error) = unlock_outcome(out, false);
        assert_eq!((state, error.as_deref()), ("refused", Some("not_private")));
        assert!(device_settled(state));
        assert_eq!(unlock_retry(state), UNLOCK_RETRY);
    }

    #[test]
    fn enrolment_refusals_keep_only_a_safe_code() {
        assert_eq!(
            enrol_refusal(&CloudError::Server(503, "not_ready".into())),
            AkDevice::Retrying("not_ready".into())
        );
        assert_eq!(
            enrol_refusal(&CloudError::Network("dns".into())),
            AkDevice::Retrying("sync_unreachable".into())
        );
        assert_eq!(
            enrol_refusal(&CloudError::Server(409, "strict_mode".into())),
            AkDevice::Refused("strict_mode".into())
        );
        assert_eq!(
            enrol_refusal(&CloudError::Server(400, "Bad <html> body".into())),
            AkDevice::Refused("enrolment_refused".into())
        );
        assert_eq!(
            enrol_refusal(&CloudError::Unauthenticated),
            AkDevice::Refused("not_signed_in".into())
        );
    }

    /// Status shows each hosted private collection; a background unlock is
    /// throttled per collection; keyed, pending and refused collections do not keep
    /// the background on its fast cadence.
    #[test]
    fn reconcile_bookkeeping_reports_and_throttles() {
        let k = AccountKeys::default();
        let ids = vec!["c1".to_string(), "c2".to_string()];
        assert_eq!(k.report(&ids)[0]["account_key"], "unchecked");
        assert!(k.unlock_due("c1"));
        k.record(
            "c1",
            "pending_account_key",
            Some("account_key_not_enrolled".into()),
            AkDevice::Waiting,
            true,
        );
        assert!(!k.unlock_due("c1"), "re-unlock throttled");
        assert!(k.unlock_due("c2"));
        // A later record without a new unlock keeps the throttle.
        k.record(
            "c1",
            "pending_account_key",
            None,
            AkDevice::PendingAccountKey,
            false,
        );
        assert!(!k.unlock_due("c1"));
        // A not-ready collection is re-unlocked shortly, not on the slow throttle.
        k.record(
            "c3",
            "not_ready",
            Some("not_ready".into()),
            AkDevice::Retrying("not_ready".into()),
            true,
        );
        assert!(!k.unlock_due("c3"));
        if let Ok(mut e) = k.entries.lock() {
            let c3 = e.get_mut("c3").unwrap();
            c3.last_unlock = Instant::now().checked_sub(NOT_READY_RETRY);
        }
        assert!(
            k.unlock_due("c3"),
            "not-ready retried after {NOT_READY_RETRY:?}"
        );
        k.record("c2", "unlocked", None, AkDevice::Keyed, false);
        let report = k.report(&ids);
        assert_eq!(report[0]["state"], "pending_account_key");
        assert_eq!(report[0]["account_key"], "pending_account_key");
        assert_eq!(report[1]["state"], "unlocked");
        assert_eq!(report[1]["account_key"], "keyed");
        assert!(report[1].get("error").is_none());
        assert!(AkDevice::Keyed.settled());
        assert!(AkDevice::PendingAccountKey.settled());
        assert!(AkDevice::Refused("strict_mode".into()).settled());
        assert!(!AkDevice::Waiting.settled());
        assert!(!AkDevice::Retrying("not_ready".into()).settled());
        let v = entry_json("c3", "refused", Some("x"), &AkDevice::Retrying("y".into()));
        assert_eq!(
            (v["error"].as_str(), v["account_key_error"].as_str()),
            (Some("x"), Some("y"))
        );
    }
}

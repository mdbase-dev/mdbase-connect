//! First-party app composition: TentativeStore, production sealer, authenticated
//! original-call log scopes, and read-only startup observations. Bootstrap is a
//! trusted HOST operation, never an app/grant RPC or an authentication shortcut.

mod account_key;
pub mod bases;
#[cfg(test)]
mod cp_tests;
pub mod device;
mod http;
#[cfg(test)]
mod http_capture_tests;
#[cfg(test)]
mod http_tests;
mod noise_custody;
#[cfg(test)]
mod noise_custody_tests;
mod private_proof;
#[cfg(test)]
mod private_proof_tests;

use crate::{
    app_index::{AppIndex, AppSqlHost},
    runtime::{OpenFailure, RUNTIME_VERSION, Runtime, wipe},
};
use mdbn_replica::log::{CallId, EndpointId, LogCall, LogError};
use mdbn_replica::policy::{PolicyKeyPin, PolicyPins, RootPin};
use mdbn_replica::replica::{AuthenticatedLogSession, LogReplyScope};
use mdbn_replica::{DeviceSecrets, Host, QueryExecutionProfile, ReplicaConfig};
use mdbn_store_file::index::OpenState;
use mdbn_store_file::{TentativeStore, sql::SqlStoreLimits};
use mdbn_wire::{
    cbor::{self, Cbor},
    common::{B16, B32, Uuid},
    policy::CState,
    schema::Wire,
};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

/// Device-key bootstrap envelope cap, independent of database/log budgets.
pub const MAX_BOOTSTRAP: usize = 64 * 1024;
/// A bounded exported log turn; overflow retires the original scopes as unknown.
pub const MAX_CALLS: usize = 64;
/// Aggregate encoded sealed frame/sidecar budget for one exported turn.
pub const MAX_CALL_BYTES: usize = 64 * 1024 * 1024;
/// No keyring ever persists through this store.
pub type AppStore = TentativeStore<AppIndex>;

/// Complete trusted initialization, decoded only after protected key unwrap.
pub struct Bootstrap {
    /// Verification, selected state, genesis and root/signer pins are explicit.
    pub cfg: ReplicaConfig,
    /// Temporary device keys; never serialized to the SQL store.
    pub secrets: DeviceSecrets,
    /// Actual index-open facts from the host.
    pub opened: OpenState,
    /// Actual SQLite version, zero means unavailable rather than a fabricated one.
    pub sqlite_version: u32,
}
impl std::fmt::Debug for Bootstrap {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppBootstrap(..)")
    }
}
fn invalid() -> OpenFailure {
    OpenFailure("invalid trusted app bootstrap".into())
}
// Fixed bootstrap grammar only, not a general CBOR or crypto decoder. Borrow
// the envelope instead of allocating secret bstr copies that a partial generic
// decode could drop without wiping. Canonical uint/lengths and key order required.
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}
impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], OpenFailure> {
        let end = self.pos.checked_add(n).ok_or_else(invalid)?;
        let slice = self.bytes.get(self.pos..end).ok_or_else(invalid)?;
        self.pos = end;
        Ok(slice)
    }
    fn arg(&mut self, major: u8) -> Result<u64, OpenFailure> {
        let head = self.take(1)?[0];
        if head >> 5 != major {
            return Err(invalid());
        }
        let ai = head & 31;
        let (n, min) = match ai {
            0..=23 => return Ok(u64::from(ai)),
            24 => (1, 24),
            25 => (2, 256),
            26 => (4, 65_536),
            27 => (8, 4_294_967_296),
            _ => return Err(invalid()),
        };
        let value = self
            .take(n)?
            .iter()
            .fold(0u64, |v, b| (v << 8) | u64::from(*b));
        if value < min {
            return Err(invalid());
        }
        Ok(value)
    }
    fn field(&mut self, k: u64) -> Result<(), OpenFailure> {
        if self.arg(0)? != k {
            return Err(invalid());
        }
        Ok(())
    }
    fn fixed<const N: usize>(&mut self) -> Result<[u8; N], OpenFailure> {
        if self.arg(2)? != N as u64 {
            return Err(invalid());
        }
        self.take(N)?.try_into().map_err(|_| invalid())
    }
    fn array(&mut self, min: usize, max: usize) -> Result<usize, OpenFailure> {
        let n = usize::try_from(self.arg(4)?).map_err(|_| invalid())?;
        if n < min || n > max {
            return Err(invalid());
        }
        Ok(n)
    }
    fn null(&mut self) -> Result<(), OpenFailure> {
        if self.take(1)?[0] != 0xf6 {
            return Err(invalid());
        }
        Ok(())
    }
    fn blob(&mut self, max: usize) -> Result<&'a [u8], OpenFailure> {
        let n = usize::try_from(self.arg(2)?).map_err(|_| invalid())?;
        if n > max {
            return Err(invalid());
        }
        self.take(n)
    }
    fn boolean(&mut self) -> Result<bool, OpenFailure> {
        match self.take(1)?[0] {
            0xf4 => Ok(false),
            0xf5 => Ok(true),
            _ => Err(invalid()),
        }
    }
}
impl Bootstrap {
    /// Consumes/wipes every ordinary path, including malformed/missing pins.
    /// Slots are documented in the app-runtime ABI interface note.
    pub fn decode_consuming(bytes: &mut [u8]) -> Result<Self, OpenFailure> {
        let result = if bytes.len() > MAX_BOOTSTRAP {
            Err(invalid())
        } else {
            Self::parse(bytes)
        };
        wipe(bytes);
        result
    }
    fn parse(bytes: &[u8]) -> Result<Self, OpenFailure> {
        Self::parse_with_owner(bytes, None)
    }
    fn parse_with_owner(
        bytes: &[u8],
        owner: Option<(DeviceSecrets, Uuid, Uuid, Uuid)>,
    ) -> Result<Self, OpenFailure> {
        let adopting = owner.is_some();
        let (mut secrets, connector, installation, expected_device) = owner.unwrap_or((
            DeviceSecrets {
                sign_sk: [0; 32],
                kem_sk: [0; 32],
            },
            B16([0; 16]),
            B16([0; 16]),
            B16([0; 16]),
        ));
        let mut r = Reader { bytes, pos: 0 };
        if r.arg(5)? != if adopting { 17 } else { 15 } {
            return Err(invalid());
        }
        r.field(0)?;
        if r.arg(0)? != if adopting { 4 } else { 3 } {
            return Err(invalid());
        }
        r.field(1)?;
        let collection = B16(r.fixed()?);
        r.field(2)?;
        let replica_id = B16(r.fixed()?);
        r.field(3)?;
        let device_id = B16(r.fixed()?);
        r.field(4)?;
        let endpoint = r.arg(0)?;
        r.field(5)?;
        let n = r.array(1, 64)?;
        let roots = (0..n).map(|_| r.fixed()).collect::<Result<Vec<_>, _>>()?;
        r.field(6)?;
        let n = r.array(0, 1_024)?;
        let signers = (0..n)
            .map(|_| r.fixed().map(B16))
            .collect::<Result<Vec<_>, _>>()?;
        r.field(7)?;
        let genesis = B32(r.fixed()?);
        r.field(8)?;
        let state = CState::from_cbor(&Cbor::Uint(r.arg(0)?)).map_err(|_| invalid())?;
        r.field(9)?;
        let opted_in = r.boolean()?;
        if (state == CState::E2e && opted_in) || (state == CState::CloudCopy && !opted_in) {
            return Err(invalid());
        }
        // Both modes guard secrets on partial decode. Adoption is metadata-only:
        // NO seed/key override can replace the protected device-phase owners.
        r.field(10)?;
        if adopting {
            r.null()?;
        } else {
            secrets.sign_sk = r.fixed()?;
        }
        r.field(11)?;
        if adopting {
            r.null()?;
        } else {
            secrets.kem_sk = r.fixed()?;
        }
        r.field(12)?;
        let opened = match r.arg(0)? {
            0 => OpenState::Fresh,
            1 => OpenState::Existing,
            2 => OpenState::Unclean,
            _ => return Err(invalid()),
        };
        r.field(13)?;
        let sqlite_version = u32::try_from(r.arg(0)?).map_err(|_| invalid())?;
        if adopting {
            r.field(14)?;
            if B16(r.fixed()?) != connector {
                return Err(invalid());
            }
            r.field(15)?;
            if B16(r.fixed()?) != installation
                || device_id != expected_device
                || [collection, replica_id, device_id]
                    .iter()
                    .any(|id| id.0 == [0; 16])
                || genesis.0 == [0; 32]
                || roots.contains(&[0; 32])
            {
                return Err(invalid());
            }
        }
        r.field(16)?;
        let policy_pins = decode_policy_pins(r.blob(MAX_BOOTSTRAP)?)?;
        // The same build-verified environment roots feed both trust surfaces.
        // No additional host/UI/log root can widen certificate authority.
        if roots.len() != policy_pins.roots.len()
            || policy_pins
                .roots
                .iter()
                .any(|r| !roots.contains(&r.root_pk.0))
            || r.pos != bytes.len()
        {
            return Err(invalid());
        }
        Ok(Self {
            cfg: ReplicaConfig {
                collection,
                replica_id,
                device_id,
                mode: mdbn_wire::client::SyncMode::Synced,
                log_endpoint: EndpointId(endpoint),
                verify: true,
                runtime_version: RUNTIME_VERSION.into(),
                trusted_roots: roots,
                trusted_signers: signers,
                e2e: state == CState::E2e,
                chosen_state: Some(state),
                user_enabled_cloud_copy: opted_in,
                key_grants_only: false,
                expected_genesis: Some(genesis),
                policy_pins: Some(policy_pins),
            },
            secrets,
            opened,
            sqlite_version,
        })
    }
}

/// Canonical public pins produced by the SHARED environment trust-asset verifier
/// at build time, not the signed asset parser itself. Reuse native PolicyPins
/// validation; never learn authority from CP replies, the log or UI metadata.
fn decode_policy_pins(bytes: &[u8]) -> Result<PolicyPins, OpenFailure> {
    let mut r = Reader { bytes, pos: 0 };
    r.array(2, 2)?;
    let n = r.array(1, 64)?;
    let mut roots = Vec::with_capacity(n);
    for _ in 0..n {
        r.array(2, 2)?;
        roots.push(RootPin {
            root_id: B16(r.fixed()?),
            root_pk: B32(r.fixed()?),
        });
    }
    let n = r.array(1, 1_024)?;
    let mut policy_keys = Vec::with_capacity(n);
    for _ in 0..n {
        r.array(3, 3)?;
        policy_keys.push(PolicyKeyPin {
            key_id: B16(r.fixed()?),
            policy_pk: B32(r.fixed()?),
            root_id: B16(r.fixed()?),
        });
    }
    if r.pos != bytes.len() {
        return Err(invalid());
    }
    let pins = PolicyPins { roots, policy_keys };
    pins.validate().map_err(|_| invalid())?;
    Ok(pins)
}

/// One immutable database/collection instance, never a second writer or RAM fallback.
pub struct AppRuntime {
    runtime: Option<Runtime<AppStore>>,
    http: http::HttpSigner,
    noise: Option<noise_custody::NoiseCustody>,
    private: Option<private_proof::PrivateProofScope>,
    retired_healthy: bool,
    index: Rc<RefCell<AppIndex>>,
    session: Option<AuthenticatedLogSession>,
    scopes: BTreeMap<CallId, LogReplyScope>,
    http_subscribes: std::collections::BTreeSet<CallId>,
    collection: Uuid,
    endpoint: EndpointId,
}
impl std::fmt::Debug for AppRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("AppRuntime(..)")
    }
}
impl AppRuntime {
    /// No network admission here. Caller supplies authenticated bootstrap pins and
    /// actual protected keys; the replica still verifies control/genesis/membership.
    pub fn open_consuming(
        bytes: &mut [u8],
        sql: Box<dyn AppSqlHost>,
        host: Host,
    ) -> Result<Self, OpenFailure> {
        let b = Bootstrap::decode_consuming(bytes)?;
        let http = http::HttpSigner::new(
            &b.secrets.sign_sk,
            b.cfg.collection,
            b.cfg.log_endpoint,
            b.cfg.device_id,
        );
        Self::compose_bootstrap(b, sql, host, http, None, None)
    }
    fn compose_bootstrap(
        b: Bootstrap,
        sql: Box<dyn AppSqlHost>,
        host: Host,
        http: http::HttpSigner,
        noise: Option<noise_custody::NoiseCustody>,
        private: Option<private_proof::PrivateProofScope>,
    ) -> Result<Self, OpenFailure> {
        let index = Rc::new(RefCell::new(AppIndex::new(sql, b.opened, b.sqlite_version)));
        let store = TentativeStore::open(index.clone(), SqlStoreLimits::MOBILE)
            .map_err(|_| OpenFailure("app store open failed; reopen and reconcile".into()))?;
        let collection = b.cfg.collection;
        let endpoint = b.cfg.log_endpoint;
        let runtime = Runtime::compose(
            b.cfg,
            store,
            host,
            b.secrets,
            QueryExecutionProfile::MemoryConstrained,
        )?;
        Ok(Self {
            runtime: Some(runtime),
            http,
            noise,
            private,
            retired_healthy: false,
            index,
            session: None,
            scopes: BTreeMap::new(),
            http_subscribes: std::collections::BTreeSet::new(),
            collection,
            endpoint,
        })
    }
    /// HOST ONLY, after actual endpoint authentication plus the post-await scope check.
    /// One binding only. Retirement destroys ALL replica/device key owners and
    /// requires a fresh module + protected unwrap, never a silent rebind.
    pub fn bind_log(&mut self, endpoint: EndpointId, collection: Uuid) -> bool {
        if endpoint != self.endpoint || collection != self.collection || self.session.is_some() {
            return false;
        }
        let Some(runtime) = self.runtime.as_mut() else {
            return false;
        };
        match runtime
            .replica_mut()
            .bind_authenticated_log(endpoint, collection)
        {
            Ok(s) if self.http.bind() => {
                self.session = Some(s);
                true
            }
            _ => false,
        }
    }
    /// HOST ONLY SAME authenticated transport after drain/abort on foreground or
    /// CP notification wake. Production bind retires original session calls as
    /// UNKNOWN before replacement, preserves same-byte recovery/keys, resubscribes
    /// via native HTTP head admission. No remote push or fresh identity fallback.
    pub fn reconnect_log(&mut self, endpoint: EndpointId, collection: Uuid) -> bool {
        if endpoint != self.endpoint
            || collection != self.collection
            || self.session.is_none()
            || !self.healthy()
        {
            return false;
        }
        let Some(runtime) = self.runtime.as_mut() else {
            return false;
        };
        match runtime
            .replica_mut()
            .bind_authenticated_log(endpoint, collection)
        {
            Ok(session) if self.http.reconnect() => {
                self.scopes.clear();
                self.http_subscribes.clear();
                self.session = Some(session);
                true
            }
            _ => {
                self.retire_log();
                false
            }
        }
    }
    /// Late replies cannot feed a successor. Classify original outcomes unknown,
    /// then drop both the HTTP signer and the replica's signing/KEM key owners.
    pub fn retire_log(&mut self) {
        self.http.retire();
        self.private = None;
        if let Some(mut noise) = self.noise.take() {
            noise.retire();
        }
        self.scopes.clear();
        self.http_subscribes.clear();
        if let Some(mut runtime) = self.runtime.take() {
            if let Some(s) = self.session.take() {
                runtime.replica_mut().retire_authenticated_log(&s);
            }
            let (_, _, failed, _, reopen) = runtime.host_observations();
            self.retired_healthy = !failed && !reopen && !self.index.borrow().fenced();
            // Runtime/production sealer/DeviceSecrets zeroize on drop.
        }
    }
    /// Read-only authenticated-session handover consumer. Exact witness bytes;
    /// public signer comes ONLY from the Replica's verified signed policy.
    pub fn verify_handover_consuming(
        &mut self,
        session: u64,
        device: &mut [u8],
        bytes: &mut [u8],
    ) -> Vec<u8> {
        let head = if bytes.len() <= 64 * 1024 && self.healthy() {
            <[u8; 16]>::try_from(&*device).ok().and_then(|source| {
                self.runtime
                    .as_mut()?
                    .replica_mut()
                    .verify_handover_witness(
                        mdbn_replica::SessionId(session),
                        mdbn_wire::common::B16(source),
                        bytes,
                    )
                    .ok()
                    .flatten()
            })
        } else {
            None
        };
        wipe(device);
        wipe(bytes);
        head.and_then(|h| h.to_bytes().ok()).unwrap_or_default()
    }
    /// Authenticated HOST ONLY one-time bootstrap pin, before log binding.
    /// Never exposed through grant/client frames. All other identity pins come
    /// from protected registered-device bootstrap, not the signing caller.
    pub fn bind_cp_connector(&mut self, connector: Uuid) -> bool {
        self.runtime.is_some()
            && self.session.is_none()
            && self.healthy()
            && self.http.bind_connector(connector)
    }
    /// Fixed CP log-token proof purpose only; challenge consumed/wiped. Not an
    /// enrolment, AK1, arbitrary route, generic digest or device signing API.
    pub fn sign_cp_log_token_consuming(&self, bytes: &mut [u8]) -> Vec<u8> {
        let signature = if self.runtime.is_some() && self.healthy() {
            self.http
                .sign_cp_log_token(bytes)
                .map(|s| s.to_vec())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        wipe(bytes);
        signature
    }
    /// Opaque process-local log lifetime; not server authentication/readiness.
    pub fn log_generation(&self) -> u64 {
        self.http.generation()
    }
    /// HOST ONLY. Strict borrowed {0: original/commit frame,1: token,2: nonce32}.
    /// Returns only a signature, or empty refusal; consumes/wipes ordinary paths.
    pub fn sign_http_consuming(
        &self,
        endpoint: EndpointId,
        generation: u64,
        original: CallId,
        bytes: &mut [u8],
    ) -> Vec<u8> {
        let signature = if self.session.is_some() && self.healthy() {
            self.http
                .sign(endpoint, generation, original, bytes)
                .map(|s| s.to_vec())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        wipe(bytes);
        signature
    }
    fn calls(&mut self) -> Vec<LogCall> {
        let Some(s) = self.session.clone() else {
            return Vec::new();
        };
        let Some(runtime) = self.runtime.as_mut() else {
            return Vec::new();
        };
        match runtime.replica_mut().take_authenticated_log_calls(&s) {
            Ok(calls) => calls
                .into_iter()
                .map(|(call, scope)| {
                    self.scopes.insert(call.id, scope);
                    call
                })
                .collect(),
            Err(_) => {
                self.retire_log();
                Vec::new()
            }
        }
    }
    /// Canonical sealed host calls; IDs/methods are never supplied by app code.
    pub fn log_calls_encoded(&mut self) -> Vec<u8> {
        let calls = self.calls();
        if calls.len() > MAX_CALLS {
            self.retire_log();
            return Vec::new();
        }
        let mut records = Vec::new();
        let mut total = 16usize;
        for call in calls {
            // Original scope remains in Replica/scopes. Native captures/signs
            // ONLY the actual adapted head frame; JS cannot relabel requests.
            let (call, as_subscribe) = mdbn_replica::log_codec::http_unary_call(call);
            let id = call.id;
            if as_subscribe {
                self.http_subscribes.insert(id);
            }
            match mdbn_replica::log_codec::host_call(call) {
                Ok(record) => {
                    let Cbor::Map(fields) = &record else {
                        self.retire_log();
                        return Vec::new();
                    };
                    let size = fields.iter().try_fold(64usize, |size, (_, value)| {
                        if let Cbor::Bytes(bytes) = value {
                            size.checked_add(bytes.len())
                        } else {
                            Some(size)
                        }
                    });
                    let Some(next) = size.and_then(|size| total.checked_add(size)) else {
                        self.retire_log();
                        return Vec::new();
                    };
                    if next > MAX_CALL_BYTES {
                        self.retire_log();
                        return Vec::new();
                    }
                    let frame = fields.iter().find_map(|(key, value)| match (key, value) {
                        (Cbor::Uint(1), Cbor::Bytes(frame)) => Some(frame),
                        _ => None,
                    });
                    if !frame.is_some_and(|frame| self.http.capture(id, frame)) {
                        self.retire_log();
                        return Vec::new();
                    }
                    total = next;
                    records.push(record);
                }
                Err(_) => {
                    self.no_response(id);
                }
            }
        }
        match cbor::encode(&Cbor::Array(records)) {
            Ok(bytes) if bytes.len() <= MAX_CALL_BYTES => bytes,
            _ => {
                self.retire_log();
                Vec::new()
            }
        }
    }
    /// The original scope is checked BEFORE the decoder is called. Invalid results
    /// are NoResponse, never acknowledgement or a definitive rejection.
    pub fn log_reply(&mut self, id: CallId, bytes: &[u8]) -> bool {
        let Some(scope) = self.scopes.remove(&id) else {
            return false;
        };
        self.http.forget(id);
        let as_subscribe = self.http_subscribes.remove(&id);
        let Some(runtime) = self.runtime.as_mut() else {
            return false;
        };
        let mut valid = true;
        let result = runtime
            .replica_mut()
            .on_authenticated_log_reply(scope, |original, method| {
                mdbn_replica::log_codec::http_unary_reply(original, method, as_subscribe, bytes)
                    .unwrap_or_else(|_| {
                        valid = false;
                        Err(LogError::NoResponse)
                    })
            });
        valid && result.is_ok()
    }
    /// Missing response is an unknown outcome for precisely the original call.
    pub fn no_response(&mut self, id: CallId) {
        self.http.forget(id);
        self.http_subscribes.remove(&id);
        if let (Some(scope), Some(runtime)) = (self.scopes.remove(&id), self.runtime.as_mut()) {
            let _ = runtime
                .replica_mut()
                .on_authenticated_log_reply(scope, |_, _| Err(LogError::NoResponse));
        }
    }
    /// Bound service pushes only; lifecycle transitions are bind/retire, not wire events.
    pub fn log_push(&mut self, bytes: &[u8]) -> bool {
        let Some(session) = self.session.clone() else {
            return false;
        };
        let Some(runtime) = self.runtime.as_mut() else {
            return false;
        };
        runtime
            .replica_mut()
            .on_authenticated_log_push(&session, |collection| {
                mdbn_replica::log_codec::push(collection, bytes).map_err(|_| LogError::NoResponse)
            })
            .is_ok()
    }
    /// The result is safe to use only to decide clean-close eligibility, never saved.
    pub fn healthy(&self) -> bool {
        let healthy = self.runtime.as_ref().map_or(self.retired_healthy, |r| {
            let (_, _, failed, _, reopen) = r.host_observations();
            !failed && !reopen
        });
        healthy && !self.index.borrow().fenced()
    }
    /// Explicit typed observations, not a caller-writable readiness boolean.
    pub fn observations(&self) -> Vec<u8> {
        let Some(runtime) = self.runtime.as_ref() else {
            return Vec::new();
        };
        let (sync, rebuilding, failed, staging, reopen) = runtime.host_observations();
        cbor::encode(&Cbor::Map(vec![
            (Cbor::Uint(0), sync.to_cbor()),
            (Cbor::Uint(1), Cbor::Bool(rebuilding)),
            (Cbor::Uint(2), Cbor::Bool(failed)),
            (Cbor::Uint(3), Cbor::Bool(staging)),
            (Cbor::Uint(4), Cbor::Bool(reopen)),
            (Cbor::Uint(5), Cbor::Bool(self.index.borrow().fenced())),
        ]))
        .unwrap_or_default()
    }
    /// Host/client frame operations retain the replica's normal authorization gates.
    pub fn hello(&mut self, grant: Option<(Uuid, [u8; 32])>, frame: &[u8]) -> (u64, Vec<u8>) {
        self.runtime
            .as_mut()
            .map_or_else(|| (0, Vec::new()), |r| r.hello(grant, frame))
    }
    /// One already-owned session frame.
    pub fn frame(&mut self, session: u64, frame: &[u8]) {
        if let Some(r) = self.runtime.as_mut() {
            r.frame(session, frame);
        }
    }
    /// Retire one client session.
    pub fn close(&mut self, session: u64) {
        if let Some(r) = self.runtime.as_mut() {
            r.close(session);
        }
    }
    /// Drive the existing replica's bounded scheduling.
    pub fn tick(&mut self, now_ms: i64) {
        if let Some(r) = self.runtime.as_mut() {
            r.tick(now_ms);
        }
    }
    /// Canonical client outputs, never the database or device keys.
    pub fn poll_encoded(&mut self) -> Vec<u8> {
        self.runtime
            .as_mut()
            .map_or_else(Vec::new, Runtime::poll_encoded)
    }
}

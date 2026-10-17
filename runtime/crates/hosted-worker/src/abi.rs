//! The raw WASM ABI the Durable Object host (`services/hosted-worker`) calls.
//!
//! Outputs are packed as `(out_ptr << 32) | out_len`; the host copies them and frees
//! them with `dealloc`. Inputs are written into `alloc`ed memory and consumed.
//! Session and call IDs are passed as `f64` (exact below 2^53).
//!
//! Exports: `alloc`, `dealloc`, `hd_open(cfg)` (empty out = ok, else UTF-8 error),
//! `hd_serving()`, `hd_hello(grant48, frame)` → `[session, frame]`, `hd_frame`,
//! `hd_close`, `hd_tick(now_ms)`, `hd_next_wakeup()` (−1 = none), `hd_poll()` →
//! `[* [session, bytes / null]]`, `hd_log_calls()` → `[* [call_id, host call]]`
//! (`mdbn_replica::log_codec::host_call`), `hd_log_reply(call_id, bytes)`,
//! `hd_log_failed(call_id, offline)`, `hd_log_push(bytes)`, `hd_log_event(kind)`
//! (0 reconnected, 1 disconnected).
//!
//! Imports (module `env`): `host_sql(ptr, len) -> u64` (see [`crate::do_index`]),
//! `host_now_ms() -> f64`, `host_random(ptr, len)`, `host_local_date(ms, tz_ptr,
//! tz_len, out) -> u32`, `host_default_zone(out, cap) -> u32`.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;

use mdbn_replica::log::{CallId, LogError};
use mdbn_replica::{Host, HostedProfile};
use mdbn_store_file::{LogCache, SqlStoreLimits};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, B32, Uuid};

use crate::cpp_claim_ticket::{CppClaimTicketSlot, handle as cpp_handle};
use crate::do_index::{DoIndex, SqlHost};
use crate::migration_action_ledger::{JournalDriver, PreparedAction, RunBinding};
use crate::runtime::{ConfiguredCppAudience, Engine, OpenConfig, Out};

#[link(wasm_import_module = "env")]
unsafe extern "C" {
    fn host_sql(ptr: *const u8, len: usize) -> u64;
    fn host_now_ms() -> f64;
    fn host_random(ptr: *mut u8, len: usize);
    fn host_local_date(instant_ms: f64, tz: *const u8, tz_len: usize, out: *mut u8) -> u32;
    fn host_default_zone(out: *mut u8, cap: usize) -> u32;
}

type Live = Engine<LogCache<DoIndex>>;

struct State {
    engine: Live,
    cpp_claim: Option<CppClaimTicketSlot>,
    migration: Option<JournalDriver<SharedMigrationIndex>>,
    migration_index: Rc<RefCell<DoIndex>>,
    migration_target: Option<crate::runtime::ObservedNativeTarget>,
    migration_ticket: Option<(u64, PreparedAction)>,
    migration_result: Option<B32>,
    migration_physical: Option<(u64, u64, Option<B32>)>,
    migration_confirmed: Option<(u64, Option<B32>)>,
    next_migration_physical: u64,
    collection: Uuid,
    /// Method of each outstanding log call, to decode its reply.
    calls: BTreeMap<u64, &'static str>,
    /// Possession proofs for the log Worker's HTTP RPC.
    http: crate::log_http::LogHttpSigner,
    /// Calls that were `subscribe` and went out as `head`.
    as_subscribe: std::collections::BTreeSet<u64>,
    /// This wake's Noise static secret (from custody, RAM only, wiped on drop).
    noise_static: Option<[u8; 32]>,
    /// App Noise sessions (RAM only; gone with the wake).
    noise: crate::noise_sessions::NoiseSessions,
}

impl Drop for State {
    fn drop(&mut self) {
        if let Some(k) = self.noise_static.as_mut() {
            crate::runtime::wipe(k);
        }
        self.noise.clear();
    }
}

// One engine per instance (one DO); JS is single-threaded per instance.
static mut STATE: Option<State> = None;
// Never reset on State replacement, so detached native handles cannot collide.
static mut CPP_NEXT: u64 = 0;
// Irreversible once-instance initialization; ordinary opens cannot enable CPP.
static mut CPP_OPEN_ATTEMPTED: bool = false;
static mut MIGRATION_NEXT: u64 = 0;
// Why the last `hd_migration_pending_begin` returned null (`Idle`, or 9 when no
// driver/fresh target/free slot was there to poll). DATA for the host loop only.
static mut MIGRATION_IDLE: u32 = 0;
/// Why the last generation-0/log-append step returned nothing (0 none): 1 bad
/// handle, 2 target not fresh, 3 ticket not current, 4 not confirmed, 5 result
/// pending, 6 no driver/target/ticket, 10+ the ledger refusal. DATA only.
static mut GEN0_REFUSAL: u32 = 0;

fn give(out: Vec<u8>) -> u64 {
    let mut out = std::mem::ManuallyDrop::new(out);
    out.shrink_to_fit();
    ((out.as_mut_ptr() as u64) << 32) | out.len() as u64
}

unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
    if len == 0 {
        return Vec::new();
    }
    unsafe { Vec::from_raw_parts(ptr, len, len) }
}

/// Borrow the exact same index allocation as this Engine's LogCache. Migration
/// metadata cannot reset the replica cache or reclassify its durability.
struct SharedMigrationIndex(Rc<RefCell<DoIndex>>);
impl mdbn_store_file::index::IndexStorage for SharedMigrationIndex {
    fn info(&self) -> mdbn_store_file::index::IndexInfo {
        mdbn_store_file::index::IndexStorage::info(&*self.0.borrow())
    }
    fn run(
        &mut self,
        batch: &mdbn_store_file::index::Batch,
    ) -> Result<Vec<mdbn_store_file::index::StmtResult>, mdbn_store_file::index::IndexError> {
        mdbn_store_file::index::IndexStorage::run(&mut *self.0.borrow_mut(), batch)
    }
    fn reset(&mut self) -> Result<(), mdbn_store_file::index::IndexError> {
        Err(mdbn_store_file::index::IndexError::new(
            mdbn_store_file::index::IndexErrorKind::Other,
            "migration index cannot reset",
        ))
    }
}

struct ImportSql;
impl SqlHost for ImportSql {
    fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
        let out = unsafe { host_sql(request.as_ptr(), request.len()) };
        if out == 0 {
            return None;
        }
        Some(unsafe { take((out >> 32) as *mut u8, (out & 0xffff_ffff) as usize) })
    }
}

struct HostClock;
impl mdbn_core::host::Clock for HostClock {
    fn now_ms(&self) -> u64 {
        let t = unsafe { host_now_ms() };
        if t.is_finite() && t > 0.0 {
            t as u64
        } else {
            0
        }
    }
}

struct HostEntropy;
impl mdbn_core::host::Entropy for HostEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        unsafe { host_random(buf.as_mut_ptr(), buf.len()) }
    }
}
impl mdbn_replica::crypto::CsprngEntropy for HostEntropy {}

struct HostZones;
impl mdbn_replica::replica::TimeZones for HostZones {
    fn local_date(&self, instant_ms: i64, tz: &str) -> Option<String> {
        let mut out = [0u8; 10];
        let n =
            unsafe { host_local_date(instant_ms as f64, tz.as_ptr(), tz.len(), out.as_mut_ptr()) };
        if n != 10 {
            return None;
        }
        String::from_utf8(out.to_vec()).ok()
    }
    fn default_zone(&self) -> String {
        let mut out = [0u8; 64];
        let n = unsafe { host_default_zone(out.as_mut_ptr(), out.len()) } as usize;
        std::str::from_utf8(&out[..n.min(out.len())])
            .map(str::to_owned)
            .unwrap_or_else(|_| "UTC".into())
    }
}

#[allow(static_mut_refs)]
fn with<T>(f: impl FnOnce(&mut State) -> T) -> Option<T> {
    unsafe { STATE.as_mut() }.map(f)
}

/// Allocate `len` bytes for the host to write into.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut v = std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(len));
    v.as_mut_ptr()
}

/// Free memory returned by [`alloc`] or by an output.
///
/// # Safety
/// `ptr` and `len` must come from `alloc(len)` or a returned output.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    // Wipe before freeing: outputs and inputs may hold plaintext or keys,
    // and the allocator reuses the memory. Writing zeros also initialises any bytes
    // the host never wrote.
    if len > 0 {
        unsafe { std::ptr::write_bytes(ptr, 0, len) };
        crate::runtime::wipe(unsafe { std::slice::from_raw_parts_mut(ptr, len) });
    }
    drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
}

/// Resolve legacy import paths over canonical CBOR metadata.
/// This is independent of the live replica: no SQL, keys, log or host capabilities.
/// The input allocation is consumed and wiped; the host copies the packed output
/// and frees it with [`dealloc`]. See `mdbn_migrate_portable::abi` for the wire shape.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mig_resolve(ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take_secret(ptr, len) };
    give(mdbn_migrate_portable::abi::resolve_cbor(&input.0))
}

/// Validate/canonicalise one legacy pre-history segment before sealing it.
/// Returns the portable `SegmentOutcome` at a packed output allocation; consumes
/// and wipes the input, like [`mig_resolve`]. No live replica or host capability.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn mig_prehistory_segment(ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take_secret(ptr, len) };
    give(mdbn_migrate_portable::abi::prehistory_segment(&input.0))
}

/// Public-only original genesis check BEFORE custody unwrap or secret use. The
/// normalized pins are immutable bundled release inputs, not CP/request inputs.
/// Returns 1 only on normal native strict policy/certificate verification. This
/// is origin evidence, NOT current-mode permission or a serving decision.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_verify_hosted_genesis(ptr: *mut u8, len: usize) -> u32 {
    let mut public = unsafe { take(ptr, len) };
    let ok = crate::host_trust::verify_public_request(&public).is_ok();
    crate::runtime::wipe(&mut public);
    u32::from(ok)
}

/// Open the engine from a CBOR config ([`OpenConfig`]); the input (which holds key
/// material) is wiped. Empty output on success, else a UTF-8 error.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_open(ptr: *mut u8, len: usize) -> u64 {
    unsafe {
        CPP_OPEN_ATTEMPTED = true;
        open_native(ptr, len, None)
    }
}

/// Trusted host configuration ONLY, separate from secret OpenConfig and all
/// signing inputs. Host must establish actual owned ControlClient provenance.
/// # Safety
/// Both inputs must come from alloc with their lengths initialized.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_open_cpp_claim(
    ptr: *mut u8,
    len: usize,
    aptr: *mut u8,
    alen: usize,
) -> u64 {
    let audience = unsafe { take_secret(aptr, alen) };
    let already_opened = unsafe { CPP_OPEN_ATTEMPTED };
    unsafe { CPP_OPEN_ATTEMPTED = true };
    if already_opened {
        let _cfg = unsafe { take_secret(ptr, len) };
        unsafe { STATE = None };
        return give(b"CPP configuration refused".to_vec());
    }
    let parsed = if alen <= 255 {
        std::str::from_utf8(&audience.0)
            .ok()
            .and_then(|s| ConfiguredCppAudience::from_owned_origin(s).ok())
    } else {
        None
    };
    match parsed {
        Some(a) => unsafe { open_native(ptr, len, Some(a)) },
        None => {
            let _cfg = unsafe { take_secret(ptr, len) };
            unsafe { STATE = None };
            give(b"CPP configuration refused".to_vec())
        }
    }
}

unsafe fn open_native(ptr: *mut u8, len: usize, audience: Option<ConfiguredCppAudience>) -> u64 {
    // A reopen attempt is terminal for old observations, even if it refuses.
    unsafe { STATE = None };
    let mut cfg = unsafe { take(ptr, len) };
    let parsed = OpenConfig::decode(&cfg);
    crate::runtime::wipe(&mut cfg);
    let r = parsed.and_then(|c| {
        let collection = c.cfg.collection;
        let http = crate::log_http::LogHttpSigner::new(&c.secrets.sign_sk);
        let index = Rc::new(RefCell::new(DoIndex::new(Box::new(ImportSql))));
        let store = LogCache::open(index.clone(), SqlStoreLimits::default())
            .map_err(|e| crate::runtime::OpenFailure(format!("cache: {e}")))?;
        let host = Host {
            clock: Box::new(HostClock),
            entropy: Box::new(HostEntropy),
            zones: Box::new(HostZones),
        };
        let engine = match audience {
            Some(a) => Engine::open_for_cpp_claim(c, store, host, HostedProfile::default(), a),
            None => Engine::open(c, store, host, HostedProfile::default()),
        };
        engine.map(|engine| State {
            engine,
            cpp_claim: None,
            migration: None,
            migration_index: index,
            migration_target: None,
            migration_ticket: None,
            migration_result: None,
            migration_physical: None,
            migration_confirmed: None,
            next_migration_physical: 0,
            collection,
            calls: BTreeMap::new(),
            http,
            as_subscribe: Default::default(),
            noise_static: None,
            noise: Default::default(),
        })
    });
    match r {
        Ok(state) => {
            #[allow(static_mut_refs)]
            unsafe {
                STATE = Some(state);
            }
            give(Vec::new())
        }
        Err(e) => give(e.0.into_bytes()),
    }
}

/// Begin one native observation; null on refusal/busy, no replacement/renewal.
/// Output [opaque handle, native collection16, native device16] is DATA only.
#[unsafe(no_mangle)]
pub extern "C" fn hd_cpp_claim_begin() -> u64 {
    let result = with(|s| {
        if s.cpp_claim.is_some() {
            return None;
        }
        let id = unsafe { CPP_NEXT.checked_add(1).filter(|n| *n < (1_u64 << 53))? };
        unsafe { CPP_NEXT = id };
        let slot = CppClaimTicketSlot::begin(&mut s.engine, id).ok()?;
        let (id, col, dev) = slot.subject();
        s.cpp_claim = Some(slot);
        Some(Cbor::Array(vec![
            Cbor::Uint(id),
            Cbor::Bytes(col.0.to_vec()),
            Cbor::Bytes(dev.0.to_vec()),
        ]))
    })
    .flatten()
    .unwrap_or(Cbor::Null);
    give(cbor::encode(&result).unwrap_or_default())
}

/// VOID predicate: no physical check, CPP freshness, lease or effect result.
#[unsafe(no_mangle)]
pub extern "C" fn hd_cpp_claim_current(h: f64) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        u32::from(
            s.cpp_claim
                .as_ref()
                .is_some_and(|slot| slot.assert_current(&mut s.engine, id).is_ok()),
        )
    })
    .unwrap_or(0)
}

/// One closed challenge signature attempt per ticket, raw signature64 or empty.
/// # Safety
/// Input must come from alloc with len initialized; consumed and wiped.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_cpp_claim_sign(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let challenge = unsafe { take_secret(ptr, len) };
    let Some(id) = cpp_handle(h) else {
        return give(Vec::new());
    };
    let output = with(|s| {
        let slot = s.cpp_claim.as_mut()?;
        if !slot.matches(id) {
            return None;
        }
        if len != 32 {
            s.cpp_claim = None;
            return None;
        }
        let bytes = <[u8; 32]>::try_from(challenge.0.as_slice()).ok()?;
        slot.sign(&mut s.engine, id, B32(bytes))
            .ok()
            .map(|sig| sig.0.to_vec())
    })
    .flatten()
    .unwrap_or_default();
    give(output)
}

/// Terminal cleanup only for this exact ticket; cannot finish its successor.
#[unsafe(no_mangle)]
pub extern "C" fn hd_cpp_claim_finish(h: f64) {
    let Some(id) = cpp_handle(h) else {
        return;
    };
    with(|s| {
        if s.cpp_claim.as_ref().is_some_and(|slot| slot.matches(id)) {
            s.cpp_claim = None;
        }
    });
}

/// Bind native Driver correlation from the closed owned-Control CPP exchange.
/// This writes run metadata but issues no effect/H1 authority.
/// # Safety
/// Input is alloc-owned initialized CBOR [owner16, exact started_us string,
/// root16, sign32, kem32, noise32], all matched against native accepted originals.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_open(h: f64, ptr: *mut u8, len: usize) -> u32 {
    let input = unsafe { take(ptr, len) };
    migration_open(h, &input, None)
}

/// Explicit expected-sequence retry, qualified by the same owned CPP slot.
/// # Safety
/// `ptr,len` is an owned alloc buffer consumed exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_restart(
    h: f64,
    sequence: f64,
    ptr: *mut u8,
    len: usize,
) -> u32 {
    let input = unsafe { take(ptr, len) };
    let Some(sequence) = cpp_handle(sequence) else {
        return 0;
    };
    migration_open(h, &input, Some(sequence))
}

fn migration_binding(s: &mut State, id: u64, input: &[u8]) -> Option<RunBinding> {
    if input.len() > 256 {
        return None;
    }
    let Cbor::Array(fields) = cbor::decode(input).ok()? else {
        return None;
    };
    let [
        Cbor::Bytes(owner),
        Cbor::Text(start),
        Cbor::Bytes(root),
        Cbor::Bytes(sign),
        Cbor::Bytes(kem),
        Cbor::Bytes(noise),
    ] = fields.as_slice()
    else {
        return None;
    };
    let owner = B16(owner.as_slice().try_into().ok()?);
    let originals = (
        B16(root.as_slice().try_into().ok()?),
        B32(sign.as_slice().try_into().ok()?),
        B32(kem.as_slice().try_into().ok()?),
        B32(noise.as_slice().try_into().ok()?),
    );
    s.cpp_claim
        .as_ref()?
        .migration_binding(&mut s.engine, id, owner, start.clone(), originals)
        .ok()
}

fn migration_open(h: f64, input: &[u8], restart: Option<u64>) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        let Some(binding) = migration_binding(s, id, input) else {
            return 0;
        };
        if let Some(sequence) = restart {
            if s.migration_ticket.is_some() || s.migration_physical.is_some() {
                return 0;
            }
            // CP may have appended cutover independently of the local action
            // ledger. A rollback-shaped checkpoint cannot override that log.
            let Ok(target) = s.engine.observe_native_target() else {
                return 0;
            };
            let Some(driver) = s.migration.as_mut() else {
                return 0;
            };
            return u32::from(
                driver
                    .restart_on_target(sequence, &binding, &mut HostEntropy, &mut s.engine, &target)
                    .is_ok(),
            );
        }
        if let Some(driver) = s.migration.as_ref() {
            return u32::from(driver.matches_binding(&binding));
        }
        let Ok(target) = s.engine.observe_native_target() else {
            return 0;
        };
        let index = SharedMigrationIndex(s.migration_index.clone());
        let Ok(driver) = JournalDriver::resume(index, binding, &mut HostEntropy) else {
            return 0;
        };
        s.migration = Some(driver);
        s.migration_target = Some(target);
        1
    })
    .unwrap_or(0)
}

/// Expected-run rollback intent from an owned CPP claim and fresh source DATA.
/// # Safety
/// Owned CBOR [claim-bytes, source-bytes], at most 21 KiB.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_rollback_request(
    h: f64,
    sequence: f64,
    ptr: *mut u8,
    len: usize,
) -> u32 {
    let input = unsafe { take(ptr, len) };
    if input.len() > 21 * 1024 {
        return 0;
    }
    let (Some(id), Some(sequence)) = (cpp_handle(h), cpp_handle(sequence)) else {
        return 0;
    };
    let Ok(Cbor::Array(parts)) = cbor::decode(&input) else {
        return 0;
    };
    let [Cbor::Bytes(claim), Cbor::Bytes(source)] = parts.as_slice() else {
        return 0;
    };
    with(|s| {
        if s.migration_ticket.is_some() || s.migration_physical.is_some() {
            return 0;
        }
        let Some(binding) = migration_binding(s, id, claim) else {
            return 0;
        };
        let Ok(target) = s.engine.observe_native_target() else {
            return 0;
        };
        let Some(driver) = s.migration.as_mut() else {
            return 0;
        };
        u32::from(
            driver
                .request_rollback(sequence, &binding, source, &mut s.engine, &target)
                .is_ok(),
        )
    })
    .unwrap_or(0)
}

/// DATA for exact ORIGINAL rollback request/lookup. Does not authorize IO.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_rollback_scope(h: f64) -> u64 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id) || s.migration_confirmed != Some((id, None)) {
            return 0;
        }
        let (Some(driver), Some((_, ticket))) = (s.migration.as_mut(), s.migration_ticket.as_ref())
        else {
            return 0;
        };
        driver
            .rollback_scope(ticket)
            .and_then(|v| v.to_bytes())
            .map_or(0, give)
    })
    .unwrap_or(0)
}

/// DATA only for a read-only unknown rollback receipt lookup; no effect ticket.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_unknown_rollback_scope(sequence: f64) -> u64 {
    let Some(sequence) = cpp_handle(sequence) else {
        return 0;
    };
    with(|s| {
        s.migration
            .as_mut()?
            .unknown_rollback_scope(sequence)
            .ok()?
            .to_bytes()
            .ok()
    })
    .flatten()
    .map_or(0, give)
}

fn migration_recovery(
    s: &mut State,
    id: u64,
    sequence: u64,
    claim: &[u8],
    receipt: Option<&[u8]>,
) -> Option<Vec<u8>> {
    if s.migration_ticket.is_some() || s.migration_physical.is_some() {
        return None;
    }
    let binding = migration_binding(s, id, claim)?;
    let target = s.engine.observe_native_target().ok()?;
    let driver = s.migration.as_mut()?;
    if !driver.matches_binding(&binding) {
        return None;
    }
    // Reserve before settlement: exhaustion must not leave a committed result
    // without a settlement-only handle for the physical confirmation barrier.
    let handle = unsafe { MIGRATION_NEXT }
        .checked_add(1)
        .filter(|n| *n <= 9_007_199_254_740_991)?;
    unsafe {
        MIGRATION_NEXT = handle;
    }
    let (ticket, result) = match receipt {
        None => driver.resolve_base(sequence, &mut s.engine, &target),
        Some(input) => driver.resolve_rollback(sequence, input, &mut s.engine, &target),
    }
    .ok()?;
    let data = ticket.data();
    let output = cbor::encode(&Cbor::Array(vec![
        Cbor::Uint(handle),
        Cbor::Bytes(driver.collection().0.to_vec()),
        Cbor::Bytes(driver.driver_id().0.to_vec()),
        Cbor::Bytes(data.action.0.to_vec()),
        Cbor::Uint(data.sequence),
        Cbor::Uint(data.kind),
        Cbor::Bytes(data.fingerprint.0.to_vec()),
        Cbor::Bytes(result.0.to_vec()),
    ]))
    .ok()?;
    s.migration_target = Some(target);
    s.migration_ticket = Some((handle, ticket));
    s.migration_result = Some(result);
    s.migration_confirmed = None;
    Some(output)
}

/// Positive actual-log resolution only; returned ticket is ALREADY settled.
/// # Safety
/// Owned claim CBOR, at most 256 bytes; no caller-provided found result.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_resolve_base(
    h: f64,
    sequence: f64,
    ptr: *mut u8,
    len: usize,
) -> u64 {
    let input = unsafe { take(ptr, len) };
    let (Some(id), Some(sequence)) = (cpp_handle(h), cpp_handle(sequence)) else {
        return 0;
    };
    with(|s| migration_recovery(s, id, sequence, &input, None))
        .flatten()
        .map_or(0, give)
}

/// Read-only exact-original receipt resolution of an evicted rollback action.
/// # Safety
/// Owned CBOR [claim-bytes, original-receipt-bytes], at most 41 KiB.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_resolve_rollback(
    h: f64,
    sequence: f64,
    ptr: *mut u8,
    len: usize,
) -> u64 {
    let input = unsafe { take(ptr, len) };
    if input.len() > 41 * 1024 {
        return 0;
    }
    let (Some(id), Some(sequence)) = (cpp_handle(h), cpp_handle(sequence)) else {
        return 0;
    };
    let Ok(Cbor::Array(parts)) = cbor::decode(&input) else {
        return 0;
    };
    let [Cbor::Bytes(claim), Cbor::Bytes(receipt)] = parts.as_slice() else {
        return 0;
    };
    with(|s| migration_recovery(s, id, sequence, claim, Some(receipt)))
        .flatten()
        .map_or(0, give)
}

/// Read-only run history; does not mint a pending/effect ticket.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_run(sequence: f64) -> u64 {
    let sequence = if sequence == 0.0 {
        0
    } else {
        let Some(sequence) = cpp_handle(sequence) else {
            return 0;
        };
        sequence
    };
    with(|s| {
        let driver = s.migration.as_mut()?;
        let data = driver.read_run(sequence).ok()??;
        let cp = data.checkpoint.to_bytes().ok()?;
        let value = Cbor::Array(vec![
            Cbor::Uint(data.sequence),
            Cbor::Bytes(data.driver.0.to_vec()),
            Cbor::Bytes(data.binding.collection.0.to_vec()),
            Cbor::Bytes(data.binding.owner.0.to_vec()),
            Cbor::Text(data.binding.started_us),
            Cbor::Bytes(data.binding.target.0.to_vec()),
            Cbor::Bytes(cp),
        ]);
        Some(give(cbor::encode(&value).ok()?))
    })
    .flatten()
    .unwrap_or(0)
}

/// Re-observe the run's native target on the SAME Engine, keeping it only
/// while the log moved forward on the same chain with the same identity,
/// epoch and originals (`Engine::refresh_native_target`).
fn migration_target_fresh(s: &mut State) -> bool {
    let Some(target) = s.migration_target.as_ref() else {
        return false;
    };
    match s.engine.refresh_native_target(target) {
        Ok(fresh) => {
            s.migration_target = Some(fresh);
            true
        }
        Err(_) => false,
    }
}

fn migration_current(s: &mut State, id: u64) -> bool {
    if !migration_target_fresh(s) {
        return false;
    }
    let Some((handle, ticket)) = s.migration_ticket.as_ref() else {
        return false;
    };
    if *handle != id {
        return false;
    }
    s.migration
        .as_mut()
        .is_some_and(|driver| driver.assert_prepared(ticket).is_ok())
}

/// Native sequencing DATA only, persisted before any effect dispatch.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_pending_begin() -> u64 {
    unsafe {
        MIGRATION_IDLE = 9;
    }
    let result = with(|s| {
        if s.migration_ticket.is_some() || !migration_target_fresh(s) {
            return None;
        }
        let id = unsafe {
            MIGRATION_NEXT
                .checked_add(1)
                .filter(|n| *n < (1_u64 << 53))?
        };
        unsafe {
            MIGRATION_NEXT = id;
        }
        // A rebuild settles only from an Engine opened over an empty cache:
        // refuse it before saving, so the host resets and reopens first.
        let fresh = s.engine.migration_opened_empty();
        let driver = s.migration.as_mut()?;
        let prepared = driver.prepare_gated(&mut HostEntropy, &|a| {
            fresh
                || !matches!(
                    a,
                    mdbn_migrate_portable::hosted_import::Action::Rebuild { .. }
                )
        });
        unsafe {
            MIGRATION_IDLE = driver.idle() as u32;
        }
        let (ticket, _) = prepared.ok()?;
        let p = ticket.data();
        let output = Cbor::Array(vec![
            Cbor::Uint(id),
            Cbor::Bytes(driver.collection().0.to_vec()),
            Cbor::Bytes(driver.driver_id().0.to_vec()),
            Cbor::Bytes(p.action.0.to_vec()),
            Cbor::Uint(p.sequence),
            Cbor::Uint(p.kind),
            Cbor::Bytes(p.fingerprint.0.to_vec()),
        ]);
        s.migration_ticket = Some((id, ticket));
        Some(output)
    })
    .flatten()
    .unwrap_or(Cbor::Null);
    give(cbor::encode(&result).unwrap_or_default())
}

/// Why the last pending begin saved nothing: 0 an action was saved, 1 continue,
/// 2 wait (paused), 3 wait (draining), 4 wait (keying), 5 done, 6 rebuild needs
/// an empty-cache reopen, 7 an outstanding action (UNKNOWN), 8 refused, 9 no
/// driver to poll. Loop DATA only, never a retry or effect permit.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_idle() -> u32 {
    unsafe { MIGRATION_IDLE }
}

/// `[kind, ...params]` of the SAME original pending action, exactly as its
/// fingerprint hashed them (read table/cursor, revoke IDs, route facts). DATA
/// for the host's request; settlement re-binds it natively.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_pending_action(h: f64) -> u64 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id) {
            return 0;
        }
        let (Some(driver), Some((_, ticket))) = (s.migration.as_mut(), s.migration_ticket.as_ref())
        else {
            return 0;
        };
        driver.prepared_fields(ticket).map_or(0, give)
    })
    .unwrap_or(0)
}

/// VOID saved pending/actual native target recheck; not a physical ACK.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_pending_current(h: f64) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| u32::from(migration_current(s, id))).unwrap_or(0)
}

/// Native negative H1 evaluation only. No Created.verified=true ingress.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_keying_wait(h: f64) -> u64 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id) || s.migration_confirmed != Some((id, None)) {
            return 0;
        }
        let Some(driver) = s.migration.as_mut() else {
            return 0;
        };
        if s.migration_result.is_some() {
            return 0;
        }
        let Some((_, ticket)) = s.migration_ticket.as_ref() else {
            return 0;
        };
        if !matches!(
            driver.prepared_action(ticket),
            Ok(mdbn_migrate_portable::hosted_import::Action::CreateCollection)
        ) {
            return 0;
        }
        match driver.settle(
            ticket,
            mdbn_migrate_portable::hosted_import::Outcome::Created { verified: false },
        ) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// Positive creation from SAME actual native target/run/pending, never an input
/// authority boolean. The owned host still owes CPP currentness and actual
/// storage.sync settlement confirmation before exposing success.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_target_complete(h: f64) -> u64 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id)
            || s.migration_confirmed != Some((id, None))
            || s.migration_result.is_some()
        {
            return 0;
        }
        let (Some(driver), Some(target), Some((_, ticket))) = (
            s.migration.as_mut(),
            s.migration_target.as_ref(),
            s.migration_ticket.as_ref(),
        ) else {
            return 0;
        };
        match driver.settle_created(ticket, &mut s.engine, target) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// Settle the SAME original pending from one Connect/provider result body (a
/// fixed CBOR mirror, see `migration_action_ledger::provider`). Native binds it
/// to the run and retained action; the host still owes actual storage.sync
/// settlement confirmation before exposing success.
/// # Safety
/// Input is alloc-owned initialized bytes of `len` (at most 20 KiB).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_provider_result(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take(ptr, len) };
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id)
            || s.migration_confirmed != Some((id, None))
            || s.migration_result.is_some()
        {
            return 0;
        }
        let (Some(driver), Some((_, ticket))) = (s.migration.as_mut(), s.migration_ticket.as_ref())
        else {
            return 0;
        };
        match driver.settle_provider(ticket, &input) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// Full ORIGINAL rollback receipt only, never bare restored/active/Ok.
/// # Safety
/// Owned fixed CBOR receipt DATA, at most 40 KiB.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_rollback_result(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take(ptr, len) };
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id)
            || s.migration_confirmed != Some((id, None))
            || s.migration_result.is_some()
        {
            return 0;
        }
        let (Some(driver), Some((_, ticket))) = (s.migration.as_mut(), s.migration_ticket.as_ref())
        else {
            return 0;
        };
        match driver.settle_rollback(ticket, &input) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// Settle the SAME original pending from one legacy source open or page result
/// (a fixed CBOR mirror, see `migration_action_ledger::source`). Native binds it
/// to the run, the settled hold and open, and the retained action; page metadata
/// commits with the settlement. The host still owes actual storage.sync
/// settlement confirmation before exposing success.
/// # Safety
/// Input is alloc-owned initialized bytes of `len` (at most 48 KiB).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_source_result(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take(ptr, len) };
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id)
            || s.migration_confirmed != Some((id, None))
            || s.migration_result.is_some()
        {
            return 0;
        }
        let (Some(driver), Some((_, ticket))) = (s.migration.as_mut(), s.migration_ticket.as_ref())
        else {
            return 0;
        };
        match driver.settle_source(ticket, &input) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// Generation-0 sealing under the SAME current original pending: `step` gets
/// the confirmed ledger, the current native target and the Engine. Sealing
/// never settles; the output is objects to upload plus addresses to verify
/// (`migration_action_ledger::gen0`), or 0 on any refusal.
fn migration_gen0(
    h: f64,
    step: impl FnOnce(
        &mut JournalDriver<SharedMigrationIndex>,
        &PreparedAction,
        &mut Live,
        &crate::runtime::ObservedNativeTarget,
    ) -> Option<Vec<u8>>,
) -> u64 {
    let refuse = |code: u32| {
        unsafe { GEN0_REFUSAL = code };
        0
    };
    unsafe { GEN0_REFUSAL = 0 };
    let Some(id) = cpp_handle(h) else {
        return refuse(1);
    };
    with(|s| {
        if !migration_target_fresh(s) {
            return refuse(2);
        }
        if !migration_current(s, id) {
            return refuse(3);
        }
        if s.migration_confirmed != Some((id, None)) {
            return refuse(4);
        }
        if s.migration_result.is_some() {
            return refuse(5);
        }
        let (Some(driver), Some(target), Some((_, ticket))) = (
            s.migration.as_mut(),
            s.migration_target.as_ref(),
            s.migration_ticket.as_ref(),
        ) else {
            return refuse(6);
        };
        step(driver, ticket, &mut s.engine, target).map_or(0, give)
    })
    .unwrap_or(0)
}

/// Record a ledger refusal from a generation-0/log-append step (see GEN0_REFUSAL).
fn gen0_refused(e: crate::migration_action_ledger::LedgerError) {
    unsafe { GEN0_REFUSAL = 10 + e as u32 };
}

/// The last generation-0/log-append refusal code (see GEN0_REFUSAL).
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_gen0_refusal() -> u32 {
    unsafe { GEN0_REFUSAL }
}

/// Metadata for the exact row/byte-bounded native-selected window.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_gen0_placements(h: f64) -> u64 {
    migration_gen0(h, |driver, ticket, engine, target| {
        driver
            .gen0_placement_input(ticket, engine, target)
            .map_err(gen0_refused)
            .ok()
    })
}

/// Seal ONE whole current file of the retained bucket window, verified against
/// its S0 placement: `[collection, head, session, file id, bytes]`.
///
/// # Safety
/// Input is alloc-owned initialized bytes of `len` (at most 1 MiB + 256).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_gen0_file(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = zeroize::Zeroizing::new(unsafe { take(ptr, len) });
    migration_gen0(h, |driver, ticket, engine, target| {
        driver
            .gen0_file(ticket, engine, target, &input)
            .map_err(gen0_refused)
            .ok()
            .map(|o| o.encode())
    })
}

/// Seal one sequential AttachmentV1 file chunk, bound to the S0 placement:
/// `[collection, head, session, file id, offset, bytes]`.
///
/// # Safety
/// Input is alloc-owned initialized bytes of `len` (at most 8 MiB + 256).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_gen0_file_chunk(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = zeroize::Zeroizing::new(unsafe { take(ptr, len) });
    migration_gen0(h, |driver, ticket, engine, target| {
        driver
            .gen0_file_chunk(ticket, engine, target, &input)
            .map_err(gen0_refused)
            .ok()
            .map(|o| o.encode())
    })
}

/// Seal the retained window's text rows and its sealed files:
/// `[collection, head, session, [[path | record id, text]…]]`.
///
/// # Safety
/// Input is alloc-owned initialized bytes of `len` (at most 72 KiB).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_gen0_window(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take(ptr, len) };
    migration_gen0(h, |driver, ticket, engine, target| {
        driver
            .gen0_window(ticket, engine, target, &input)
            .map_err(gen0_refused)
            .ok()
            .map(|o| o.encode())
    })
}

/// Seal the retained `FinishGen0`: remaining sections and the manifest.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_gen0_finish(h: f64) -> u64 {
    migration_gen0(h, |driver, ticket, engine, target| {
        driver
            .gen0_finish(ticket, engine, target)
            .map_err(gen0_refused)
            .ok()
            .map(|o| o.encode())
    })
}

/// Settle the staged generation-0 window or finish from the host's HasObjects
/// flags over exactly its addresses, in order: `[collection, [present…]]`.
///
/// # Safety
/// Input is alloc-owned initialized bytes of `len` (at most 4 KiB).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_migration_gen0_result(h: f64, ptr: *mut u8, len: usize) -> u64 {
    let input = unsafe { take(ptr, len) };
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id)
            || s.migration_confirmed != Some((id, None))
            || s.migration_result.is_some()
        {
            return 0;
        }
        let (Some(driver), Some(target), Some((_, ticket))) = (
            s.migration.as_mut(),
            s.migration_target.as_ref(),
            s.migration_ticket.as_ref(),
        ) else {
            return 0;
        };
        match driver.settle_gen0(ticket, &mut s.engine, target, &input) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// Seal (once per action) and send the retained `AppendBase`'s hosted-import
/// base through the Engine's log session, or resend the same bytes after a
/// dropped batch: `[item hash, seq]` (`migration_action_ledger::log`). Sending
/// never settles.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_log_append(h: f64) -> u64 {
    migration_gen0(h, |driver, ticket, engine, target| {
        driver
            .log_append(ticket, engine, target)
            .map_err(gen0_refused)
            .ok()
            .map(|o| o.encode())
    })
}

/// Settle the SAME original pending log action (base, cutover, head, rebuild,
/// page) from the Engine's own log evidence; no input. The host still owes
/// actual storage.sync settlement confirmation before exposing success.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_log_result(h: f64) -> u64 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_current(s, id)
            || s.migration_confirmed != Some((id, None))
            || s.migration_result.is_some()
        {
            return 0;
        }
        let (Some(driver), Some(target), Some((_, ticket))) = (
            s.migration.as_mut(),
            s.migration_target.as_ref(),
            s.migration_ticket.as_ref(),
        ) else {
            return 0;
        };
        match driver.settle_log(ticket, &mut s.engine, target) {
            Ok(result) => {
                s.migration_result = Some(result);
                give(result.0.to_vec())
            }
            Err(_) => 0,
        }
    })
    .unwrap_or(0)
}

/// VOID exact original settlement readback, not physical completion ACK.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_settlement_current(h: f64) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| u32::from(migration_settled(s, id))).unwrap_or(0)
}
fn migration_settled(s: &mut State, id: u64) -> bool {
    if !migration_target_fresh(s) {
        return false;
    }
    let Some((handle, ticket)) = s.migration_ticket.as_ref() else {
        return false;
    };
    let Some(result) = s.migration_result else {
        return false;
    };
    *handle == id
        && s.migration
            .as_mut()
            .is_some_and(|d| d.assert_settled(ticket, result).is_ok())
}

/// Native one-slot sequencing for the closed host's actual storage.sync await.
/// IDs correlate only. No ACK Boolean/payload is accepted and this alone grants
/// no migration/H1/external-effect permission; the actual host barrier is required.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_physical_begin(h: f64) -> f64 {
    let Some(action) = cpp_handle(h) else {
        return 0.0;
    };
    with(|s| {
        if s.migration_physical.is_some() {
            return 0.0;
        }
        let current = if s.migration_result.is_none() {
            migration_current(s, action)
        } else {
            migration_settled(s, action)
        };
        if !current {
            return 0.0;
        }
        let Some(next) = s
            .next_migration_physical
            .checked_add(1)
            .filter(|n| *n < (1_u64 << 53))
        else {
            return 0.0;
        };
        s.next_migration_physical = next;
        s.migration_physical = Some((next, action, s.migration_result));
        next as f64
    })
    .unwrap_or(0.0)
}
fn migration_physical_current(s: &mut State, id: u64) -> bool {
    let Some((handle, action, result)) = s.migration_physical else {
        return false;
    };
    handle == id
        && result == s.migration_result
        && if result.is_none() {
            migration_current(s, action)
        } else {
            migration_settled(s, action)
        }
}
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_physical_current(h: f64) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| u32::from(migration_physical_current(s, id))).unwrap_or(0)
}
/// Called ONLY by closed host continuation after actual physical ACK + checks.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_physical_finish(h: f64) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        if !migration_physical_current(s, id) {
            return 0;
        }
        let Some((_, action, result)) = s.migration_physical.take() else {
            return 0;
        };
        s.migration_confirmed = Some((action, result));
        1
    })
    .unwrap_or(0)
}
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_physical_close(h: f64) {
    let Some(id) = cpp_handle(h) else {
        return;
    };
    with(|s| {
        if s.migration_physical.is_some_and(|(h, _, _)| h == id) {
            s.migration_physical = None;
        }
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_settlement_confirmed(h: f64) -> u32 {
    let Some(id) = cpp_handle(h) else {
        return 0;
    };
    with(|s| {
        u32::from(
            s.migration_result.is_some()
                && s.migration_confirmed == Some((id, s.migration_result))
                && migration_settled(s, id),
        )
    })
    .unwrap_or(0)
}

/// Exact RAM cleanup leaves original durable pending UNKNOWN; never abandons it.
#[unsafe(no_mangle)]
pub extern "C" fn hd_migration_pending_finish(h: f64) {
    let Some(id) = cpp_handle(h) else {
        return;
    };
    with(|s| {
        if s.migration_ticket.as_ref().is_some_and(|(n, _)| *n == id) {
            s.migration_ticket = None;
            s.migration_result = None;
            s.migration_physical = None;
            s.migration_confirmed = None;
        }
    });
}

/// 1 when the engine serves sessions (rebuilt from the log), else 0.
#[unsafe(no_mangle)]
pub extern "C" fn hd_serving() -> u32 {
    with(|s| u32::from(s.engine.serving())).unwrap_or(0)
}

/// 1 when the cache must be dropped (it disagrees with the log), else 0.
#[unsafe(no_mangle)]
pub extern "C" fn hd_needs_reset() -> u32 {
    with(|s| u32::from(s.engine.needs_reset())).unwrap_or(0)
}

/// The pin check on the applied state (`Engine::pin_state`) plus 1: 1 the state
/// fails the pins, 2 consistent while rebuilding, 3 consistent and rebuilt;
/// 0 without an engine (no evidence either way).
#[unsafe(no_mangle)]
pub extern "C" fn hd_pin_state() -> u32 {
    with(|s| s.engine.pin_state() + 1).unwrap_or(0)
}

/// Open a session. `grant` is empty (host) or 48 bytes (grant ID ‖ client key).
/// Output: CBOR `[session, response frame]` (session 0 = refused).
///
/// # Safety
/// Both inputs must come from `alloc` with their lengths initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_hello(gptr: *mut u8, glen: usize, ptr: *mut u8, len: usize) -> u64 {
    let g = unsafe { take(gptr, glen) };
    let frame = unsafe { take(ptr, len) };
    let grant = match g.len() {
        48 => {
            let mut id = [0u8; 16];
            let mut pk = [0u8; 32];
            id.copy_from_slice(&g[..16]);
            pk.copy_from_slice(&g[16..]);
            Some((B16(id), pk))
        }
        _ => None,
    };
    let out = with(|s| s.engine.hello(grant, &frame)).unwrap_or((0, Vec::new()));
    give(
        cbor::encode(&Cbor::Array(vec![Cbor::Uint(out.0), Cbor::Bytes(out.1)])).unwrap_or_default(),
    )
}

/// A frame from a session's client.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_frame(session: f64, ptr: *mut u8, len: usize) {
    let frame = unsafe { take(ptr, len) };
    with(|s| s.engine.frame(session as u64, &frame));
}

/// A session's socket closed.
#[unsafe(no_mangle)]
pub extern "C" fn hd_close(session: f64) {
    with(|s| s.engine.close(session as u64));
}

/// Run timers.
#[unsafe(no_mangle)]
pub extern "C" fn hd_tick(now_ms: f64) {
    with(|s| s.engine.tick(now_ms as i64));
}

/// The next wakeup (host ms), or −1.
#[unsafe(no_mangle)]
pub extern "C" fn hd_next_wakeup() -> f64 {
    with(|s| s.engine.next_wakeup())
        .flatten()
        .map_or(-1.0, |t| t as f64)
}

/// Frames and closes to deliver: `[* [session, bytes / null]]`.
#[unsafe(no_mangle)]
pub extern "C" fn hd_poll() -> u64 {
    let items = with(|s| s.engine.poll()).unwrap_or_default();
    let c = Cbor::Array(
        items
            .into_iter()
            .map(|o| match o {
                Out::Frame(s, b) => Cbor::Array(vec![Cbor::Uint(s), Cbor::Bytes(b)]),
                Out::Closed(s) => Cbor::Array(vec![Cbor::Uint(s), Cbor::Null]),
            })
            .collect(),
    );
    give(cbor::encode(&c).unwrap_or_default())
}

/// Log calls to send: `[* [call_id, host call record]]`. A call that does not
/// encode is answered `no response` (retried) rather than dropped.
///
/// **HTTP-only transport.** The DO reaches the log Worker by unary RPC, with no
/// standing socket (it must be able to hibernate), so there are no service pushes.
/// A `subscribe` is sent as a `head` RPC and its reply delivered as `subscribed`
/// (same head and chain); the host re-runs it (`hd_log_event(0)`, reconnected) to
/// learn of new entries.
#[unsafe(no_mangle)]
pub extern "C" fn hd_log_calls() -> u64 {
    let items = with(|s| {
        let mut out = Vec::new();
        for call in s.engine.take_log_calls() {
            let (call, as_subscribe) = mdbn_replica::log_codec::http_unary_call(call);
            let id = call.id;
            if as_subscribe {
                s.as_subscribe.insert(id.0);
            }
            let method = call.request.method();
            match mdbn_replica::log_codec::host_call(call) {
                Ok(rec) => {
                    s.calls.insert(id.0, method);
                    out.push(Cbor::Array(vec![Cbor::Uint(id.0), rec]));
                }
                Err(_) => {
                    s.engine.on_log_reply(id, Err(LogError::NoResponse));
                }
            }
        }
        out
    })
    .unwrap_or_default();
    give(cbor::encode(&Cbor::Array(items)).unwrap_or_default())
}

/// The service's reply to a call. A reply that does not decode against its call is
/// treated as no response (the outcome is unknown; the replica retries).
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_log_reply(call: f64, ptr: *mut u8, len: usize) {
    let bytes = unsafe { take(ptr, len) };
    let id = call as u64;
    with(|s| {
        if s.calls.remove(&id).is_none() {
            return;
        }
        let as_subscribe = s.as_subscribe.remove(&id);
        // Decoded only once the engine has validated this call's scope against
        // the current log session, with the call's ORIGINAL method.
        s.engine.on_log_reply_with(CallId(id), |call, method| {
            mdbn_replica::log_codec::http_unary_reply(call, method, as_subscribe, &bytes)
                .unwrap_or(Err(LogError::NoResponse))
        });
    });
}

/// A call failed in transport: `offline` 1 = no connectivity, 0 = no response.
#[unsafe(no_mangle)]
pub extern "C" fn hd_log_failed(call: f64, offline: u32) {
    let id = call as u64;
    with(|s| {
        if s.calls.remove(&id).is_some() {
            s.as_subscribe.remove(&id);
            let e = if offline == 1 {
                LogError::Offline
            } else {
                LogError::NoResponse
            };
            s.engine.on_log_reply(CallId(id), Err(e));
        }
    });
}

/// Bind the authenticated log session. The host calls it only after its
/// transport authenticated for this collection (token in hand, configured
/// binding), after any await, while its own generation is still current.
/// Returns 1 when bound.
#[unsafe(no_mangle)]
pub extern "C" fn hd_log_bind() -> u32 {
    with(|s| {
        s.calls.clear();
        s.as_subscribe.clear();
        let collection = s.collection;
        u32::from(s.engine.bind_log(collection))
    })
    .unwrap_or(0)
}

/// Retire the log session: the host's generation moved (reset, pause, replaced
/// engine, transport lost). Replies to its calls are then refused undecoded.
#[unsafe(no_mangle)]
pub extern "C" fn hd_log_retire() {
    with(|s| {
        s.calls.clear();
        s.as_subscribe.clear();
        s.engine.retire_log();
    });
}

/// Queue one head fetch on the CURRENT log session: how this push-less host
/// learns entries other writers appended (the control plane's cutover) while a
/// migration ticket is open. No retire or rebind, so the native target stays.
#[unsafe(no_mangle)]
pub extern "C" fn hd_log_request_head() -> u32 {
    with(|s| u32::from(s.engine.request_log_head())).unwrap_or(0)
}

fn bounded_uint(value: f64) -> Option<u64> {
    (value.is_finite() && (0.0..=9_007_199_254_740_991.0).contains(&value) && value.fract() == 0.0)
        .then_some(value as u64)
}

/// Host-only object lease, or CBOR null when there is no bounded read to fetch.
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_object() -> u64 {
    let object = with(|s| s.engine.attachment_object())
        .flatten()
        .unwrap_or(Cbor::Null);
    give(cbor::encode(&object).unwrap_or_default())
}

/// Recheck ticket/READ/folder/wake/health after each host await.
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_allowed(ticket: f64) -> u32 {
    bounded_uint(ticket)
        .and_then(|t| with(|s| u32::from(s.engine.attachment_allowed(t))))
        .unwrap_or(0)
}

/// Reserve only the bounded ciphertext length, never a file-sized allocation.
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_reserve(ticket: f64, size: f64) -> u32 {
    match (bounded_uint(ticket), bounded_uint(size)) {
        (Some(t), Some(n)) => with(|s| u32::from(s.engine.attachment_reserve(t, n))).unwrap_or(0),
        _ => 0,
    }
}

/// Current native resource preflight; owned request bytes are wiped.
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_attachment_call_requires_slot(
    session: f64,
    ptr: *mut u8,
    len: usize,
) -> u32 {
    let mut bytes = unsafe { take(ptr, len) };
    let result = bounded_uint(session)
        .and_then(|id| with(|s| u32::from(s.engine.attachment_call_requires_slot(id, &bytes))))
        .unwrap_or(0);
    crate::runtime::wipe(&mut bytes);
    result
}
/// Existing RPC unavailable/busy error, after rechecking native policy/READ.
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_attachment_call_busy(session: f64, ptr: *mut u8, len: usize) {
    let mut bytes = unsafe { take(ptr, len) };
    if let Some(id) = bounded_uint(session) {
        with(|s| s.engine.attachment_call_busy(id, &bytes));
    }
    crate::runtime::wipe(&mut bytes);
}
/// Ephemeral stream owner, for resource-slot retirement only (not admission).
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_active(session: f64) -> u32 {
    bounded_uint(session)
        .and_then(|id| with(|s| u32::from(s.engine.attachment_active(id))))
        .unwrap_or(0)
}

/// Mint the next <=1MiB fixed-region write slice (pointer only, no allocation).
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_region(ticket: f64, size: f64) -> u32 {
    match (bounded_uint(ticket), bounded_uint(size)) {
        (Some(t), Some(n)) if n <= crate::runtime::MAX_OUT_FRAME as u64 => with(|s| {
            s.engine
                .attachment_region(t, n as usize)
                .map_or(0, |p| p as u32)
        })
        .unwrap_or(0),
        _ => 0,
    }
}
/// Commit the exact minted length after the synchronous host write.
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_written(ticket: f64, size: f64) -> u32 {
    match (bounded_uint(ticket), bounded_uint(size)) {
        (Some(t), Some(n)) if n <= crate::runtime::MAX_OUT_FRAME as u64 => {
            with(|s| u32::from(s.engine.attachment_written(t, n as usize))).unwrap_or(0)
        }
        _ => 0,
    }
}

/// Copy one <=1MiB network segment into the scoped ciphertext allocation.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_attachment_write(ticket: f64, ptr: *mut u8, len: usize) -> u32 {
    let mut bytes = unsafe { take(ptr, len) };
    let result = bounded_uint(ticket)
        .and_then(|t| with(|s| u32::from(s.engine.attachment_write(t, &bytes))))
        .unwrap_or(0);
    crate::runtime::wipe(&mut bytes);
    result
}

/// Verify the full encoded object's checksum and authentication before release.
///
/// # Safety
/// `ptr` must come from `alloc(len)`; the input is the expected 32-byte checksum.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_attachment_complete(ticket: f64, ptr: *mut u8, len: usize) -> u32 {
    let mut bytes = unsafe { take(ptr, len) };
    let result = match (
        bounded_uint(ticket),
        <&[u8; 32]>::try_from(bytes.as_slice()),
    ) {
        (Some(t), Ok(hash)) => {
            with(|s| u32::from(s.engine.attachment_complete(t, B32(*hash)))).unwrap_or(0)
        }
        _ => 0,
    };
    crate::runtime::wipe(&mut bytes);
    result
}

/// Terminate only this pending lease on transport error, not a newer read.
#[unsafe(no_mangle)]
pub extern "C" fn hd_attachment_failed(ticket: f64) {
    if let Some(t) = bounded_uint(ticket) {
        with(|s| s.engine.attachment_failed(t));
    }
}

/// A push from the log service; ignored unless it decodes for this collection.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_log_push(ptr: *mut u8, len: usize) {
    let bytes = unsafe { take(ptr, len) };
    with(|s| {
        if let Ok(p) = mdbn_replica::log_codec::push(s.collection, &bytes) {
            let _ = s.engine.on_log_push(p);
        }
    });
}

/// A trusted-host transport event: 0 reconnected (re-bind the session, which
/// re-subscribes), 1 disconnected (retire it).
#[unsafe(no_mangle)]
pub extern "C" fn hd_log_event(kind: u32) {
    match kind {
        0 => {
            hd_log_bind();
        }
        _ => hd_log_retire(),
    }
}

/// Sign one log HTTP RPC (`ls-http` transcript, [`crate::log_http`]) with the
/// service device key. Inputs: LS method (UTF-8), params key 0 (16 bytes, or empty),
/// bearer token (UTF-8), the exact request body, the server nonce (32 bytes).
/// Output: the 64-byte signature, or empty when refused.
///
/// # Safety
/// Every input must come from `alloc` with its length initialised.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn hd_log_http_sign(
    mptr: *mut u8,
    mlen: usize,
    kptr: *mut u8,
    klen: usize,
    tptr: *mut u8,
    tlen: usize,
    bptr: *mut u8,
    blen: usize,
    nptr: *mut u8,
    nlen: usize,
) -> u64 {
    let method = unsafe { take(mptr, mlen) };
    let key0 = unsafe { take(kptr, klen) };
    let mut token = unsafe { take(tptr, tlen) };
    let body = unsafe { take(bptr, blen) };
    let nonce = unsafe { take(nptr, nlen) };
    let sig = (|| {
        let method = std::str::from_utf8(&method).ok()?;
        let token = std::str::from_utf8(&token).ok()?;
        let key0: Option<[u8; 16]> = match key0.len() {
            0 => None,
            16 => key0.as_slice().try_into().ok(),
            _ => return None,
        };
        let nonce: [u8; 32] = nonce.as_slice().try_into().ok()?;
        with(|s| s.http.sign(method, key0, token, &body, &nonce)).flatten()
    })();
    crate::runtime::wipe(&mut token);
    give(sig.map(|s| s.to_vec()).unwrap_or_default())
}

/// Generate a hosted service device (Connect cloud-copy bootstrap) from the host
/// CSPRNG. Output: `secret(96) ‖ sign_pk(32) ‖ kem_pk(32) ‖ noise_pk(32)`. The host
/// copies it, then frees it with [`hd_wipe_free`]; the secret goes only to KMS wrap.
/// Needs no open engine.
#[unsafe(no_mangle)]
pub extern "C" fn hd_generate_device() -> u64 {
    let g = crate::device_keys::generate(&mut HostEntropy);
    let mut out = Vec::with_capacity(crate::device_keys::SECRET_LEN + 96);
    out.extend_from_slice(&g.secret.0);
    out.extend_from_slice(&g.public.sign);
    out.extend_from_slice(&g.public.kem);
    out.extend_from_slice(&g.public.noise);
    give(out)
}

/// The public keys of an unwrapped 96-byte secret, for custody to check against the
/// service record and the log's enrolment: `sign_pk ‖ kem_pk ‖ noise_pk`, or empty
/// when the input is not 96 bytes. The input is wiped.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_public_keys(ptr: *mut u8, len: usize) -> u64 {
    let mut secret = unsafe { take(ptr, len) };
    let keys = crate::device_keys::public_keys(&secret);
    crate::runtime::wipe(&mut secret);
    give(
        keys.map(|k| [k.sign, k.kem, k.noise].concat())
            .unwrap_or_default(),
    )
}

/// Wipe, then free, an output that held secret bytes.
///
/// # Safety
/// `ptr` and `len` must come from a returned output.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_wipe_free(ptr: *mut u8, len: usize) {
    let mut v = unsafe { take(ptr, len) };
    crate::runtime::wipe(&mut v);
}

// ------------------------------------------------------------- app sessions
//
// Noise IK responder sessions for apps (`replica-client-api.md` §12.3) and the
// live admission observation the host's trusted bridge consumes synchronously.
// Outputs are CBOR `[]` on failure (the session, if any, is discarded).

fn ok(items: Vec<Cbor>) -> u64 {
    give(cbor::encode(&Cbor::Array(items)).unwrap_or_default())
}

fn failed() -> u64 {
    ok(Vec::new())
}

/// [`ok`] for items holding plaintext: the items' byte strings and the consumed
/// encoding are wiped once encoded (the output itself is wiped by `dealloc`).
fn ok_secret(items: Vec<Cbor>) -> u64 {
    let mut array = Cbor::Array(items);
    let out = cbor::encode(&array).unwrap_or_default();
    if let Cbor::Array(items) = &mut array {
        for i in items.iter_mut() {
            if let Cbor::Bytes(b) = i {
                crate::runtime::wipe(b);
            }
        }
    }
    give(out)
}

/// Take an input that holds plaintext; wiped when the returned guard drops.
unsafe fn take_secret(ptr: *mut u8, len: usize) -> Wiped {
    Wiped(unsafe { take(ptr, len) })
}

/// A byte buffer wiped on drop.
struct Wiped(Vec<u8>);
impl std::ops::Deref for Wiped {
    type Target = Vec<u8>;
    fn deref(&self) -> &Vec<u8> {
        &self.0
    }
}
impl Drop for Wiped {
    fn drop(&mut self) {
        crate::runtime::wipe(&mut self.0);
    }
}

unsafe fn key32(ptr: *mut u8, len: usize) -> Option<[u8; 32]> {
    let mut v = unsafe { take(ptr, len) };
    let k: Option<[u8; 32]> = v.as_slice().try_into().ok();
    crate::runtime::wipe(&mut v);
    k
}

/// Install this wake's Noise static secret (input wiped). 1 on success.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_key(ptr: *mut u8, len: usize) -> u32 {
    let Some(k) = (unsafe { key32(ptr, len) }) else {
        return 0;
    };
    with(|s| {
        if let Some(old) = s.noise_static.as_mut() {
            crate::runtime::wipe(old);
        }
        s.noise_static = Some(k);
        s.noise.clear();
        1
    })
    .unwrap_or(0)
}

/// 1 when the installed Noise static key's public key is `pk` (32 bytes).
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_matches(ptr: *mut u8, len: usize) -> u32 {
    let pk = unsafe { take(ptr, len) };
    with(|s| {
        s.noise_static
            .as_ref()
            .is_some_and(|k| pk.len() == 32 && mdbn_noise::public_key(k)[..] == pk[..])
    })
    .map_or(0, u32::from)
}

/// Start a responder handshake bound to `prologue`; 0 when unavailable.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_start(ptr: *mut u8, len: usize) -> u32 {
    let prologue = unsafe { take(ptr, len) };
    with(|s| match s.noise_static {
        Some(k) => s.noise.start(&k, &prologue).unwrap_or(0),
        None => 0,
    })
    .unwrap_or(0)
}

/// Message 1: `[payload, initiator static]`.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_read1(h: u32, ptr: *mut u8, len: usize) -> u64 {
    let msg = unsafe { take_secret(ptr, len) };
    match with(|s| s.noise.read1(h, &msg)) {
        Some(Ok((payload, peer))) => {
            ok_secret(vec![Cbor::Bytes(payload), Cbor::Bytes(peer.to_vec())])
        }
        _ => failed(),
    }
}

/// READ-ONLY original app CP-query metadata from THIS State's actual Noise handle
/// and Engine. Fixed five-field public array or `[]` on refusal; no native proof
/// export/installation, current CP result, before-key barrier or serving hook.
/// Host declarations <=512 bytes before CBOR decode; ABI allocation predates cap.
/// Recheck current native/CP/phase after I/O before keys/effects/final output.
///
/// # Safety
/// `ptr` must come from `alloc(len)` and be initialised for that exact length.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_pitr_app_query(h: u32, ptr: *mut u8, len: usize) -> u64 {
    let declarations = unsafe { take(ptr, len) };
    let result = with(|s| {
        let caller = s.noise.app_caller(h)?;
        s.engine.original_app_query(&caller, &declarations).ok()
    })
    .flatten();
    match result {
        Some(bytes) => give(bytes),
        None => failed(),
    }
}

/// Message 2 carrying `payload`, with the host CSPRNG's 32-byte ephemeral (wiped):
/// `[m2]`.
///
/// # Safety
/// Both inputs must come from `alloc` with their lengths initialised.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_write2(
    h: u32,
    eptr: *mut u8,
    elen: usize,
    ptr: *mut u8,
    len: usize,
) -> u64 {
    let e = unsafe { key32(eptr, elen) };
    let payload = unsafe { take_secret(ptr, len) };
    let r = e.and_then(|mut e| {
        let r = with(|s| s.noise.write2(h, &e, &payload));
        crate::runtime::wipe(&mut e);
        r
    });
    match r {
        Some(Ok(m2)) => ok(vec![Cbor::Bytes(m2)]),
        _ => {
            with(|s| s.noise.drop_session(h));
            failed()
        }
    }
}

/// Encrypt one transport message: `[ciphertext]`.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_seal(h: u32, ptr: *mut u8, len: usize) -> u64 {
    let pt = unsafe { take_secret(ptr, len) };
    match with(|s| s.noise.seal(h, &pt)) {
        Some(Ok(c)) => ok(vec![Cbor::Bytes(c)]),
        _ => failed(),
    }
}

/// Decrypt one transport message: `[plaintext]`.
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_noise_open(h: u32, ptr: *mut u8, len: usize) -> u64 {
    let ct = unsafe { take(ptr, len) };
    match with(|s| s.noise.open(h, &ct)) {
        Some(Ok(p)) => ok_secret(vec![Cbor::Bytes(p)]),
        _ => failed(),
    }
}

/// End a Noise session.
#[unsafe(no_mangle)]
pub extern "C" fn hd_noise_drop(h: u32) {
    with(|s| s.noise.drop_session(h));
}

/// The live verified hosted admission ([`crate::admission_wire`]).
#[unsafe(no_mangle)]
pub extern "C" fn hd_admission() -> u64 {
    give(with(|s| crate::admission_wire::encode(&s.engine.admission())).unwrap_or_default())
}

/// This engine's wake instance (8 bytes, big-endian).
#[unsafe(no_mangle)]
pub extern "C" fn hd_wake_instance() -> u64 {
    give(with(|s| s.engine.wake_instance().to_be_bytes().to_vec()).unwrap_or_default())
}

/// 1 when the verified policy holds grant (16 bytes) for client key (32 bytes).
///
/// # Safety
/// `ptr` must come from `alloc(len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn hd_grant_ok(ptr: *mut u8, len: usize) -> u32 {
    let g = unsafe { take(ptr, len) };
    if g.len() != 48 {
        return 0;
    }
    let mut id = [0u8; 16];
    let mut pk = [0u8; 32];
    id.copy_from_slice(&g[..16]);
    pk.copy_from_slice(&g[16..]);
    with(|s| s.engine.grant_authorized(&B16(id), &pk)).map_or(0, u32::from)
}

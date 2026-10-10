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

use crate::do_index::{DoIndex, SqlHost};
use crate::runtime::{Engine, OpenConfig, Out};

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
    let mut cfg = unsafe { take(ptr, len) };
    let parsed = OpenConfig::decode(&cfg);
    crate::runtime::wipe(&mut cfg);
    let r = parsed.and_then(|c| {
        let collection = c.cfg.collection;
        let http = crate::log_http::LogHttpSigner::new(&c.secrets.sign_sk);
        let index = Rc::new(RefCell::new(DoIndex::new(Box::new(ImportSql))));
        let store = LogCache::open(index, SqlStoreLimits::default())
            .map_err(|e| crate::runtime::OpenFailure(format!("cache: {e}")))?;
        let host = Host {
            clock: Box::new(HostClock),
            entropy: Box::new(HostEntropy),
            zones: Box::new(HostZones),
        };
        Engine::open(c, store, host, HostedProfile::default()).map(|engine| State {
            engine,
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

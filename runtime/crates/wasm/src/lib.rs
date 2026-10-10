//! # mdbn-wasm: the WASM runtime
//!
//! **Responsibility.** Builds `runtime.wasm`: the core, the replica service and the
//! file layer behind a small raw ABI, for the TS SDK and the shared Obsidian runtime
//! (shared portable runtime). It is the artifact the size budget measures and the one
//! the determinism check replays.
//!
//! Host capabilities (clock, entropy, `FilePlatform`, `IndexStorage`, the log
//! service transport) will be WASM imports. There is no wasm-bindgen and no
//! `getrandom` JS backend: the host passes entropy in.
//!
//! **ABI** (wasm32 only). Outputs are packed as `(out_ptr << 32) | out_len`; the host
//! reads them and frees them with `dealloc`. Inputs are written into `alloc`ed memory
//! and consumed by the call.
//! - `alloc(len) -> ptr` and `dealloc(ptr, len)`;
//! - `replay(ptr, len) -> u64`: UTF-8 log in, JSON report out (`scripts/wasm-replay.mjs`);
//! - `rt_info() -> u64`: [`runtime::info`] (CBOR);
//! - `rt_open(ptr, len) -> u64`: open the runtime from a CBOR config; out is empty on
//!   success, else a UTF-8 error; new modules default to MemoryConstrained;
//! - `rt_open_profile(ptr, len, tag) -> u64`: trusted one-time bootstrap; fixed
//!   0 MemoryConstrained / 1 Desktop, others refused (input consumed and wiped);
//!   config CBOR unchanged. No session/query/grant profile override.
//! - `rt_hello(grant_ptr, grant_len, ptr, len) -> u64`: grant is empty (host) or
//!   48 bytes (grant ID ‖ client key); out is CBOR `[session, response frame]`;
//! - `rt_frame(session, ptr, len)`, `rt_close(session)`, `rt_tick(now_ms)`;
//! - `rt_poll() -> u64`: CBOR `[* [session, frame / null]]` ([`runtime::Runtime::poll_encoded`]).
//!
//! Imports (module `env`): `host_now_ms() -> f64`, `host_random(ptr, len)`,
//! `host_local_date(ms, tz_ptr, tz_len, out) -> u32` and `host_default_zone(out, cap) -> u32`.
//! See `packages/sdk/src/runtime/wasm.ts` for the JS side.
//!
//! **Rules.** Portable, like `mdbn-core`. The [`replay`] function is shared by the
//! WASM export and the native harness (`mdbn-conformance`), so both run identical
//! code.
//!
//! **Allowed dependencies.** Internal: `mdbn-core`, `mdbn-wire`, `mdbn-replica`,
//! `mdbn-store-file`.

#[cfg(feature = "app-runtime")]
pub mod app;
#[cfg(feature = "app-runtime")]
pub mod app_index;
pub mod runtime;

// Linked so the size budget measures the whole runtime as it grows.
use mdbn_store_file as _;

/// Replay a log of core operations and return the canonical JSON report
/// ([`mdbn_core::replay`]).
pub fn replay(input: &str) -> String {
    mdbn_core::replay::replay(input).to_json()
}

#[cfg(target_arch = "wasm32")]
#[allow(unsafe_code)]
mod abi {
    /// Allocate `len` bytes for the host to write into.
    #[unsafe(no_mangle)]
    pub extern "C" fn alloc(len: usize) -> *mut u8 {
        let mut v = std::mem::ManuallyDrop::new(Vec::<u8>::with_capacity(len));
        v.as_mut_ptr()
    }

    /// Free memory returned by [`alloc`] or by an output pointer.
    ///
    /// # Safety
    /// `ptr` and `len` must come from `alloc(len)` or a returned output.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
        drop(unsafe { Vec::from_raw_parts(ptr, 0, len) });
    }

    /// Replay the UTF-8 log at `ptr..ptr+len` (consumed) and return the output
    /// location packed as `(ptr << 32) | len`.
    ///
    /// # Safety
    /// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
    #[unsafe(no_mangle)]
    #[cfg(not(feature = "app-runtime"))]
    pub unsafe extern "C" fn replay(ptr: *mut u8, len: usize) -> u64 {
        let input = unsafe { Vec::from_raw_parts(ptr, len, len) };
        let out = match std::str::from_utf8(&input) {
            Ok(s) => super::replay(s),
            Err(_) => String::from("{\"error\":\"input is not UTF-8\"}"),
        };
        give(out.into_bytes())
    }

    fn give(out: Vec<u8>) -> u64 {
        let mut out = std::mem::ManuallyDrop::new(out);
        out.shrink_to_fit();
        ((out.as_mut_ptr() as u64) << 32) | out.len() as u64
    }

    /// Take ownership of an `alloc`ed input.
    unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
        if len == 0 {
            return Vec::new();
        }
        unsafe { Vec::from_raw_parts(ptr, len, len) }
    }

    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        /// Same-Worker app SQL. Legacy hosts supply a denying stub, never RAM fallback.
        #[cfg(feature = "app-runtime")]
        fn host_app_sql(ptr: *const u8, len: usize) -> u64;
        fn host_now_ms() -> f64;
        fn host_random(ptr: *mut u8, len: usize);
        /// Writes `YYYY-MM-DD` of `instant_ms` in zone `tz` to `out` (10 bytes);
        /// returns 10, or 0 for an unknown zone.
        fn host_local_date(instant_ms: f64, tz: *const u8, tz_len: usize, out: *mut u8) -> u32;
        /// Writes the host's IANA zone to `out` (up to `cap` bytes); returns its length.
        fn host_default_zone(out: *mut u8, cap: usize) -> u32;
    }

    struct HostZones;
    impl mdbn_replica::replica::TimeZones for HostZones {
        fn local_date(&self, instant_ms: i64, tz: &str) -> Option<String> {
            let mut out = [0u8; 10];
            let n = unsafe {
                host_local_date(instant_ms as f64, tz.as_ptr(), tz.len(), out.as_mut_ptr())
            };
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

    // The SDK host_random import is backed by crypto.getRandomValues. Embedders
    // must supply a CSPRNG; a deterministic source is only valid in tests.
    impl mdbn_replica::crypto::CsprngEntropy for HostEntropy {}

    enum Active {
        #[cfg(not(feature = "app-runtime"))]
        Legacy(Box<super::runtime::Runtime>),
        #[cfg(feature = "app-runtime")]
        App(Box<super::app::AppRuntime>),
    }
    impl Active {
        fn hello(
            &mut self,
            grant: Option<(mdbn_wire::common::Uuid, [u8; 32])>,
            frame: &[u8],
        ) -> (u64, Vec<u8>) {
            match self {
                #[cfg(not(feature = "app-runtime"))]
                Self::Legacy(r) => r.hello(grant, frame),
                #[cfg(feature = "app-runtime")]
                Self::App(r) => r.hello(grant, frame),
            }
        }
        fn frame(&mut self, session: u64, frame: &[u8]) {
            match self {
                #[cfg(not(feature = "app-runtime"))]
                Self::Legacy(r) => r.frame(session, frame),
                #[cfg(feature = "app-runtime")]
                Self::App(r) => r.frame(session, frame),
            }
        }
        fn close(&mut self, session: u64) {
            match self {
                #[cfg(not(feature = "app-runtime"))]
                Self::Legacy(r) => r.close(session),
                #[cfg(feature = "app-runtime")]
                Self::App(r) => r.close(session),
            }
        }
        fn tick(&mut self, now: i64) {
            match self {
                #[cfg(not(feature = "app-runtime"))]
                Self::Legacy(r) => r.tick(now),
                #[cfg(feature = "app-runtime")]
                Self::App(r) => r.tick(now),
            }
        }
        fn poll_encoded(&mut self) -> Vec<u8> {
            match self {
                #[cfg(not(feature = "app-runtime"))]
                Self::Legacy(r) => r.poll_encoded(),
                #[cfg(feature = "app-runtime")]
                Self::App(r) => r.poll_encoded(),
            }
        }
        #[cfg(feature = "app-runtime")]
        fn app(&mut self) -> Option<&mut super::app::AppRuntime> {
            match self {
                Self::App(r) => Some(r),
            }
        }
    }

    #[cfg(feature = "app-runtime")]
    struct ImportAppSql;
    #[cfg(feature = "app-runtime")]
    impl super::app_index::AppSqlHost for ImportAppSql {
        fn run(&mut self, request: &[u8]) -> Option<Vec<u8>> {
            let packed = unsafe { host_app_sql(request.as_ptr(), request.len()) };
            let ptr = (packed >> 32) as usize;
            let len = (packed & 0xffff_ffff) as usize;
            let end = ptr.checked_add(len)?;
            let memory = core::arch::wasm32::memory_size::<0>().checked_mul(65_536)?;
            let start = request.as_ptr() as usize;
            let request_end = start.checked_add(request.len())?;
            if ptr == 0
                || len == 0
                || len > super::app_index::LIMITS.max_bytes
                || end > memory
                || (ptr < request_end && end > start)
            {
                return None;
            }
            // The import must allocate with this instance's alloc(len), exactly once.
            Some(unsafe { take(ptr as *mut u8, len) })
        }
    }

    // One runtime per instance; JS is single-threaded per instance.
    static mut RUNTIME: Option<Active> = None;
    // Call IDs can restart in a new Replica. Never reuse a module after app
    // shutdown/open refusal: late host callbacks must not address a successor.
    #[cfg(feature = "app-runtime")]
    static mut APP_OPEN_ATTEMPTED: bool = false;
    #[cfg(feature = "app-runtime")]
    static mut APP_DEVICE_ATTEMPTED: bool = false;
    #[cfg(feature = "app-runtime")]
    static mut APP_DEVICE: Option<super::app::device::DeviceIdentity> = None;
    #[allow(static_mut_refs)]
    #[cfg(feature = "app-runtime")]
    fn device() -> Option<&'static mut super::app::device::DeviceIdentity> {
        unsafe { APP_DEVICE.as_mut() }
    }
    #[cfg(feature = "app-runtime")]
    fn retire_device_lifetime() {
        unsafe {
            APP_DEVICE = None;
            APP_OPEN_ATTEMPTED = true;
        }
        if let Some(r) = rt().and_then(Active::app) {
            r.retire_log();
        }
    }

    #[allow(static_mut_refs)]
    fn rt() -> Option<&'static mut Active> {
        unsafe { RUNTIME.as_mut() }
    }

    /// CBOR info for the shared-runtime registry.
    #[unsafe(no_mangle)]
    pub extern "C" fn rt_info() -> u64 {
        give(super::runtime::info())
    }

    /// Open the runtime.
    ///
    /// # Safety
    /// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
    #[unsafe(no_mangle)]
    #[allow(static_mut_refs)]
    pub unsafe extern "C" fn rt_open(ptr: *mut u8, len: usize) -> u64 {
        unsafe { rt_open_profile(ptr, len, 0) }
    }

    /// Trusted host bootstrap, not a mutable policy setter. Inputs are consumed
    /// and wiped on ordinary refusal paths too; traps require discarding the module.
    ///
    /// # Safety
    /// `ptr` must come from `alloc(len)` and hold `len` initialised bytes.
    #[unsafe(no_mangle)]
    #[allow(static_mut_refs)]
    pub unsafe extern "C" fn rt_open_profile(ptr: *mut u8, len: usize, profile_tag: u32) -> u64 {
        let mut cfg = unsafe { take(ptr, len) };
        #[cfg(feature = "app-runtime")]
        {
            let _ = profile_tag;
            super::runtime::wipe(&mut cfg);
            give(b"app artifact requires trusted rt_app_open; MemStore open refused".to_vec())
        }
        #[cfg(not(feature = "app-runtime"))]
        {
            if unsafe { RUNTIME.is_some() } {
                super::runtime::wipe(&mut cfg);
                return give(b"runtime is already open".to_vec());
            }
            let host = mdbn_replica::Host {
                clock: Box::new(HostClock),
                entropy: Box::new(HostEntropy),
                zones: Box::new(HostZones),
            };
            let opened = super::runtime::Runtime::open_consuming(&mut cfg, host, profile_tag);
            match opened {
                Ok(r) => {
                    unsafe { RUNTIME = Some(Active::Legacy(Box::new(r))) };
                    give(Vec::new())
                }
                Err(e) => give(e.0.into_bytes()),
            }
        }
    }

    /// Trusted first-party app open. No Store swap or unauthenticated fallback.
    ///
    /// # Safety
    /// Input must be this instance's alloc(len); consumed and wiped on ordinary returns.
    #[unsafe(no_mangle)]
    #[allow(static_mut_refs)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_open(ptr: *mut u8, len: usize) -> u64 {
        let mut config = unsafe { take(ptr, len) };
        if unsafe { APP_OPEN_ATTEMPTED || APP_DEVICE_ATTEMPTED || RUNTIME.is_some() } {
            if unsafe { APP_DEVICE_ATTEMPTED } {
                retire_device_lifetime();
            }
            super::runtime::wipe(&mut config);
            return give(b"app module already used; discard and reopen".to_vec());
        }
        unsafe { APP_OPEN_ATTEMPTED = true };
        let host = mdbn_replica::Host {
            clock: Box::new(HostClock),
            entropy: Box::new(HostEntropy),
            zones: Box::new(HostZones),
        };
        match super::app::AppRuntime::open_consuming(&mut config, Box::new(ImportAppSql), host) {
            Ok(r) => {
                unsafe { RUNTIME = Some(Active::App(Box::new(r))) };
                give(Vec::new())
            }
            Err(_) => give(b"app runtime open failed; reopen and reconcile".to_vec()),
        }
    }

    /// HOST ONLY, after actual transport authentication and scope checks.
    ///
    /// # Safety
    /// Collection bytes must be this instance's alloc(len), consumed.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_log_bind(endpoint: u64, ptr: *mut u8, len: usize) -> u32 {
        let bytes = unsafe { take(ptr, len) };
        if bytes.len() != 16 {
            return 0;
        }
        let mut collection = [0; 16];
        collection.copy_from_slice(&bytes);
        rt().and_then(Active::app).is_some_and(|r| {
            r.bind_log(
                mdbn_replica::log::EndpointId(endpoint),
                mdbn_wire::common::B16(collection),
            )
        }) as u32
    }
    /// Read-only verified-policy handover witness consumer, READ-gated session.
    ///
    /// # Safety
    /// Inputs are exact nonoverlapping same-instance alloc allocations, consumed.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_verify_handover(
        session: u64,
        dp: *mut u8,
        dn: usize,
        wp: *mut u8,
        wn: usize,
    ) -> u64 {
        let mut device = unsafe { take(dp, dn) };
        let mut bytes = unsafe { take(wp, wn) };
        let result = rt().and_then(Active::app).map_or_else(Vec::new, |r| {
            r.verify_handover_consuming(session, &mut device, &mut bytes)
        });
        super::runtime::wipe(&mut device);
        super::runtime::wipe(&mut bytes);
        give(result)
    }
    /// Read-only app-runtime Bases execution, current READ/full-collection gated.
    /// Request consumed/wiped; complete bounded success or canonical Problem.
    ///
    /// # Safety
    /// Input is an initialized, same-instance allocation from alloc(len).
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_bases_execute(session: u64, ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let result = rt().and_then(Active::app).map_or_else(
            || {
                super::app::bases::refusal(
                    mdbn_replica::api::ErrorCode::Unavailable
                        .problem("app runtime is not ready for Bases execution"),
                )
            },
            |r| r.bases_execute_consuming(session, &mut bytes),
        );
        super::runtime::wipe(&mut bytes);
        give(result)
    }
    /// Bounded native metadata discovery using the actual resident READ session.
    ///
    /// # Safety
    /// Input is an initialized, same-instance allocation from alloc(len).
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_bases_list_views(
        session: u64,
        ptr: *mut u8,
        len: usize,
    ) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let result = rt().and_then(Active::app).map_or_else(
            || {
                super::app::bases::refusal(
                    mdbn_replica::api::ErrorCode::Unavailable
                        .problem("app runtime is not ready for Bases discovery"),
                )
            },
            |r| r.bases_list_views_consuming(session, &mut bytes),
        );
        super::runtime::wipe(&mut bytes);
        give(result)
    }
    /// Exact current source/revision/ordinal READ, never a path/alias selection.
    ///
    /// # Safety
    /// Input is an initialized, same-instance allocation from alloc(len).
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_bases_read_view_source(
        session: u64,
        ptr: *mut u8,
        len: usize,
    ) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let result = rt().and_then(Active::app).map_or_else(
            || {
                super::app::bases::refusal(
                    mdbn_replica::api::ErrorCode::Unavailable
                        .problem("app runtime is not ready for Bases source read"),
                )
            },
            |r| r.bases_read_view_source_consuming(session, &mut bytes),
        );
        super::runtime::wipe(&mut bytes);
        give(result)
    }
    /// Authenticated host-only one-time connector pin, before log binding.
    ///
    /// # Safety
    /// Connector UUID must come from alloc(len), consumed/wiped on every path.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_cp_bind_connector(ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = if let Ok(connector) = <[u8; 16]>::try_from(bytes.as_slice()) {
            rt().and_then(Active::app)
                .is_some_and(|r| r.bind_cp_connector(mdbn_wire::common::B16(connector)))
        } else {
            false
        };
        super::runtime::wipe(&mut bytes);
        accepted as u32
    }
    /// Protected device ONLY bootstrap, BEFORE registration/collection/SQL.
    /// Public tuple + opaque Noise envelope only; never plaintext seeds.
    ///
    /// # Safety
    /// Exact owned8-field protected loan from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    #[allow(static_mut_refs)]
    pub unsafe extern "C" fn rt_app_device_open(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        if unsafe { APP_DEVICE_ATTEMPTED || APP_OPEN_ATTEMPTED || RUNTIME.is_some() } {
            super::runtime::wipe(&mut bytes);
            retire_device_lifetime();
            return give(Vec::new());
        }
        unsafe {
            APP_DEVICE_ATTEMPTED = true;
        }
        match super::app::device::DeviceIdentity::open_consuming(&mut bytes, &mut HostEntropy) {
            Ok((owner, out)) => {
                unsafe {
                    APP_DEVICE = Some(owner);
                }
                give(out)
            }
            Err(_) => {
                retire_device_lifetime();
                give(Vec::new())
            }
        }
    }
    /// HOST ONLY actual registration response or protected stored receipt.
    /// Exact scope/public tuple, not collection policy/approval/unlock/readiness.
    ///
    /// # Safety
    /// Exact owned six-field public receipt from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_device_registered(ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = device().is_some_and(|r| r.acknowledge_registration_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        if !accepted {
            retire_device_lifetime();
        }
        accepted as u32
    }
    /// HOST ONLY ONCE prospective collection pin in registered-device phase.
    /// No roots/Core/SQL/LS/readiness authority. Strict approval deferred in v1.
    ///
    /// # Safety
    /// Owned fixed two-field public scope from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_private_collection_pin(ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = device()
            .is_some_and(|r| r.pin_private_collection_consuming(&mut bytes, &mut HostEntropy));
        super::runtime::wipe(&mut bytes);
        if !accepted {
            retire_device_lifetime();
        }
        accepted as u32
    }
    /// HOST ONLY public default-enrol marker after protected platform unwrap.
    /// Exact native tuple/scope, ONCE, no r/state/new commit or strict authority.
    ///
    /// # Safety
    /// Owned fixed10-field marker from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_private_enrol_restore(ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = device().is_some_and(|r| r.restore_private_enrol_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        if !accepted {
            retire_device_lifetime();
        }
        accepted as u32
    }
    /// Public native-generated commitment ONLY. No caller commitment or r/state.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_private_enrol_commitment() -> u64 {
        give(device().map_or_else(Vec::new, |r| r.private_enrol_commitment()))
    }
    /// Fixed private-create CBOR proof, signature ONLY.
    ///
    /// # Safety
    /// Owned challenge32 from alloc(len), consumed/wiped; no overrides.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_private_create_sign(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let out = device().map_or_else(Vec::new, |r| r.sign_private_create_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        if out.is_empty() {
            retire_device_lifetime();
        }
        give(out)
    }
    /// Fixed default password/AK1 private-device-enrol proof, signature ONLY;
    /// SAS commitment comes from the native owner, never caller-selected bytes.
    ///
    /// # Safety
    /// Owned challenge32 from alloc(len), consumed/wiped; no overrides.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_private_device_enrol_sign(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let out = device().map_or_else(Vec::new, |r| {
            r.sign_private_device_enrol_consuming(&mut bytes)
        });
        super::runtime::wipe(&mut bytes);
        if out.is_empty() {
            retire_device_lifetime();
        }
        give(out)
    }
    /// HOST ONLY once-pinned original cloud-copy collection/create-or-join.
    ///
    /// # Safety
    /// Exact owned public two-field map from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_cloud_copy_pin(ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = device().is_some_and(|r| r.pin_cloud_copy_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        if !accepted {
            retire_device_lifetime();
        }
        accepted as u32
    }
    /// Fixed native cloud-copy-create transcript only; no caller domain/digest.
    ///
    /// # Safety
    /// Owned challenge32 from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_cloud_copy_create_sign(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let out =
            device().map_or_else(Vec::new, |r| r.sign_cloud_copy_create_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        if out.is_empty() {
            retire_device_lifetime();
        }
        give(out)
    }
    /// Fixed native cloud-copy-join transcript only; no caller domain/digest.
    ///
    /// # Safety
    /// Owned challenge32 from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_cloud_copy_join_sign(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let out = device().map_or_else(Vec::new, |r| r.sign_cloud_copy_join_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        if out.is_empty() {
            retire_device_lifetime();
        }
        give(out)
    }
    /// Consuming adoption of SAME native owners after registration and genuine
    /// collection trust/readiness. Separate metadata v2, NO caller seed loans.
    ///
    /// # Safety
    /// Exact owned metadata16-field envelope from alloc(len), consumed/wiped.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    #[allow(static_mut_refs)]
    pub unsafe extern "C" fn rt_app_device_adopt(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        if unsafe { APP_OPEN_ATTEMPTED || !APP_DEVICE_ATTEMPTED || RUNTIME.is_some() } {
            super::runtime::wipe(&mut bytes);
            retire_device_lifetime();
            return give(b"app device adoption failed; reopen and reconcile".to_vec());
        }
        unsafe {
            APP_OPEN_ATTEMPTED = true;
        }
        let Some(owner) = (unsafe { APP_DEVICE.take() }) else {
            super::runtime::wipe(&mut bytes);
            return give(b"app device adoption failed; reopen and reconcile".to_vec());
        };
        let host = mdbn_replica::Host {
            clock: Box::new(HostClock),
            entropy: Box::new(HostEntropy),
            zones: Box::new(HostZones),
        };
        match owner.adopt_consuming(&mut bytes, Box::new(ImportAppSql), host) {
            Ok(r) => {
                unsafe {
                    RUNTIME = Some(Active::App(Box::new(r)));
                }
                give(Vec::new())
            }
            Err(_) => give(b"app device adoption failed; reopen and reconcile".to_vec()),
        }
    }
    /// Terminal retirement of EITHER phase, preserving uncertain external state.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_device_retire() {
        retire_device_lifetime();
    }
    /// Fixed cp-enrol proof; signature and native protected public tuple ONLY.
    ///
    /// # Safety
    /// Challenge32 from alloc(len), consumed/wiped on all ordinary paths.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_cp_enrol_sign(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let result = device().map_or_else(Vec::new, |r| r.sign_cp_enrol_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        give(result)
    }
    /// Fixed collection-log-token purpose; returns ONLY a signature or refusal.
    ///
    /// # Safety
    /// Challenge32 must come from alloc(len), consumed/wiped on every path.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_cp_log_token_sign(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let signature = rt()
            .and_then(Active::app)
            .map_or_else(Vec::new, |r| r.sign_cp_log_token_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        give(signature)
    }
    /// Current opaque log lifetime, zero before bind/after terminal retirement.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_log_generation() -> u64 {
        rt().and_then(Active::app).map_or(0, |r| r.log_generation())
    }
    /// Fixed ls-http transcript for one outstanding original/associated commit.
    /// Only a 64-byte signature is returned, never a seed or generic digest signer.
    ///
    /// # Safety
    /// Envelope must come from alloc(len), consumed/wiped even on refusal.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_log_http_sign(
        endpoint: u64,
        generation: u64,
        original: u64,
        ptr: *mut u8,
        len: usize,
    ) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let signature = rt().and_then(Active::app).map_or_else(Vec::new, |r| {
            r.sign_http_consuming(
                mdbn_replica::log::EndpointId(endpoint),
                generation,
                mdbn_replica::log::CallId(original),
                &mut bytes,
            )
        });
        super::runtime::wipe(&mut bytes);
        give(signature)
    }
    /// Original scoped, canonical host calls.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_log_calls() -> u64 {
        give(
            rt().and_then(Active::app)
                .map_or_else(Vec::new, |r| r.log_calls_encoded()),
        )
    }
    /// Original ID, method and current scope are checked by Rust before decoding.
    ///
    /// # Safety
    /// Reply must come from alloc(len), consumed. IDs stay lossless u64.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_log_reply(id: u64, ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = rt()
            .and_then(Active::app)
            .is_some_and(|r| r.log_reply(mdbn_replica::log::CallId(id), &bytes));
        super::runtime::wipe(&mut bytes);
        accepted as u32
    }
    /// Unknown outcome, not a rejection.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_log_no_response(id: u64) {
        if let Some(r) = rt().and_then(Active::app) {
            r.no_response(mdbn_replica::log::CallId(id));
        }
    }
    /// HOST ONLY SAME authenticated foreground/CP-notification reconnect after
    /// draining/aborting old transport. No push-channel/readiness/identity claim.
    ///
    /// # Safety
    /// Collection bytes from alloc(len), consumed/wiped on ordinary paths.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_log_reconnect(endpoint: u64, ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let ok = <[u8; 16]>::try_from(bytes.as_slice())
            .ok()
            .is_some_and(|collection| {
                rt().and_then(Active::app).is_some_and(|r| {
                    r.reconnect_log(
                        mdbn_replica::log::EndpointId(endpoint),
                        mdbn_wire::common::B16(collection),
                    )
                })
            });
        super::runtime::wipe(&mut bytes);
        u32::from(ok)
    }
    /// Retire before transport/module shutdown.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_log_retire() {
        if unsafe { APP_DEVICE_ATTEMPTED } {
            retire_device_lifetime();
            return;
        }
        if let Some(r) = rt().and_then(Active::app) {
            r.retire_log();
        }
    }
    /// Authenticated service push, never a wire lifecycle transition.
    ///
    /// # Safety
    /// Bytes must come from alloc(len), consumed.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_log_push(ptr: *mut u8, len: usize) -> u32 {
        let mut bytes = unsafe { take(ptr, len) };
        let accepted = rt()
            .and_then(Active::app)
            .is_some_and(|r| r.log_push(&bytes));
        super::runtime::wipe(&mut bytes);
        accepted as u32
    }
    /// HOST ONLY protected R32 loan; native collection-bound production AK1
    /// self-grant. No derived keys/signature export, approval or keyed inference.
    ///
    /// # Safety
    /// Bytes from alloc(len), consumed/wiped on every ordinary path.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_account_key_unlock(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let out = rt()
            .and_then(Active::app)
            .map_or_else(Vec::new, |r| r.unlock_account_key_consuming(&mut bytes));
        super::runtime::wipe(&mut bytes);
        give(out)
    }
    /// HOST ONLY protected R32 loan: production KEY_GRANT setup of the EXACT
    /// CP-enrolled recovery device. Status is recovery-device keyed, NOT app keyed.
    ///
    /// # Safety
    /// Bytes from alloc(len), consumed/wiped on every ordinary path.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub unsafe extern "C" fn rt_app_account_key_device_setup(ptr: *mut u8, len: usize) -> u64 {
        let mut bytes = unsafe { take(ptr, len) };
        let out = rt().and_then(Active::app).map_or_else(Vec::new, |r| {
            r.setup_account_key_device_consuming(&mut bytes)
        });
        super::runtime::wipe(&mut bytes);
        give(out)
    }
    /// Actual applied-policy/trust account unlock status, no guessed readiness.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_account_key_status() -> u64 {
        give(
            rt().and_then(Active::app)
                .map_or_else(Vec::new, |r| r.account_key_state()),
        )
    }
    /// Read-only startup/store/keyring observations.
    #[unsafe(no_mangle)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_observations() -> u64 {
        give(
            rt().and_then(Active::app)
                .map_or_else(Vec::new, |r| r.observations()),
        )
    }
    /// Drop keys/runtime after retiring log scopes. 1 allows a clean SQL close;
    /// it does NOT mean pending mutations were confirmed or saved.
    #[unsafe(no_mangle)]
    #[allow(static_mut_refs)]
    #[cfg(feature = "app-runtime")]
    pub extern "C" fn rt_app_shutdown() -> u32 {
        if unsafe { APP_DEVICE_ATTEMPTED } {
            unsafe {
                APP_DEVICE = None;
                APP_OPEN_ATTEMPTED = true;
            }
        }
        if !matches!(unsafe { RUNTIME.as_ref() }, Some(Active::App(_))) {
            return 0;
        }
        let Some(Active::App(mut r)) = (unsafe { RUNTIME.take() }) else {
            return 0;
        };
        r.retire_log();
        r.healthy() as u32
    }

    /// Open a session.
    ///
    /// # Safety
    /// Both inputs must come from `alloc` (an empty grant may be `(0, 0)`).
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn rt_hello(gptr: *mut u8, glen: usize, ptr: *mut u8, len: usize) -> u64 {
        let grant = unsafe { take(gptr, glen) };
        let frame = unsafe { take(ptr, len) };
        let Some(r) = rt() else {
            return give(Vec::new());
        };
        if !grant.is_empty() && grant.len() != 48 {
            return give(Vec::new());
        }
        let grant = if grant.len() == 48 {
            let mut id = [0u8; 16];
            let mut pk = [0u8; 32];
            id.copy_from_slice(&grant[..16]);
            pk.copy_from_slice(&grant[16..]);
            Some((mdbn_wire::common::B16(id), pk))
        } else {
            None
        };
        let (s, resp) = r.hello(grant, &frame);
        let out = mdbn_wire::cbor::Cbor::Array(vec![
            mdbn_wire::cbor::Cbor::Uint(s),
            mdbn_wire::cbor::Cbor::Bytes(resp),
        ]);
        give(mdbn_wire::cbor::encode(&out).unwrap_or_default())
    }

    /// A frame from a session's client.
    ///
    /// # Safety
    /// `ptr` must come from `alloc(len)`.
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn rt_frame(session: u64, ptr: *mut u8, len: usize) {
        let frame = unsafe { take(ptr, len) };
        if let Some(r) = rt() {
            r.frame(session, &frame);
        }
    }

    /// The client's port closed.
    #[unsafe(no_mangle)]
    pub extern "C" fn rt_close(session: u64) {
        if let Some(r) = rt() {
            r.close(session);
        }
    }

    /// Run timers.
    #[unsafe(no_mangle)]
    pub extern "C" fn rt_tick(now_ms: f64) {
        if let Some(r) = rt() {
            r.tick(if now_ms.is_finite() { now_ms as i64 } else { 0 });
        }
    }

    /// Everything to deliver.
    #[unsafe(no_mangle)]
    pub extern "C" fn rt_poll() -> u64 {
        match rt() {
            Some(r) => give(r.poll_encoded()),
            None => give(Vec::new()),
        }
    }
}

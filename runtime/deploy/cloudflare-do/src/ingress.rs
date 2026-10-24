//! Bounded request-body ingestion. Content-Length only sizes the first booking
//! (never trusted as a bound); no Request::bytes/arrayBuffer: BYOB pulls at most
//! 64 KiB, plus one boundary byte.
use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
use std::cell::Cell;
use wasm_bindgen::{JsCast, JsValue};
use worker::Request;
use worker::wasm_bindgen_futures::{self, JsFuture};

/// Includes the largest 9 MiB import object and its CBOR envelope.
pub(crate) const RPC_CAP: usize = 10 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
// Account conservatively for body/JS/decode copies across async requests.
const MEMORY_BUDGET: usize = 64 * 1024 * 1024;
thread_local! {
    static RESERVED:Cell<usize>=const{Cell::new(0)};
    static PEAK:Cell<usize>=const{Cell::new(0)};
}
pub(crate) fn reserved() -> usize {
    RESERVED.with(Cell::get)
}
/// Highest booking since the last call (debug hook); restarts from current.
pub(crate) fn take_peak() -> usize {
    PEAK.with(|p| p.replace(reserved()))
}
fn book(next: usize) {
    RESERVED.with(|used| used.set(next));
    PEAK.with(|p| p.set(p.get().max(next)));
}
#[derive(Debug)]
pub(crate) struct Reject(pub(crate) u16);
struct Permit(usize);
impl Permit {
    fn reserve(cap: usize) -> Result<Self, Reject> {
        let cost = cap.max(CHUNK).checked_mul(4).ok_or(Reject(413))?;
        RESERVED.with(|used| {
            let next = used.get().checked_add(cost).ok_or(Reject(503))?;
            if next > MEMORY_BUDGET {
                return Err(Reject(503));
            }
            book(next);
            Ok(Self(cost))
        })
    }
    /// Extend this request's credits to `cost`; nonwaiting like `reserve`.
    fn grow(&mut self, cost: usize) -> Result<(), Reject> {
        if cost <= self.0 {
            return Ok(());
        }
        RESERVED.with(|used| {
            let next = used.get().checked_add(cost - self.0).ok_or(Reject(503))?;
            if next > MEMORY_BUDGET {
                return Err(Reject(503));
            }
            book(next);
            self.0 = cost;
            Ok(())
        })
    }
    fn reduce(&mut self, cost: usize) {
        assert!(cost <= self.0);
        RESERVED.with(|v| v.set(v.get() - (self.0 - cost)));
        self.0 = cost;
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        RESERVED.with(|v| v.set(v.get() - self.0));
    }
}
/// Holds the memory reservation through decoding/dispatch, not just reading.
pub(crate) struct Body {
    pub(crate) bytes: Vec<u8>,
    permit: Permit,
}
impl Body {
    /// Rust's buffer is dropped after copying into the forwarded JS Request.
    /// Retain accounting for its JS body until forwarding completes. The actor
    /// independently reserves its WASM/decode budget (including same-isolate).
    pub(crate) fn forwarded(mut self) -> impl Drop {
        self.permit.reduce(self.bytes.len().max(CHUNK) * 2);
        self.permit
    }
}
fn method(object: &JsValue, name: &str) -> Result<Function, Reject> {
    Reflect::get(object, &JsValue::from_str(name))
        .map_err(|_| Reject(400))?
        .dyn_into()
        .map_err(|_| Reject(400))
}
fn discard(promise: JsValue) {
    if let Ok(p) = promise.dyn_into::<Promise>() {
        wasm_bindgen_futures::spawn_local(async move {
            let _ = JsFuture::from(p).await;
        });
    }
}
/// Cancel a rejected, otherwise unread body without draining it into memory.
pub(crate) fn cancel(req: &Request) {
    if let Some(stream) = req.inner().body()
        && let Ok(f) = method(stream.as_ref(), "cancel")
        && let Ok(p) = f.call0(stream.as_ref())
    {
        discard(p);
    }
}
struct Reader {
    raw: JsValue,
    done: bool,
}
impl Drop for Reader {
    fn drop(&mut self) {
        if !self.done
            && let Ok(f) = method(&self.raw, "cancel")
            && let Ok(p) = f.call0(&self.raw)
        {
            discard(p);
        }
        if let Ok(f) = method(&self.raw, "releaseLock") {
            let _ = f.call0(&self.raw);
        }
    }
}
/// Consume at most cap+1 bytes, cancel on every rejection/error, and copy no
/// over-limit chunk into WASM. An absent body is the empty body. Byte-stream
/// support is mandatory: no unbounded default-reader/arrayBuffer fallback.
pub(crate) async fn read(req: &Request, cap: usize) -> Result<Body, Reject> {
    let result = read_inner(req, cap).await;
    if result.is_err() {
        cancel(req);
    }
    result
}
/// Credits for the bytes a body may still deliver. Content-Length only sizes
/// the up-front reservation: without one, the whole cap is reserved before any
/// read. Bytes beyond a declared length extend the credits per chunk, so a lie
/// still cannot exceed the shared budget or the cap. A declared length over the
/// cap (or not representable) is refused before any booking or read.
fn cost(bytes: usize) -> usize {
    bytes.max(CHUNK) * 4
}
fn declared(req: &Request, cap: usize) -> Result<usize, Reject> {
    let Some(v) = req
        .headers()
        .get("content-length")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty() && v.bytes().all(|b| b.is_ascii_digit()))
    else {
        return Ok(cap);
    };
    match v.parse::<usize>() {
        Ok(n) if n <= cap => Ok(n),
        _ => Err(Reject(413)),
    }
}
async fn read_inner(req: &Request, cap: usize) -> Result<Body, Reject> {
    let mut covered = declared(req, cap)?;
    let mut permit = Permit::reserve(covered)?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(covered).map_err(|_| Reject(503))?;
    let Some(stream) = req.inner().body() else {
        return Ok(Body { bytes, permit });
    };
    let opts = Object::new();
    Reflect::set(&opts, &"mode".into(), &"byob".into()).map_err(|_| Reject(400))?;
    let raw = method(stream.as_ref(), "getReader")?
        .call1(stream.as_ref(), &opts)
        .map_err(|_| Reject(400))?;
    let mut reader = Reader { raw, done: false };
    loop {
        let n = (cap - bytes.len() + 1).min(CHUNK);
        // The boundary byte past cap is rejected before it is copied.
        let need = (bytes.len() + n).min(cap);
        if need > covered {
            permit.grow(cost(need))?;
            bytes
                .try_reserve(need - bytes.len())
                .map_err(|_| Reject(503))?;
            covered = need;
        }
        let view = Uint8Array::new_with_length(n as u32);
        let promise: Promise = method(&reader.raw, "read")?
            .call1(&reader.raw, &view)
            .map_err(|_| Reject(400))?
            .dyn_into()
            .map_err(|_| Reject(400))?;
        let result = JsFuture::from(promise).await.map_err(|_| Reject(400))?;
        let done = Reflect::get(&result, &"done".into())
            .map_err(|_| Reject(400))?
            .as_bool()
            .ok_or(Reject(400))?;
        let value = Reflect::get(&result, &"value".into()).map_err(|_| Reject(400))?;
        if !value.is_undefined() {
            let chunk: Uint8Array = value.dyn_into().map_err(|_| Reject(400))?;
            let len = chunk.length() as usize;
            if len > n || len > cap - bytes.len() {
                return Err(Reject(413));
            }
            let old = bytes.len();
            bytes.resize(old + len, 0);
            chunk.copy_to(&mut bytes[old..]);
            if len == 0 && !done {
                return Err(Reject(400));
            }
        } else if !done {
            return Err(Reject(400));
        }
        if done {
            reader.done = true;
            return Ok(Body { bytes, permit });
        }
    }
}

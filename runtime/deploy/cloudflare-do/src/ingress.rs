//! Bounded request-body ingestion. Never trust Content-Length or call
//! Request::bytes/arrayBuffer: BYOB pulls at most 64 KiB, plus one boundary byte.
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
thread_local! {static RESERVED:Cell<usize>=const{Cell::new(0)};}
pub(crate) fn reserved() -> usize {
    RESERVED.with(Cell::get)
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
            used.set(next);
            Ok(Self(cost))
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
async fn read_inner(req: &Request, cap: usize) -> Result<Body, Reject> {
    let permit = Permit::reserve(cap)?;
    let mut bytes = Vec::new();
    bytes.try_reserve_exact(cap).map_err(|_| Reject(503))?;
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

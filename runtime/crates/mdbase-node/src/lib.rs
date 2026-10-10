//! # mdbase-node: the Node.js addon behind `mdbase/node`
//!
//! **Responsibility.** Exposes [`mdbase::Collection`] to JavaScript through
//! napi-rs. The addon is deliberately thin: one class, `Collection`, with
//! `open`, `init`, `attach`, `call(op, args)` and `close`. Every call is JSON
//! text in, JSON text out (`{ok: …}` or `{error: {code, message, help, …}}`),
//! and the typed TypeScript API lives in `packages/mdbase/src/node/`. One
//! generic entry means adding a method never changes the binary interface.
//!
//! A `mdbase::Collection` is single-threaded, so each JS `Collection` owns a
//! thread that holds it; calls are queued to that thread and awaited on the
//! libuv pool (`AsyncTask`), never blocking the event loop.
//!
//! **Rules.** Native only, real I/O: exempt from the portability lints.
//!
//! **Allowed dependencies.** Internal: `mdbase`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]
#![allow(unsafe_code)]

mod ops;

use std::sync::mpsc::{Receiver, Sender, channel};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

type Job = Box<dyn FnOnce(&mdbase::Collection) -> Value + Send>;

/// A pending result on the collection's thread.
pub struct Call {
    rx: Receiver<Value>,
}

impl Task for Call {
    type Output = Value;
    type JsValue = String;

    fn compute(&mut self) -> Result<Value> {
        Ok(self.rx.recv().unwrap_or_else(|_| closed()))
    }

    fn resolve(&mut self, _env: Env, output: Value) -> Result<String> {
        Ok(output.to_string())
    }
}

fn closed() -> Value {
    ops::error_value(
        "closed",
        "the collection is closed",
        "Open it again with Collection.open().",
    )
}

/// A task that already has its answer.
fn ready(v: Value) -> AsyncTask<Call> {
    let (tx, rx) = channel::<Value>();
    let _ = tx.send(v);
    AsyncTask::new(Call { rx })
}

/// Parse a JSON argument; `{}` when empty.
fn parse(s: &str) -> std::result::Result<Value, Value> {
    if s.trim().is_empty() {
        return Ok(Value::Object(Default::default()));
    }
    serde_json::from_str(s).map_err(|e| {
        ops::error_value(
            "invalid_json",
            &e.to_string(),
            "Arguments must be JSON text.",
        )
    })
}

enum Msg {
    Run(Job, Sender<Value>),
    Close(Sender<Value>),
}

/// A collection hosted on its own thread.
#[napi]
pub struct Collection {
    tx: std::sync::Mutex<Option<Sender<Msg>>>,
}

fn spawn(open: impl FnOnce() -> mdbase::Result<mdbase::Collection> + Send + 'static) -> Call {
    let (done_tx, done_rx) = channel::<Value>();
    std::thread::Builder::new()
        .name("mdbase-collection".into())
        .spawn(move || {
            let col = match open() {
                Ok(c) => c,
                Err(e) => {
                    let _ = done_tx.send(ops::error_json(&e));
                    return;
                }
            };
            let (tx, rx) = channel::<Msg>();
            let _ = done_tx.send(serde_json::json!({ "ok": true, "__channel": register(tx) }));
            for msg in rx {
                match msg {
                    Msg::Run(job, reply) => {
                        let _ = reply.send(job(&col));
                    }
                    Msg::Close(reply) => {
                        col.close();
                        let _ = reply.send(serde_json::json!({ "ok": null }));
                        return;
                    }
                }
            }
        })
        .expect("spawn the collection thread");
    Call { rx: done_rx }
}

/// Channels handed from an opening thread to the JS object: `open`/`init`
/// resolve to a token that `attach` redeems.
type Registry = (u64, Vec<(u64, Sender<Msg>)>);
static CHANNELS: std::sync::Mutex<Registry> = std::sync::Mutex::new((1, Vec::new()));

fn register(tx: Sender<Msg>) -> u64 {
    let mut slots = CHANNELS.lock().expect("channel registry");
    let id = slots.0;
    slots.0 += 1;
    slots.1.push((id, tx));
    id
}

fn take(id: u64) -> Option<Sender<Msg>> {
    let mut slots = CHANNELS.lock().expect("channel registry");
    let i = slots.1.iter().position(|(k, _)| *k == id)?;
    Some(slots.1.swap_remove(i).1)
}

#[napi]
impl Collection {
    /// Start opening `root` with JSON `options` (`{stateDir?, constrained?,
    /// timezone?, takeOver?, client?: [name, version]}`). Resolves to
    /// `{ok: true, __channel}` or `{error}`; pass `__channel` to `attach`.
    #[napi]
    pub fn open(root: String, options: String) -> AsyncTask<Call> {
        match parse(&options) {
            Ok(o) => AsyncTask::new(spawn(move || ops::open(&root, &o))),
            Err(e) => ready(e),
        }
    }

    /// Like `open`, after creating the folder and `mdbase.yaml` if missing.
    /// `init` is `{name?, timezone?}`.
    #[napi]
    pub fn init(root: String, init: String, options: String) -> AsyncTask<Call> {
        match (parse(&init), parse(&options)) {
            (Ok(i), Ok(o)) => AsyncTask::new(spawn(move || ops::init(&root, &i, &o))),
            (Err(e), _) | (_, Err(e)) => ready(e),
        }
    }

    /// Redeem the `__channel` token from `open`/`init`.
    #[napi]
    pub fn attach(channel: f64) -> Result<Collection> {
        let tx = take(channel as u64).ok_or_else(|| {
            Error::from_reason("unknown collection channel; call open() or init() first")
        })?;
        Ok(Collection {
            tx: std::sync::Mutex::new(Some(tx)),
        })
    }

    /// Run `op` with JSON `args` on the collection's thread. Resolves to
    /// `{ok: result}` or `{error: {code, message, help, location?, details?}}`.
    #[napi]
    pub fn call(&self, op: String, args: String) -> AsyncTask<Call> {
        let args = match parse(&args) {
            Ok(a) => a,
            Err(e) => return ready(e),
        };
        let (reply_tx, reply_rx) = channel::<Value>();
        let job: Job = Box::new(move |col| ops::dispatch(col, &op, &args));
        let sent = self
            .tx
            .lock()
            .ok()
            .and_then(|g| {
                g.as_ref()
                    .map(|tx| tx.send(Msg::Run(job, reply_tx)).is_ok())
            })
            .unwrap_or(false);
        if !sent {
            return ready(closed());
        }
        AsyncTask::new(Call { rx: reply_rx })
    }

    /// Flush and release the folder. Idempotent.
    #[napi]
    pub fn close(&self) -> AsyncTask<Call> {
        let (reply_tx, reply_rx) = channel::<Value>();
        let tx = self.tx.lock().ok().and_then(|mut g| g.take());
        match tx {
            Some(tx) if tx.send(Msg::Close(reply_tx)).is_ok() => {
                AsyncTask::new(Call { rx: reply_rx })
            }
            _ => ready(serde_json::json!({ "ok": null })),
        }
    }
}

//! LAB smoke and timing driver for a running `mdbase` daemon (test tooling only).
//!
//! Registers a disposable local collection, then opens a host session over the
//! real local IPC replica endpoint (Noise IK, keychain-derived host key), and
//! times: registration (cold open + first scan), session open, query, write
//! (submit, wait confirmed) and read-back. Prints one JSON object.
//!
//! ```sh
//! lab_smoke --state-dir <profile> --dir <parent> [--records 10000] [--repeat 5] [--keep]
//! lab_smoke --state-dir <profile> --collection <id> [--records N] [--repeat 5]
//! ```
//!
//! With `--collection`, an already registered collection is reused (warm
//! timings; nothing is seeded, registered or removed; `--records` is only the
//! query-all limit). Its smoke files are written as `smoke-<ms>-<n>.md`.
//!
//! The daemon must be running on the same profile and signed in (registration
//! needs the paired account). The collection folder is created fresh under
//! `--dir` and is unregistered (and deleted) at the end unless `--keep`.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::PathBuf;
use std::time::{Duration, Instant};

use mdbn_daemon::client::ControlClient;
use mdbn_daemon::control::{CollectionState, CollectionStatus, Method};
use mdbn_daemon::paths::Profile;
use mdbn_daemon::secrets;
use mdbn_daemon::session::{ClientSession, Prologue, request};
use mdbn_wire::Wire;
use mdbn_wire::cbor::Cbor;
use mdbn_wire::client::{
    ClientFrame, ClientRequest, ClientResponse, HelloParams, QueryResult, Receipt, ReceiptState,
    RecordView, SubmitParams, WaitFor,
};
use mdbn_wire::common::{B16, Text, Value, Version};
use mdbn_wire::intent::{Create, Op};
use serde_json::json;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

struct Args {
    state_dir: PathBuf,
    dir: PathBuf,
    records: u64,
    repeat: u32,
    keep: bool,
    collection: Option<String>,
}

fn args() -> Res<Args> {
    let mut a = std::env::args().skip(1);
    let mut state_dir = std::env::var_os("MDBASE_HOME").map(PathBuf::from);
    let (mut dir, mut records, mut repeat, mut keep) = (None, 10_000, 5, false);
    let mut collection = None;
    while let Some(k) = a.next() {
        let mut v = || a.next().ok_or(format!("{k} needs a value"));
        match k.as_str() {
            "--state-dir" => state_dir = Some(v()?.into()),
            "--dir" => dir = Some(PathBuf::from(v()?)),
            "--records" => records = v()?.parse()?,
            "--repeat" => repeat = v()?.parse()?,
            "--keep" => keep = true,
            "--collection" => collection = Some(v()?),
            other => return Err(format!("unknown argument {other}").into()),
        }
    }
    Ok(Args {
        state_dir: state_dir.ok_or("--state-dir or MDBASE_HOME is required")?,
        dir: dir.unwrap_or_default(),
        records,
        repeat: repeat.max(1),
        keep,
        collection,
    })
}

fn uuid16(s: &str) -> Res<[u8; 16]> {
    Ok(secrets::hex_decode(&s.replace('-', ""))?
        .try_into()
        .map_err(|_| "bad uuid")?)
}

fn random16() -> [u8; 16] {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS entropy");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

fn ms(d: Duration) -> f64 {
    (d.as_secs_f64() * 1000.0 * 10.0).round() / 10.0
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn map(entries: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        entries
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}

struct Session<S> {
    s: ClientSession<S>,
    next: u64,
}

impl<S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> Session<S> {
    async fn call(&mut self, method: &str, params: Cbor) -> Res<Cbor> {
        self.next += 1;
        let id = self.next;
        self.s
            .send(&ClientFrame::Request(ClientRequest {
                id,
                method: method.into(),
                params,
            }))
            .await?;
        let r: ClientResponse = tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                match self.s.recv().await {
                    Ok(Some(ClientFrame::Response(r))) if r.id == id => return Ok(r),
                    Ok(Some(_)) => continue,
                    Ok(None) => return Err("daemon closed the session".to_string()),
                    Err(e) => return Err(format!("{e:?}")),
                }
            }
        })
        .await
        .map_err(|_| format!("{method}: timed out"))??;
        if let Some(p) = r.problem {
            return Err(format!("{method}: {} {:?} {:?}", p.code, p.reason, p.message).into());
        }
        Ok(r.result.unwrap_or(Cbor::Null))
    }
}

fn document(i: u64) -> String {
    format!(
        "---\ntitle: Record {i}\npriority: {}\nstatus: {}\n---\nBody of record {i}.\n",
        i % 5,
        if i.is_multiple_of(3) { "done" } else { "open" }
    )
}

fn create(path: String, doc: String) -> SubmitParams {
    SubmitParams {
        ops: vec![Op::Create(Create {
            id: B16(random16()),
            path: Some(path),
            type_name: None,
            frontmatter: None,
            body: None,
            document: Some(Text::Inline(doc)),
        })],
        mutation_id: None,
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: Some(WaitFor::Confirmed),
    }
}

fn query(where_: &str, limit: i64) -> Cbor {
    let q = Value::Map(vec![
        ("where".into(), Value::Text(where_.into())),
        ("limit".into(), Value::Int(limit)),
    ]);
    map(vec![(0, q.to_cbor())])
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Res<()> {
    let a = args()?;
    let profile = Profile::resolve(Some(&a.state_dir))?;
    let store = secrets::store_for(&profile.secret_namespace(), &profile.state_dir);
    let ck = secrets::read_control_key(store.as_ref())?
        .ok_or("no control key in this profile's secret store (is the daemon initialised?)")?;
    let ident = secrets::read_daemon_identity(&profile.state_dir, &profile.identity_file())?;
    let daemon_pk: [u8; 32] = secrets::hex_decode(&ident.noise_pk)?
        .try_into()
        .map_err(|_| "bad daemon key")?;

    let mut c = ControlClient::connect(&profile.control).await?;
    if let Some(id) = &a.collection {
        let list = c
            .call(Method::COLLECTION_LIST, json!({}))
            .await
            .map_err(|e| format!("collection.list: {e:?}"))?;
        let cols: Vec<CollectionStatus> = serde_json::from_value(list)?;
        let col = cols
            .into_iter()
            .find(|x| x.id == *id)
            .ok_or("no such registered collection")?;
        let root = col.root.clone();
        let mut out = run(&a, &profile, &ck, &daemon_pk, &ident.device, &col, &root).await?;
        out["records"] = json!(a.records);
        out["collection"] = json!(col.id);
        out["warm"] = json!(true);
        println!("{}", serde_json::to_string_pretty(&out)?);
        return Ok(());
    }
    if a.dir.as_os_str().is_empty() {
        return Err("--dir is required".into());
    }
    // A fresh disposable folder with N records.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    let folder = a.dir.join(format!("lab-smoke-{stamp}"));
    std::fs::create_dir_all(&folder)?;
    let t = Instant::now();
    for i in 0..a.records {
        std::fs::write(folder.join(format!("r{i:06}.md")), document(i))?;
    }
    let seed_ms = ms(t.elapsed());

    let t = Instant::now();
    let added: CollectionStatus = serde_json::from_value(
        c.call(Method::COLLECTION_ADD, json!({ "path": folder }))
            .await
            .map_err(|e| format!("collection.add: {e:?}"))?,
    )?;
    let register_call_ms = ms(t.elapsed());
    if added.reason.is_some() {
        return Err(format!("collection not ready: {:?} {:?}", added.state, added.reason).into());
    }
    // The runtime opens in the background (first scan); wait for `ready`.
    let added = loop {
        let list = c
            .call(Method::COLLECTION_LIST, json!({}))
            .await
            .map_err(|e| format!("collection.list: {e:?}"))?;
        let cols: Vec<CollectionStatus> = serde_json::from_value(list)?;
        let col = cols
            .into_iter()
            .find(|x| x.id == added.id)
            .ok_or("collection vanished")?;
        match col.state {
            CollectionState::Ready => break col,
            CollectionState::Opening => tokio::time::sleep(Duration::from_millis(50)).await,
            other => return Err(format!("collection {other:?} {:?}", col.reason).into()),
        }
    };
    let register_ms = ms(t.elapsed());

    let result = run(
        &a,
        &profile,
        &ck,
        &daemon_pk,
        &ident.device,
        &added,
        &folder,
    )
    .await;

    if !a.keep {
        let _ = c
            .call(Method::COLLECTION_REMOVE, json!({ "collection": added.id }))
            .await;
        let _ = std::fs::remove_dir_all(&folder);
    }
    let mut out = result?;
    out["seed_files_ms"] = json!(seed_ms);
    out["register_call_ms"] = json!(register_call_ms);
    out["register_cold_open_ms"] = json!(register_ms);
    out["records"] = json!(a.records);
    out["collection"] = json!(added.id);
    out["kept"] = json!(a.keep);
    println!("{}", serde_json::to_string_pretty(&out)?);
    Ok(())
}

async fn run(
    a: &Args,
    profile: &Profile,
    ck: &[u8; 32],
    daemon_pk: &[u8; 32],
    device: &str,
    added: &CollectionStatus,
    folder: &std::path::Path,
) -> Res<serde_json::Value> {
    let host_sk = secrets::host_noise_secret(ck);
    let prologue = Prologue {
        collection: uuid16(&added.id)?,
        grant: [0; 16],
        target: uuid16(device)?,
    };
    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "lab_smoke".into(),
        client_version: mdbn_daemon::BINARY_VERSION.into(),
        features: None,
        timezone: None,
    };
    let t = Instant::now();
    let stream = mdbn_daemon::ipc::connect(&profile.replica).await?;
    let (s, resp) = ClientSession::connect(
        stream,
        &host_sk,
        daemon_pk,
        prologue,
        request(0, "hello", hello.to_cbor()),
    )
    .await
    .map_err(|e| format!("session: {e:?}"))?;
    if let Some(p) = resp.problem {
        return Err(format!("hello refused: {} {:?}", p.code, p.reason).into());
    }
    let session_open_ms = ms(t.elapsed());
    let mut s = Session { s, next: 0 };

    // Query: an indexed-shape filter over all records, and a count of everything.
    let (mut q_ms, mut q_rows) = (Vec::new(), 0);
    for _ in 0..a.repeat {
        let t = Instant::now();
        let r: QueryResult = Wire::from_cbor(&s.call("query", query("priority >= 3", 100)).await?)?;
        q_ms.push(ms(t.elapsed()));
        q_rows = r.records.len();
    }
    let t = Instant::now();
    let all: QueryResult = Wire::from_cbor(
        &s.call("query", query("true", a.records as i64 + 10))
            .await?,
    )?;
    let query_all_ms = ms(t.elapsed());

    // Write, wait confirmed, read back by path; the file must hold the write.
    let (mut w_ms, mut rb_ms) = (Vec::new(), Vec::new());
    let tag = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis();
    for n in 0..a.repeat {
        let path = format!("smoke-{tag}-{n}.md");
        let doc = format!("---\ntitle: Smoke {n}\npriority: {tag}\n---\nwritten by lab_smoke\n");
        let t = Instant::now();
        let rs: Vec<Receipt> = Wire::from_cbor(
            &s.call("submit", create(path.clone(), doc).to_cbor())
                .await?,
        )?;
        let receipt = rs.into_iter().next().ok_or("no receipt")?;
        if receipt.state != ReceiptState::Confirmed {
            return Err(format!("write not confirmed: {:?}", receipt.state).into());
        }
        w_ms.push(ms(t.elapsed()));
        let t = Instant::now();
        let v: RecordView = Wire::from_cbor(
            &s.call("get", map(vec![(0, Cbor::Text(path.clone()))]))
                .await?,
        )?;
        rb_ms.push(ms(t.elapsed()));
        let title = v.frontmatter.get("title");
        if !matches!(title, Some(Value::Text(t)) if *t == format!("Smoke {n}")) {
            return Err(format!("read-back mismatch for {path}: {title:?}").into());
        }
        let on_disk = std::fs::read_to_string(folder.join(&path))?;
        if !on_disk.contains(&format!("title: Smoke {n}")) {
            return Err(format!("{path} on disk does not hold the write").into());
        }
    }
    let new_rows: QueryResult = Wire::from_cbor(
        &s.call("query", query(&format!("priority == {tag}"), 100))
            .await?,
    )?;
    if new_rows.records.len() != a.repeat as usize {
        return Err(format!(
            "query after write: {} rows, want {}",
            new_rows.records.len(),
            a.repeat
        )
        .into());
    }
    Ok(json!({
        "ok": true,
        "binary_version": mdbn_daemon::BINARY_VERSION,
        "session_open_ms": session_open_ms,
        "query_filtered_ms_median": median(&mut q_ms),
        "query_filtered_rows": q_rows,
        "query_all_ms": query_all_ms,
        "query_all_rows": all.records.len(),
        "write_confirmed_ms_median": median(&mut w_ms.clone()),
        "read_back_ms_median": median(&mut rb_ms.clone()),
        "write_plus_read_back_ms_median": median(
            &mut w_ms.iter().zip(&rb_ms).map(|(a, b)| a + b).collect::<Vec<_>>()
        ),
        "repeat": a.repeat,
    }))
}

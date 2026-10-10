//! LAB test tooling (never shipped): preseed a fresh, never-touched benchmark
//! fixture's LOG through the native writer, so the hosted DO's first-ever open can be
//! measured using a genuine native writer against the isolated test log.
//!
//! The fixture's owner desktop (public test keys from `lab_fixture`) runs a real
//! daemon runtime against the isolated LAB log Worker, with log tokens from that
//! Worker's LAB-only stand-in issuer. Like `e2e/lab.mjs load`, it writes each
//! resource as its own mutation (`must_not_exist`), then the records in mutations of
//! 100 creates, each waited on until the log confirms it. It never talks to the
//! hosted Worker. The log must already hold exactly the fixture's control prefix
//! (`e2e/lab.mjs seed`); anything else stops it before a write.
//!
//! ```text
//! lab_preseed --fixture <fixture.json> --private <dir> --corpus <dir> --work <dir>
//! ```
//!
//! `--private` holds `lab-hosted.json` (issuer seed) and `lab-urls.json` (log URL),
//! 0600 in a 0700 directory. Receipts (mutation ID, log position) are appended to
//! `<private>/preseed-<key>.jsonl` and the first-ever provenance is written to
//! `<private>/first-ever-<key>.json` (`touched: false`), where `<key>` is the same
//! hash of the collection that `e2e/lab.mjs` uses. Nothing printed names the
//! collection, a device or a key. An unknown outcome stops it: no replay.
#![allow(clippy::disallowed_methods, clippy::disallowed_types)]

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use ed25519_dalek::{Signer, SigningKey};
use mdbn_daemon::logwire::{Token, TokenSource};
use mdbn_daemon::runtime::{Runtime, RuntimeConfig, Synced};
use mdbn_log_service::auth::{Claims, token_digest};
use mdbn_replica::DeviceSecrets;
use mdbn_replica::api::SessionAuth;
use mdbn_replica::policy::{EffectiveGrant, GrantSource};
use mdbn_wire::Wire;
use mdbn_wire::client::{
    ClientFrame, ClientRequest, HelloParams, Receipt, ReceiptState, SubmitParams, WaitFor,
};
use mdbn_wire::common::{B16, B32, Text, Version};
use mdbn_wire::intent::{Create, Op, ResourcePut};
use mdbn_wire::policy::CState;
use serde_json::Value;
use sha2::Digest;

const BATCH: usize = 100;

/// Published-key pins for one root and one policy key (test tooling).
fn pins(root: [u8; 32], policy: [u8; 32]) -> mdbn_replica::policy::PolicyPins {
    use mdbn_replica::policy::{PolicyKeyPin, PolicyPins, RootPin, key_id};
    PolicyPins {
        roots: vec![RootPin {
            root_id: key_id(&root),
            root_pk: B32(root),
        }],
        policy_keys: vec![PolicyKeyPin {
            key_id: key_id(&policy),
            policy_pk: B32(policy),
            root_id: key_id(&root),
        }],
    }
}

fn arg(name: &str) -> String {
    let args: Vec<String> = std::env::args().collect();
    args.iter()
        .position(|a| a == name)
        .and_then(|i| args.get(i + 1).cloned())
        .unwrap_or_else(|| panic!("{name} is required"))
}

fn unhex<const N: usize>(s: &str) -> [u8; N] {
    let b: Vec<u8> = (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect();
    b.try_into().expect("length")
}

fn uuid(s: &str) -> [u8; 16] {
    unhex(&s.replace('-', ""))
}

fn private_json(dir: &Path, name: &str) -> Value {
    let p = dir.join(name);
    mdbn_daemon::fsutil::verify_owner_only(&p).expect("private file must be owner-only");
    serde_json::from_slice(&std::fs::read(&p).expect("read private file")).expect("json")
}

#[cfg(not(unix))]
fn write_private(_: &Path, _: &[u8], _: bool) {
    panic!("LAB preseed requires Unix owner-only file creation; no permissive fallback");
}

#[cfg(unix)]
fn write_private(p: &Path, bytes: &[u8], append: bool) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .mode(0o600)
        .open(p)
        .expect("open private file");
    f.write_all(bytes).expect("write private file");
    f.sync_all().expect("sync private file");
}

/// Device tokens from the LAB Worker's stand-in issuer, scoped to the fixture.
struct LabTokens {
    issuer: SigningKey,
    device: B16,
    sign_pk: B32,
    collection: B16,
}

impl TokenSource for LabTokens {
    fn token(
        &self,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<Token, String>> + Send + '_>> {
        Box::pin(async move {
            let expires_at_ms = mdbn_daemon::fsutil::now_ms() as i64 + 10 * 60_000;
            let c = Claims {
                control_plane: false,
                device: Some(self.device),
                sign_pk: self.sign_pk,
                expires_at: expires_at_ms,
                collection: Some(self.collection),
            }
            .encode();
            let sig = self.issuer.sign(&token_digest(&c).0);
            Ok(Token {
                token: format!(
                    "{}.{}",
                    mdbn_wire::render::hex(&c),
                    mdbn_wire::render::hex(&sig.to_bytes())
                )
                .into(),
                expires_at_ms,
            })
        })
    }
    fn refused(&self) {}
    fn current(&self) -> Result<(), String> {
        Ok(())
    } // synthetic explicit-root fixture only
}

struct HostOnly;
impl GrantSource for HostOnly {
    fn grant(&self, _: &B16) -> Option<EffectiveGrant> {
        None
    }
}

fn req(id: u64, method: &str, params: mdbn_wire::cbor::Cbor) -> Vec<u8> {
    ClientFrame::Request(ClientRequest {
        id,
        method: method.into(),
        params,
    })
    .to_bytes()
    .expect("encode")
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    for e in std::fs::read_dir(dir).expect("corpus") {
        let p = e.expect("entry").path();
        if p.is_dir() {
            walk(&p, out);
        } else {
            out.push(p);
        }
    }
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(std::env::var("RUST_LOG").unwrap_or_else(|_| "warn".into()))
        .init();
    let fixture: Value = {
        let p = PathBuf::from(arg("--fixture"));
        mdbn_daemon::fsutil::verify_owner_only(&p).expect("fixture must be owner-only");
        serde_json::from_slice(&std::fs::read(&p).expect("fixture")).expect("fixture json")
    };
    let private = PathBuf::from(arg("--private"));
    let corpus = PathBuf::from(arg("--corpus"));
    let work = PathBuf::from(arg("--work"));
    let secrets = private_json(&private, "lab-hosted.json");
    let urls = private_json(&private, "lab-urls.json");
    let log_url = urls["log"].as_str().expect("log url").to_string();
    let col_str = fixture["collection"]
        .as_str()
        .expect("collection")
        .to_string();
    let collection = B16(uuid(&col_str));
    let key = mdbn_wire::render::hex(&sha2::Sha256::digest(col_str.as_bytes()))[..16].to_string();
    let provenance = private.join(format!("first-ever-{key}.json"));
    let receipts = private.join(format!("preseed-{key}.jsonl"));
    assert!(
        !provenance.exists() && !private.join(format!("touch-{key}.json")).exists(),
        "fixture already preseeded or touched"
    );
    let items: Vec<String> = fixture["items"]
        .as_array()
        .expect("items")
        .iter()
        .map(|v| v.as_str().expect("item").to_string())
        .collect();
    let genesis_bytes: Vec<u8> = (0..items[0].len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&items[0][i..i + 2], 16).expect("hex"))
        .collect();
    let owner = B16(uuid(fixture["owner"]["device"].as_str().expect("owner")));
    let sign_sk: [u8; 32] = unhex(fixture["owner"]["sign_sk"].as_str().expect("sign"));
    let kem_sk: [u8; 32] = unhex(
        fixture["owner"]["kem_sk"]
            .as_str()
            .expect("owner kem_sk (regenerate the fixture)"),
    );
    let issuer = SigningKey::from_bytes(&unhex(secrets["issuer_seed"].as_str().expect("issuer")));
    let sign_pk = B32(SigningKey::from_bytes(&sign_sk).verifying_key().to_bytes());

    // The corpus: resources first (mdbase.yaml, _types/*), then every other .md.
    let mut files = Vec::new();
    walk(&corpus, &mut files);
    let rel = |p: &Path| {
        p.strip_prefix(&corpus)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    };
    let mut files: Vec<String> = files.iter().map(|p| rel(p)).collect();
    files.sort();
    let resources: Vec<&String> = files
        .iter()
        .filter(|f| *f == "mdbase.yaml" || f.starts_with("_types/"))
        .collect();
    let records: Vec<&String> = files
        .iter()
        .filter(|f| !resources.contains(f) && f.ends_with(".md"))
        .collect();

    std::fs::create_dir_all(work.join("folder")).expect("work");
    let cfg = RuntimeConfig {
        collection: collection.0,
        replica_id: mdbn_daemon::secrets::new_uuid()
            .ok()
            .and_then(|s| mdbn_daemon::attest::uuid_bytes(&s))
            .expect("replica id"),
        device_id: owner.0,
        root: work.join("folder"),
        private_dir: work.join("state"),
        sync: Some(Synced {
            log_url,
            chosen_state: CState::CloudCopy,
            trusted_roots: vec![unhex(fixture["root_pk"].as_str().expect("root"))],
            trusted_signers: vec![owner.0],
            user_enabled_cloud_copy: true,
            tokens: Arc::new(LabTokens {
                issuer,
                device: owner,
                sign_pk,
                collection,
            }),
            secrets: Arc::new(mdbn_daemon::secrets::MemoryStore::default()),
            expected_genesis: mdbn_wire::hash::chain_hash(&genesis_bytes).0,
            policy_pins: pins(
                unhex(fixture["root_pk"].as_str().expect("root")),
                unhex(fixture["cp_pk"].as_str().expect("cp_pk")),
            ),
        }),
    };
    let rt = Runtime::open(
        cfg,
        DeviceSecrets { sign_sk, kem_sk },
        Box::new(HostOnly),
        Default::default(),
    )
    .unwrap_or_else(|e| panic!("open: {}", e.0));

    // Caught up with exactly the control prefix, keyed, no incidents.
    let t0 = Instant::now();
    loop {
        let s = rt.status().await.expect("status");
        assert!(
            s.incidents.is_empty(),
            "incident before any write: {:?}",
            s.incidents.iter().map(|i| i.kind).collect::<Vec<_>>()
        );
        if s.confirmed_through as usize == items.len() && s.head_known as usize == items.len() {
            break;
        }
        assert!(
            (s.head_known as usize) <= items.len(),
            "the log is not a fresh fixture (head {}); refusing to write",
            s.head_known
        );
        assert!(
            t0.elapsed() < Duration::from_secs(120),
            "never caught up with the control prefix"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    println!(
        "caught up with the control prefix ({} items) in {:?}",
        items.len(),
        t0.elapsed()
    );

    let hello = HelloParams {
        versions: vec![Version { major: 1, minor: 0 }],
        client_name: "lab-preseed".into(),
        client_version: "0".into(),
        features: None,
        timezone: None,
    };
    let (session, resp, mut out) = rt
        .hello(SessionAuth::Host, req(0, "hello", hello.to_cbor()))
        .await
        .expect("runtime");
    let session = session.unwrap_or_else(|| {
        panic!(
            "hello refused: {:?}",
            ClientFrame::from_bytes(&resp).map(|_| ())
        )
    });
    let mut next_id = 1u64;
    let mut submit = async |ops: Vec<Op>, id: u64| -> Receipt {
        let mutation = B16(uuid(&mdbn_daemon::secrets::new_uuid().expect("uuid")));
        let p = SubmitParams {
            ops,
            mutation_id: Some(mutation),
            conflict_mode: None,
            timezone: None,
            allow_partial: None,
            mutation_ids: None,
            dry_run: None,
            include: None,
            wait: Some(WaitFor::Confirmed),
        };
        assert!(rt.frame(session, req(id, "submit", p.to_cbor())));
        let r = tokio::time::timeout(Duration::from_secs(300), async {
            loop {
                let bytes = out.recv().await.expect("session open");
                if let ClientFrame::Response(r) = ClientFrame::from_bytes(&bytes).expect("frame")
                    && r.id == id
                {
                    assert!(
                        r.problem.is_none(),
                        "write refused: {:?}",
                        r.problem.map(|p| p.code)
                    );
                    let rs: Vec<Receipt> =
                        Wire::from_cbor(&r.result.expect("result")).expect("receipts");
                    break rs.into_iter().next().expect("one receipt");
                }
            }
        })
        .await
        .expect("no outcome within 300 s: stopping (no replay)");
        assert_eq!(
            r.state,
            ReceiptState::Confirmed,
            "unknown outcome: stopping (no replay)"
        );
        let line = format!(
            "{{\"mutation\":\"{}\",\"seq\":{},\"state\":\"confirmed\"}}\n",
            mutation.to_uuid_string(),
            r.seq.unwrap_or(0)
        );
        write_private(&receipts, line.as_bytes(), true);
        r
    };

    let t1 = Instant::now();
    for f in &resources {
        let doc = std::fs::read_to_string(corpus.join(f.as_str())).expect("resource");
        submit(
            vec![Op::ResourcePut(ResourcePut {
                path: (*f).clone(),
                doc: Text::Inline(doc),
                base_revision: None,
                must_not_exist: Some(true),
            })],
            next_id,
        )
        .await;
        next_id += 1;
    }
    let mut last = None;
    for (n, chunk) in records.chunks(BATCH).enumerate() {
        let ops = chunk
            .iter()
            .map(|f| {
                Op::Create(Create {
                    id: B16(uuid(&mdbn_daemon::secrets::new_uuid().expect("uuid"))),
                    path: Some((*f).clone()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(Text::Inline(
                        std::fs::read_to_string(corpus.join(f.as_str())).expect("record"),
                    )),
                })
            })
            .collect();
        last = submit(ops, next_id).await.seq;
        next_id += 1;
        if n % 10 == 0 {
            println!(
                "loaded {}/{}",
                ((n + 1) * BATCH).min(records.len()),
                records.len()
            );
        }
    }
    let (confirmed, digest) = rt.confirmed_digest().await.expect("digest");
    let status = rt.status().await.expect("status");
    let through = status.confirmed_through;
    rt.stop().await;
    write_private(
        &provenance,
        format!(
            "{{\"touched\":false,\"preseeded_at\":\"{}\",\"writer\":\"native-daemon-runtime\",\"resources\":{},\"records\":{},\"batch\":{BATCH},\"log_head\":{},\"confirmed_records\":{},\"confirmed_digest\":\"{}\"}}\n",
            mdbn_daemon::fsutil::now_ms(),
            resources.len(),
            records.len(),
            through,
            confirmed,
            mdbn_wire::render::hex(&digest)
        )
        .as_bytes(),
        false,
    );
    println!(
        "PASS: {} resources and {} records ({} confirmed) through log seq {} (last batch at {:?}) in {:?}; pending {}, incidents {}",
        resources.len(),
        records.len(),
        confirmed,
        through,
        last,
        t1.elapsed(),
        status.pending,
        status.incidents.len()
    );
}

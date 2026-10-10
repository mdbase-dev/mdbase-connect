//! The runtime the ABI wraps, run natively: open, info, hello over frames.

use mdbn_core::host::{Clock, Entropy};
use mdbn_replica::Host;
use mdbn_wasm::runtime::{ABI_MAJOR, Out, Runtime, info};
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::client::{ClientFrame, ClientRequest, HelloParams};
use mdbn_wire::common::Version;
use mdbn_wire::schema::Wire;

struct Fixed;
impl Clock for Fixed {
    fn now_ms(&self) -> u64 {
        1_791_100_000_000
    }
}
struct Counter(u8);
impl Entropy for Counter {
    fn fill(&mut self, buf: &mut [u8]) {
        for b in buf {
            self.0 = self.0.wrapping_add(1);
            *b = self.0;
        }
    }
}

// Deterministic entropy is confined to this native test harness.
impl mdbn_replica::crypto::CsprngEntropy for Counter {}

fn host() -> Host {
    Host {
        clock: Box::new(Fixed),
        entropy: Box::new(Counter(0)),
        zones: Box::new(mdbn_replica::replica::UtcOnly),
    }
}

fn config() -> Vec<u8> {
    let m = |k: u64, v: Cbor| (Cbor::Uint(k), v);
    cbor::encode(&Cbor::Map(vec![
        m(0, Cbor::Bytes(vec![1; 16])),
        m(1, Cbor::Bytes(vec![2; 16])),
        m(2, Cbor::Bytes(vec![3; 16])),
        m(3, Cbor::Uint(0)),
        m(4, Cbor::Bytes(vec![4; 32])),
        m(5, Cbor::Bytes(vec![5; 32])),
    ]))
    .unwrap()
}

#[test]
fn info_reports_abi_runtime_and_api() {
    let Cbor::Map(m) = cbor::decode(&info()).unwrap() else {
        panic!("map")
    };
    assert_eq!(m[0], (Cbor::Uint(0), Cbor::Uint(ABI_MAJOR)));
    assert!(matches!(&m[1].1, Cbor::Text(_)));
}

#[test]
fn open_validates_the_config() {
    assert!(Runtime::open(&config(), host()).is_ok());
    let bad = cbor::encode(&Cbor::Map(vec![(Cbor::Uint(0), Cbor::Bytes(vec![1; 3]))])).unwrap();
    assert!(Runtime::open(&bad, host()).is_err());
    assert!(Runtime::open(&[0xff], host()).is_err());
}

/// The generic runtime has no trust anchors: a synced (or synced-by-default)
/// config, or a local-only one carrying synced trust choices, is refused before
/// any key is used (trust-shape validation; synced app collections open through `app`).
#[test]
fn generic_open_refuses_a_synced_trust_shape() {
    let Cbor::Map(base) = cbor::decode(&config()).unwrap() else {
        unreachable!()
    };
    let mut synced = base.clone();
    synced[3].1 = Cbor::Uint(1);
    let mut default_synced = base.clone();
    default_synced.remove(3);
    let mut local_e2e = base;
    local_e2e.push((Cbor::Uint(6), Cbor::Bool(true)));
    for m in [synced, default_synced, local_e2e] {
        match Runtime::open(&cbor::encode(&Cbor::Map(m)).unwrap(), host()) {
            Err(err) => assert!(err.0.starts_with("host trust:"), "{}", err.0),
            Ok(_) => panic!("a synced trust shape opened"),
        }
    }
}

#[test]
fn trusted_profiles_are_per_instance_and_selected_before_serving() {
    use mdbn_replica::QueryExecutionProfile::{Desktop, MemoryConstrained};
    let default = Runtime::open(&config(), host()).unwrap();
    let desktop = Runtime::open_with_query_profile(&config(), host(), Desktop).unwrap();
    let constrained =
        Runtime::open_with_query_profile(&config(), host(), MemoryConstrained).unwrap();
    assert_eq!(default.query_execution_profile(), MemoryConstrained);
    assert_eq!(desktop.query_execution_profile(), Desktop);
    assert_eq!(constrained.query_execution_profile(), MemoryConstrained);
    assert_eq!(
        default
            .query_execution_profile()
            .fallback_source_limits()
            .unwrap()
            .records,
        1000
    );
}

#[test]
fn consuming_bootstrap_wipes_success_refusal_and_unknown_tags() {
    use mdbn_replica::QueryExecutionProfile::{Desktop, MemoryConstrained};
    for (tag, profile) in [(0, MemoryConstrained), (1, Desktop)] {
        let mut input = config();
        let runtime = Runtime::open_consuming(&mut input, host(), tag).unwrap();
        assert!(input.iter().all(|b| *b == 0));
        assert_eq!(runtime.query_execution_profile(), profile);
    }
    for tag in [2, u32::MAX] {
        let mut input = config();
        assert_eq!(
            Runtime::open_consuming(&mut input, host(), tag)
                .unwrap_err()
                .0,
            "unknown query execution profile"
        );
        assert!(input.iter().all(|b| *b == 0));
    }
    let mut trailing = config();
    trailing.push(0);
    for mut input in [
        vec![0xff],
        cbor::encode(&Cbor::Map(vec![])).unwrap(),
        trailing,
    ] {
        assert!(Runtime::open_consuming(&mut input, host(), 1).is_err());
        assert!(input.iter().all(|b| *b == 0));
    }
}

#[test]
fn hello_answers_with_a_response_frame() {
    let mut rt = Runtime::open(&config(), host()).unwrap();
    let hello = ClientFrame::Request(ClientRequest {
        id: 0,
        method: "hello".into(),
        params: HelloParams {
            versions: vec![Version { major: 1, minor: 0 }],
            client_name: "t".into(),
            client_version: "0".into(),
            features: None,
            timezone: None,
        }
        .to_cbor(),
    })
    .to_bytes()
    .unwrap();
    let (session, resp) = rt.hello(None, &hello);
    match ClientFrame::from_cbor(&cbor::decode(&resp).unwrap()).unwrap() {
        // Today the replica answers hello with `not_implemented`; once it opens
        // sessions this is a result and `session` is non-zero.
        ClientFrame::Response(r) => {
            assert_eq!(r.id, 0);
            assert_eq!(session == 0, r.problem.is_some());
        }
        other => panic!("{other:?}"),
    }
    // Frames for an unknown session are ignored, and polling is empty.
    rt.frame(42, &[0xa0]);
    assert_eq!(rt.poll(), Vec::<Out>::new());
    let polled = cbor::decode(&rt.poll_encoded()).unwrap();
    assert_eq!(polled, Cbor::Array(vec![]));
}

#[test]
fn wipe_zeroes_key_material() {
    let mut b = vec![7u8; 32];
    mdbn_wasm::runtime::wipe(&mut b);
    assert!(b.iter().all(|x| *x == 0));
}

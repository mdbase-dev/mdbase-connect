use super::*;
use crate::testutil::TestDir;
use mdbn_wire::common::B16;
use std::net::Ipv4Addr;
use std::os::unix::fs::PermissionsExt;

const IP: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);
const ORIGIN: &str = "https://example.org";

fn open(home: &TestDir) -> Credentials {
    std::fs::set_permissions(home.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    Credentials::open(
        &home.path().join("auth"),
        &home.path().join("collection"),
        Some((B16([7; 16]), &[ORIGIN.to_owned()])),
    )
    .unwrap()
}

#[test]
fn restart_preserves_the_whole_window_and_roll_forward_only_extends_its_tail() {
    let home = TestDir::new("calendar");
    let first = 1720;
    let store = open(&home);
    let (leaf, issued) = store.transport_calendar(IP, first).unwrap();
    drop(store);
    let store = open(&home);
    let (reopened, again) = store.transport_calendar(IP, first).unwrap();
    assert_eq!(leaf.cert, reopened.cert);
    assert!(leaf.key == reopened.key);
    assert_eq!(issued.hashes, again.hashes);
    assert_eq!(issued.hashes.len(), 32);
    for (offset, hash) in issued.hashes.iter().enumerate() {
        let slot = first + offset as i64;
        let der: Vec<u8> = store
            .db()
            .unwrap()
            .query_row(
                "SELECT cert FROM webtransport_leaf WHERE slot=?1",
                [slot],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(&sha256(&der).0, hash);
        let (_, cert) = x509_parser::parse_x509_certificate(&der).unwrap();
        assert_eq!(
            cert.validity().not_before.timestamp(),
            slot * 1036800 - 3600
        );
        assert_eq!(
            cert.validity().not_after.timestamp(),
            (slot + 1) * 1036800 + 3600
        );
    }
    assert_eq!(slot_at(-1), -1);
    let (next, advanced) = store.transport_calendar(IP, first + 3).unwrap();
    assert_eq!(sha256(&next.cert).0, issued.hashes[3]);
    assert_eq!(issued.hashes[3..], advanced.hashes[..29]);
    let bounds: (i64, i64, usize) = store
        .db()
        .unwrap()
        .query_row(
            "SELECT min(slot),max(slot),count(*) FROM webtransport_leaf",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(bounds, (first + 3, first + 34, 32));
    let disk = std::fs::read(home.path().join("auth/credentials.sqlite")).unwrap();
    assert!(
        !disk
            .windows(leaf.key.len())
            .any(|bytes| bytes == leaf.key.as_slice())
    );
    assert!(store.transport_calendar(IP, first + 1).is_err());
    let (_, jumped) = store.transport_calendar(IP, first + 64).unwrap();
    assert!(jumped.hashes.iter().all(|h| !advanced.hashes.contains(h)));
    assert_eq!(
        store.transport_calendar(IP, first + 64).unwrap().1.hashes,
        jumped.hashes
    );
}

#[test]
fn malformed_future_state_is_never_repaired_or_paired() {
    for edit in [
        "DELETE FROM webtransport_leaf WHERE slot=(SELECT max(slot) FROM webtransport_leaf)",
        "DELETE FROM webtransport_calendar",
        "UPDATE webtransport_calendar SET pins=zeroblob(1024)",
        "UPDATE webtransport_leaf SET cert=x'00' WHERE slot=(SELECT max(slot) FROM webtransport_leaf)",
        "UPDATE webtransport_leaf SET key=(SELECT key FROM webtransport_leaf ORDER BY slot LIMIT 1) WHERE slot=(SELECT max(slot) FROM webtransport_leaf)",
        "UPDATE webtransport_leaf SET slot=slot+40 WHERE slot=(SELECT max(slot) FROM webtransport_leaf)",
    ] {
        let home = TestDir::new("damaged-calendar");
        let store = open(&home);
        let first = current_slot();
        let (_, window) = store.transport_calendar(IP, first).unwrap();
        let code = store.pair(ORIGIN, "browser").unwrap();
        store.db().unwrap().execute(edit, []).unwrap();
        assert!(
            store
                .redeem(ORIGIN, code.as_bytes(), Some(&window))
                .is_err()
        );
        assert!(store.list(ORIGIN).unwrap().is_empty());
        drop(store);
        let store = open(&home);
        assert!(store.transport_calendar(IP, first + 1).is_err());
        assert!(store.transport_calendar(IP, first + 64).is_err());
    }
}

#[test]
fn stale_handshake_cannot_consume_a_pairing_code() {
    let home = TestDir::new("cross-slot-pair");
    let store = open(&home);
    let current = current_slot();
    let (_, old) = store.transport_calendar(IP, current - 1).unwrap();
    let (_, fresh) = store.transport_calendar(IP, current).unwrap();
    let code = store.pair(ORIGIN, "browser").unwrap();
    assert!(store.redeem(ORIGIN, code.as_bytes(), Some(&old)).is_err());
    assert!(store.list(ORIGIN).unwrap().is_empty());
    assert!(
        store
            .redeem(ORIGIN, code.as_bytes(), Some(&fresh))
            .unwrap()
            .is_some()
    );
}

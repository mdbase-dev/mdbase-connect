//! A replica pointed at a snapshot it refuses: install falls back to the older
//! retained snapshot (`snapshot.md` §8), the installer takes the semantics
//! ratchet from the manifest (§2), and a refused or failed snapshot upload is
//! not rebuilt on every tick (§5.3).

use mdbn_wire::client::IncidentKind;
use mdbn_wire::common::{B16, B32};
use mdbn_wire::policy::Role;

use super::engine::{COL, Node, node, settle};
use super::snapshot_trust::{
    device, draft, endorsed_after, incident, pointers, set_role, thirty_notes,
};
use crate::Store;
use crate::fake::FakeLogService;
use crate::log::{LogClient, LogError, LogErrorCode, LogPort};
use crate::mem::MemStore;
use crate::store::{RecordMeta, RecordRow, Tx, bucket16, meta_keys};

/// Every confirmed record's id, path and document.
fn docs(n: &Node) -> Vec<(B16, String, String)> {
    n.r.confirmed_records()
        .unwrap()
        .into_iter()
        .map(|r| (r.id, r.path, r.doc))
        .collect()
}

/// `b`'s store departs from the log: one document's text changes under its
/// honest revision. A snapshot `b` then builds passes every manifest check and
/// fails an installer's state digest.
fn tamper(b: &mut Node) {
    let mut row = b.r.confirmed_records().unwrap().remove(0);
    row.doc = "tampered text under the honest revision".into();
    b.r.store_mut()
        .commit(Tx {
            records_put: vec![row],
            ..Tx::default()
        })
        .unwrap();
}

/// The semantics ratchet as stored (`LOG_STATE` is `log_time ‖ sem_ratchet`).
fn stored_ratchet(n: &Node) -> u64 {
    let b = n.r.store().meta(meta_keys::LOG_STATE).unwrap().unwrap();
    u64::from_be_bytes(b[8..16].try_into().unwrap())
}

// ------------------------------------------------------------ fallback

/// The newest snapshot fails its state digest. The older retained snapshot is
/// good and the log is retained from it: the joiner installs the older one and
/// replays the entries after it.
#[test]
fn install_falls_back_to_the_older_snapshot_when_the_newest_fails_its_digest() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    let older = a.r.head().seq;
    for i in 30..35u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a, &mut b]);
    tamper(&mut b);
    b.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    let newest = b.r.head().seq;
    assert_eq!(
        pointers(&svc)
            .iter()
            .map(|p| (p.seq, p.author))
            .collect::<Vec<_>>(),
        vec![(newest, device(2)), (older, device(1))],
        "both snapshots are retained, newest first"
    );
    // The log is readable from the older snapshot.
    svc.compact(&COL, older);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.head(), a.r.head(), "the tail after it is replayed");
    assert_eq!(docs(&c), docs(&a));
}

/// The newest snapshot is signed by a device without write authority at its
/// position. The older one, from a writer, is installed instead.
#[test]
fn install_falls_back_to_the_older_snapshot_when_the_newest_signer_may_not_write() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut v = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut v]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut v]);
    let older = a.r.head().seq;
    let honest = docs(&a);
    set_role(&svc, Role::Viewer);
    settle(&mut [&mut a, &mut v]);
    // A modified client on the viewer's device: it forges a record and is told
    // it is an editor.
    let id = B16([0xee; 16]);
    v.r.store_mut()
        .commit(Tx {
            records_put: vec![RecordRow {
                id,
                path: "forged.md".into(),
                path_key: "forged.md".into(),
                doc: "forged by a viewer".into(),
                revision: mdbn_wire::hash::sha256(b"forged by a viewer"),
                modified_seq: 1,
                mtime: None,
                bucket: bucket16(&id),
                meta: RecordMeta::default(),
            }],
            ..Tx::default()
        })
        .unwrap();
    v.r.policy
        .members
        .insert(crate::testkit::TEST_OWNER, Role::Editor);
    v.r.build_snapshot_now().unwrap();
    settle(&mut [&mut v]);
    assert_eq!(pointers(&svc).len(), 2);
    assert_eq!(pointers(&svc)[0].author, device(2));
    svc.compact(&COL, older);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.head().seq, svc.head(&COL).0);
    assert_eq!(docs(&c), honest, "nothing of the forged snapshot");
}

/// The text of `n`'s incident of `kind`.
fn detail(n: &Node, kind: IncidentKind) -> String {
    let i =
        n.r.sync_status()
            .incidents
            .into_iter()
            .find(|i| i.kind == kind)
            .unwrap_or_else(|| panic!("no {kind:?} incident"));
    match i.details {
        Some(mdbn_wire::common::Value::Text(t)) => t,
        other => panic!("{other:?}"),
    }
}

/// Both retained snapshots fail their state digest. Nothing is installed, and
/// one incident names both failures.
#[test]
fn an_incident_names_both_snapshots_when_neither_installs() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    tamper(&mut b);
    b.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    let older = b.r.head().seq;
    for i in 30..35u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a, &mut b]);
    b.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(pointers(&svc).len(), 2);
    svc.compact(&COL, older);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.head().seq, 0);
    assert_eq!(docs(&c), vec![]);
    assert_eq!(c.r.sync_status().incidents.len(), 1);
    assert_eq!(
        detail(&c, IncidentKind::Integrity),
        "snapshot install: state digest mismatch; older snapshot: state digest mismatch"
    );
    // Nothing has changed at the service: the snapshots are not fetched again.
    let fetched = svc.object_gets(&COL).len();
    for _ in 0..5 {
        settle(&mut [&mut c]);
    }
    assert_eq!(svc.object_gets(&COL).len(), fetched);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.sync_status().incidents.len(), 1);
    // A newer snapshot is registered, a good one: it is installed.
    a.create(35, "n35.md", "doc 35");
    settle(&mut [&mut a, &mut b]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    assert_eq!(pointers(&svc)[0].author, device(1));
    settle(&mut [&mut c]);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(docs(&c), docs(&a));
}

/// A single retained snapshot is refused: there is no older one, and the
/// incident says so as before.
#[test]
fn a_single_refused_snapshot_is_an_incident() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut b = node(&svc, 2, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a, &mut b]);
    tamper(&mut b);
    b.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a, &mut b]);
    svc.compact(&COL, b.r.head().seq);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert_eq!(c.r.stats.snapshot_fallbacks, 0);
    assert_eq!(
        detail(&c, IncidentKind::Integrity),
        "snapshot install: state digest mismatch"
    );
    // It is not fetched again while it is the newest.
    let fetched = svc.object_gets(&COL).len();
    for _ in 0..5 {
        settle(&mut [&mut c]);
    }
    assert_eq!(svc.object_gets(&COL).len(), fetched);
}

/// `a` builds a snapshot, writes five more notes and builds a second one; the
/// log is retained from the first. Returns `a` and the objects only the second
/// snapshot has, without its manifest.
fn two_snapshots(svc: &FakeLogService) -> (Node, Vec<B32>) {
    let mut a = node(svc, 1, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let older = a.r.head().seq;
    let before: Vec<B32> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    for i in 30..35u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let ptrs = pointers(svc);
    assert_eq!(ptrs.len(), 2);
    let own = svc
        .objects(&COL)
        .into_iter()
        .map(|(h, _)| h)
        .filter(|h| !before.contains(h) && *h != ptrs[0].manifest)
        .collect();
    svc.compact(&COL, older);
    (a, own)
}

/// The service does not have the newest snapshot's manifest. It answers
/// `not_found`, and will again: the joiner installs the older snapshot.
#[test]
fn install_falls_back_to_the_older_snapshot_when_the_service_lacks_the_newest_manifest() {
    let svc = FakeLogService::new();
    let (a, _) = two_snapshots(&svc);
    svc.forget_object(&COL, &pointers(&svc)[0].manifest);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.head(), a.r.head(), "the tail after it is replayed");
    assert_eq!(docs(&c), docs(&a));
}

/// The service does not have one chunk of the newest snapshot. The joiner
/// installs the older snapshot.
#[test]
fn install_falls_back_to_the_older_snapshot_when_the_service_lacks_a_chunk_of_the_newest() {
    let svc = FakeLogService::new();
    let (a, own) = two_snapshots(&svc);
    let chunk = *own
        .last()
        .expect("the newest snapshot has chunks of its own");
    svc.forget_object(&COL, &chunk);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert!(svc.object_gets(&COL).contains(&chunk), "it was asked for");
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(docs(&c), docs(&a));
}

/// A single retained snapshot with a chunk the service does not have: an
/// incident that says so, and the snapshot is not fetched again.
#[test]
fn a_single_snapshot_with_a_missing_chunk_is_an_incident() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a]);
    let before: Vec<B32> = svc.objects(&COL).into_iter().map(|(h, _)| h).collect();
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let manifest = pointers(&svc)[0].manifest;
    let chunk = svc
        .objects(&COL)
        .into_iter()
        .map(|(h, _)| h)
        .find(|h| !before.contains(h) && *h != manifest)
        .unwrap();
    svc.forget_object(&COL, &chunk);
    svc.compact(&COL, a.r.head().seq);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert_eq!(c.r.head().seq, 0);
    assert_eq!(
        detail(&c, IncidentKind::Integrity),
        "snapshot install: the service does not have a chunk"
    );
    let fetched = svc.object_gets(&COL).len();
    for _ in 0..5 {
        settle(&mut [&mut c]);
    }
    assert_eq!(svc.object_gets(&COL).len(), fetched);
}

/// A service that cannot answer now is asked again: the install goes on.
#[test]
fn an_unavailable_service_does_not_refuse_the_snapshot() {
    let svc = FakeLogService::new();
    let (a, _) = two_snapshots(&svc);
    let mut c = node(&svc, 3, MemStore::new());
    let mut faults = vec![
        LogError::NoResponse,
        LogError::Offline,
        LogError::code(LogErrorCode::Unavailable),
        LogError::code(LogErrorCode::RateLimited),
        LogError::code(LogErrorCode::Unauthenticated),
    ];
    // One request of the install is answered with each, in turn.
    for _ in 0..100 {
        for push in c.log.poll_pushes() {
            c.r.on_log_push(push);
        }
        for call in c.r.take_log_calls() {
            let reply = if c.r.installing()
                && let Some(e) = faults.pop()
            {
                Err(e)
            } else {
                c.log.call(call.request)
            };
            c.r.on_log_reply(call.id, reply);
        }
        c.r.tick();
    }
    assert_eq!(faults, vec![]);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.stats.snapshot_fallbacks, 0);
    assert_eq!(c.r.head(), a.r.head());
}

// ------------------------------------------------------------ semantics ratchet

/// A joiner that installs a snapshot holds the log's semantics ratchet at the
/// snapshot's position, as a replica that replayed the log to there does.
#[test]
fn an_installer_holds_the_semantics_ratchet_at_the_snapshot() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    assert_eq!(a.r.sem_ratchet(), mdbn_core::semantics::SEM.major);
    svc.compact(&COL, a.r.head().seq);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(c.r.sem_ratchet(), a.r.sem_ratchet());
    assert_eq!(stored_ratchet(&c), stored_ratchet(&a));
}

/// `a` builds an honest snapshot, writes five more notes, and publishes a
/// second one whose manifest `edit` changed. The log is retained from the
/// first. Returns `a` and a joiner that has settled.
fn joins_after(
    edit: impl FnOnce(&mut mdbn_wire::attachment_runtime_v1::ManifestPayload),
) -> (Node, Node) {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a]);
    a.r.build_snapshot_now().unwrap();
    settle(&mut [&mut a]);
    let older = a.r.head().seq;
    for i in 30..35u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    let mut d = draft(&mut a, &svc);
    edit(&mut d.m);
    d.publish(&mut a, &svc, None);
    assert_eq!(pointers(&svc).len(), 2);
    svc.compact(&COL, older);
    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    (a, c)
}

/// The newest snapshot was built by a semantics major this build does not
/// have. The joiner does not install it; it installs the older one.
#[test]
fn a_snapshot_built_by_newer_semantics_is_not_installed() {
    let (a, c) = joins_after(|m| m.sem.major = mdbn_core::semantics::SEM.major + 1);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshots_installed, 1);
    assert_eq!(c.r.stats.snapshot_fallbacks, 1);
    assert_eq!(c.r.head(), a.r.head());
    assert_eq!(docs(&c), docs(&a));
}

/// With no older snapshot to install, a snapshot built by newer semantics asks
/// for an upgrade. It is not an integrity incident: nothing is wrong with it.
#[test]
fn a_snapshot_built_by_newer_semantics_alone_requires_an_upgrade() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    thirty_notes(&mut a);
    settle(&mut [&mut a]);
    let mut d = draft(&mut a, &svc);
    d.m.sem.major = mdbn_core::semantics::SEM.major + 1;
    d.publish(&mut a, &svc, None);
    svc.compact(&COL, a.r.head().seq);

    let mut c = node(&svc, 3, MemStore::new());
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert_eq!(c.r.sync_status().incidents.len(), 1);
    assert_eq!(
        detail(&c, IncidentKind::UpgradeRequired),
        "snapshot install: snapshot was built by newer semantics than this build has"
    );
    assert!(!incident(&c, IncidentKind::Integrity));
}

/// A builder newer by a minor version only: installed. Minors interleave.
#[test]
fn a_snapshot_built_by_a_newer_minor_installs() {
    let (a, c) = joins_after(|m| m.sem.minor += 1);
    assert_eq!(c.r.sync_status().incidents, vec![]);
    assert_eq!(c.r.stats.snapshot_fallbacks, 0);
    assert_eq!(c.r.head(), a.r.head());
}

/// The installer takes the manifest's ratchet, not its own. A manifest from a
/// build that does not write it installs as before and leaves the installer's.
/// The snapshot is at the head, so no later entry could have raised either.
#[test]
fn the_ratchet_is_the_manifests_and_absent_it_is_the_installers() {
    for (written, held) in [(true, mdbn_core::semantics::SEM.major), (false, 0)] {
        let svc = FakeLogService::new();
        let mut a = node(&svc, 1, MemStore::new());
        thirty_notes(&mut a);
        settle(&mut [&mut a]);
        let mut d = draft(&mut a, &svc);
        if !written {
            d.m.sem_ratchet = None;
        }
        d.publish(&mut a, &svc, None);
        svc.compact(&COL, a.r.head().seq);
        let mut c = node(&svc, 3, MemStore::new());
        settle(&mut [&mut c]);
        assert_eq!(c.r.stats.snapshots_installed, 1, "written: {written}");
        assert_eq!(c.r.sem_ratchet(), held, "written: {written}");
        assert_eq!(stored_ratchet(&c), held, "written: {written}");
    }
}

/// A replica that has applied entries holds the log's ratchet at its head. A
/// snapshot ahead of it whose ratchet is lower contradicts the log: refused.
#[test]
fn a_manifest_ratchet_below_the_installers_is_refused() {
    let svc = FakeLogService::new();
    let mut a = node(&svc, 1, MemStore::new());
    let mut c = node(&svc, 3, MemStore::new());
    a.create(0, "n0.md", "doc 0");
    settle(&mut [&mut a, &mut c]);
    assert_eq!(c.r.sem_ratchet(), mdbn_core::semantics::SEM.major);
    let head = c.r.head().seq;
    // `c` closes and falls behind retention.
    let store = c.r.into_store();
    for i in 1..30u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    let mut d = draft(&mut a, &svc);
    d.m.sem_ratchet = Some(0);
    d.publish(&mut a, &svc, None);
    svc.compact(&COL, a.r.head().seq);
    let mut c = node(&svc, 3, store);
    settle(&mut [&mut c]);
    assert_eq!(c.r.stats.snapshots_installed, 0);
    assert_eq!(c.r.head().seq, head);
    assert_eq!(
        detail(&c, IncidentKind::Integrity),
        "snapshot install: manifest semantics ratchet is below this replica's"
    );
}

/// An endorser at the snapshot's position holds the log's ratchet there. It
/// does not endorse a manifest that states another.
#[test]
fn a_snapshot_stating_another_ratchet_is_not_endorsed() {
    let (b, endorsed) = endorsed_after(|_, d| {
        d.m.sem_ratchet = Some(mdbn_core::semantics::SEM.major + 1);
    });
    assert!(!endorsed);
    assert!(incident(&b, IncidentKind::VerificationMismatch));
    // A manifest without it is from an older build: nothing to compare.
    let (b, endorsed) = endorsed_after(|_, d| d.m.sem_ratchet = None);
    assert!(endorsed);
    assert_eq!(b.r.sync_status().incidents, vec![]);
}

// ------------------------------------------------------------ upload retries

/// Ten notes at a ten-entry period: `a` is due a snapshot.
fn due(svc: &FakeLogService) -> Node {
    let mut a = node(svc, 1, MemStore::new());
    for i in 0..10u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    settle(&mut [&mut a]);
    a.r.snapshot_every = 10;
    a
}

/// A hundred ticks: whether `a` uploaded any snapshot object in them, that is,
/// whether it started a build.
fn builds(a: &mut Node) -> bool {
    let before = a.log.snapshot_puts;
    for _ in 0..5 {
        settle(&mut [a]);
    }
    a.log.snapshot_puts > before
}

fn wait(a: &Node, ms: u64) {
    a.clock.set(a.clock.get() + ms);
}

/// The service refuses the registration. The build is not repeated until the
/// head has moved by another period.
#[test]
fn a_refused_registration_is_not_rebuilt_until_the_next_period() {
    let svc = FakeLogService::new();
    let mut a = due(&svc);
    a.log.faults.put_snapshot_error = Some(LogError::code(LogErrorCode::Forbidden));
    settle(&mut [&mut a]);
    assert!(a.log.snapshot_puts > 0, "it built and was refused");
    assert!(!builds(&mut a), "not again at this head");
    wait(&a, 24 * 60 * 60 * 1000);
    assert!(!builds(&mut a), "however long it waits");
    for i in 10..19u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    assert!(!builds(&mut a), "nine entries on: not yet");
    a.create(19, "n19.md", "doc 19");
    assert!(builds(&mut a), "the next period tries again");
    assert!(!builds(&mut a), "once");
    assert_eq!(a.r.stats.snapshots_built, 0);
    assert_eq!(pointers(&svc), vec![]);
}

/// The service refuses an upload of the build (over quota, say). The same rule.
#[test]
fn a_refused_upload_is_not_rebuilt_until_the_next_period() {
    let svc = FakeLogService::new();
    let mut a = due(&svc);
    a.log.faults.put_object_error = Some(LogError::code(LogErrorCode::QuotaExceeded));
    settle(&mut [&mut a]);
    assert!(a.log.snapshot_puts > 0, "it built and was refused");
    assert!(!builds(&mut a), "not again at this head");
    a.log.faults.put_object_error = None;
    for i in 10..20u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    assert!(builds(&mut a), "the next period tries again");
    assert_eq!(a.r.stats.snapshots_built, 1);
}

/// The registration gets no answer. The build waits before it is tried again,
/// twice as long each time, and registers once the service answers.
#[test]
fn a_registration_without_an_answer_backs_off() {
    let svc = FakeLogService::new();
    let mut a = due(&svc);
    a.log.faults.put_snapshot_error = Some(LogError::NoResponse);
    settle(&mut [&mut a]);
    assert!(a.log.snapshot_puts > 0, "it built and heard nothing");
    assert!(!builds(&mut a), "not again before the wait is over");
    wait(&a, 1_000);
    assert!(builds(&mut a), "again after the first wait");
    wait(&a, 1_000);
    assert!(!builds(&mut a), "the second wait is twice as long");
    wait(&a, 1_000);
    assert!(builds(&mut a));
    a.log.faults.put_snapshot_error = None;
    wait(&a, 3_999);
    assert!(!builds(&mut a), "the third is four seconds");
    wait(&a, 1);
    assert!(builds(&mut a));
    assert_eq!(a.r.stats.snapshots_built, 1);
    assert_eq!(pointers(&svc).len(), 1);
    // A success ends the waiting: the next period builds at once.
    for i in 10..20u8 {
        a.create(i, &format!("n{i}.md"), &format!("doc {i}"));
    }
    assert!(builds(&mut a));
    assert_eq!(a.r.stats.snapshots_built, 2);
}

/// An upload of the build gets no answer. The same wait.
#[test]
fn an_upload_without_an_answer_backs_off() {
    let svc = FakeLogService::new();
    let mut a = due(&svc);
    a.log.faults.put_object_error = Some(LogError::NoResponse);
    settle(&mut [&mut a]);
    assert!(a.log.snapshot_puts > 0, "it built and heard nothing");
    assert!(!builds(&mut a), "not again before the wait is over");
    a.log.faults.put_object_error = None;
    wait(&a, 1_000);
    assert!(builds(&mut a));
    assert_eq!(a.r.stats.snapshots_built, 1);
}

/// The wait stops doubling at an hour.
#[test]
fn the_wait_between_unanswered_builds_is_at_most_an_hour() {
    const HOUR: u64 = 60 * 60 * 1000;
    let svc = FakeLogService::new();
    let mut a = due(&svc);
    a.log.faults.put_snapshot_error = Some(LogError::NoResponse);
    settle(&mut [&mut a]);
    // 1 s doubled twelve times is past an hour.
    for _ in 0..13 {
        wait(&a, HOUR);
        assert!(builds(&mut a));
    }
    wait(&a, HOUR - 1);
    assert!(!builds(&mut a));
    wait(&a, 1);
    assert!(builds(&mut a));
}

/// The service asks for a longer wait than the replica's own: it is kept.
#[test]
fn a_services_retry_hint_lengthens_the_wait() {
    let svc = FakeLogService::new();
    let mut a = due(&svc);
    a.log.faults.put_snapshot_error = Some(LogError::Service {
        code: LogErrorCode::RateLimited,
        reason: None,
        retry_after_ms: Some(30_000),
        missing: Vec::new(),
    });
    settle(&mut [&mut a]);
    assert!(a.log.snapshot_puts > 0);
    wait(&a, 29_999);
    assert!(!builds(&mut a));
    wait(&a, 1);
    assert!(builds(&mut a));
}

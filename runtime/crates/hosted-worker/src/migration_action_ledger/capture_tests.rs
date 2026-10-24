//! Real SQLite capture/rollback boundaries, not physical durability or a source
//! page/caller authority producer. The imported-page integration is separate.
use super::*;
use mdbn_migrate_portable::hosted_import::{Class, Generation, Key, Meta};
use mdbn_migrate_portable::preflight::EntityKind;
use tests::Sqlite;

fn meta() -> (Key, Meta) {
    (
        Key {
            kind: EntityKind::Record,
            id: "00000000-0000-4000-8000-000000000007".into(),
        },
        Meta {
            class: Class::Record,
            path: "[test] note.md".into(),
            content: B32([7; 32]),
            size: 2048,
        },
    )
}
fn spill() -> SqlSpill<Sqlite> {
    SqlSpill::open(Sqlite::new()).unwrap()
}

#[test]
fn completion_capture_reads_own_claim_and_drop_discards_all_writes() {
    let mut spill = spill();
    let (key, meta) = meta();
    {
        let mut capture = capture::CheckpointCapture::new(&mut spill).unwrap();
        assert!(!capture.is_claimed(Generation::S0, &meta.content).unwrap());
        capture.claim(Generation::S0, &meta.content).unwrap();
        assert!(capture.is_claimed(Generation::S0, &meta.content).unwrap());
        capture.put_placement(Generation::S0, &key, &meta).unwrap();
        capture.save(&[1, 2, 3]).unwrap();
        assert_eq!(capture.load().unwrap(), Some(vec![1, 2, 3]));
    }
    assert!(!spill.is_claimed(Generation::S0, &meta.content).unwrap());
    assert!(
        spill
            .placements_page(Generation::S0, None, 128)
            .unwrap()
            .is_empty()
    );
    assert_eq!(spill.load().unwrap(), None);
}

#[test]
fn completion_capture_budget_failure_cannot_commit_earlier_good_plans() {
    let mut spill = spill();
    let (key, mut meta) = meta();
    let mut capture = capture::CheckpointCapture::new(&mut spill).unwrap();
    capture.claim(Generation::S0, &meta.content).unwrap();
    meta.path = "x".repeat(mdbn_migrate_portable::budget::MAX_COMPLETION_BYTES);
    assert!(capture.put_placement(Generation::S0, &key, &meta).is_err());
    assert!(capture.finish().is_err());
    assert!(!spill.is_claimed(Generation::S0, &meta.content).unwrap());
    assert!(
        spill
            .placements_page(Generation::S0, None, 128)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn completion_capture_sql_failure_rolls_back_metadata_checkpoint_and_settlement() {
    let binding = RunBinding {
        collection: B16([1; 16]),
        owner: B16([2; 16]),
        started_us: "10413792000000001".into(),
        target: B32([3; 32]),
    };
    let mut driver = JournalDriver::resume(
        Sqlite::new(),
        binding,
        &mut mdbn_replica::crypto::TestEntropy::new(6),
    )
    .unwrap();
    let (ticket, action) = driver
        .prepare(&mut mdbn_replica::crypto::TestEntropy::new(7))
        .unwrap();
    assert_eq!(action, Action::EnsureBackup);
    let (key, meta) = meta();
    let mut capture = capture::CheckpointCapture::new(&mut driver.spill).unwrap();
    capture.claim(Generation::S0, &meta.content).unwrap();
    capture.put_placement(Generation::S0, &key, &meta).unwrap();
    driver
        .driver
        .complete(
            &mut capture,
            Outcome::Backup {
                hold: "test-original".into(),
            },
        )
        .unwrap();
    let (after, mut statements) = capture.finish().unwrap();
    let after = after.unwrap();
    assert_eq!(
        driver.spill.load().unwrap(),
        Some(ticket.data.before.clone())
    );
    assert!(
        driver
            .spill
            .placements_page(Generation::S0, None, 128)
            .unwrap()
            .is_empty()
    );
    // Fixed production trigger rejects this altered fingerprint after metadata
    // statements have executed within the SAME actual SQLite transaction.
    statements.push(Stmt::new(
        "UPDATE mig_native_action SET settled=1,after_cp=?1,result=?2,fingerprint=?3 WHERE seq=?4",
        vec![
            blob(&after),
            blob(&[8; 32]),
            blob(&[9; 32]),
            SqlValue::Integer(ticket.data.sequence as i64),
        ],
    ));
    assert!(run(driver.spill.index_mut(), statements, BatchMode::Transaction).is_err());
    assert_eq!(
        driver.spill.load().unwrap(),
        Some(ticket.data.before.clone())
    );
    assert!(
        !driver
            .spill
            .is_claimed(Generation::S0, &meta.content)
            .unwrap()
    );
    assert!(
        driver
            .spill
            .placements_page(Generation::S0, None, 128)
            .unwrap()
            .is_empty()
    );
    let saved = driver.saved_pending().unwrap().unwrap();
    assert_eq!(saved, ticket.data);
}

#[test]
fn completion_capture_any_refusal_is_sticky_and_never_yields_partial_plans() {
    let (key, meta) = meta();
    // Read after a staged write, a second checkpoint and the claim budget each
    // refuse; none may let finish() return the earlier staged plans.
    for fault in 0..3 {
        let mut spill = spill();
        let mut capture = capture::CheckpointCapture::new(&mut spill).unwrap();
        capture.claim(Generation::S0, &meta.content).unwrap();
        capture.put_placement(Generation::S0, &key, &meta).unwrap();
        match fault {
            0 => assert!(capture.placements_page(Generation::S0, None, 8).is_err()),
            1 => {
                capture.save(&[1]).unwrap();
                assert!(capture.save(&[2]).is_err());
            }
            _ => {
                let failed = (1u16..=600).any(|n| {
                    let mut hash = [0xa5; 32];
                    hash[..2].copy_from_slice(&n.to_be_bytes());
                    capture.claim(Generation::S0, &B32(hash)).is_err()
                });
                assert!(failed);
            }
        }
        // Later otherwise-valid calls cannot clear the failure.
        assert!(capture.load().is_err());
        assert!(capture.is_claimed(Generation::S0, &meta.content).is_err());
        assert!(capture.claim(Generation::Final, &meta.content).is_err());
        assert!(capture.finish().is_err());
        assert!(!spill.is_claimed(Generation::S0, &meta.content).unwrap());
        assert!(
            spill
                .placements_page(Generation::S0, None, 128)
                .unwrap()
                .is_empty()
        );
        assert_eq!(spill.load().unwrap(), None);
        // The ended capture leaves the spill writable directly again.
        spill.claim(Generation::S0, &meta.content).unwrap();
        assert!(spill.is_claimed(Generation::S0, &meta.content).unwrap());
    }
}

#[test]
fn completion_staging_refuses_nesting_and_take_without_begin() {
    let mut spill = spill();
    assert!(spill.take_completion().is_err());
    spill.begin_completion().unwrap();
    assert!(spill.begin_completion().is_err());
    assert!(spill.take_completion().unwrap().is_empty());
    assert!(spill.take_completion().is_err());
}

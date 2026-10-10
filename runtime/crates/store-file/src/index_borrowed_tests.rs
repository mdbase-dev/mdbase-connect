use super::*;

fn write() -> Batch {
    Batch {
        mode: BatchMode::Transaction,
        stmts: vec![Stmt::new(
            "INSERT INTO t(v) VALUES(?)",
            vec![SqlValue::Null],
        )],
    }
}

#[test]
fn borrowed_blob_shape_is_single_null_slot_and_inclusive_capacity_bound() {
    let bytes = vec![7; MAX_BORROWED_BLOB_BYTES + 1];
    let valid = write();
    for length in [0, 1, MAX_BORROWED_BLOB_BYTES] {
        assert_eq!(
            BorrowedBlob {
                parameter: 0,
                bytes: &bytes[..length]
            }
            .validate(&valid),
            Ok(())
        );
    }
    assert_eq!(
        BorrowedBlob {
            parameter: 0,
            bytes: &bytes
        }
        .validate(&valid)
        .unwrap_err()
        .kind,
        IndexErrorKind::Sql
    );
    assert_eq!(
        BorrowedBlob {
            parameter: 1,
            bytes: &[]
        }
        .validate(&valid)
        .unwrap_err()
        .kind,
        IndexErrorKind::Sql
    );
    for parameter in [
        SqlValue::Blob(vec![]),
        SqlValue::Integer(0),
        SqlValue::Text("not-null".into()),
    ] {
        let mut bad = valid.clone();
        bad.stmts[0].params[0] = parameter;
        assert_eq!(
            BorrowedBlob {
                parameter: 0,
                bytes: &[]
            }
            .validate(&bad)
            .unwrap_err()
            .kind,
            IndexErrorKind::Sql
        );
    }
    let mut auto = valid.clone();
    auto.mode = BatchMode::Autocommit;
    assert!(
        BorrowedBlob {
            parameter: 0,
            bytes: &[]
        }
        .validate(&auto)
        .is_err()
    );
    let mut multiple = valid;
    multiple.stmts.push(Stmt::new("DELETE FROM t", vec![]));
    assert!(
        BorrowedBlob {
            parameter: 0,
            bytes: &[]
        }
        .validate(&multiple)
        .is_err()
    );
}

#[test]
fn unsupported_host_refuses_without_execution_info_or_owned_fallback() {
    // Negative-only backend: never evidence of native storage or durability.
    struct Unsupported;
    impl IndexStorage for Unsupported {
        fn info(&self) -> IndexInfo {
            panic!("not consulted")
        }
        fn run(&mut self, _: &Batch) -> Result<Vec<StmtResult>, IndexError> {
            panic!("no owned fallback")
        }
        fn reset(&mut self) -> Result<(), IndexError> {
            panic!("no reset")
        }
    }
    let bytes = [7; 17];
    let blob = BorrowedBlob {
        parameter: 0,
        bytes: &bytes,
    };
    let error = Unsupported
        .run_with_borrowed_blob(&write(), blob)
        .unwrap_err();
    assert_eq!(error.kind, IndexErrorKind::Other);
    assert_eq!(error.detail, "borrowed blob writes unsupported");
    assert_eq!(bytes, [7; 17]);
    assert_eq!(
        format!("{blob:?}"),
        "BorrowedBlob { parameter: 0, bytes: 17, .. }"
    );
}

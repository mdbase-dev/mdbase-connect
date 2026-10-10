//! Hermetic strict restore: source accounting/closure without raising live quota.
use mdbn_log_service::auth::Principal;
use mdbn_log_service::mem::{MemBackend, MemObjects};
use mdbn_log_service::model::{CollectionMeta, ObjectMeta, SnapshotRow, Status, object_key};
use mdbn_log_service::restore_plan::RestorePlan;
use mdbn_log_service::testkit::{ControlPlane, Device, id16, object};
use mdbn_log_service::{Backend, Code, Config, Mode, ObjectStore, Service, Txn, Write};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::envelope::ItemKind;
use mdbn_wire::hash::sha256;
use mdbn_wire::log_service::{AppendParams, GetObjectParams};
use mdbn_wire::policy::{DeviceKind, Freeze, PolicyOp};
use mdbn_wire::schema::Wire;
use std::future::Future;
use std::task::{Context, Poll, Waker};

type Svc = Service<MemBackend, MemObjects>;
const NOW: i64 = 1000;
fn ready<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("memory operation waited"),
    }
}
fn map(fields: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    )
}
fn field(v: &Cbor, k: u64) -> Cbor {
    let Cbor::Map(rows) = v else { panic!() };
    rows.iter()
        .find(|(key, _)| *key == Cbor::Uint(k))
        .unwrap()
        .1
        .clone()
}
fn service(cp: &ControlPlane) -> Svc {
    Service::new(
        MemBackend::default(),
        MemObjects::default(),
        Config {
            roots: vec![cp.root_pk()],
            token_issuers: vec![cp.issuer_pk()],
            url_secret: vec![7; 32],
            public_base: "https://restore.invalid".into(),
        },
    )
}
fn call(svc: &Svc, method: &str, fields: Vec<(u64, Cbor)>) -> mdbn_log_service::Result<Cbor> {
    ready(svc.call(&Principal::ControlPlane, method, &map(fields), NOW + 100)).map(|o| o.result)
}
fn meta(svc: &Svc, c: &Uuid) -> CollectionMeta {
    let mut tx = ready(svc.backend.begin(c, Mode::Read)).unwrap();
    ready(tx.load()).unwrap().unwrap().meta
}
struct Fixture {
    cp: ControlPlane,
    src: Svc,
    c: Uuid,
    dev: Device,
    objects: Vec<(B32, u64, Vec<u8>)>,
    page: Cbor,
    plan: RestorePlan,
}
impl Fixture {
    fn new(snapshot: bool, compacted: bool) -> Self {
        let cp = ControlPlane::new("restore-plan");
        let src = service(&cp);
        let c = id16("restore-plan/collection");
        let owner = id16("restore-plan/owner");
        let dev = Device::new("restore-plan/device", owner);
        call(
            &src,
            "create_log",
            vec![(0, c.to_cbor()), (1, Cbor::Bytes(cp.genesis(c, owner)))],
        )
        .unwrap();
        let head = ready(src.head(&Principal::ControlPlane, &c)).unwrap();
        ready(src.append(
            &Principal::ControlPlane,
            AppendParams {
                collection: c,
                expect_seq: 2,
                expect_prev: head.head_chain,
                items: vec![Bytes(cp.policy_item(
                    c,
                    2,
                    head.head_chain,
                    vec![dev.enrol(DeviceKind::Desktop)],
                    2,
                ))],
            },
            NOW,
        ))
        .unwrap();
        let blob = object(c, ItemKind::BlobPart, 0, vec![42; 64]);
        let unused = object(c, ItemKind::BlobPart, 0, vec![50; 64]);
        let address = sha256(&blob);
        let mut objects = vec![(address, 18, blob), (sha256(&unused), 18, unused)];
        if snapshot {
            let manifest = dev.manifest(c, 0, vec![address], vec![55; 64]);
            objects.push((sha256(&manifest), 16, manifest));
        }
        ready(async {
            let mut tx = src.backend.begin(&c, Mode::Write).await.unwrap();
            let mut m = tx.load().await.unwrap().unwrap().meta;
            for (a, kind, bytes) in &objects {
                tx.write(Write::PutObject(ObjectMeta {
                    address: *a,
                    kind: *kind,
                    size: bytes.len() as u64,
                    checksum: *a,
                    committed: true,
                    created_at: NOW,
                }));
                m.used_bytes += bytes.len() as u64;
                src.objects
                    .put_new(&object_key(&c, a), bytes.clone())
                    .await
                    .unwrap();
            }
            tx.write(Write::PutMeta(m));
            tx.commit().await.unwrap();
        });
        let head = ready(src.head(&Principal::ControlPlane, &c)).unwrap();
        let entry = dev.entry(
            c,
            3,
            head.head_chain,
            0,
            id16("restore-plan/mutation"),
            Some(vec![address]),
            vec![9; 64],
        );
        let entry_len = entry.len() as u64;
        let principal = Principal::Device {
            id: dev.id,
            sign_pk: dev.pk(),
            collection: Some(c),
        };
        ready(src.append(
            &principal,
            AppendParams {
                collection: c,
                expect_seq: 3,
                expect_prev: head.head_chain,
                items: vec![Bytes(entry)],
            },
            NOW,
        ))
        .unwrap();
        if compacted {
            let head = ready(src.head(&Principal::ControlPlane, &c)).unwrap();
            ready(src.append(
                &Principal::ControlPlane,
                AppendParams {
                    collection: c,
                    expect_seq: 4,
                    expect_prev: head.head_chain,
                    items: vec![Bytes(cp.policy_item(
                        c,
                        4,
                        head.head_chain,
                        vec![PolicyOp::Freeze(Freeze {
                            frozen: false,
                            reason: None,
                        })],
                        4,
                    ))],
                },
                NOW,
            ))
            .unwrap();
        }
        ready(async {
            let mut tx = src.backend.begin(&c, Mode::Write).await.unwrap();
            let mut m = tx.load().await.unwrap().unwrap().meta;
            // A legitimate quota shrink may leave committed bytes above quota.
            m.quotas.storage_bytes = 0;
            if compacted {
                tx.write(Write::DeleteEntriesThrough(3));
                m.used_bytes -= entry_len;
                m.retained_from = 4;
            }
            if snapshot {
                let manifest = objects[2].0;
                tx.write(Write::InsertSnapshot(SnapshotRow {
                    seq: 3,
                    manifest,
                    author: dev.id,
                    created_at: NOW,
                    endorsed: false,
                    refs: vec![address, manifest],
                }));
            }
            tx.write(Write::PutMeta(m));
            tx.commit().await.unwrap();
        });
        let mut tx = ready(src.backend.begin(&c, Mode::Write)).unwrap();
        let original = ready(tx.load()).unwrap().unwrap().meta;
        let plan = ready(RestorePlan::capture(&mut tx, &original)).unwrap();
        drop(tx);
        let page = call(&src, "export", vec![(0, c.to_cbor())]).unwrap();
        Self {
            cp,
            src,
            c,
            dev,
            objects,
            page,
            plan,
        }
    }
    fn dst(&self) -> Svc {
        service(&self.cp)
    }
    fn start(&self, dst: &Svc, plan: &RestorePlan) {
        let Cbor::Array(items) = field(&self.page, 0) else {
            panic!()
        };
        let result = call(
            dst,
            "import",
            vec![
                (0, self.c.to_cbor()),
                (1, Cbor::Array(vec![items[0].clone()])),
                (3, field(&self.page, 7)),
                (4, plan.to_cbor()),
            ],
        )
        .unwrap();
        assert_eq!(
            field(&result, 3),
            Cbor::Bool(true),
            "target must acknowledge strict enforcement"
        );
    }
    fn import_objects(&self, dst: &Svc) {
        for (a, kind, bytes) in &self.objects {
            call(
                dst,
                "import_object",
                vec![
                    (0, self.c.to_cbor()),
                    (1, a.to_cbor()),
                    (2, Cbor::Uint(*kind)),
                    (3, Cbor::Bytes(bytes.clone())),
                ],
            )
            .unwrap();
        }
    }
    fn tail(&self) -> Cbor {
        let Cbor::Array(mut items) = field(&self.page, 0) else {
            panic!()
        };
        items.remove(0);
        Cbor::Array(items)
    }
    fn snapshots(&self, dst: &Svc) {
        let Cbor::Array(ptrs) = field(&self.page, 1) else {
            panic!()
        };
        let Cbor::Array(refs) = field(&self.page, 6) else {
            panic!()
        };
        for (ptr, refs) in ptrs.into_iter().zip(refs) {
            let Cbor::Array(refs) = refs else { panic!() };
            call(
                dst,
                "import_snapshot",
                vec![(0, self.c.to_cbor()), (1, ptr), (2, refs[1].clone())],
            )
            .unwrap();
        }
    }
    fn done(&self, dst: &Svc, items: Cbor) -> mdbn_log_service::Result<Cbor> {
        call(
            dst,
            "import",
            vec![
                (0, self.c.to_cbor()),
                (1, items),
                (
                    2,
                    map(vec![
                        (0, field(&self.page, 5)),
                        (1, field(&self.page, 3)),
                        (2, field(&self.page, 4)),
                    ]),
                ),
            ],
        )
        .inspect(|result| {
            assert_eq!(field(result, 3), Cbor::Bool(true));
        })
    }
}

#[test]
fn overquota_source_restores_exactly_and_live_new_writes_remain_refused() {
    let f = Fixture::new(true, false);
    let dst = f.dst();
    f.start(&dst, &f.plan);
    f.import_objects(&dst);
    call(&dst, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    f.snapshots(&dst);
    let importing = meta(&dst, &f.c);
    assert_eq!(importing.quotas.storage_bytes, 0);
    assert!(importing.used_bytes > importing.quotas.storage_bytes);
    assert_eq!(
        CollectionMeta::decode(&importing.encode()).unwrap(),
        importing,
        "progress survives serialized ports"
    );
    assert_eq!(
        ready(dst.head(&Principal::ControlPlane, &f.c))
            .unwrap_err()
            .code,
        Code::Unavailable
    );
    f.done(&dst, Cbor::Array(vec![])).unwrap();
    let restored = meta(&dst, &f.c);
    assert_eq!(restored.status, Status::Live);
    assert!(restored.restore_plan.is_none());
    assert_eq!(restored.quotas, meta(&f.src, &f.c).quotas);
    assert_eq!(restored.used_bytes, f.plan.used_bytes);
    assert_eq!(
        ready(dst.head(&Principal::ControlPlane, &f.c)).unwrap(),
        ready(f.src.head(&Principal::ControlPlane, &f.c)).unwrap()
    );
    let address = f.objects[0].0;
    assert_eq!(
        ready(dst.get_object(
            &Principal::ControlPlane,
            GetObjectParams {
                collection: f.c,
                address,
                range: None
            },
            NOW
        ))
        .unwrap()
        .bytes
        .unwrap()
        .0,
        f.objects[0].2
    );
    let entry = f.dev.entry(
        f.c,
        f.plan.head + 1,
        f.plan.chain,
        0,
        id16("new-write"),
        None,
        vec![8; 64],
    );
    assert_eq!(
        ready(dst.append(
            &Principal::Device {
                id: f.dev.id,
                sign_pk: f.dev.pk(),
                collection: Some(f.c)
            },
            AppendParams {
                collection: f.c,
                expect_seq: f.plan.head + 1,
                expect_prev: f.plan.chain,
                items: vec![Bytes(entry)],
            },
            NOW
        ))
        .unwrap_err()
        .code,
        Code::QuotaExceeded
    );
}

#[test]
fn nonempty_final_failure_rolls_back_items_and_progress_then_correct_retry_succeeds() {
    let f = Fixture::new(false, false);
    let dst = f.dst();
    let mut wrong = f.plan.clone();
    wrong.objects = B32([7; 32]);
    f.start(&dst, &wrong);
    f.import_objects(&dst);
    let before = meta(&dst, &f.c);
    assert_eq!(
        f.done(&dst, f.tail()).unwrap_err().reason.as_deref(),
        Some("restore_inventory")
    );
    assert_eq!(meta(&dst, &f.c), before);
    let mut tx = ready(dst.backend.begin(&f.c, Mode::Read)).unwrap();
    assert_eq!(ready(tx.items(0, 100, u64::MAX, false)).unwrap().len(), 1);
    drop(tx);
    // A failed plan is not silently replaced; recover with a new isolated target.
    assert_eq!(
        call(
            &dst,
            "import",
            vec![
                (0, f.c.to_cbor()),
                (1, Cbor::Array(vec![])),
                (3, field(&f.page, 7)),
                (4, f.plan.to_cbor())
            ]
        )
        .unwrap_err()
        .reason
        .as_deref(),
        Some("restore_plan")
    );
    let correct = f.dst();
    f.start(&correct, &f.plan);
    f.import_objects(&correct);
    f.done(&correct, f.tail()).unwrap();
}

#[test]
fn missing_snapshot_and_same_size_wrong_object_inventory_cannot_activate() {
    let f = Fixture::new(true, false);
    let dst = f.dst();
    f.start(&dst, &f.plan);
    f.import_objects(&dst);
    call(&dst, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    let before = meta(&dst, &f.c);
    assert_eq!(
        f.done(&dst, Cbor::Array(vec![]))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("restore_inventory")
    );
    assert_eq!(meta(&dst, &f.c), before);
    f.snapshots(&dst);
    f.done(&dst, Cbor::Array(vec![])).unwrap();
    let wrong = f.dst();
    f.start(&wrong, &f.plan);
    for (i, (a, kind, bytes)) in f.objects.iter().enumerate() {
        let replacement = if i == 1 {
            object(f.c, ItemKind::BlobPart, 0, vec![51; 64])
        } else {
            bytes.clone()
        };
        let address = if i == 1 { sha256(&replacement) } else { *a };
        assert_eq!(replacement.len(), bytes.len());
        call(
            &wrong,
            "import_object",
            vec![
                (0, f.c.to_cbor()),
                (1, address.to_cbor()),
                (2, Cbor::Uint(*kind)),
                (3, Cbor::Bytes(replacement)),
            ],
        )
        .unwrap();
    }
    call(&wrong, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    f.snapshots(&wrong);
    assert_eq!(meta(&wrong, &f.c).used_bytes, f.plan.used_bytes);
    assert_eq!(
        f.done(&wrong, Cbor::Array(vec![]))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("restore_inventory")
    );
}

#[test]
fn compacted_entry_gap_before_retained_control_is_bound_by_complete_item_root() {
    let f = Fixture::new(true, true);
    let dst = f.dst();
    f.start(&dst, &f.plan);
    f.import_objects(&dst);
    call(&dst, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    f.snapshots(&dst);
    f.done(&dst, Cbor::Array(vec![])).unwrap();
    assert_eq!(meta(&dst, &f.c).retained_from, 4);
    assert_eq!(meta(&dst, &f.c).head, 4);
    assert_eq!(meta(&dst, &f.c).head_chain, f.plan.chain);
    let mut bad = f.plan.clone();
    bad.items = B32([9; 32]);
    let wrong = f.dst();
    f.start(&wrong, &bad);
    f.import_objects(&wrong);
    call(&wrong, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    f.snapshots(&wrong);
    assert_eq!(
        f.done(&wrong, Cbor::Array(vec![]))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("restore_inventory")
    );
}

#[test]
fn omitted_retained_entry_is_rejected_and_omitted_control_cannot_match_item_root() {
    let mut f = Fixture::new(false, false);
    call(
        &f.src,
        "set_quota",
        vec![
            (0, f.c.to_cbor()),
            (
                1,
                Cbor::Array(vec![
                    Cbor::Uint(999999),
                    Cbor::Uint(20),
                    Cbor::Uint(100000),
                    Cbor::Uint(20),
                ]),
            ),
        ],
    )
    .unwrap();
    ready(f.src.append(
        &Principal::ControlPlane,
        AppendParams {
            collection: f.c,
            expect_seq: 4,
            expect_prev: f.plan.chain,
            items: vec![Bytes(f.cp.policy_item(
                f.c,
                4,
                f.plan.chain,
                vec![PolicyOp::Freeze(Freeze {
                    frozen: false,
                    reason: None,
                })],
                4,
            ))],
        },
        NOW,
    ))
    .unwrap();
    call(
        &f.src,
        "set_quota",
        vec![
            (0, f.c.to_cbor()),
            (
                1,
                Cbor::Array(vec![
                    Cbor::Uint(0),
                    Cbor::Uint(20),
                    Cbor::Uint(100000),
                    Cbor::Uint(20),
                ]),
            ),
        ],
    )
    .unwrap();
    let mut tx = ready(f.src.backend.begin(&f.c, Mode::Write)).unwrap();
    let original = ready(tx.load()).unwrap().unwrap().meta;
    f.plan = ready(RestorePlan::capture(&mut tx, &original)).unwrap();
    drop(tx);
    f.page = call(&f.src, "export", vec![(0, f.c.to_cbor())]).unwrap();
    let dst = f.dst();
    f.start(&dst, &f.plan);
    f.import_objects(&dst);
    let Cbor::Array(mut tail) = f.tail() else {
        panic!()
    };
    tail.remove(1); // retained entry3
    let before = meta(&dst, &f.c);
    assert_eq!(
        f.done(&dst, Cbor::Array(tail))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("chain")
    );
    assert_eq!(meta(&dst, &f.c), before);

    let f = Fixture::new(true, true);
    let Cbor::Array(mut tail) = f.tail() else {
        panic!()
    };
    let Cbor::Array(removed) = tail.remove(0) else {
        panic!()
    };
    let Cbor::Bytes(control) = &removed[1] else {
        panic!()
    };
    let mut incomplete = f.plan.clone();
    // Even an inconsistent claimed accounting value cannot hide a missing
    // retained control item from the authenticated complete item inventory.
    incomplete.used_bytes -= control.len() as u64;
    let dst = f.dst();
    f.start(&dst, &incomplete);
    f.import_objects(&dst);
    call(
        &dst,
        "import",
        vec![(0, f.c.to_cbor()), (1, Cbor::Array(tail))],
    )
    .unwrap();
    f.snapshots(&dst);
    assert_eq!(meta(&dst, &f.c).used_bytes, incomplete.used_bytes);
    assert_eq!(
        f.done(&dst, Cbor::Array(vec![]))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("restore_inventory")
    );
    assert_eq!(meta(&dst, &f.c).status, Status::Importing);
}

#[test]
fn source_budget_under_over_and_missing_unref_object_cannot_activate() {
    let f = Fixture::new(false, false);
    for delta in [-1i64, 1] {
        let dst = f.dst();
        let mut plan = f.plan.clone();
        plan.used_bytes = plan.used_bytes.checked_add_signed(delta).unwrap();
        f.start(&dst, &plan);
        f.import_objects(&dst);
        let before = meta(&dst, &f.c);
        assert_eq!(
            f.done(&dst, f.tail()).unwrap_err().reason.as_deref(),
            Some("restore_accounting")
        );
        assert_eq!(meta(&dst, &f.c), before);
    }
    let dst = f.dst();
    f.start(&dst, &f.plan);
    let (a, kind, bytes) = &f.objects[0];
    call(
        &dst,
        "import_object",
        vec![
            (0, f.c.to_cbor()),
            (1, a.to_cbor()),
            (2, Cbor::Uint(*kind)),
            (3, Cbor::Bytes(bytes.clone())),
        ],
    )
    .unwrap();
    assert_eq!(
        f.done(&dst, f.tail()).unwrap_err().reason.as_deref(),
        Some("restore_accounting")
    );
    assert_eq!(meta(&dst, &f.c).status, Status::Importing);
}

#[test]
fn strict_snapshot_refs_reject_malformed_elements_and_normalize_duplicate_edges() {
    let f = Fixture::new(true, false);
    let dst = f.dst();
    f.start(&dst, &f.plan);
    f.import_objects(&dst);
    call(&dst, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    let Cbor::Array(ptrs) = field(&f.page, 1) else {
        panic!()
    };
    let mut refs = vec![
        f.objects[0].0.to_cbor(),
        f.objects[2].0.to_cbor(),
        f.objects[0].0.to_cbor(),
    ];
    let mut malformed = refs.clone();
    malformed.push(Cbor::Uint(0));
    assert_eq!(
        call(
            &dst,
            "import_snapshot",
            vec![
                (0, f.c.to_cbor()),
                (1, ptrs[0].clone()),
                (2, Cbor::Array(malformed))
            ]
        )
        .unwrap_err()
        .reason
        .as_deref(),
        Some("shape")
    );
    call(
        &dst,
        "import_snapshot",
        vec![
            (0, f.c.to_cbor()),
            (1, ptrs[0].clone()),
            (2, Cbor::Array(std::mem::take(&mut refs))),
        ],
    )
    .unwrap();
    let mut tx = ready(dst.backend.begin(&f.c, Mode::Read)).unwrap();
    assert_eq!(ready(tx.snapshot_refs(3)).unwrap().len(), 2);
    drop(tx);
    f.done(&dst, Cbor::Array(vec![])).unwrap();
}

#[test]
fn wrong_expanded_refs_fail_with_exact_objects_and_accounting() {
    let f = Fixture::new(true, false);
    let dst = f.dst();
    f.start(&dst, &f.plan);
    f.import_objects(&dst);
    call(&dst, "import", vec![(0, f.c.to_cbor()), (1, f.tail())]).unwrap();
    let Cbor::Array(ptrs) = field(&f.page, 1) else {
        panic!()
    };
    let refs = vec![
        f.objects[0].0.to_cbor(),
        f.objects[1].0.to_cbor(),
        f.objects[2].0.to_cbor(),
    ];
    call(
        &dst,
        "import_snapshot",
        vec![
            (0, f.c.to_cbor()),
            (1, ptrs[0].clone()),
            (2, Cbor::Array(refs)),
        ],
    )
    .unwrap();
    assert_eq!(meta(&dst, &f.c).used_bytes, f.plan.used_bytes);
    let before = meta(&dst, &f.c);
    assert_eq!(
        f.done(&dst, Cbor::Array(vec![]))
            .unwrap_err()
            .reason
            .as_deref(),
        Some("restore_inventory")
    );
    assert_eq!(meta(&dst, &f.c), before);
}

#[test]
fn malformed_plan_unpaired_completion_and_quota_mutation_have_no_effects() {
    let f = Fixture::new(false, false);
    let dst = f.dst();
    let Cbor::Array(items) = field(&f.page, 0) else {
        panic!()
    };
    let mut malformed = f.plan.to_cbor();
    let Cbor::Array(ref mut fields) = malformed else {
        panic!()
    };
    fields.push(Cbor::Uint(0));
    let legacy = f.dst();
    let legacy_result = call(
        &legacy,
        "import",
        vec![
            (0, f.c.to_cbor()),
            (1, Cbor::Array(vec![items[0].clone()])),
            (3, field(&f.page, 7)),
        ],
    )
    .unwrap();
    assert_eq!(field(&legacy_result, 3), Cbor::Bool(false));
    assert_eq!(meta(&legacy, &f.c).status, Status::Importing);
    assert_eq!(
        call(
            &dst,
            "import",
            vec![
                (0, f.c.to_cbor()),
                (1, Cbor::Array(vec![items[0].clone()])),
                (3, field(&f.page, 7)),
                (4, malformed)
            ]
        )
        .unwrap_err()
        .reason
        .as_deref(),
        Some("restore_plan")
    );
    f.start(&dst, &f.plan);
    let before = meta(&dst, &f.c);
    assert_eq!(
        call(
            &dst,
            "set_quota",
            vec![
                (0, f.c.to_cbor()),
                (1, Cbor::Array(vec![Cbor::Uint(999999); 4]))
            ]
        )
        .unwrap_err()
        .reason
        .as_deref(),
        Some("restore_settings")
    );
    assert_eq!(
        call(
            &dst,
            "import",
            vec![
                (0, f.c.to_cbor()),
                (1, Cbor::Array(vec![])),
                (
                    2,
                    map(vec![(0, Cbor::Uint(1)), (1, Cbor::Uint(f.plan.head))])
                )
            ]
        )
        .unwrap_err()
        .reason
        .as_deref(),
        Some("shape")
    );
    assert_eq!(meta(&dst, &f.c), before);
}

//! Conflict dismissal goes through the control method and the real replica.
use super::*;
use mdbn_wire::common::{B16, Text};
use mdbn_wire::intent::{Create, DocVersion, Document, Op};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dismiss_conflict_clears_list_without_changing_files() {
    let dir = crate::testutil::TestDir::new("conflict-control");
    let folder = crate::testutil::TestDir::new("conflict-folder");
    let d = paired_daemon(&dir).await;
    let added = d
        .add(crate::control::AddCollection {
            path: folder.path().to_path_buf(),
            name: Some("Notes".into()),
        })
        .await
        .unwrap();
    let collection = added["id"].as_str().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    let rt = loop {
        if let Ok(rt) = d.runtime_of(collection).await {
            break rt;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "collection never served"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    };
    // Two records sharing a prefix, with stale document edits on each.
    for byte in [0x90, 0x91] {
        let id = B16([byte; 16]);
        let path = format!("{byte}.md");
        let version = |title: &str| DocVersion {
            path: path.clone(),
            doc: Text::Inline(format!("---\ntitle: {title}\n---\n")),
        };
        let base = version("base");
        assert_eq!(
            submit_as(
                &rt,
                vec![Op::Create(Create {
                    id,
                    path: Some(path.clone()),
                    type_name: None,
                    frontmatter: None,
                    body: None,
                    document: Some(base.doc.clone()),
                })],
                new_uuid_v7()
            )
            .await
            .unwrap(),
            crate::takeover::held::Outcome::Confirmed
        );
        for title in ["first", "second"] {
            assert_eq!(
                submit_as(
                    &rt,
                    vec![Op::Document(Document {
                        id,
                        base: Some(base.clone()),
                        new: Some(version(title)),
                        if_revision: None,
                    })],
                    new_uuid_v7()
                )
                .await
                .unwrap(),
                crate::takeover::held::Outcome::Confirmed
            );
        }
    }
    let call = |method: &str, params: Value| {
        let d = d.clone();
        let req = Request {
            v: PROTOCOL,
            id: 1,
            method: method.into(),
            params,
        };
        async move { d.handle_and_note(&req, &mut ConnAuth::default()).await }
    };
    let list = call(
        Method::COLLECTION_CONFLICTS,
        json!({"collection": collection}),
    )
    .await
    .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 2, "{list}");
    let before = doc_at(&rt, "144.md").await.unwrap();
    let dismiss = |id: &str| json!({"collection": collection, "id": id});
    assert_eq!(
        call(Method::CONFLICTS_DISMISS, dismiss("9"))
            .await
            .unwrap_err()
            .reason
            .as_deref(),
        Some("ambiguous_conflict")
    );
    assert!(
        call(Method::CONFLICTS_DISMISS, dismiss("not-a-uuid"))
            .await
            .is_err()
    );
    assert!(
        call(Method::CONFLICTS_DISMISS, dismiss("ffff"))
            .await
            .is_err()
    );
    let receipt = call(Method::CONFLICTS_DISMISS, dismiss("9090"))
        .await
        .unwrap();
    assert_eq!(receipt["state"], "confirmed");
    let list = call(
        Method::COLLECTION_CONFLICTS,
        json!({"collection": collection}),
    )
    .await
    .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1, "{list}");
    assert!(list[0]["id"].as_str().unwrap().starts_with("9191"));
    assert_eq!(doc_at(&rt, "144.md").await.unwrap(), before);
    call(
        Method::CONFLICTS_DISMISS,
        dismiss(list[0]["id"].as_str().unwrap()),
    )
    .await
    .unwrap();
    assert_eq!(
        call(
            Method::COLLECTION_CONFLICTS,
            json!({"collection": collection})
        )
        .await
        .unwrap(),
        json!([])
    );
    assert!(
        call(Method::CONFLICTS_DISMISS, dismiss("9090"))
            .await
            .is_err()
    );
    for host in d.inner.lock().await.hosts.iter_mut() {
        host.close().await;
    }
}

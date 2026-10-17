//! A collection with a Bases include but no `obsidian.base` contract names the
//! missing contract on every call, rather than an incomplete inventory.
use super::*;

fn discovery_error(app: &mut App, session: SessionId) -> Option<(String, Option<String>, String)> {
    app.encode_bases_discovery_page(session, Some("UTC"), 64, None, |_, _, _| Ok(()))
        .err()
        .map(|e| {
            let p = e.problem();
            (p.code.clone(), p.reason.clone(), p.message.clone())
        })
}

#[test]
fn missing_obsidian_base_contract_is_named_until_installed() {
    let path = scratch("tentative-missing-base-contract").join("app.db");
    let service = log();
    let (mut app, session, _) = open(&path, Rc::new(Probe::default()));
    settle(&mut app, &service);
    submit(
        &mut app,
        session,
        vec![
            Op::ResourcePut(ResourcePut {
                path: "mdbase.yaml".into(),
                doc: "spec_version: '0.3.0'\nsettings:\n  record_extensions: [md, base]\nx-obsidian:\n  bases:\n    include: ['TaskNotes/Views/**/*.base']\n".into(),
                base_revision: None,
                must_not_exist: None,
            }),
            create(SOURCE_ID, SOURCE_PATH, SOURCE),
        ],
        31,
    );
    settle(&mut app, &service);
    let first = discovery_error(&mut app, session);
    let (code, reason, _) = first
        .clone()
        .expect("discovery without the contract refuses");
    assert_eq!(code, "unavailable");
    assert_eq!(reason.as_deref(), Some("bases_contract_not_installed"));
    app.tick();
    assert_eq!(discovery_error(&mut app, session), first);
    // The same store, head and records list views once the contract exists.
    configure_resources(&mut app, session, &service);
    assert_eq!(discovery_error(&mut app, session), None);
    assert_eq!(views(&mut app, session).len(), 2);
}

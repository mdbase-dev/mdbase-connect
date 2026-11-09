//! Calling a collection runtime from the daemon: host sessions, timeouts and submit/read-back helpers.

use super::*;

/// A random UUIDv7 (ms timestamp, then random bits).
pub(super) fn new_uuid_v7() -> [u8; 16] {
    let mut b = [0u8; 16];
    let _ = getrandom::fill(&mut b);
    let ms = (crate::fsutil::now_ms() as u64).to_be_bytes();
    b[..6].copy_from_slice(&ms[2..]);
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

/// The record at `path` with its exact source, or `None`.
pub(super) async fn record_at(
    rt: &Arc<crate::runtime::Runtime>,
    path: &str,
) -> Result<Option<mdbn_wire::client::RecordView>, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::cbor::Cbor;
    let include = mdbn_wire::client::Include {
        effective: None,
        body: None,
        document: Some(true),
        diagnostics: None,
    };
    let params = Cbor::Map(vec![
        (Cbor::Uint(0), Cbor::Text(path.into())),
        (Cbor::Uint(1), include.to_cbor()),
    ]);
    match host_call(rt, "get", params).await {
        Ok(v) => mdbn_wire::client::RecordView::from_cbor(&v)
            .map(Some)
            .map_err(|_| ControlError::internal("the replica's record does not decode")),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

fn outcome_of(state: mdbn_wire::client::ReceiptState) -> crate::takeover::held::Outcome {
    use crate::takeover::held::Outcome;
    use mdbn_wire::client::ReceiptState;
    match state {
        ReceiptState::Pending => Outcome::Pending,
        ReceiptState::Confirmed => Outcome::Confirmed,
        ReceiptState::Unknown => Outcome::Unknown,
        ReceiptState::Rejected => Outcome::Rejected,
    }
}

/// Submit `ops` as the hosting app under `mutation` and wait for confirmation:
/// the receipt's outcome. A mutation the replica already has answers with its
/// original receipt; nothing is applied twice.
pub(super) async fn submit_as(
    rt: &Arc<crate::runtime::Runtime>,
    ops: Vec<mdbn_wire::intent::Op>,
    mutation: [u8; 16],
) -> Result<crate::takeover::held::Outcome, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::client::{Receipt, SubmitParams, WaitFor};
    let submit = SubmitParams {
        ops,
        mutation_id: Some(mdbn_wire::common::B16(mutation)),
        conflict_mode: None,
        timezone: None,
        allow_partial: None,
        mutation_ids: None,
        dry_run: None,
        include: None,
        wait: Some(WaitFor::Confirmed),
        validation: None,
    };
    let result = host_call(rt, "submit", submit.to_cbor()).await?;
    let receipts: Vec<Receipt> = Wire::from_cbor(&result)
        .map_err(|_| ControlError::internal("the replica's receipt does not decode"))?;
    let r = receipts
        .into_iter()
        .next()
        .ok_or_else(|| ControlError::internal("no receipt"))?;
    if r.mutation.0 != mutation {
        return Err(ControlError::internal(
            "the receipt is for another mutation",
        ));
    }
    Ok(outcome_of(r.state))
}

/// The outcome of `mutation` as the replica's receipt says, or `None` when the
/// replica has no receipt for it.
pub(super) async fn read_back(
    rt: &Arc<crate::runtime::Runtime>,
    mutation: [u8; 16],
) -> Result<Option<crate::takeover::held::Outcome>, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::cbor::Cbor;
    use mdbn_wire::client::Receipt;
    let params = Cbor::Map(vec![(
        Cbor::Uint(0),
        mdbn_wire::common::B16(mutation).to_cbor(),
    )]);
    match host_call(rt, "receipt", params).await {
        Ok(v) => Receipt::from_cbor(&v)
            .map(|r| Some(outcome_of(r.state)))
            .map_err(|_| ControlError::internal("the replica's receipt does not decode")),
        Err(e) if e.code == "not_found" => Ok(None),
        Err(e) => Err(e),
    }
}

/// How long a one-shot host call may take.
const HOST_CALL_TIMEOUT: Duration = Duration::from_secs(20);

pub(super) async fn host_call(
    rt: &Arc<crate::runtime::Runtime>,
    method: &str,
    params: mdbn_wire::cbor::Cbor,
) -> Result<mdbn_wire::cbor::Cbor, ControlError> {
    use mdbn_wire::Wire;
    use mdbn_wire::client::{ClientFrame, ClientRequest};
    let stopped = || ControlError::unavailable("runtime_stopped", "the collection stopped");
    let mut host = HostSession::open(rt).await?;
    let req = ClientFrame::Request(ClientRequest {
        id: 1,
        method: method.into(),
        params,
    })
    .to_bytes()
    .map_err(|_| ControlError::internal("request does not encode"))?;
    let result = async {
        if !rt.frame(host.id, req) {
            return Err(stopped());
        }
        loop {
            let Some(b) = host.out.recv().await else {
                return Err(stopped());
            };
            if let Ok(ClientFrame::Response(r)) = ClientFrame::from_bytes(&b)
                && r.id == 1
            {
                return match (r.result, r.problem) {
                    (_, Some(p)) => Err(problem_error(p)),
                    (Some(v), None) => Ok(v),
                    (None, None) => Ok(mdbn_wire::cbor::Cbor::Null),
                };
            }
        }
    };
    tokio::time::timeout(HOST_CALL_TIMEOUT, result)
        .await
        .unwrap_or_else(|_| {
            Err(ControlError::unavailable(
                "timeout",
                format!("{method} did not answer in time"),
            ))
        })
}

/// A replica problem as the control error (same codes, §9).
pub(super) fn problem_error(p: mdbn_wire::client::Problem) -> ControlError {
    ControlError::new(&p.code, p.reason.as_deref().unwrap_or(&p.code), p.message)
}

/// A `SessionAuth::Host` session on a collection's runtime (the daemon is the
/// host: no grant, the user's own device). Closed when dropped.
pub(super) struct HostSession {
    pub(super) rt: Arc<crate::runtime::Runtime>,
    pub(super) id: mdbn_replica::api::SessionId,
    out: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
}

impl HostSession {
    pub(super) async fn open(rt: &Arc<crate::runtime::Runtime>) -> Result<Self, ControlError> {
        use mdbn_wire::Wire;
        use mdbn_wire::client::{ClientFrame, ClientRequest, HelloParams};
        use mdbn_wire::common::Version;
        let stopped = || ControlError::unavailable("runtime_stopped", "the collection stopped");
        let hello = ClientRequest {
            id: 0,
            method: "hello".into(),
            params: HelloParams {
                versions: vec![Version { major: 1, minor: 0 }],
                client_name: "mdbase-daemon".into(),
                client_version: env!("CARGO_PKG_VERSION").into(),
                features: None,
                timezone: None,
            }
            .to_cbor(),
        };
        let bytes = ClientFrame::Request(hello)
            .to_bytes()
            .map_err(|_| ControlError::internal("hello does not encode"))?;
        let (session, resp, out) = rt
            .hello(mdbn_replica::api::SessionAuth::Host, bytes)
            .await
            .ok_or_else(stopped)?;
        match (session, ClientFrame::from_bytes(&resp)) {
            (Some(id), Ok(ClientFrame::Response(r))) if r.problem.is_none() => Ok(Self {
                rt: rt.clone(),
                id,
                out,
            }),
            (_, Ok(ClientFrame::Response(r))) => Err(r
                .problem
                .map(problem_error)
                .unwrap_or_else(|| ControlError::internal("host hello refused"))),
            _ => Err(ControlError::internal("the replica answered hello badly")),
        }
    }
}

impl Drop for HostSession {
    fn drop(&mut self) {
        self.rt.close(self.id);
    }
}

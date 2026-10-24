//! One bounded original-client setup workflow. Requests carry no authority.
use super::{CollectionSetupSession, PreparedCollectionSetupReview, Replica, Store};
use crate::{
    api::{ApiResult, ErrorCode, SessionId},
    log::CallId,
};
use mdbn_wire::{
    cbor::{self, Cbor},
    client::Problem,
    common::{B16, Uuid},
    schema::Wire,
};

pub(crate) const FEATURE: &str = "declared-collection-setup-v1";
pub(crate) enum Stage {
    Collecting(Box<CollectionSetupSession>),
    Reviewed(Box<PreparedCollectionSetupReview>),
    Failed(Problem),
}
pub(crate) struct Job {
    pub owner: SessionId,
    pub ticket: Uuid,
    pub deadline: i64,
    pub call: Option<CallId>,
    pub stage: Stage,
}
fn invalid() -> crate::api::ApiError {
    ErrorCode::InvalidRequest.err("invalid declared setup request")
}
fn missing() -> crate::api::ApiError {
    ErrorCode::NotFound.err("setup review is no longer available")
}
fn value(fields: &[(Cbor, Cbor)], key: u64) -> ApiResult<&Cbor> {
    fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
        .ok_or_else(invalid)
}
fn fixed<const N: usize>(v: &Cbor) -> ApiResult<[u8; N]> {
    let Cbor::Bytes(v) = v else {
        return Err(invalid());
    };
    v.as_slice().try_into().map_err(|_| invalid())
}
fn encode(mut fields: Vec<(u64, Cbor)>) -> ApiResult<Vec<u8>> {
    fields.sort_by_key(|(key, _)| *key);
    let bytes = cbor::encode(&Cbor::Map(
        fields
            .into_iter()
            .map(|(k, v)| (Cbor::Uint(k), v))
            .collect(),
    ))
    .map_err(|_| invalid())?;
    if bytes.len() > 256 * 1024 {
        return Err(ErrorCode::TooLarge.err("setup review exceeds its fixed budget"));
    }
    Ok(bytes)
}
impl<S: Store> Replica<S> {
    pub(crate) fn declared_setup_rpc(
        &mut self,
        owner: SessionId,
        input: &[u8],
    ) -> ApiResult<Vec<u8>> {
        // Decoding is bounded before any schema-driven allocation or source IO.
        if input.is_empty() || input.len() > 2 * 1024 * 1024 {
            return Err(invalid());
        }
        let Cbor::Map(fields) = cbor::decode(input).map_err(|_| invalid())? else {
            return Err(invalid());
        };
        if value(&fields, 0)? != &Cbor::Uint(1) {
            return Err(invalid());
        }
        let Cbor::Text(action) = value(&fields, 1)? else {
            return Err(invalid());
        };
        let want: &[u64] = match action.as_str() {
            "assess" if fields.iter().any(|(k, _)| *k == Cbor::Uint(4)) => {
                if fields.iter().any(|(k, _)| *k == Cbor::Uint(3)) {
                    &[0, 1, 3, 4]
                } else {
                    &[0, 1, 4]
                }
            }
            "assess" if fields.iter().any(|(k, _)| *k == Cbor::Uint(3)) => &[0, 1, 3],
            "assess" => &[0, 1],
            "poll" | "cancel" => &[0, 1, 2],
            "apply" => &[0, 1, 2, 3, 4, 5],
            _ => return Err(invalid()),
        };
        if fields.len() != want.len()
            || want.iter().any(|k| {
                fields
                    .iter()
                    .filter(|(key, _)| *key == Cbor::Uint(*k))
                    .count()
                    != 1
            })
        {
            return Err(invalid());
        }
        let auth = self.session(owner)?.auth.clone();
        let crate::api::SessionAuth::Grant { grant, client_pk } = auth else {
            return Err(ErrorCode::Forbidden.err("setup requires an original app session"));
        };
        self.grant_for_client(&grant, &client_pk).ok_or_else(|| {
            ErrorCode::Unauthenticated.err("original app grant is no longer current")
        })?;
        self.declared_setup_rpc_prune();
        if action == "assess" {
            // Cancellation/expiry never loans an outstanding original GET slot
            // to a successor; hold the bound until its response/transport close.
            if self.inflight.values().any(|call| {
                matches!(
                    call,
                    super::super::append::Inflight::DeclaredSetupSource(..)
                )
            }) {
                return Err(
                    ErrorCode::RateLimited.err("an original setup source request is still pending")
                );
            }
            if self
                .declared_setup_rpc_job
                .as_ref()
                .is_some_and(|j| j.owner != owner)
            {
                return Err(ErrorCode::RateLimited.err("another setup review is active"));
            }
            let mut adopt = std::collections::BTreeMap::new();
            if fields.iter().any(|(k, _)| *k == Cbor::Uint(3)) {
                let Cbor::Map(choices) = value(&fields, 3)? else {
                    return Err(invalid());
                };
                if choices.len() > 256 {
                    return Err(invalid());
                }
                for (path, digest) in choices {
                    let Cbor::Text(path) = path else {
                        return Err(invalid());
                    };
                    if path.is_empty()
                        || path.len() > 1024
                        || adopt
                            .insert(path.clone(), mdbn_core::ids::Hash(fixed(digest)?))
                            .is_some()
                    {
                        return Err(invalid());
                    }
                }
            }
            let mut records = Vec::new();
            if fields.iter().any(|(k, _)| *k == Cbor::Uint(4)) {
                let Cbor::Array(entries) = value(&fields, 4)? else {
                    return Err(invalid());
                };
                if entries.len() > 32 {
                    return Err(invalid());
                }
                for entry in entries {
                    let Cbor::Map(row) = entry else {
                        return Err(invalid());
                    };
                    if row.len() != 2 {
                        return Err(invalid());
                    }
                    let (Cbor::Text(path), Cbor::Text(document)) = (value(row, 0)?, value(row, 1)?)
                    else {
                        return Err(invalid());
                    };
                    records.push(mdbn_core::setup::envelope::SetupStarterRecord {
                        id: crate::convert::uuid(&self.mint_v7()),
                        path: path.clone(),
                        document: document.clone(),
                    });
                }
            }
            let session = self.begin_app_setup_with_adoptions(owner, None, adopt, records)?;
            let mut ticket = [0; 16];
            self.host.entropy.fill(&mut ticket);
            self.declared_setup_rpc_job = Some(Job {
                owner,
                ticket: B16(ticket),
                deadline: self.now().max(self.clock_floor).saturating_add(60_000),
                call: None,
                stage: Stage::Collecting(Box::new(session)),
            });
            self.declared_setup_rpc_step();
            return self.declared_setup_rpc_projection(owner);
        }
        let ticket = B16(fixed(value(&fields, 2)?)?);
        if !self
            .declared_setup_rpc_job
            .as_ref()
            .is_some_and(|j| j.owner == owner && j.ticket == ticket)
        {
            return Err(missing());
        }
        if action == "cancel" {
            self.declared_setup_rpc_job = None;
            return encode(vec![
                (0, Cbor::Uint(1)),
                (1, Cbor::Text("cancelled".into())),
            ]);
        }
        self.declared_setup_rpc_step();
        if action == "poll" {
            return self.declared_setup_rpc_projection(owner);
        }
        let mutation = B16(fixed(value(&fields, 3)?)?);
        let revision = mdbn_core::ids::Hash(fixed(value(&fields, 4)?)?);
        let digest = mdbn_core::ids::Hash(fixed(value(&fields, 5)?)?);
        let job = self.declared_setup_rpc_job.take().ok_or_else(missing)?;
        let Stage::Reviewed(review) = job.stage else {
            return Err(ErrorCode::Conflict.err("setup review is not ready"));
        };
        let plan = self.prepare_reviewed_collection_setup(*review, revision, digest)?;
        let receipt = self.capture_prepared_collection_setup(owner, plan, mutation)?;
        encode(vec![
            (0, Cbor::Uint(1)),
            (1, Cbor::Text("receipt".into())),
            (3, receipt.to_cbor()),
        ])
    }
    fn declared_setup_rpc_projection(&self, owner: SessionId) -> ApiResult<Vec<u8>> {
        let job = self
            .declared_setup_rpc_job
            .as_ref()
            .filter(|j| j.owner == owner)
            .ok_or_else(missing)?;
        let mut fields = vec![(0, Cbor::Uint(1)), (2, Cbor::Bytes(job.ticket.0.to_vec()))];
        match &job.stage {
            Stage::Failed(problem) => return Err(problem.clone().into()),
            Stage::Collecting(_) => fields.push((1, Cbor::Text("pending".into()))),
            Stage::Reviewed(review) => {
                self.check_collection_setup_review(review)?;
                let a = review.assessment();
                fields.extend([
                    (1, Cbor::Text("review".into())),
                    (
                        3,
                        Cbor::Text(
                            if !a.applicable {
                                "incompatible"
                            } else if a.has_changes() {
                                "setup_required"
                            } else {
                                "ready"
                            }
                            .into(),
                        ),
                    ),
                    (4, Cbor::Bytes(a.collection_revision.0.to_vec())),
                    (5, Cbor::Bytes(a.assessment_digest.0.to_vec())),
                    (6, crate::convert::wvalue(&a.review_value()).to_cbor()),
                    (7, Cbor::Bytes(review.declaration_digest().0.to_vec())),
                    (8, Cbor::Text(a.application_id.clone())),
                    (
                        10,
                        Cbor::Array(
                            a.records
                                .iter()
                                .map(|r| {
                                    Cbor::Map(vec![
                                        (Cbor::Uint(0), Cbor::Text(r.path.clone())),
                                        (Cbor::Uint(1), Cbor::Text(r.action.into())),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                    // Impact counts only: source paths, identifiers, descriptors
                    // and plaintext stay inside the keyed original review.
                    (
                        9,
                        Cbor::Map(vec![
                            (
                                Cbor::Uint(0),
                                Cbor::Uint(
                                    a.files.iter().filter(|f| f.action == "promote").count() as u64,
                                ),
                            ),
                            (
                                Cbor::Uint(1),
                                Cbor::Uint(
                                    a.files.iter().filter(|f| f.action == "retain").count() as u64
                                ),
                            ),
                        ]),
                    ),
                ]);
            }
        }
        encode(fields)
    }
    pub(crate) fn declared_setup_rpc_prune(&mut self) {
        if self.declared_setup_rpc_job.as_ref().is_some_and(|j| {
            !self.sessions.contains_key(&j.owner) || self.now().max(self.clock_floor) >= j.deadline
        }) {
            self.declared_setup_rpc_job = None;
        }
    }
}

//! Type pack assessment and apply planning over the local view (Core `packs`).
//! Nothing is written here: the caller submits the planned writes as one
//! mutation, guarded by `definitions.manage` and each write's revision.
use std::collections::{BTreeMap, BTreeSet};

use super::super::Replica;
use super::super::submit::store_err;
use crate::api::{
    ApiError, ApiResult, ErrorCode, SessionId, TypePackPlan, TypePackRequest, TypePackWrite,
};
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::policy::capability::DEFINITIONS;
use crate::{Store, convert};
use mdbn_core::contracts::Version;
use mdbn_core::ids::Hash as CHash;
use mdbn_core::intent::Op;
use mdbn_core::intent::ResourcePut;
use mdbn_core::packs::{
    Action, AssessOptions, Assessment, LockResource, Mode, Pack, PackStatus, Receipt,
    apply_type_pack, assess_type_pack, load_pack,
};
use mdbn_core::types::LOCK_PATH;
use mdbn_wire::common::Value;

/// Most entries in each caller decision list or map.
const MAX_DECISIONS: usize = 256;

fn bad(message: &str) -> ApiError {
    ErrorCode::InvalidRequest.err_with_reason("invalid_type_pack_request", message.to_owned())
}

fn issue(i: mdbn_core::validate::Issue) -> ApiError {
    let code = match i.code.as_str() {
        "concurrent_modification" | "type_pack_conflict" => ErrorCode::Conflict,
        _ => ErrorCode::InvalidRequest,
    };
    code.err_with_reason(&i.code, i.message)
}

fn text_map(v: Option<&Value>, what: &str) -> ApiResult<BTreeMap<String, String>> {
    let Some(v) = v else {
        return Ok(BTreeMap::new());
    };
    let Value::Map(entries) = v else {
        return Err(bad(what));
    };
    if entries.len() > MAX_DECISIONS {
        return Err(bad(what));
    }
    let mut out = BTreeMap::new();
    for (k, v) in entries {
        let Value::Text(t) = v else {
            return Err(bad(what));
        };
        if out.insert(k.clone(), t.clone()).is_some() {
            return Err(bad(what));
        }
    }
    Ok(out)
}

/// The provision's manifest and exact sources, through Core's one pack loader.
fn pack(provision: &Value) -> ApiResult<Pack> {
    let Value::Map(entries) = provision else {
        return Err(bad("the provision must be a map"));
    };
    let get = |key: &str| entries.iter().find(|(k, _)| k == key).map(|(_, v)| v);
    if entries
        .iter()
        .any(|(k, _)| !matches!(k.as_str(), "manifest" | "resources" | "provides"))
    {
        return Err(bad("unknown provision member"));
    }
    let manifest = match get("manifest") {
        Some(m @ Value::Map(_)) => convert::value(m).map_err(|_| bad("invalid manifest"))?,
        _ => return Err(bad("the provision needs a manifest")),
    };
    let Some(Value::List(rows)) = get("resources") else {
        return Err(bad("the provision needs resources"));
    };
    let mut sources = BTreeMap::new();
    for row in rows {
        let Value::Map(row) = row else {
            return Err(bad("invalid provision resource"));
        };
        let (Some(Value::Text(source)), Some(Value::Text(document)), 2) = (
            row.iter().find(|(k, _)| k == "source").map(|(_, v)| v),
            row.iter().find(|(k, _)| k == "document").map(|(_, v)| v),
            row.len(),
        ) else {
            return Err(bad("invalid provision resource"));
        };
        if sources.insert(source.clone(), document.clone()).is_some() {
            return Err(bad("duplicate provision resource"));
        }
    }
    let pack = load_pack(&manifest.to_json(), &|p| sources.get(p).cloned()).map_err(issue)?;
    if pack.resources.len() != sources.len() {
        return Err(bad("the provision has sources the manifest does not list"));
    }
    Ok(pack)
}

fn options(r: &TypePackRequest) -> ApiResult<AssessOptions> {
    if r.preserve_seed_targets.len() > MAX_DECISIONS {
        return Err(bad("too many preserved seed targets"));
    }
    let adopt = text_map(r.adopt.as_ref(), "adoptions must map targets to digests")?
        .into_iter()
        .map(|(k, v)| {
            CHash::parse(&v)
                .filter(|_| v.starts_with("sha256:"))
                .map(|h| (k, h))
                .ok_or_else(|| bad("adoptions must map targets to digests"))
        })
        .collect::<ApiResult<_>>()?;
    Ok(AssessOptions {
        installed_by: r.installed_by.clone(),
        target_overrides: text_map(
            r.target_overrides.as_ref(),
            "target overrides must map targets to targets",
        )?,
        adopt,
        preserve_seed_targets: r
            .preserve_seed_targets
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>(),
        allow_downgrade: r.allow_downgrade,
    })
}

fn obj(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}

fn text(s: impl Into<String>) -> Value {
    Value::Text(s.into())
}

fn mode(m: Mode) -> Value {
    text(match m {
        Mode::Managed => "managed",
        Mode::Seed => "seed",
    })
}

fn digest(h: &CHash) -> Value {
    text(h.to_string())
}

fn receipt_resource(r: &LockResource) -> Value {
    let mut e = vec![
        ("source", text(r.source.clone())),
        ("target", text(r.target.clone())),
        ("kind", text(r.kind.clone())),
        ("mode", mode(r.mode)),
        ("digest", digest(&r.digest)),
    ];
    if let Some(o) = &r.origin_digest {
        e.push(("origin_digest", digest(o)));
    }
    obj(e)
}

fn receipt(r: &Receipt) -> Value {
    obj(vec![
        ("id", text(r.id.clone())),
        ("version", text(r.version.clone())),
        ("digest", digest(&r.digest)),
        ("installed_by", text(r.installed_by.clone())),
        (
            "resources",
            Value::List(r.resources.iter().map(receipt_resource).collect()),
        ),
    ])
}

/// A downgrade refused only because `allow_downgrade` is off (Core reports
/// it as a plain conflict).
fn refused_downgrade(a: &Assessment, pack: &Pack, opts: &AssessOptions) -> bool {
    !opts.allow_downgrade
        && a.status == PackStatus::Conflict
        && a.current
            .as_ref()
            .and_then(|c| Version::parse(&c.version))
            .is_some_and(|installed| pack.version < installed)
}

/// The plan's assessment (snake_case) from Core's assessment.
fn assessment(a: &Assessment, pack: &Pack, opts: &AssessOptions, manage: bool) -> Value {
    let downgrade = refused_downgrade(a, pack, opts);
    let installed = |source: &str, target: &str| {
        a.current.as_ref().and_then(|c| {
            c.resources
                .iter()
                .find(|e| e.target == target && (source.is_empty() || e.source == source))
        })
    };
    let desired = Receipt {
        id: pack.id.clone(),
        version: pack.version.to_string(),
        digest: pack.digest,
        installed_by: a
            .current
            .as_ref()
            .map_or_else(|| opts.installed_by.clone(), |c| c.installed_by.clone()),
        resources: pack
            .resources
            .iter()
            .zip(&a.resources)
            .map(|(r, p)| LockResource {
                kind: r.kind.clone(),
                mode: r.mode,
                source: r.source.clone(),
                target: p.target.clone(),
                digest: r.digest,
                origin_digest: if r.mode == Mode::Seed { p.origin } else { None },
            })
            .collect(),
    };
    let resources = a
        .resources
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let entry = installed(&p.source, &p.target);
            // Desired resources come first, in manifest order; retired ones after.
            let (source, digest_of) = match pack.resources.get(i) {
                Some(r) => (r.source.clone(), Some(r.digest)),
                None => (
                    entry.map(|e| e.source.clone()).unwrap_or_default(),
                    entry.map(|e| e.digest),
                ),
            };
            let mut e = vec![
                ("source", text(source)),
                ("target", text(p.target.clone())),
                ("kind", text(p.kind.clone())),
                ("mode", mode(p.mode)),
                ("action", text(p.action.as_str())),
            ];
            if let Some(d) = digest_of.or(p.result) {
                e.push(("digest", digest(&d)));
            }
            if let Some(live) = &p.live {
                e.push(("current_digest", digest(live)));
            }
            if let Some(entry) = entry {
                e.push(("installed_digest", digest(&entry.digest)));
            }
            let adopted = p.action == Action::Adopt
                || (entry.is_none() && opts.adopt.contains_key(&p.target) && p.live.is_some());
            if adopted && let Some(live) = &p.live {
                e.push(("adopted_from_digest", digest(live)));
            }
            if let Some((d, version)) = &p.upgrade_baseline {
                let mut b = vec![("digest", digest(d))];
                if let Some(v) = version {
                    b.push(("version", Value::Int(*v)));
                }
                e.push(("upgrade_baseline", obj(b)));
            }
            if let Some(reason) = &p.reason {
                e.push(("reason", text(reason.clone())));
            }
            obj(e)
        })
        .collect();
    let mut out = vec![
        (
            "status",
            text(if downgrade {
                "downgrade"
            } else {
                a.status.as_str()
            }),
        ),
        ("applicable", Value::Bool(a.applicable())),
        ("definitions_manage", Value::Bool(manage)),
        ("assessment_digest", digest(&a.assessment_digest)),
    ];
    if let Some(c) = &a.current {
        out.push(("current", receipt(c)));
    }
    out.push(("desired", receipt(&desired)));
    out.push(("resources", Value::List(resources)));
    out.push((
        "lock",
        obj(vec![
            ("target", text(LOCK_PATH)),
            ("action", text(a.lock_action.as_str())),
            ("digest", digest(&a.lock_digest)),
        ]),
    ));
    if !a.issues.is_empty() {
        out.push((
            "issues",
            Value::List(
                a.issues
                    .iter()
                    .map(|i| {
                        let mut e = vec![
                            ("code", text(i.code.clone())),
                            ("message", text(i.message.clone())),
                        ];
                        if let Some(l) = &i.location {
                            e.push(("location", text(l.clone())));
                        }
                        obj(e)
                    })
                    .collect(),
            ),
        ));
    }
    obj(out)
}

fn write(op: Op) -> ApiResult<TypePackWrite> {
    match op {
        Op::ResourcePut(p) => Ok(TypePackWrite {
            path: p.path,
            doc: Some(p.doc),
            base_revision: p.base_revision.as_ref().map(convert::whash),
            must_not_exist: p.must_not_exist,
        }),
        Op::ResourceDelete(d) => Ok(TypePackWrite {
            path: d.path,
            doc: None,
            base_revision: d.base_revision.as_ref().map(convert::whash),
            must_not_exist: false,
        }),
        _ => Err(ErrorCode::Internal.err("type pack apply planned a non-resource write")),
    }
}

impl<S: Store> Replica<S> {
    pub(crate) fn type_pack_plan(
        &mut self,
        session: SessionId,
        request: TypePackRequest,
    ) -> ApiResult<TypePackPlan> {
        // The plan reads definitions like list_resources does.
        self.require_resource_inventory_read(session)?;
        let pack = pack(&request.provision)?;
        let opts = options(&request)?;
        let base = StoreView::new(&self.store, self.catalog.clone());
        let local = LayerView {
            base: &base,
            layer: &self.layer,
        };
        let manage = self.require(session, DEFINITIONS).is_ok();
        let planned = match &request.expected {
            None => assess_type_pack(&local, &pack, &opts).map(|a| (a, None)),
            Some(expected) => {
                // Refuse an apply the session could never submit, before review.
                self.require(session, DEFINITIONS)?;
                let a = assess_type_pack(&local, &pack, &opts);
                match a {
                    Ok(a)
                        if a.assessment_digest == convert::hash(expected)
                            && refused_downgrade(&a, &pack, &opts) =>
                    {
                        Err(mdbn_core::validate::Issue::new(
                            "type_pack_downgrade",
                            mdbn_core::validate::Severity::Error,
                            mdbn_core::validate::Tier::Request,
                            "an older version of an installed pack needs allow_downgrade",
                        ))
                    }
                    Ok(_) => apply_type_pack(&local, &pack, &opts, &convert::hash(expected)).map(
                        |(a, ops)| {
                            let ops = guard_adoptions(&a, &pack, ops);
                            (a, Some(ops))
                        },
                    ),
                    Err(e) => Err(e),
                }
            }
        };
        if let Some(e) = base.error() {
            return Err(store_err(e));
        }
        let (a, ops) = planned.map_err(issue)?;
        Ok(TypePackPlan {
            assessment: assessment(&a, &pack, &opts, manage),
            writes: ops
                .map(|ops| ops.into_iter().map(write).collect::<ApiResult<Vec<_>>>())
                .transpose()?,
        })
    }
}

/// Core records a byte-identical adopted target without writing it; a
/// same-bytes put guarded by its reviewed revision keeps it from changing
/// between review and submit (a matching put is a no-op).
fn guard_adoptions(a: &Assessment, pack: &Pack, mut ops: Vec<Op>) -> Vec<Op> {
    if ops.is_empty() {
        return ops;
    }
    // Desired resources come first in manifest order, so index `i` is pack resource `i`.
    let mut out: Vec<Op> = a
        .resources
        .iter()
        .zip(&pack.resources)
        .filter_map(|(p, r)| match (p.action, p.live) {
            (Action::Adopt, Some(live)) => Some(Op::ResourcePut(ResourcePut {
                path: p.target.clone(),
                doc: r.document.clone(),
                base_revision: Some(live),
                must_not_exist: false,
            })),
            _ => None,
        })
        .collect();
    out.append(&mut ops);
    out
}

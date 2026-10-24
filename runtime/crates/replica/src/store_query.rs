//! Neutral bounded query-index contract. No SQL, document parsing or temporal inference.
use crate::store::{Head, StoreError, StoreResult};
use mdbn_wire::common::Uuid;

/// Catalogue/default/SEM/spec/KEY_VERSION/projection-algorithm fingerprint;
/// the captured head is bound separately.
pub type QueryGeneration = [u8; 32];

/// An unambiguous materialized metadata field identity.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct QueryField {
    /// Effective=0, raw=1. Eligibility is determined by the trusted producer.
    pub source: u8,
    /// Core's canonical structural path encoding, not an ambiguously dotted name.
    pub path_key: Vec<u8>,
}
/// Lossless core ordering atom, validated by the producer and backend.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryAtom {
    /// Core SortAtom kind (Bool1/Number2/Temporal3/Text4/List5/Map6/Null255).
    pub kind: u8,
    /// Exact BLOB ordering key, never a floating-point SQL conversion.
    pub key: Vec<u8>,
}
/// A single trusted per-record projected field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryFieldValue {
    /// Materialized source/path identity.
    pub field: QueryField,
    /// Per-record trusted hint, never inferred by the store from a string shape.
    pub temporal_hint: u8,
    /// Canonical ordering value, including explicit null/missing.
    pub atom: QueryAtom,
}
/// Projection derived from the actual record and current catalogue.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryIndexedRow {
    /// Stable record identity.
    pub id: Uuid,
    /// Actual exact path, not a case-folded sorting substitute.
    pub path: String,
    /// Current catalogue membership, not stale RecordMeta.types.
    pub types: Vec<String>,
    /// Exactly one atom for EVERY configured field, including missing/null.
    pub fields: Vec<QueryFieldValue>,
}
/// Persistent materialization status, not permission to serve an app session.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryIndexState {
    /// Trusted semantic/spec generation.
    pub generation: QueryGeneration,
    /// Applied record snapshot.
    pub head: Head,
    /// Complete configured field set.
    pub fields: Vec<QueryField>,
    /// Backend-verified coverage; false while rebuilding or invalidated.
    pub ready: bool,
}
/// Accompanies the SAME Store Tx as record changes. No independent publication.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct QueryIndexTx {
    /// Generation under which these rows were derived.
    pub generation: QueryGeneration,
    /// Starts an inactive rebuild and clears previous rows/specs.
    pub replace_specs: Option<Vec<QueryField>>,
    /// Projected rows to replace atomically with record changes.
    pub rows: Vec<QueryIndexedRow>,
    /// Publish ONLY after backend checks complete coverage and this current head.
    pub publish_at: Option<Head>,
}
/// An eligible column in the bounded index plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryColumn {
    /// Exact UTF-8 path bytes.
    Path,
    /// Explicitly materialized metadata source/path.
    Field(QueryField),
}
/// Comparison whose CEL compatibility must be proven by the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QueryCompare {
    /// Equal.
    Eq,
    /// Not equal.
    Ne,
    /// Less than.
    Lt,
    /// Less than or equal.
    Le,
    /// Greater than.
    Gt,
    /// Greater than or equal.
    Ge,
}
/// Bounded, fully lowered predicate; unsupported CEL stays out of this AST.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum QueryPredicate {
    /// Every live indexed record.
    All,
    /// Any of these trusted current membership names.
    Types(Vec<String>),
    /// Typed CEL eligibility must be proven by the caller. A numeric ordered
    /// predicate requires Number kind: total sort-kind order is NOT CEL.
    Compare {
        /// Indexed column.
        column: QueryColumn,
        /// Supported comparison.
        op: QueryCompare,
        /// Canonical scalar operand, not a SQL REAL approximation.
        value: QueryAtom,
    },
    /// All predicates must match.
    And(Vec<QueryPredicate>),
    /// Any predicate may match.
    Or(Vec<QueryPredicate>),
    /// Complement of a predicate that cannot raise a CEL error (Core proves it).
    /// Every field/ID has a materialized atom, so there is no SQL NULL logic.
    Not(Box<QueryPredicate>),
}
/// An explicit order term; the final ID tie-break is always ascending.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryOrder {
    /// Exact indexed column.
    pub column: QueryColumn,
    /// Reverse this term's kind/key, never the final ID tie-break.
    pub descending: bool,
}
/// Selected identity/ordering metadata without record source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryKeyedId {
    /// Stable record identity.
    pub id: Uuid,
    /// Full ordering tuple.
    pub keys: Vec<QueryAtom>,
    /// SQL length(row) or equivalently conservative encoded source size.
    pub encoded_bytes: u64,
}
/// Captured index request; the driver additionally binds query hash/clock/auth.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryIndexRequest {
    /// Expected semantic/spec fingerprint.
    pub generation: QueryGeneration,
    /// Expected record snapshot.
    pub head: Head,
    /// Complete eligible predicate, not a partial residual claimed complete.
    pub predicate: QueryPredicate,
    /// Explicit order terms.
    pub order: Vec<QueryOrder>,
    /// Full ordering tuple, with ID always ASC (also for DESC order terms).
    pub after: Option<QueryKeyedId>,
    /// Requested page size; backends reject values above 1000.
    pub limit: u32,
    /// Matching identities to skip (in order) before the page, after `after`.
    /// Skipping reads index keys only, never record sources; it lets a bounded
    /// page start deep in a large match set.
    pub offset: u64,
    /// Aggregate returned key bytes; separate from record-source hydration.
    pub max_key_bytes: u64,
    /// Also count every match ([`QueryIndexPage::total_matches`]). A full count
    /// costs work proportional to all matches, so the driver never asks for it.
    pub count_matches: bool,
}
impl QueryIndexRequest {
    /// Map Core's complete membership/order proof; omitted fields fail before
    /// hydration. Diagnostics, overlays and authority still need caller proof.
    pub fn from_profile(
        profile: &mdbn_core::query::profile::Profile,
        context: &crate::plan::QueryProjectionContext,
        head: Head,
        limit: u32,
        max_key_bytes: u64,
    ) -> StoreResult<Self> {
        use mdbn_core::query::profile as p;
        if limit > 1000
            || max_key_bytes > 1 << 20
            || profile.types.len() > 16
            || profile.types.iter().any(|s| s.len() > 256)
            || profile.order.len() > 8
        {
            return Err(StoreError::Full);
        }
        fn column(
            c: &p::Column,
            ctx: &crate::plan::QueryProjectionContext,
        ) -> StoreResult<QueryColumn> {
            match c {
                p::Column::Path => Ok(QueryColumn::Path),
                p::Column::Field(f) => {
                    let field = QueryField {
                        source: match f.source {
                            mdbn_core::query::indexed::FieldSource::Effective => 0,
                            mdbn_core::query::indexed::FieldSource::Raw => 1,
                        },
                        path_key: f.path_key(1024).map_err(|_| StoreError::Full)?,
                    };
                    if !ctx.fields().contains(&field) {
                        return Err(StoreError::Io("query field is not materialized".into()));
                    }
                    Ok(QueryColumn::Field(field))
                }
            }
        }
        fn predicate(
            p: &p::Predicate,
            ctx: &crate::plan::QueryProjectionContext,
            nodes: &mut usize,
            depth: usize,
        ) -> StoreResult<QueryPredicate> {
            *nodes += 1;
            if *nodes > 128 || depth > 16 {
                return Err(StoreError::Full);
            }
            Ok(match p {
                p::Predicate::All => QueryPredicate::All,
                p::Predicate::None => QueryPredicate::Or(vec![]),
                p::Predicate::Not(inner) => {
                    QueryPredicate::Not(Box::new(predicate(inner, ctx, nodes, depth + 1)?))
                }
                p::Predicate::And(ps) | p::Predicate::Or(ps) => {
                    // AND and OR are associative: a chain of nested same-operator
                    // nodes is one flat list, so a long `a && b && ...` costs one
                    // level of depth, not one per clause.
                    let and = matches!(p, p::Predicate::And(_));
                    let mut flat = Vec::new();
                    let mut pending: Vec<&p::Predicate> = ps.iter().rev().collect();
                    while let Some(q) = pending.pop() {
                        match q {
                            p::Predicate::And(inner) if and => {
                                pending.extend(inner.iter().rev());
                            }
                            p::Predicate::Or(inner) if !and => {
                                pending.extend(inner.iter().rev());
                            }
                            q => flat.push(q),
                        }
                        if flat.len() + pending.len() > 128 {
                            return Err(StoreError::Full);
                        }
                    }
                    let children = flat
                        .into_iter()
                        .map(|p| predicate(p, ctx, nodes, depth + 1))
                        .collect::<StoreResult<_>>()?;
                    if matches!(p, p::Predicate::And(_)) {
                        QueryPredicate::And(children)
                    } else {
                        QueryPredicate::Or(children)
                    }
                }
                p::Predicate::Compare {
                    column: c,
                    op,
                    value,
                } => {
                    if value.key().len() > 8192 {
                        return Err(StoreError::Full);
                    }
                    QueryPredicate::Compare {
                        column: column(c, ctx)?,
                        op: match op {
                            p::Compare::Eq => QueryCompare::Eq,
                            p::Compare::Lt => QueryCompare::Lt,
                            p::Compare::Le => QueryCompare::Le,
                            p::Compare::Gt => QueryCompare::Gt,
                            p::Compare::Ge => QueryCompare::Ge,
                        },
                        value: QueryAtom {
                            kind: value.kind() as u8,
                            key: value.key().to_vec(),
                        },
                    }
                }
            })
        }
        let mut where_ = predicate(&profile.predicate, context, &mut 0, 0)?;
        if !profile.types.is_empty() {
            where_ =
                QueryPredicate::And(vec![QueryPredicate::Types(profile.types.clone()), where_]);
        }
        let order = profile
            .order
            .iter()
            .map(|o| {
                Ok(QueryOrder {
                    column: column(&o.column, context)?,
                    descending: o.direction == mdbn_core::query::Direction::Desc,
                })
            })
            .collect::<StoreResult<_>>()?;
        Ok(Self {
            generation: context.generation(),
            head,
            predicate: where_,
            order,
            after: None,
            offset: 0,
            limit,
            max_key_bytes,
            count_matches: false,
        })
    }
}
/// Bounded selected IDs/keys, never record source documents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryIndexPage {
    /// At most the requested bounded number of identities.
    pub rows: Vec<QueryKeyedId>,
    /// Every match, when the request asked for the count
    /// ([`QueryIndexRequest::count_matches`]). Exact only for a fully lowered
    /// index predicate, not residual matches.
    pub total_matches: Option<u64>,
    /// More matching identities remain. A key-byte-capped short page is NOT EOF.
    /// An oversized first key must error, never masquerade as an empty final page.
    pub has_more: bool,
}
/// Confirmed source metadata, usable before an optional field index is ready.
/// Encoded size is source admission, not an aggregate allocation measurement.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueryRecordSize {
    /// Stable confirmed record identity.
    pub id: Uuid,
    /// Conservative encoded source size; no document has been copied.
    pub encoded_bytes: u64,
}
/// One request owns ONE budget across every page/retry/restart; no refunds.
#[derive(Debug, PartialEq, Eq)]
pub struct QueryBudget {
    records_left: u32,
    bytes_left: u64,
}
impl QueryBudget {
    /// Shared binding profile: 1000 hydrated records AND 1 MiB encoded source.
    pub const HOSTED: Self = Self {
        records_left: 1000,
        bytes_left: 1 << 20,
    };
    /// Tighten the binding profile, never widen it for any replica mode.
    pub fn new(records: u32, bytes: u64) -> Self {
        Self {
            records_left: records.min(1000),
            bytes_left: bytes.min(1 << 20),
        }
    }
    /// Remaining cumulative record count.
    pub fn records_left(&self) -> u32 {
        self.records_left
    }
    /// Remaining cumulative encoded-source bytes.
    pub fn bytes_left(&self) -> u64 {
        self.bytes_left
    }
    /// Charge atomically BEFORE record BLOB fetch/decode. Failed work is not refunded.
    pub fn charge(&mut self, records: u32, bytes: u64) -> StoreResult<()> {
        let records_left = self
            .records_left
            .checked_sub(records)
            .ok_or(StoreError::Full)?;
        let bytes_left = self.bytes_left.checked_sub(bytes).ok_or(StoreError::Full)?;
        self.records_left = records_left;
        self.bytes_left = bytes_left;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_constructor_cannot_widen_the_binding_profile() {
        let b = QueryBudget::new(u32::MAX, u64::MAX);
        assert_eq!((b.records_left(), b.bytes_left()), (1000, 1 << 20));
    }
    #[test]
    fn cumulative_charge_rejects_atomically() {
        let mut b = QueryBudget::new(2, 10);
        b.charge(1, 6).unwrap();
        assert_eq!((b.records_left(), b.bytes_left()), (1, 4));
        assert_eq!(b.charge(1, 5), Err(StoreError::Full));
        assert_eq!(b.charge(2, 1), Err(StoreError::Full));
        assert_eq!((b.records_left(), b.bytes_left()), (1, 4));
        b.charge(1, 4).unwrap();
        assert_eq!((b.records_left(), b.bytes_left()), (0, 0));
    }
}

// ---- bounded raw projection (streaming Bases; views owns the SQL backend) ----

/// Most rows one projection page may return.
pub const MAX_PROJECTION_ROWS: u32 = 128;
/// Most encoded bytes (paths, raw values, tags) one projection page may return.
pub const MAX_PROJECTION_BYTES: u64 = 1 << 20;
/// Most raw frontmatter fields one projection request may name.
pub const MAX_PROJECTION_FIELDS: usize = 64;

/// Readiness of the raw projection payload, separate from the field index
/// ([`QueryIndexState`]): requested raw names need not be indexed fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct QueryProjectionState {
    /// Generation the payload was materialized under.
    pub generation: QueryGeneration,
    /// Snapshot it covers.
    pub head: Head,
    /// Complete for every record at `head` (backfill done, version current).
    pub ready: bool,
}

/// A bounded page of raw per-record projections under a captured index
/// generation and head. The predicate is a NECESSARY condition only: callers
/// evaluate the full query on every returned row. Never reads document BLOBs.
#[derive(Clone, Debug, PartialEq)]
pub struct QueryProjectionRequest {
    /// Expected semantic/spec fingerprint (the captured projection context).
    pub generation: QueryGeneration,
    /// Expected record snapshot; any other store head is an error, not a page.
    pub head: Head,
    /// Necessary-condition candidate filter. `QueryPredicate::All` for none.
    pub predicate: QueryPredicate,
    /// Separate raw Bases three-valued candidate approximation. Only with All;
    /// unknown/error-capable rows must remain candidates. No CEL proof implied.
    pub bases_candidate: Option<mdbn_core::views::bases::BasesCandidate>,
    /// Trusted exact already-matched identities for window display hydration.
    /// Raw-only with All/no candidate/no cursor; sorted unique, nonempty and
    /// bounded by this page's unchanged row limit. Never caller authority.
    pub bases_records: Option<Vec<Uuid>>,
    /// ID cursor (exclusive): rows are returned in ascending ID order after it.
    pub after: Option<Uuid>,
    /// Requested rows, `1..=MAX_PROJECTION_ROWS`.
    pub limit: u32,
    /// Encoded byte bound for the page, `1..=MAX_PROJECTION_BYTES`.
    pub max_bytes: u64,
    /// Top-level raw frontmatter names (structural source 1), distinct, sorted.
    pub fields: Vec<String>,
    /// Whether to return the qualified `file.tags` observation.
    pub tags: bool,
}

impl QueryProjectionRequest {
    /// Whether the request is within the contract's bounds. Backends refuse an
    /// invalid request with an error, never a truncated or empty page.
    pub fn check(&self) -> StoreResult<()> {
        let sorted = self.fields.windows(2).all(|w| w[0] < w[1]);
        if self.limit == 0
            || self.limit > MAX_PROJECTION_ROWS
            || self.max_bytes == 0
            || self.max_bytes > MAX_PROJECTION_BYTES
            || self.fields.len() > MAX_PROJECTION_FIELDS
            || !sorted
            || self.fields.iter().any(|f| f.is_empty() || f.len() > 256)
            || self.bases_records.as_ref().is_some_and(|ids| {
                self.predicate != QueryPredicate::All
                    || self.bases_candidate.is_some()
                    || self.after.is_some()
                    || ids.is_empty()
                    || ids.len() > self.limit as usize
                    || !ids.windows(2).all(|w| w[0] < w[1])
            })
            || self
                .bases_candidate
                .as_ref()
                .is_some_and(|p| self.predicate != QueryPredicate::All || !p.is_bounded())
        {
            return Err(StoreError::Full);
        }
        Ok(())
    }
}

/// One raw frontmatter value as written, without schema or temporal coercion.
#[derive(Clone, Debug)]
pub enum RawField {
    /// The key is absent from the frontmatter.
    Missing,
    /// The key is present; `Value::Null` for an explicit null.
    Present(mdbn_core::value::Value),
}

/// One record's raw projection.
#[derive(Clone, Debug)]
pub struct QueryProjectionRow {
    /// Record ID.
    pub id: Uuid,
    /// Exact record path.
    pub path: String,
    /// The authenticated source revision the values were read from.
    pub source_sha: mdbn_wire::common::B32,
    /// Encoded source size, for the caller's source meter.
    pub source_bytes: u64,
    /// One entry per requested field, in request order.
    pub fields: Vec<RawField>,
    /// Qualified `file.tags`: `None` when unavailable (never "no tags"),
    /// `Some(vec![])` when known empty. Always `None` unless requested.
    pub tags: Option<Vec<String>>,
}

/// A bounded projection page.
#[derive(Clone, Debug, Default)]
pub struct QueryProjectionPage {
    /// At most `limit` rows, ascending by ID, all after the cursor.
    pub rows: Vec<QueryProjectionRow>,
    /// Encoded bytes of this page as the backend counted them.
    pub encoded_bytes: u64,
    /// More candidates remain after the last row (a byte-capped short page is
    /// NOT EOF).
    pub has_more: bool,
}

impl QueryProjectionPage {
    /// The contract a backend's page must meet for `request`; a violation is
    /// an integrity error at the caller, never a page to use.
    pub fn check(&self, request: &QueryProjectionRequest) -> Result<(), &'static str> {
        if self.rows.len() > request.limit as usize {
            return Err("projection page over its row limit");
        }
        if self.encoded_bytes > request.max_bytes {
            return Err("projection page over its byte bound");
        }
        if self.rows.is_empty() && self.has_more {
            return Err("empty projection page claims more rows");
        }
        if let Some(ids) = &request.bases_records
            && (self.rows.len() > ids.len()
                || self.rows.iter().zip(ids).any(|(row, id)| row.id != *id)
                || (!self.has_more && self.rows.len() != ids.len())
                || (self.has_more && self.rows.len() == ids.len()))
        {
            return Err("projection page differs from exact requested identities");
        }
        let mut prev = request.after;
        for row in &self.rows {
            if prev.is_some_and(|p| row.id <= p) {
                return Err("projection rows out of ID order or not after the cursor");
            }
            prev = Some(row.id);
            if row.fields.len() != request.fields.len() {
                return Err("projection row fields differ from the request");
            }
            if !request.tags && row.tags.is_some() {
                return Err("projection row carries unrequested tags");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod projection_tests {
    use super::*;
    use crate::store::Store as _;
    use mdbn_wire::common::{B16, B32};

    fn request() -> QueryProjectionRequest {
        QueryProjectionRequest {
            generation: [1; 32],
            head: Head::GENESIS,
            predicate: QueryPredicate::All,
            bases_candidate: None,
            bases_records: None,
            after: Some(B16([5; 16])),
            limit: 2,
            max_bytes: 100,
            fields: vec!["due".into(), "status".into()],
            tags: false,
        }
    }

    fn row(id: u8) -> QueryProjectionRow {
        QueryProjectionRow {
            id: B16([id; 16]),
            path: format!("t{id}.md"),
            source_sha: B32([id; 32]),
            source_bytes: 10,
            fields: vec![
                RawField::Missing,
                RawField::Present(mdbn_core::value::Value::Null),
            ],
            tags: None,
        }
    }

    #[test]
    fn exact_identity_requests_and_pages_refuse_incomplete_or_extra_membership() {
        let req = QueryProjectionRequest {
            after: None,
            bases_records: Some(vec![B16([6; 16]), B16([8; 16])]),
            ..request()
        };
        assert!(req.check().is_ok());
        for bad in [
            QueryProjectionRequest {
                after: Some(B16([5; 16])),
                ..req.clone()
            },
            QueryProjectionRequest {
                bases_records: Some(vec![]),
                ..req.clone()
            },
            QueryProjectionRequest {
                bases_records: Some(vec![B16([8; 16]), B16([6; 16])]),
                ..req.clone()
            },
            QueryProjectionRequest {
                bases_records: Some(vec![B16([6; 16]), B16([6; 16])]),
                ..req.clone()
            },
            QueryProjectionRequest {
                limit: 1,
                ..req.clone()
            },
        ] {
            assert!(bad.check().is_err());
        }
        let full = QueryProjectionPage {
            rows: vec![row(6), row(8)],
            encoded_bytes: 90,
            has_more: false,
        };
        assert!(full.check(&req).is_ok());
        let prefix = QueryProjectionPage {
            rows: vec![row(6)],
            encoded_bytes: 45,
            has_more: true,
        };
        assert!(prefix.check(&req).is_ok());
        for bad in [
            QueryProjectionPage {
                has_more: true,
                ..full.clone()
            },
            QueryProjectionPage {
                has_more: false,
                ..prefix.clone()
            },
            QueryProjectionPage {
                rows: vec![row(8)],
                ..prefix.clone()
            },
            QueryProjectionPage {
                rows: vec![row(6), row(7)],
                ..full.clone()
            },
            QueryProjectionPage {
                rows: vec![],
                encoded_bytes: 0,
                has_more: false,
            },
        ] {
            assert!(bad.check(&req).is_err());
        }
    }
    #[test]
    fn requests_out_of_bounds_are_refused() {
        assert!(request().check().is_ok());
        for bad in [
            QueryProjectionRequest {
                limit: 0,
                ..request()
            },
            QueryProjectionRequest {
                limit: MAX_PROJECTION_ROWS + 1,
                ..request()
            },
            QueryProjectionRequest {
                max_bytes: 0,
                ..request()
            },
            QueryProjectionRequest {
                max_bytes: MAX_PROJECTION_BYTES + 1,
                ..request()
            },
            QueryProjectionRequest {
                fields: vec!["b".into(), "a".into()],
                ..request()
            },
            QueryProjectionRequest {
                fields: vec!["a".into(), "a".into()],
                ..request()
            },
            QueryProjectionRequest {
                fields: vec![String::new()],
                ..request()
            },
        ] {
            assert!(matches!(bad.check(), Err(StoreError::Full)), "{bad:?}");
        }
    }

    #[test]
    fn pages_that_break_the_contract_are_refused() {
        let r = request();
        let ok = QueryProjectionPage {
            rows: vec![row(6), row(7)],
            encoded_bytes: 100,
            has_more: true,
        };
        assert!(ok.check(&r).is_ok());
        let bad = [
            QueryProjectionPage {
                rows: vec![row(6), row(7), row(8)],
                ..ok.clone()
            },
            QueryProjectionPage {
                encoded_bytes: 101,
                ..ok.clone()
            },
            QueryProjectionPage {
                rows: vec![],
                encoded_bytes: 0,
                has_more: true,
            },
            QueryProjectionPage {
                rows: vec![row(5)],
                ..ok.clone()
            },
            QueryProjectionPage {
                rows: vec![row(7), row(6)],
                ..ok.clone()
            },
            QueryProjectionPage {
                rows: vec![QueryProjectionRow {
                    fields: vec![RawField::Missing],
                    ..row(6)
                }],
                ..ok.clone()
            },
            QueryProjectionPage {
                rows: vec![QueryProjectionRow {
                    tags: Some(vec![]),
                    ..row(6)
                }],
                ..ok.clone()
            },
        ];
        for page in bad {
            assert!(page.check(&r).is_err(), "{page:?}");
        }
    }

    /// The neutral default never answers with an empty page.
    #[test]
    fn unsupported_store_errors() {
        let store = crate::mem::MemStore::new();
        assert!(store.query_projection_state().unwrap().is_none());
        assert!(store.query_projection_page(&request()).is_err());
    }
}

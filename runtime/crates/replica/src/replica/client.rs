//! The in-process client API (`replica-client-api.md`), implemented on [`Replica`].

mod describe;
mod resources;

use mdbn_core::query::{Query, QueryEnv, QueryRecord, Verdict};
use mdbn_core::state::StateView;
use mdbn_wire::client::{
    FileState, FileView, GrantInfo, HelloParams, HelloResult, Hold, Include, Issue,
    Materialization, MaterializeMode, OpenUploadParams, OpenUploadResult, QueryResult, Receipt,
    ReceiptState, RecordView, SubmitParams, SyncStatus, UploadChunkParams,
};
use mdbn_wire::common::{Hash, Uuid, Value, Version};
use mdbn_wire::policy::Role;

use super::submit::store_err;
use super::{Replica, Session};
use crate::api::{
    ApiResult, CallbackId, ChangesResult, ClientApi, ConflictEntry, Describe, ErrorCode,
    FenceEditor, FenceResult, FileList, HoldResolution, ListFiles, PendingDevice, Push,
    SessionAuth, SessionId, StreamId, Target,
};
use crate::convert;
use crate::layer::LayerView;
use crate::plan::StoreView;
use crate::store::{FileLocal, Page, Store};

/// The client API versions this replica serves (major 1, minors 0..=0).
pub const API_VERSION: Version = Version { major: 1, minor: 0 };

/// Every capability (`policy.md` §5), granted to the hosting app.
pub const ALL_CAPABILITIES: [&str; 8] = [
    "collection.read",
    "records.create",
    "records.edit",
    "records.delete",
    "views.manage",
    "definitions.manage",
    "background.schedule",
    "offline.replica",
];

fn not_yet<T>(what: &str) -> ApiResult<T> {
    Err(ErrorCode::Unavailable
        .err_with_reason("not_implemented", format!("{what} is not implemented yet")))
}

impl<S: Store> Replica<S> {
    /// Terminal apply faults require disposal of this instance and its sealer.
    /// Recover/reload durable storage, supply a fresh sealer, then `Replica::open`;
    /// reusing a failed logical cache or toggling a flag is NOT recovery.
    /// A known aborted transaction may retry normally and returns `false` here.
    /// Client sessions are closed on either fault and must reconnect/resubscribe.
    pub fn requires_reopen(&self) -> bool {
        self.apply_fault
    }

    pub(crate) fn check_apply_health(&self) -> ApiResult<()> {
        if self.apply_fault {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "apply_reopen_required",
                "dispose and reopen the replica from recovered durable storage",
            ));
        }
        if self.is_apply_recovering() {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "apply_recovering",
                "control apply is recovering; retry after its verified prefix is restored",
            ));
        }
        if !self.hosted_serving() {
            return Err(ErrorCode::Unavailable.err_with_reason(
                "hosted_rebuilding",
                "the hosted replica is rebuilding from the log; retry",
            ));
        }
        Ok(())
    }

    pub(crate) fn session(&self, s: SessionId) -> ApiResult<&Session> {
        self.check_apply_health()?;
        self.sessions
            .get(&s)
            .ok_or_else(|| ErrorCode::Unauthenticated.err("no such session"))
    }

    /// Whether this replica may serve app (granted) sessions at all: its key must be
    /// trusted on this device and the collection state in the log must be
    /// the one the user chose (a log that claims cloud copy
    /// on its own serves no apps).
    pub(crate) fn serves_apps(&self) -> Result<(), &'static str> {
        // while lost control is latched, or a rollback has not
        // finished, only the hosting app is served.
        if self.lost_control_pending() {
            return Err("re-syncing after a lost log tail; only the hosting app is served");
        }
        if self.key_untrusted {
            return Err("the collection key is not trusted on this device");
        }
        if let Some(chosen) = self.cfg.chosen_state
            && self.policy.cstate.is_some()
            && self.policy.cstate != Some(chosen)
        {
            return Err("the collection state differs from the one chosen on this device");
        }
        Ok(())
    }

    pub(crate) fn grant_now(&self, grant: &Uuid) -> Option<crate::policy::EffectiveGrant> {
        // no grant is effective while lost control is latched (only the
        // hosting app is served), and a latched grant stays revoked until the log
        // shows it again.
        if self.lost_control_pending() || self.grant_latched(grant) {
            return None;
        }
        if self.local_only() {
            let mut grant = self.grant_source.as_ref()?.grant(grant)?;
            grant.role = grant
                .role
                .min(self.authorize(grant.account, self.cfg.collection)?);
            Some(grant)
        } else {
            self.policy.effective_grant(grant)
        }
    }

    pub(crate) fn grant_for_client(
        &self,
        grant: &Uuid,
        client_pk: &[u8; 32],
    ) -> Option<crate::policy::EffectiveGrant> {
        self.grant_now(grant)
            .filter(|g| g.client_pk.0 == *client_pk)
    }

    /// Current collection authority for an independently authenticated account.
    /// Local-only uses registered ownership; synced/shared uses current signed
    /// membership and role, never the original creator or stale local metadata.
    /// The caller authenticates `active_account`; this lookup does not do so.
    pub fn authorize(
        &self,
        active_account: Uuid,
        collection: Uuid,
    ) -> Option<mdbn_wire::policy::Role> {
        if self.apply_fault
            || collection != self.cfg.collection
            || active_account == crate::policy::SERVICE_ACCOUNT
            // a member removed in a lost window stays removed here.
            || self.latch.members.contains(&active_account)
        {
            return None;
        }
        if !self.local_only() {
            return self.policy.members.get(&active_account).copied();
        }
        let source = self.grant_source.as_ref()?;
        if source.active_account() != Some(active_account) {
            return None;
        }
        source
            .owner_identity()
            .filter(|owner| {
                owner.collection.0 != [0; 16]
                    && owner.device.0 != [0; 16]
                    && owner.collection == collection
                    && owner.device == self.cfg.device_id
                    && owner.account == active_account
            })
            .map(|_| mdbn_wire::policy::Role::Owner)
    }

    pub(crate) fn serving_account_matches(&self, account: &Uuid) -> bool {
        if !self.local_only() {
            return self
                .policy
                .writer_serves_account(&self.cfg.device_id, account);
        }
        self.grant_source
            .as_ref()
            .and_then(|source| source.active_account())
            .is_some_and(|active| {
                active == *account && self.authorize(active, self.cfg.collection).is_some()
            })
    }

    /// This replica instance's wake identity (random per open; the host's live
    /// admission bridge compares it with each observation).
    pub fn wake_instance(&self) -> u64 {
        self.live.instance
    }

    /// Read-only policy binding: the policy of the last applied verified prefix holds
    /// an active grant `grant` bound to `client_pk`. Not freshness, a current head,
    /// account, custody or Ready: hosts combine it with live verified admission, and
    /// the replica still authorizes each method/path/record itself.
    pub fn grant_authorized(&self, grant: &Uuid, client_pk: &[u8; 32]) -> bool {
        !self.apply_fault
            && !self.local_only()
            && self.policy.grant_for_client(grant, client_pk).is_some()
    }

    /// Install the trusted host's dynamic local grant/ownership provider. Synced
    /// authority remains policy-based. Missing/changed provenance closes sessions.
    pub fn set_grant_source(&mut self, source: Box<dyn crate::policy::GrantSource>) {
        self.grant_source = Some(source);
        self.close_revoked_sessions();
    }

    /// Call on grant/lease/owner changes; reads and outputs also recheck dynamically.
    pub fn grants_changed(&mut self) {
        self.close_revoked_sessions();
        self.cancel_stale_approvals();
    }

    /// The session, checked for `cap` against its grant in the current confirmed
    /// policy (`policy.md` §7). The hosting app may do everything.
    pub(crate) fn require(&self, s: SessionId, cap: &str) -> ApiResult<()> {
        let sess = self.session(s)?;
        let SessionAuth::Grant { grant, client_pk } = &sess.auth else {
            return Ok(());
        };
        let g = self
            .grant_for_client(grant, client_pk)
            .ok_or_else(|| ErrorCode::Unauthenticated.err("the grant is no longer active"))?;
        if !self.serving_account_matches(&g.account) {
            return Err(ErrorCode::Forbidden.err_with_reason(
                "grant_account_mismatch",
                "this device may not serve this account's grant",
            ));
        }
        if let Err(why) = self.serves_apps() {
            return Err(ErrorCode::Unavailable.err_with_reason("untrusted", why));
        }
        if !g.allows(cap) {
            let mut p = ErrorCode::Forbidden.problem(format!("the grant lacks {cap}"));
            p.details = Some(Value::Map(vec![(
                "capability".into(),
                Value::Text(cap.to_string()),
            )]));
            return Err(p.into());
        }
        Ok(())
    }

    /// The folder scope of a session's file namespace (`policy.md` §5):
    /// `None` when unrestricted (the hosting app, or a grant without folders).
    pub(crate) fn file_scope(&self, s: SessionId) -> Option<Vec<String>> {
        let SessionAuth::Grant { grant, .. } = &self.sessions.get(&s)?.auth else {
            return None;
        };
        match self
            .grant_now(grant)
            .filter(|g| self.serving_account_matches(&g.account))
        {
            Some(g) => g.file_folders,
            // No effective grant: nothing is visible.
            None => Some(Vec::new()),
        }
    }

    /// Whether a file at `path` is visible to the session. Outside the scope a file
    /// does not exist for it.
    pub(crate) fn file_visible(&self, s: SessionId, path: &str) -> bool {
        match self.file_scope(s) {
            None => true,
            Some(folders) => {
                crate::policy::within_folders(path, &folders, &mdbn_core::paths::path_key)
            }
        }
    }

    /// Whether a change-feed entry is visible to the session: records always (grants
    /// are collection-wide for records), files only within the scope.
    pub(crate) fn change_visible(&self, s: SessionId, c: &mdbn_wire::client::Change) -> bool {
        if self.file_scope(s).is_none() {
            return true;
        }
        let is_file = self.store.file(&c.id).ok().flatten().is_some()
            || self
                .store
                .tombstone(&c.id)
                .ok()
                .flatten()
                .is_some_and(|t| t.kind == mdbn_wire::snapshot::EntityKind::File)
            || self.layer.file_known(&crate::convert::uuid(&c.id));
        !is_file || self.file_visible(s, &c.path)
    }

    /// Receipt output needs a current authenticated session, but not read
    /// capability: write-only clients still receive their own outcomes.
    fn receipt_session_current(&self, id: SessionId) -> bool {
        let Ok(session) = self.session(id) else {
            return false;
        };
        match &session.auth {
            SessionAuth::Host => true,
            SessionAuth::Grant { grant, client_pk } => {
                self.serves_apps().is_ok()
                    && self
                        .grant_for_client(grant, client_pk)
                        .is_some_and(|g| self.serving_account_matches(&g.account))
            }
        }
    }

    /// Fan out only after a durable receipt-state commit. Ownership comes from
    /// the persisted pending/local receipt, never an expired submitter connection.
    /// A failed ownership read suppresses output; receipt polling can retry.
    pub(super) fn push_durable_receipt(&mut self, receipt: Receipt) {
        // Pending capture must retain the original session for explicitly
        // nonpersisted Hosted collision/ticket resolution. Terminal states retire it.
        if receipt.state != ReceiptState::Pending {
            self.submitted_by.remove(&receipt.mutation);
        }
        let targets: Vec<_> = self
            .sessions
            .keys()
            .copied()
            .filter(|id| {
                self.receipt_session_current(*id)
                    && self
                        .known_receipt_for(&receipt.mutation, self.sessions[id].grant())
                        .is_ok_and(|r| r.is_some())
            })
            .collect();
        self.pushes.extend(
            targets
                .into_iter()
                .map(|id| (id, Push::Receipt(receipt.clone()))),
        );
    }

    /// Close granted sessions whose grant is no longer effective (`policy.md` §7.4).
    pub(crate) fn close_revoked_sessions(&mut self) {
        let gone: Vec<SessionId> = self
            .sessions
            .iter()
            .filter(|(_, s)| match &s.auth {
                SessionAuth::Grant { grant, client_pk } => self
                    .grant_for_client(grant, client_pk)
                    .is_none_or(|g| self.local_only() && !self.serving_account_matches(&g.account)),
                SessionAuth::Host => false,
            })
            .map(|(id, _)| *id)
            .collect();
        for id in gone {
            self.pushes
                .retain(|(session, p)| *session != id || matches!(p, Push::Closed(_)));
            self.pushes.push((
                id,
                Push::Closed(ErrorCode::Unauthenticated.problem("the grant was revoked")),
            ));
            self.sessions.remove(&id);
            self.bases_discovery.remove(id);
            self.query_cursors.close(id);
            self.submitted_by.retain(|_, s| *s != id);
            self.drop_session_live(id);
        }
    }

    pub(super) fn host_only(&self, s: SessionId) -> ApiResult<()> {
        match self.session(s)?.auth {
            SessionAuth::Host => Ok(()),
            SessionAuth::Grant { .. } => {
                Err(ErrorCode::Forbidden.err("only the hosting app may do this"))
            }
        }
    }

    /// "Confirmed through N, plus pending".
    pub fn sync_status(&self) -> SyncStatus {
        // Resurrected acknowledged writes are re-syncing, not pending (§6).
        let pending = self
            .store
            .pending_count()
            .unwrap_or(0)
            .saturating_sub(self.resurrected.len() as u64);
        let oldest = self
            .store
            .pending(None, 1)
            .ok()
            .and_then(|r| r.first().map(|r| r.mutation.clock.instant));
        SyncStatus {
            resyncing: self.resyncing(),
            confirmed_head: self.confirmed_handover_head(),
            mode: self.cfg.mode,
            confirmed_through: if self.local_only() { 0 } else { self.head.seq },
            head_known: if self.local_only() {
                0
            } else {
                self.head_known.max(self.head.seq)
            },
            pending,
            oldest_pending: oldest,
            holds: self.store.holds().map(|h| h.len() as u64).unwrap_or(0),
            unresolved: self.store.conflict_count().unwrap_or(0),
            connection: self.connection,
            installing: self.install.as_ref().map(|_| mdbn_wire::client::Progress {
                done: self.install_progress.0,
                total: self.install_progress.1,
            }),
            incidents: self.incidents.values().cloned().collect(),
        }
    }

    fn resolve_target(&self, v: &dyn StateView, t: &Target) -> Option<Uuid> {
        match t {
            Target::Id(id) => Some(*id),
            Target::Path(p) => {
                let k = mdbn_core::paths::path_key(p);
                match v.at_path_key(&k) {
                    Some(mdbn_core::state::PathHolder::Record(id)) => Some(convert::wuuid(&id)),
                    Some(mdbn_core::state::PathHolder::File(id)) => Some(convert::wuuid(&id)),
                    None => v.alias(&k).map(|id| convert::wuuid(&id)),
                }
            }
        }
    }

    pub(crate) fn run_query(&self, query: &Value, include: &Include) -> ApiResult<QueryResult> {
        self.run_query_mode(query, include, true)
    }

    /// Fresh ordinary query whose generic index attempt already declined BEFORE
    /// hydration. Do not attempt the same selection again or count it twice.
    pub(crate) fn run_query_per_record(
        &self,
        query: &Value,
        include: &Include,
    ) -> ApiResult<QueryResult> {
        self.run_query_mode(query, include, false)
    }

    fn run_query_mode(
        &self,
        query: &Value,
        include: &Include,
        try_index: bool,
    ) -> ApiResult<QueryResult> {
        let cq = convert::value(query).map_err(|e| ErrorCode::InvalidRequest.err(e.to_string()))?;
        let q = Query::from_value(&cq).map_err(|e| {
            ErrorCode::InvalidRequest.err_with_reason("invalid_query", format!("{e:?}"))
        })?;
        let view = StoreView::new(&self.store, self.catalog.clone());
        let lv = LayerView {
            base: &view,
            layer: &self.layer,
        };
        let catalog = lv.catalog();
        let plan = mdbn_core::query::compile(&q, &catalog).map_err(|e| {
            ErrorCode::InvalidRequest.err_with_reason("invalid_query", format!("{e:?}"))
        })?;
        if plan.requires_whole_metadata() {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "query_profile_unavailable",
                "grouping and summaries require a bounded whole-query executor",
            ));
        }
        let now = self.now();
        let env = QueryEnv {
            now_ms: now,
            tz: self.host.zones.default_zone(),
            today: self
                .host
                .zones
                .local_date(now, &self.host.zones.default_zone())
                .unwrap_or_else(|| super::utc_date(now)),
        };
        // Declined queries take the per-record path below, which is complete.
        if try_index && let Ok(result) = self.indexed_query(&plan, &lv, &env, include)? {
            if let Some(e) = view.error() {
                return Err(store_err(e));
            }
            return Ok(result);
        }
        // Candidates: confirmed rows the layer does not override, plus layered records.
        // A budgeted profile charges every source copy (candidate rows, then each
        // parsed record) and pages small, so it stops near the budget with an
        // explicit error instead of a partial answer.
        let mut budget = self.fallback_budget();
        let page_limit = if budget.is_some() { 32 } else { 1024 };
        let mut ids: std::collections::BTreeSet<Uuid> = std::collections::BTreeSet::new();
        let mut after = None;
        loop {
            let page = self
                .store
                .candidates(
                    &plan.candidate,
                    Page {
                        after,
                        limit: page_limit,
                    },
                )
                .map_err(store_err)?;
            let Some(l) = page.last() else {
                break;
            };
            after = Some(l.id);
            for r in page {
                Self::charge_fallback(&mut budget, r.doc.len())?;
                if !self.layer.touches(&convert::uuid(&r.id)) {
                    ids.insert(r.id);
                }
            }
        }
        for id in self.layer.touched_ids() {
            ids.insert(convert::wuuid(&id));
        }
        let mut rows = Vec::new();
        for id in ids {
            let Some(rec) = lv.record(&convert::uuid(&id)) else {
                continue;
            };
            Self::charge_fallback(&mut budget, rec.source.len())?;
            let doc = mdbn_core::doc::Document::parse_at(&rec.path, &*rec.source);
            let fm = doc.frontmatter().clone();
            let types = catalog.membership(&rec.path, &fm).types;
            let verdict = plan.matches(
                &QueryRecord {
                    path: &rec.path,
                    types: &types,
                    frontmatter: &fm,
                    body: Some(doc.body()),
                },
                &env,
            );
            if verdict == Verdict::Match {
                rows.push((id, rec.path.clone(), fm, types));
            }
        }
        rows.sort_by(|a, b| {
            plan.compare_by_id(
                (
                    convert::uuid(&a.0),
                    &QueryRecord {
                        path: &a.1,
                        types: &a.3,
                        frontmatter: &a.2,
                        body: None,
                    },
                ),
                (
                    convert::uuid(&b.0),
                    &QueryRecord {
                        path: &b.1,
                        types: &b.3,
                        frontmatter: &b.2,
                        body: None,
                    },
                ),
            )
        });
        let start = usize::try_from(plan.query.offset)
            .unwrap_or(usize::MAX)
            .min(rows.len());
        let end = match plan.query.limit {
            Some(l) => start
                .saturating_add(usize::try_from(l).unwrap_or(usize::MAX))
                .min(rows.len()),
            None => rows.len(),
        };
        let records = rows[start..end]
            .iter()
            .filter_map(|r| self.view_of(&lv, &r.0, include, true))
            .collect();
        if let Some(e) = view.error() {
            return Err(store_err(e));
        }
        Ok(QueryResult {
            records,
            cursor: None,
            complete: self.install.is_none(),
            as_of: self.view_version,
            columns: None,
            total_count: None,
            diagnostics: None,
            view: None,
            groups: None,
            has_more: None,
        })
    }

    fn file_view(&self, f: &crate::store::FileRow) -> FileView {
        FileView {
            id: f.id,
            path: f.path.clone(),
            size: f.content.size(),
            digest: f.content.plain_hash(),
            media: f.media,
            state: match f.local {
                FileLocal::Materialized => FileState::Materialized,
                FileLocal::Remote => FileState::Remote,
                FileLocal::Fetching => FileState::Fetching,
            },
            confirmed_seq: f.modified_seq,
            hold: None,
        }
    }
}

/// `hello` features this build grants when asked (`replica-client-api.md` §2).
/// `attachment-v1` is bare codec support only (`intent.md` §3.11); the
/// qualified directions are decided per replica by `attachment_direction`.
const GRANTABLE_FEATURES: &[&str] = &["presence", super::attachment_runtime::ATTACHMENT_V1_FEATURE];

impl<S: Store> Replica<S> {
    /// The qualified attachment-v1 directions (`intent.md` §3.9, §3.11):
    /// - `.read`: this replica applies attachment entries and fetches and
    ///   authenticates their content from its log (a synced device replica;
    ///   the hosted read path is separate work);
    /// - `.materialize`: its store also places attachment files on disk.
    ///
    /// `.write` (app uploads) is not granted yet.
    fn attachment_direction(&self, feature: &str) -> bool {
        let reads = !self.is_hosted() && !self.local_only();
        match feature {
            "attachment-v1.read" => reads,
            "attachment-v1.materialize" => reads && self.store.materializes_attachments(),
            _ => false,
        }
    }
}

impl<S: Store> ClientApi for Replica<S> {
    fn hello(
        &mut self,
        auth: SessionAuth,
        params: HelloParams,
    ) -> ApiResult<(SessionId, HelloResult)> {
        self.check_apply_health()?;
        if !params.versions.iter().any(|v| v.major == API_VERSION.major) {
            return Err(ErrorCode::UpgradeRequired.err("no common API version"));
        }
        let grant_info = match &auth {
            SessionAuth::Host => GrantInfo {
                grant: None,
                capabilities: ALL_CAPABILITIES.iter().map(|s| s.to_string()).collect(),
                role: Role::Owner,
            },
            SessionAuth::Grant { grant, client_pk } => {
                if let Err(why) = self.serves_apps() {
                    return Err(ErrorCode::Unavailable.err_with_reason("untrusted", why));
                }
                let g = self.grant_for_client(grant, client_pk).ok_or_else(|| {
                    ErrorCode::Unauthenticated.err("no active grant for this client")
                })?;
                if !self.serving_account_matches(&g.account) {
                    return Err(ErrorCode::Forbidden.err_with_reason(
                        "grant_account_mismatch",
                        "this device may not serve another account's grant",
                    ));
                }
                // Advertise current role-effective capabilities, not merely the
                // approved/declarative intersection. Calls still reauthorize.
                let caps: Vec<String> = g
                    .capabilities
                    .iter()
                    .filter(|cap| g.allows(cap))
                    .cloned()
                    .collect();
                if caps.is_empty() {
                    return Err(ErrorCode::Forbidden.err("the grant allows nothing"));
                }
                GrantInfo {
                    grant: Some(*grant),
                    capabilities: caps,
                    role: g.role,
                }
            }
        };
        if let Some(tz) = &params.timezone
            && self.host.zones.local_date(0, tz).is_none()
        {
            return Err(ErrorCode::InvalidRequest
                .err_with_reason("invalid_timezone", format!("unknown time zone {tz}")));
        }
        let id = SessionId(self.next_session);
        self.next_session += 1;
        self.sessions.insert(
            id,
            Session {
                auth,
                tz: params.timezone.clone(),
                status_sub: false,
                holds_sub: false,
                conflicts_sub: false,
            },
        );
        let wanted = params.features.clone().unwrap_or_default();
        let status = self.sync_status();
        let head_witness = status
            .confirmed_head
            .as_ref()
            .and_then(|head| self.signed_handover_head(head))
            .map(mdbn_wire::common::Bytes);
        Ok((
            id,
            HelloResult {
                version: API_VERSION,
                runtime_version: self.cfg.runtime_version.clone(),
                sem: Version {
                    major: mdbn_core::semantics::SEM.major,
                    minor: mdbn_core::semantics::SEM.minor,
                },
                collection: self.cfg.collection,
                grant: grant_info,
                status,
                features: wanted
                    .into_iter()
                    .filter(|f| {
                        GRANTABLE_FEATURES.contains(&f.as_str())
                            || self.attachment_direction(f.as_str())
                    })
                    .collect(),
                head_witness,
            },
        ))
    }

    fn close(&mut self, session: SessionId) {
        self.hosted_drop_session(session);
        self.sessions.remove(&session);
        self.bases_discovery.remove(session);
        self.query_cursors.close(session);
        self.submitted_by.retain(|_, s| *s != session);
        self.drop_session_live(session);
        self.cancel_stale_approvals();
    }

    fn describe(&mut self, session: SessionId) -> ApiResult<Describe> {
        self.require(session, crate::policy::capability::READ)?;
        let cat = self.catalog.clone();
        let (types, contracts) = describe::summaries(&cat);
        Ok(Describe {
            spec_version: cat.spec_version().unwrap_or("").to_string(),
            types,
            contracts,
            settings: Value::Null,
            inclusion: self
                .store
                .settings()
                .map_err(store_err)?
                .unwrap_or_else(|| convert::winclusion(&Default::default())),
            issues: cat
                .issues()
                .iter()
                .map(|i| Issue {
                    code: i.code.clone(),
                    severity: match i.severity {
                        mdbn_core::validate::Severity::Error => mdbn_wire::client::Severity::Error,
                        _ => mdbn_wire::client::Severity::Warning,
                    },
                    message: i.message.clone(),
                    details: None,
                })
                .collect(),
        })
    }

    fn get_resource(
        &mut self,
        session: SessionId,
        path: String,
    ) -> ApiResult<crate::api::ResourceView> {
        self.read_resource(session, path)
    }

    fn list_resources(
        &mut self,
        session: SessionId,
        params: crate::api::ListResources,
    ) -> ApiResult<crate::api::ResourceList> {
        self.read_resource_page(session, params)
    }

    fn get(
        &mut self,
        session: SessionId,
        target: Target,
        include: Include,
    ) -> ApiResult<RecordView> {
        self.require(session, crate::policy::capability::READ)?;
        let view = StoreView::new(&self.store, self.catalog.clone());
        let lv = LayerView {
            base: &view,
            layer: &self.layer,
        };
        let id = self
            .resolve_target(&lv, &target)
            .ok_or_else(|| ErrorCode::NotFound.err("no such record"))?;
        let r = self.view_of(&lv, &id, &include, true);
        if let Some(e) = view.error() {
            return Err(store_err(e));
        }
        r.ok_or_else(|| ErrorCode::NotFound.err("no such record"))
    }

    fn query(
        &mut self,
        session: SessionId,
        query: Value,
        include: Include,
    ) -> ApiResult<QueryResult> {
        self.require(session, crate::policy::capability::READ)?;
        self.query_keyset(session, &query, &include)
    }

    fn subscribe(&mut self, session: SessionId, query: Value, include: Include) -> ApiResult<u64> {
        self.require(session, crate::policy::capability::READ)?;
        if super::query_cursor::supplied(&query)?.is_some() {
            return Err(ErrorCode::InvalidRequest.err_with_reason(
                "invalid_query_cursor",
                "subscriptions cannot use page cursors",
            ));
        }
        self.subscribe_query(session, query, include)
    }

    fn unsubscribe(&mut self, session: SessionId, sub: u64) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        self.unsubscribe_query(session, sub)
    }

    fn changes(
        &mut self,
        session: SessionId,
        cursor: Option<String>,
        limit: Option<u32>,
        watch: bool,
    ) -> ApiResult<ChangesResult> {
        self.require(session, crate::policy::capability::READ)?;
        self.feed_changes(session, cursor, limit, watch)
    }

    fn validate(
        &mut self,
        _session: SessionId,
        _targets: Option<Vec<Target>>,
    ) -> ApiResult<Vec<(Uuid, Vec<Issue>)>> {
        not_yet("validate")
    }

    fn submit(&mut self, session: SessionId, params: SubmitParams) -> ApiResult<Vec<Receipt>> {
        if self.is_hosted() {
            // A `pending` answer is not an acknowledgement in hosted mode.
            return Err(ErrorCode::Internal.err_with_reason(
                "hosted_submit_logged",
                "a hosted replica acknowledges writes only through submit_logged",
            ));
        }
        let mut rs = self.submit_ops(session, params)?;
        for r in &mut rs {
            self.stamp_published(r);
        }
        Ok(rs)
    }

    fn receipt(&mut self, session: SessionId, mutation: Uuid) -> ApiResult<Receipt> {
        let grant = self.session(session)?.grant();
        self.hosted_owner_check(&mutation, grant)?;
        // a granted session sees only receipts of its own grant.
        let mut r = self
            .known_receipt_for(&mutation, grant)
            .map_err(store_err)?
            .ok_or_else(|| ErrorCode::NotFound.err("no such mutation"))?;
        self.stamp_published(&mut r);
        Ok(r)
    }

    fn status(&mut self, session: SessionId) -> ApiResult<SyncStatus> {
        self.require(session, crate::policy::capability::READ)?;
        Ok(self.sync_status())
    }

    fn applied_prefix(
        &mut self,
        session: SessionId,
        seq: u64,
    ) -> ApiResult<mdbn_wire::client::AppliedPrefix> {
        self.handover_applied_prefix(session, seq)
    }

    fn subscribe_status(&mut self, session: SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if let Some(s) = self.sessions.get_mut(&session) {
            s.status_sub = true;
        }
        let st = self.sync_status();
        self.pushes.push((session, Push::Status(st)));
        Ok(())
    }

    fn list_holds(&mut self, session: SessionId) -> ApiResult<Vec<Hold>> {
        self.require(session, crate::policy::capability::READ)?;
        self.store.holds().map_err(store_err)
    }

    fn subscribe_holds(&mut self, session: SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if let Some(s) = self.sessions.get_mut(&session) {
            s.holds_sub = true;
        }
        Ok(())
    }

    fn resolve_hold(
        &mut self,
        session: SessionId,
        id: Uuid,
        how: HoldResolution,
    ) -> ApiResult<Receipt> {
        let cap = match how {
            HoldResolution::Delete => crate::policy::capability::DELETE,
            _ => crate::policy::capability::EDIT,
        };
        self.require(session, cap)?;
        self.resolve_hold_with(session, id, how)
    }

    fn list_conflicts(
        &mut self,
        session: SessionId,
        record: Option<Uuid>,
    ) -> ApiResult<Vec<ConflictEntry>> {
        self.require(session, crate::policy::capability::READ)?;
        Ok(self
            .store
            .conflicts(record.as_ref())
            .map_err(store_err)?
            .into_iter()
            .map(|c| ConflictEntry {
                mutation: c.mutation,
                seq: c.seq,
                conflict: c.conflict,
            })
            .collect())
    }

    fn subscribe_conflicts(&mut self, session: SessionId) -> ApiResult<()> {
        self.require(session, crate::policy::capability::READ)?;
        if let Some(s) = self.sessions.get_mut(&session) {
            s.conflicts_sub = true;
        }
        Ok(())
    }

    fn pending_devices(&mut self, session: SessionId) -> ApiResult<Vec<PendingDevice>> {
        self.pending_private_devices(session)
    }

    fn approve_device(&mut self, session: SessionId, _device: Uuid, _sas: String) -> ApiResult<()> {
        self.host_only(session)?;
        not_yet("approve_device")
    }

    fn reject_device(&mut self, session: SessionId, _device: Uuid) -> ApiResult<()> {
        self.host_only(session)?;
        not_yet("reject_device")
    }

    fn list_files(&mut self, session: SessionId, params: ListFiles) -> ApiResult<FileList> {
        self.require(session, crate::policy::capability::READ)?;
        let mut files = Vec::new();
        let mut after = None;
        loop {
            let page = self
                .store
                .files(Page { after, limit: 1024 })
                .map_err(store_err)?;
            let Some(l) = page.last() else {
                break;
            };
            after = Some(l.id);
            for f in page {
                if !self.file_visible(session, &f.path) {
                    continue;
                }
                if let Some(folder) = &params.folder {
                    let fk = mdbn_core::paths::path_key(folder.trim_end_matches('/'));
                    if !f.path_key.starts_with(&format!("{fk}/")) {
                        continue;
                    }
                }
                if let Some(m) = &params.media
                    && !m.contains(&f.media)
                {
                    continue;
                }
                files.push(self.file_view(&f));
            }
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        if let Some(l) = params.limit {
            files.truncate(l as usize);
        }
        Ok(FileList {
            files,
            cursor: None,
            complete: true,
        })
    }

    fn get_file(&mut self, session: SessionId, target: Target) -> ApiResult<FileView> {
        self.require(session, crate::policy::capability::READ)?;
        let id = match target {
            Target::Id(id) => id,
            Target::Path(p) => self
                .store
                .file_at(&mdbn_core::paths::path_key(&p))
                .map_err(store_err)?
                .ok_or_else(|| ErrorCode::NotFound.err("no such file"))?,
        };
        let f = self
            .store
            .file(&id)
            .map_err(store_err)?
            .filter(|f| self.file_visible(session, &f.path))
            .ok_or_else(|| ErrorCode::NotFound.err("no such file"))?;
        Ok(self.file_view(&f))
    }

    fn open_upload(
        &mut self,
        _session: SessionId,
        _params: OpenUploadParams,
    ) -> ApiResult<OpenUploadResult> {
        not_yet("open_upload")
    }

    fn upload_chunk(&mut self, _session: SessionId, _params: UploadChunkParams) -> ApiResult<u64> {
        not_yet("upload_chunk")
    }

    fn commit_upload(&mut self, _session: SessionId, _transfer: Uuid) -> ApiResult<Receipt> {
        not_yet("commit_upload")
    }

    fn abort_upload(&mut self, _session: SessionId, _transfer: Uuid) -> ApiResult<()> {
        not_yet("abort_upload")
    }

    fn read_file(
        &mut self,
        _session: SessionId,
        _target: Target,
        _range: Option<(u64, u64)>,
        _revision: Option<Hash>,
    ) -> ApiResult<(StreamId, FileView)> {
        not_yet("read_file")
    }

    fn ack_chunks(
        &mut self,
        _session: SessionId,
        _stream: StreamId,
        _offset: u64,
    ) -> ApiResult<()> {
        not_yet("ack_chunks")
    }

    fn fetch_file(&mut self, _session: SessionId, _file: Uuid) -> ApiResult<()> {
        not_yet("fetch_file")
    }

    fn evict_file(&mut self, session: SessionId, _file: Uuid) -> ApiResult<()> {
        self.host_only(session)?;
        not_yet("evict_file")
    }

    fn get_materialization(&mut self, session: SessionId) -> ApiResult<Materialization> {
        self.require(session, crate::policy::capability::READ)?;
        Ok(Materialization {
            mode: MaterializeMode::All,
            pinned: None,
            media: None,
            max_size: None,
        })
    }

    fn set_materialization(
        &mut self,
        session: SessionId,
        _policy: Materialization,
    ) -> ApiResult<()> {
        self.host_only(session)?;
        not_yet("set_materialization")
    }

    fn presence_join(
        &mut self,
        _session: SessionId,
        _record: Uuid,
        _state: Value,
    ) -> ApiResult<()> {
        not_yet("presence")
    }

    fn presence_update(
        &mut self,
        _session: SessionId,
        _record: Uuid,
        _state: Value,
    ) -> ApiResult<()> {
        not_yet("presence")
    }

    fn presence_leave(&mut self, _session: SessionId, _record: Uuid) -> ApiResult<()> {
        not_yet("presence")
    }

    fn subscribe_presence(&mut self, _session: SessionId, _record: Uuid) -> ApiResult<()> {
        not_yet("presence")
    }

    fn fence_report(&mut self, _session: SessionId, _editors: Vec<FenceEditor>) -> ApiResult<()> {
        not_yet("fence")
    }

    fn fence_result(
        &mut self,
        _session: SessionId,
        _id: CallbackId,
        _result: FenceResult,
    ) -> ApiResult<()> {
        not_yet("fence")
    }

    fn take_pushes(&mut self) -> Vec<(SessionId, Push)> {
        self.cancel_stale_approvals();
        // A live lease/owner change can precede the host's notification. Never
        // drain queued plaintext for a now-invalid granted session.
        if self.local_only() {
            self.close_revoked_sessions();
        }
        if self.apply_fault || self.is_apply_recovering() {
            self.pushes.retain(|(_, p)| matches!(p, Push::Closed(_)));
        } else {
            self.flush_status();
        }
        let mut pushes = std::mem::take(&mut self.pushes);
        for (_, p) in &mut pushes {
            if let Push::Receipt(r) = p {
                self.stamp_published(r);
            }
        }
        // Policy/account changes can happen after queueing an outcome. Recheck
        // receipt sessions at delivery in every profile, including synced.
        pushes.retain(|(session, push)| {
            !matches!(push, Push::Receipt(_)) || self.receipt_session_current(*session)
        });
        if !self.local_only() {
            return pushes;
        }
        pushes
            .into_iter()
            .filter(|(session, push)| {
                matches!(
                    push,
                    Push::Closed(_)
                        | Push::Receipt(mdbn_wire::client::Receipt { records: None, .. })
                ) || self
                    .require(*session, crate::policy::capability::READ)
                    .is_ok()
            })
            .collect()
    }
}

//! The state digest and the row index it is computed from.

use super::*;

/// The state digest of confirmed state (`snapshot.md` §4).
///
/// Encoding: the canonical CBOR of a 7-element array, one element per section in
/// the order of §4: lists of row arrays, and the inclusion map for `settings` (the
/// default inclusion when none was set).
pub fn state_digest(s: &dyn Store) -> Result<Hash, StoreError> {
    Ok(DigestIndex::of(s)?.digest())
}

/// What the state digest covers, row by row, without documents. A snapshot install
/// builds it chunk by chunk, so it holds one chunk plus this index in memory, and
/// refuses duplicate IDs and path keys as rows arrive.
#[derive(Debug, Default, Clone)]
pub(crate) struct DigestIndex {
    resources: BTreeMap<String, Hash>,
    records: BTreeMap<mdbn_wire::common::Uuid, (String, Hash)>,
    files: BTreeMap<mdbn_wire::common::Uuid, (String, Hash)>,
    pub(super) tombs: BTreeMap<mdbn_wire::common::Uuid, (EntityKind, String, Hash, u64)>,
    pub(super) settings: Option<FileInclusion>,
    /// By path key, as stores keep them.
    pub(super) aliases: BTreeMap<String, (String, mdbn_wire::common::Uuid)>,
    pub(super) conflicts:
        std::collections::BTreeSet<(mdbn_wire::common::Uuid, mdbn_wire::common::Uuid, u64)>,
    /// Native-only canonical rows. Absent rows preserve the legacy seven-element
    /// digest exactly; native state binds kind and complete descriptor identity.
    native_files: BTreeMap<mdbn_wire::common::Uuid, Cbor>,
    pub(super) native_tombs: BTreeMap<mdbn_wire::common::Uuid, Cbor>,
    pub(super) native_conflicts:
        BTreeMap<(mdbn_wire::common::Uuid, mdbn_wire::common::Uuid, u64), Cbor>,
    /// Path keys of live records and files.
    live: std::collections::BTreeSet<String>,
}

impl DigestIndex {
    /// The index of a store's confirmed state.
    fn of(s: &dyn Store) -> Result<DigestIndex, StoreError> {
        let mut x = DigestIndex::default();
        for (p, d) in s.resources()? {
            x.resource(&p, &d);
        }
        for r in all_records(s)? {
            x.record(&r).map_err(StoreError::Corrupt)?;
        }
        for f in all_files(s)? {
            x.file(&f).map_err(StoreError::Corrupt)?;
        }
        for t in all_tombstones(s)? {
            x.tombstone(&t).map_err(StoreError::Corrupt)?;
        }
        x.settings = s.settings()?;
        for a in s.aliases()? {
            x.alias(&a);
        }
        for c in s.conflicts(None)? {
            x.conflict(&c);
        }
        Ok(x)
    }

    pub(super) fn resource(&mut self, path: &str, doc: &str) {
        self.resources
            .insert(path.to_string(), mdbn_wire::hash::sha256(doc.as_bytes()));
    }

    fn entity_id_available(&self, id: &mdbn_wire::common::Uuid) -> Result<(), String> {
        // Live records, ordinary/native files and retained tombstones share one
        // entity namespace. Index rows, aliases and conflict sides are references.
        if self.records.contains_key(id)
            || self.files.contains_key(id)
            || self.tombs.contains_key(id)
        {
            return Err("two entries share an ID".into());
        }
        Ok(())
    }

    fn live_entry(&mut self, id: &mdbn_wire::common::Uuid, path_key: &str) -> Result<(), String> {
        self.entity_id_available(id)?;
        if !self.live.insert(path_key.to_string()) {
            return Err("two entries share a path".into());
        }
        Ok(())
    }

    pub(super) fn record(&mut self, r: &RecordRow) -> Result<(), String> {
        self.live_entry(&r.id, &r.path_key)?;
        self.records.insert(r.id, (r.path.clone(), r.revision));
        Ok(())
    }

    pub(super) fn file(&mut self, f: &FileRow) -> Result<(), String> {
        self.live_entry(&f.id, &f.path_key)?;
        self.files
            .insert(f.id, (f.path.clone(), f.content.plain_hash()));
        if f.kind == mdbn_wire::unindexed_markdown::FileKindV1::UnindexedOversizedMarkdown {
            self.native_files.insert(
                f.id,
                Cbor::Array(vec![
                    f.id.to_cbor(),
                    f.path.to_cbor(),
                    mdbn_wire::unindexed_markdown::UnindexedMarkdownPayloadV1 {
                        content: f.content.clone(),
                    }
                    .to_cbor(),
                    f.media.to_cbor(),
                ]),
            );
        }
        Ok(())
    }

    pub(super) fn tombstone(&mut self, t: &TombstoneRow) -> Result<(), String> {
        self.entity_id_available(&t.id)?;
        let v = (t.kind, t.path.clone(), tomb_revision(t), t.seq);
        self.tombs.insert(t.id, v);
        if let TombstoneLast::UnindexedMarkdown(p) = &t.last {
            self.native_tombs.insert(
                t.id,
                Cbor::Array(vec![
                    t.id.to_cbor(),
                    t.kind.to_cbor(),
                    t.path.to_cbor(),
                    p.to_cbor(),
                    Cbor::Uint(t.seq),
                    t.time.to_cbor(),
                ]),
            );
        }
        Ok(())
    }

    pub(super) fn alias(&mut self, a: &AliasRow) {
        self.aliases
            .insert(a.path_key.clone(), (a.path.clone(), a.record));
    }

    pub(super) fn conflict(&mut self, c: &ConflictRow) {
        let key = (c.mutation, c.conflict.id, c.conflict.kind.value());
        self.conflicts.insert(key);
        if [
            Some(&c.conflict.kept),
            Some(&c.conflict.lost),
            c.conflict.base.as_ref(),
        ]
        .into_iter()
        .flatten()
        .any(|v| matches!(v, rt::ConflictValue::UnindexedMarkdown(_)))
        {
            self.native_conflicts.insert(
                key,
                WConflictRow {
                    mutation: c.mutation,
                    seq: c.seq,
                    conflict: c.conflict.clone(),
                }
                .to_cbor(),
            );
        }
    }

    pub(super) fn digest(&self) -> Hash {
        let resources: Vec<Cbor> = self
            .resources
            .iter()
            .map(|(p, h)| Cbor::Array(vec![Cbor::Text(p.clone()), h.to_cbor()]))
            .collect();
        let records: Vec<Cbor> = self
            .records
            .iter()
            .map(|(id, (p, r))| Cbor::Array(vec![id.to_cbor(), Cbor::Text(p.clone()), r.to_cbor()]))
            .collect();
        let files: Vec<Cbor> = self
            .files
            .iter()
            .map(|(id, (p, h))| Cbor::Array(vec![id.to_cbor(), Cbor::Text(p.clone()), h.to_cbor()]))
            .collect();
        let tombs: Vec<Cbor> = self
            .tombs
            .iter()
            .map(|(id, (k, p, r, seq))| {
                Cbor::Array(vec![
                    id.to_cbor(),
                    k.to_cbor(),
                    Cbor::Text(p.clone()),
                    r.to_cbor(),
                    Cbor::Uint(*seq),
                ])
            })
            .collect();
        let settings = self
            .settings
            .clone()
            .unwrap_or_else(|| crate::convert::winclusion(&Default::default()))
            .to_cbor();
        let mut aliases: Vec<&(String, mdbn_wire::common::Uuid)> = self.aliases.values().collect();
        aliases.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
        let aliases: Vec<Cbor> = aliases
            .into_iter()
            .map(|(p, r)| Cbor::Array(vec![Cbor::Text(p.clone()), r.to_cbor()]))
            .collect();
        let conflicts: Vec<Cbor> = self
            .conflicts
            .iter()
            .map(|(m, r, k)| Cbor::Array(vec![m.to_cbor(), r.to_cbor(), Cbor::Uint(*k)]))
            .collect();
        let mut parts = vec![
            Cbor::Array(resources),
            Cbor::Array(records),
            Cbor::Array(files),
            Cbor::Array(tombs),
            settings,
            Cbor::Array(aliases),
            Cbor::Array(conflicts),
        ];
        if !self.native_files.is_empty()
            || !self.native_tombs.is_empty()
            || !self.native_conflicts.is_empty()
        {
            parts.push(Cbor::Array(vec![
                Cbor::Array(self.native_files.values().cloned().collect()),
                Cbor::Array(self.native_tombs.values().cloned().collect()),
                Cbor::Array(self.native_conflicts.values().cloned().collect()),
            ]));
        }
        mdbn_wire::hash::h("mdbase/v1/state-digest", &enc(&Cbor::Array(parts)))
    }
}

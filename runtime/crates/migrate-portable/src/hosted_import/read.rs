//! One consistent legacy read (at `S0` or `S_final`): metadata pages through
//! the bounded namespace resolve into a placement table, plus the expected live
//! digest. Sans-IO: the driver turns [`ReadGen::action`] into an action.

use std::collections::{BTreeMap, BTreeSet};

use super::spill::GenClaims;
use super::{Generation, ImportStats, Key, Meta, SourceRow, Spill, Table, class_of, live_of};
use crate::budget::{MAX_HYDRATE_BYTES, MAX_HYDRATE_RECORDS};
use crate::live_digest::LiveDigest;
use crate::namespace::{Namespace, Step, Summary};
use crate::preflight::{EntityKind, PathEntity};
use crate::rows::{FileRow, RecordRow, ResourceRow};
use crate::{Error, Result};

/// What the read needs next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Need {
    /// Open the consistent read.
    Open,
    /// The next page of a table.
    Page(Table, Option<String>),
    /// Synchronous work on the spill (the deferred pass); call [`ReadGen::work`].
    Work,
    /// Finished; call [`ReadGen::finish`].
    Done,
}

#[derive(Debug)]
enum Phase {
    Open,
    Page(Table, Option<String>),
    Deferred(Option<PathEntity>),
    Done,
}

/// The read state machine. RAM only: a crash restarts the read.
#[derive(Debug)]
pub(crate) struct ReadGen {
    pub(crate) generation: Generation,
    pub(crate) head: Option<u64>,
    phase: Phase,
    ns: Namespace,
    digest: LiveDigest,
    stats: ImportStats,
    resources: Vec<SourceRow>,
    resource_bytes: usize,
}

impl ReadGen {
    pub(crate) fn new(generation: Generation) -> ReadGen {
        ReadGen {
            generation,
            head: None,
            phase: Phase::Open,
            ns: Namespace::new(),
            digest: LiveDigest::new(),
            stats: ImportStats::default(),
            resources: Vec::new(),
            resource_bytes: 0,
        }
    }

    pub(crate) fn need(&self) -> Need {
        match &self.phase {
            Phase::Open => Need::Open,
            Phase::Page(t, c) => Need::Page(*t, c.clone()),
            Phase::Deferred(_) => Need::Work,
            Phase::Done => Need::Done,
        }
    }

    pub(crate) fn opened(&mut self, head: u64) -> Result<()> {
        if !matches!(self.phase, Phase::Open) {
            return Err(Error::Invalid("read opened twice".into()));
        }
        self.head = Some(head);
        self.phase = Phase::Page(Table::Resources, None);
        Ok(())
    }

    /// One metadata page of the table the read asked for.
    pub(crate) fn page(
        &mut self,
        spill: &mut dyn Spill,
        rows: Vec<SourceRow>,
        next: Option<String>,
    ) -> Result<()> {
        let Phase::Page(table, _) = self.phase else {
            return Err(Error::Invalid("unexpected source page".into()));
        };
        let bytes: usize = rows.iter().map(|r| r.path.len()).sum();
        if rows.len() > MAX_HYDRATE_RECORDS || bytes > MAX_HYDRATE_BYTES {
            return Err(Error::Invalid(format!(
                "source page over budget: {} rows, {bytes} path bytes",
                rows.len()
            )));
        }
        match table {
            Table::Resources => {
                self.resource_bytes += bytes;
                self.resources.extend(rows);
                if self.resources.len() > MAX_HYDRATE_RECORDS
                    || self.resource_bytes > MAX_HYDRATE_BYTES
                {
                    return Err(Error::Invalid(
                        "more resources than one bounded window".into(),
                    ));
                }
                if next.is_none() {
                    let rows = std::mem::take(&mut self.resources);
                    let input: Vec<ResourceRow> = rows
                        .iter()
                        .map(|r| ResourceRow {
                            path: r.path.clone(),
                        })
                        .collect();
                    let step = self.ns.resources(
                        &mut GenClaims {
                            spill: &mut *spill,
                            g: self.generation,
                        },
                        &input,
                    )?;
                    self.place(spill, Table::Resources, &rows, step)?;
                }
            }
            Table::Records => {
                let input = rows
                    .iter()
                    .map(|r| {
                        Ok(RecordRow {
                            record_id: id_of(r)?,
                            path: r.path.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let step = self.ns.records(
                    &mut GenClaims {
                        spill: &mut *spill,
                        g: self.generation,
                    },
                    &input,
                )?;
                self.place(spill, table, &rows, step)?;
            }
            Table::Files => {
                let input = rows
                    .iter()
                    .map(|r| {
                        Ok(FileRow {
                            file_id: id_of(r)?,
                            path: r.path.clone(),
                        })
                    })
                    .collect::<Result<Vec<_>>>()?;
                let step = self.ns.files(
                    &mut GenClaims {
                        spill: &mut *spill,
                        g: self.generation,
                    },
                    &input,
                )?;
                self.place(spill, table, &rows, step)?;
            }
        }
        self.phase = match (table, next) {
            (t, Some(c)) => Phase::Page(t, Some(c)),
            (Table::Resources, None) => Phase::Page(Table::Records, None),
            (Table::Records, None) => Phase::Page(Table::Files, None),
            (Table::Files, None) => Phase::Deferred(None),
        };
        Ok(())
    }

    /// One bounded page of the deferred pass.
    pub(crate) fn work(&mut self, spill: &mut dyn Spill) -> Result<()> {
        let Phase::Deferred(after) = &self.phase else {
            return Err(Error::Invalid("no deferred work".into()));
        };
        let page = spill
            .deferred_page(self.generation, after.as_ref(), MAX_HYDRATE_RECORDS)
            .map_err(spill_err)?;
        let Some((last, _)) = page.last() else {
            self.phase = Phase::Done;
            return Ok(());
        };
        let last = last.clone();
        let entities: Vec<PathEntity> = page.iter().map(|(e, _)| e.clone()).collect();
        let step = self.ns.deferred(
            &mut GenClaims {
                spill: &mut *spill,
                g: self.generation,
            },
            &entities,
        )?;
        let renamed: BTreeMap<&PathEntity, &str> = step
            .renames
            .iter()
            .map(|r| (&r.entity, r.to.as_str()))
            .collect();
        for (e, meta) in &page {
            if let Some(to) = renamed.get(e) {
                let meta = Meta {
                    path: (*to).to_owned(),
                    ..meta.clone()
                };
                self.put(spill, &key_of(e), &meta)?;
            }
        }
        self.phase = Phase::Deferred(Some(last));
        Ok(())
    }

    /// The placements are complete: the expected digest, and the resolve's totals.
    /// Refuses a namespace with unfixable names.
    pub(crate) fn finish(self) -> Result<(u64, LiveDigest, Summary, ImportStats)> {
        if !matches!(self.phase, Phase::Done) {
            return Err(Error::Invalid("read not finished".into()));
        }
        let head = self
            .head
            .ok_or_else(|| Error::Invalid("read never opened".into()))?;
        let summary = self.ns.finish()?;
        Ok((head, self.digest, summary, self.stats))
    }

    /// Persist where each row of a page lives, or defer it.
    fn place(
        &mut self,
        spill: &mut dyn Spill,
        table: Table,
        rows: &[SourceRow],
        step: Step,
    ) -> Result<()> {
        let kind = match table {
            Table::Resources => EntityKind::Resource,
            Table::Records => EntityKind::Record,
            Table::Files => EntityKind::File,
        };
        let renamed: BTreeMap<PathEntity, String> =
            step.renames.into_iter().map(|r| (r.entity, r.to)).collect();
        let deferred: BTreeSet<PathEntity> = step.deferred.into_iter().collect();
        let unfixable: BTreeSet<PathEntity> =
            step.unfixable.into_iter().map(|u| u.entity).collect();
        for r in rows {
            let entity = PathEntity {
                kind,
                id: r.id.clone(),
                path: r.path.clone(),
            };
            let meta = Meta {
                class: class_of(table, r.size),
                path: r.path.clone(),
                content: r.content,
                size: r.size,
            };
            if deferred.contains(&entity) {
                spill
                    .push_deferred(self.generation, &entity, &meta)
                    .map_err(spill_err)?;
            } else if unfixable.contains(&entity) {
                // Counted by the namespace; `finish` refuses the collection.
            } else {
                let meta = Meta {
                    path: renamed.get(&entity).cloned().unwrap_or(meta.path.clone()),
                    ..meta
                };
                self.put(spill, &key_of(&entity), &meta)?;
            }
        }
        Ok(())
    }

    fn put(&mut self, spill: &mut dyn Spill, key: &Key, meta: &Meta) -> Result<()> {
        self.stats.add(meta)?;
        self.digest.add(&live_of(key, meta)?);
        spill
            .put_placement(self.generation, key, meta)
            .map_err(spill_err)
    }
}

fn id_of(r: &SourceRow) -> Result<String> {
    let id =
        r.id.clone()
            .ok_or_else(|| Error::Invalid("a record or file row without an ID".into()))?;
    crate::ids::uuid(&id)?;
    Ok(id)
}

/// The key of a namespace entity: its ID, or a resource's original path.
pub(crate) fn key_of(e: &PathEntity) -> Key {
    Key {
        kind: e.kind,
        id: e.id.clone().unwrap_or_else(|| e.path.clone()),
    }
}

pub(crate) fn spill_err(e: String) -> Error {
    Error::Invalid(format!("spill: {e}"))
}

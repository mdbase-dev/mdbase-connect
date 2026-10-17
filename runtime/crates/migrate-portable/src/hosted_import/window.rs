//! One canonical metadata window selector, shared by preflight and sealing.
use super::read::spill_err;
use super::{Class, Generation, Key, Meta, Spill};
use crate::{Error, Result};

/// Normal windows' placement bound.
pub const GEN0_WINDOW_ROWS: usize = 128;
/// Normal windows' charged text/path/descriptor allowance.
pub const GEN0_WINDOW_BYTES: u64 = 64 << 10;
/// A larger record is isolated; the native record cap remains exactly 1 MiB.
pub const GEN0_RECORD_BYTES: u64 = 1 << 20;
/// The isolated record plus its UUID, path and allocation/framing charge.
pub const GEN0_RECORD_WINDOW_BYTES: u64 = GEN0_RECORD_BYTES + (8 << 10);

/// The exact prefix after a retained cursor; `done` is computed from spill only.
/// Reads at most 129 metadata rows, never text or whole-collection metadata.
pub fn gen0_window(
    spill: &mut dyn Spill,
    bits: u64,
    bucket: Option<u64>,
    after: Option<&Key>,
) -> Result<(Vec<(Key, Meta)>, bool)> {
    let mut rows = spill
        .placements_in_bucket(Generation::S0, bits, bucket, after, GEN0_WINDOW_ROWS + 1)
        .map_err(spill_err)?;
    let mut bytes = 0u64;
    let mut take = 0;
    for (key, meta) in rows.iter().take(GEN0_WINDOW_ROWS) {
        let payload = match meta.class {
            Class::Resource | Class::Record => meta.size.checked_add(256),
            Class::Attachment | Class::UnindexedMarkdown => meta
                .size
                .div_ceil(if meta.class == Class::UnindexedMarkdown {
                    1 << 20
                } else {
                    8 << 20
                })
                .max(1)
                .checked_mul(32)
                .and_then(|n| n.checked_add(512)),
        }
        .ok_or_else(overflow)?;
        let charge = (key.id.len() as u64)
            .checked_add(meta.path.len() as u64)
            .and_then(|n| n.checked_add(payload))
            .ok_or_else(overflow)?;
        if charge > GEN0_WINDOW_BYTES {
            if take > 0 {
                break;
            }
            if meta.class != Class::Record
                || meta.size > GEN0_RECORD_BYTES
                || charge > GEN0_RECORD_WINDOW_BYTES
            {
                return Err(Error::Invalid(
                    "generation-0 placement exceeds window budget".into(),
                ));
            }
            take = 1;
            break;
        }
        if bytes + charge > GEN0_WINDOW_BYTES {
            break;
        }
        bytes += charge;
        take += 1;
    }
    let done = take == rows.len();
    rows.truncate(take);
    Ok((rows, done))
}
fn overflow() -> Error {
    Error::Invalid("generation-0 window charge overflow".into())
}

/// RAM-only paged preflight. Counts the same windows/sections as the writer,
/// reserving both optional file sections even if a caller declares them empty.
/// No new persisted cursor or SQL writes; one poll reads one metadata window.
#[derive(Debug)]
pub(super) struct Gen0Preflight {
    bits: u64,
    bucket: Option<u64>,
    after: Option<Key>,
    seen: [bool; 5],
    refs: u64,
}
impl Gen0Preflight {
    pub(super) fn new(stats: super::ImportStats) -> Result<Self> {
        // Keep the early file-inventory/overflow/direct-ref checks. Window refs
        // are counted below, not estimated as two per collection row.
        stats.hosted_fmt1_preflight()?;
        Ok(Self {
            bits: stats.bucket_bits(),
            bucket: None,
            after: None,
            seen: [false; 5],
            refs: stats.file_object_refs_upper_bound + 5,
        })
    }
    pub(super) fn work(&mut self, spill: &mut dyn Spill) -> Result<bool> {
        let (rows, done) = gen0_window(spill, self.bits, self.bucket, self.after.as_ref())?;
        if self.bucket.is_none() {
            self.refs += 1; // One resources chunk, including the empty section.
        } else {
            let mut populated = [false; 5];
            for (_, meta) in &rows {
                populated[0] = true; // index
                populated[match meta.class {
                    Class::Record => 1,
                    Class::Attachment => 3,
                    Class::UnindexedMarkdown => 4,
                    Class::Resource => {
                        return Err(Error::Invalid("resource in gen0 bucket".into()));
                    }
                }] = true;
            }
            for (i, present) in populated.into_iter().enumerate() {
                if present || (done && !self.seen[i]) {
                    self.refs += 1;
                }
                self.seen[i] |= present;
            }
        }
        if self.refs > 1024 {
            return Err(Error::Invalid(format!(
                "hosted_ref_index_import_unqualified: generated refs bound {} exceeds hosted direct-ref limit 1024",
                self.refs
            )));
        }
        if done {
            self.bucket = Some(self.bucket.map_or(0, |b| b + 1));
            self.after = None;
            self.seen = [false; 5];
        } else {
            self.after = rows.last().map(|(key, _)| key.clone());
        }
        Ok(self.bucket == Some(1 << self.bits))
    }
}

//! The H9 replay: the S0→`S_final` difference as budgeted batches of effects.
//!
//! The diff is per entity (the spill's S0 and final placements). Two passes, in key
//! order, so a path freed by one entity and taken by another never collides:
//! 1. **Clear.** Delete every entity absent at `S_final`; move every entity whose
//!    path key changes to a unique parking path ([`park_path`]).
//! 2. **Settle.** Bring every entity present at `S_final` to its exact final state
//!    (create, content, class and path).
//!
//! After pass 1, the only holders of any path are entities whose path key does not
//! change, and final path keys are unique (the `S_final` resolve), so no pass-2
//! effect lands on an occupied path. Content comes from legacy at `S_final` (frozen),
//! so replaying a batch twice is idempotent; the mutation ID is stable anyway.

use mdbn_core::paths::path_key;
use mdbn_wire::common::B16;

use super::{Class, DiffRow, Key, Meta};
use crate::budget::{MAX_BATCH_BYTES, MAX_BATCH_EFFECTS, MAX_HYDRATE_BYTES};

/// The folder parking paths live under while the replay runs (routes stay closed).
pub const PARK_FOLDER: &str = "mdbase-migration";

/// Decoded bytes an effect without inline text costs in a batch (a descriptor).
pub const DESCRIPTOR_BYTES: u64 = 1024;

/// One replay effect.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Effect {
    /// Remove the entity (absent at `S_final`).
    Delete {
        /// Which.
        key: Key,
        /// Its S0 placement.
        from: Meta,
    },
    /// Move the entity to its parking path, content unchanged.
    Park {
        /// Which.
        key: Key,
        /// Its S0 placement.
        from: Meta,
        /// The parking path.
        to: String,
    },
    /// Bring the entity to its `S_final` state. The host reads its content from
    /// legacy at `S_final` and checks it against `to.content` and `to.size`.
    Put {
        /// Which.
        key: Key,
        /// Its current placement in the new system (S0, or parked), if any.
        from: Option<Meta>,
        /// Its `S_final` placement.
        to: Meta,
    },
}

impl Effect {
    /// Decoded bytes this effect hydrates.
    pub fn bytes(&self) -> u64 {
        match self {
            Effect::Put { to, .. } if matches!(to.class, Class::Record | Class::Resource) => {
                to.size
            }
            _ => DESCRIPTOR_BYTES,
        }
    }
}

/// One replay batch: one signed mutation with a stable ID.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Batch {
    /// Stable mutation ID ([`mutation_id`]).
    pub mutation: B16,
    /// Pass 1 (clear) or 2 (settle).
    pub pass: u64,
    /// The frozen legacy head every `Put` reads at.
    pub s_final: u64,
    /// The effects, at most [`MAX_BATCH_EFFECTS`].
    pub effects: Vec<Effect>,
    /// The last diff key this batch covers.
    pub last: Key,
}

/// The base parking path for `key`, keeping the original extension so the entity
/// keeps its kind while parked. The path actually used is [`allocate_park`]'s.
pub fn park_path(key: &Key, from_path: &str) -> String {
    let name = from_path.rsplit('/').next().unwrap_or(from_path);
    let ext = name
        .rfind('.')
        .filter(|&d| d > 0)
        .map(|d| &name[d..])
        .filter(|e| e.len() <= 16 && e.chars().all(|c| c.is_ascii_alphanumeric() || c == '.'))
        .unwrap_or("");
    let h = mdbn_wire::hash::h("mdbase/v1/migrate/park", &key.to_bytes());
    format!("{PARK_FOLDER}/{}{ext}", &h.to_hex()[..32])
}

/// How many suffixed candidates [`allocate_park`] tries before refusing.
pub const MAX_PARK_CANDIDATES: u64 = 64;

/// The parking path of `key`: [`park_path`], or its first ` (n)` variant whose
/// path key is claimed in **neither** the S0 namespace (every path occupied before
/// the replay) **nor** the `S_final` namespace (every path the replay lands on),
/// and that passes the portable path policy. A pure function of the two claim
/// tables, which are fixed once the `S_final` read completes, so resume and stable
/// mutation IDs reproduce exactly the same allocation. Parking names of different
/// keys never collide (their bases are distinct 128-bit hashes). Refuses after
/// [`MAX_PARK_CANDIDATES`]; the driver checks every allocation before the cutover
/// intent, so a refusal rolls back instead of failing after cutover.
pub(crate) fn allocate_park(
    spill: &mut dyn super::Spill,
    key: &Key,
    from_path: &str,
) -> crate::Result<String> {
    use super::Generation;
    use crate::namespace::claim_key;
    let base = park_path(key, from_path);
    for n in 1..=MAX_PARK_CANDIDATES {
        let candidate = if n == 1 {
            base.clone()
        } else {
            mdbn_core::paths::suffixed(&base, n)
        };
        if mdbn_core::paths::check_path(&candidate).is_err() {
            continue;
        }
        let k = claim_key(&candidate);
        let taken = spill
            .is_claimed(Generation::S0, &k)
            .and_then(|a| Ok(a || spill.is_claimed(Generation::Final, &k)?))
            .map_err(|e| crate::Error::Invalid(format!("spill: {e}")))?;
        if !taken {
            return Ok(candidate);
        }
    }
    Err(crate::Error::Invalid(
        "no free parking path for a moved entity".into(),
    ))
}

/// Allocates a parking path for a key and its S0 path.
pub(crate) type Park<'a> = dyn FnMut(&Key, &str) -> crate::Result<String> + 'a;

/// Whether the diff row moves its entity to another path key (pass 1 parks it).
pub(crate) fn parks(s0: Option<&Meta>, fin: Option<&Meta>) -> bool {
    matches!((s0, fin), (Some(a), Some(b)) if path_key(&a.path) != path_key(&b.path))
}

/// The effect of one diff row in `pass`, if any.
pub(crate) fn effect(
    pass: u64,
    key: &Key,
    s0: Option<&Meta>,
    fin: Option<&Meta>,
    park: &mut Park<'_>,
) -> crate::Result<Option<Effect>> {
    let moving = parks(s0, fin);
    Ok(match (pass, s0, fin) {
        (1, Some(a), None) => Some(Effect::Delete {
            key: key.clone(),
            from: a.clone(),
        }),
        (1, Some(a), Some(_)) if moving => Some(Effect::Park {
            key: key.clone(),
            from: a.clone(),
            to: park(key, &a.path)?,
        }),
        (2, a, Some(b)) => Some(Effect::Put {
            key: key.clone(),
            from: match a {
                Some(a) if moving => Some(Meta {
                    path: park(key, &a.path)?,
                    ..a.clone()
                }),
                a => a.cloned(),
            },
            to: b.clone(),
        }),
        _ => None,
    })
}

/// The stable mutation ID of the batch of `pass` ending at `last`.
pub(crate) fn mutation_id(collection: &str, s_final: u64, pass: u64, last: &Key) -> B16 {
    let mut m = Vec::new();
    m.extend_from_slice(collection.as_bytes());
    m.push(0);
    m.extend_from_slice(&s_final.to_be_bytes());
    m.extend_from_slice(&pass.to_be_bytes());
    m.extend_from_slice(&last.to_bytes());
    let h = mdbn_wire::hash::h("mdbase/v1/migrate/replay-mutation", &m);
    let mut id = [0u8; 16];
    id.copy_from_slice(&h.0[..16]);
    B16(id)
}

/// Take the next batch from `rows` (diff rows after the cursor, in key order).
/// Returns the batch's effects and the last row it consumed; `None` when `rows` is
/// empty. A batch stops before exceeding [`MAX_BATCH_EFFECTS`] or
/// [`MAX_BATCH_BYTES`]; one effect over the byte budget (a record up to 1 MiB,
/// the per-entry cap) travels alone and never splits.
pub(crate) fn take_batch(
    pass: u64,
    rows: &[DiffRow],
    park: &mut Park<'_>,
) -> crate::Result<Option<(Vec<Effect>, Key)>> {
    let mut effects = Vec::new();
    let mut bytes = 0u64;
    let mut last = None;
    for (key, s0, fin) in rows {
        if let Some(e) = effect(pass, key, s0.as_ref(), fin.as_ref(), park)? {
            let b = e.bytes();
            if b > MAX_HYDRATE_BYTES as u64 {
                return Err(crate::Error::Invalid(format!(
                    "replay effect over the request budget: {b} bytes"
                )));
            }
            let full = effects.len() + 1 > MAX_BATCH_EFFECTS
                || (!effects.is_empty() && bytes + b > MAX_BATCH_BYTES as u64);
            if full {
                break;
            }
            bytes += b;
            effects.push(e);
            if bytes > MAX_BATCH_BYTES as u64 {
                // A lone over-budget effect: nothing joins it.
                last = Some(key.clone());
                break;
            }
        }
        last = Some(key.clone());
    }
    Ok(last.map(|l| (effects, l)))
}

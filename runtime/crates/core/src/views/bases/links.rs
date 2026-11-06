//! Property wikilinks resolved against one captured request state.
//! Semantics observed on Obsidian 1.12.7: see
//! `conformance/oracle/obsidian-1.12.7/links.observed.json`. Without a bound
//! state, link properties refuse.
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;

use super::{CapturedLink, EvaluationFailure, LinkResolution, WorkBudget};
use crate::links::{self, Link, Resolution};
use crate::state::StateView;

/// Ceiling on bytes remembered per request; later misses just resolve again.
pub const MAX_BASES_LINK_MEMO_BYTES: u64 = 1 << 18;
const RESOLVE_STEPS: u64 = 64;

/// One resolved target: unavailable (ambiguous), broken, or an exact path.
type Resolved = Option<Option<String>>;

/// Per-request resolutions, keyed by what a wikilink resolves from: its target
/// and the source folder. Owns no state, so it outlives each borrowed view.
#[derive(Default)]
pub struct BasesLinkMemo {
    resolved: RefCell<BTreeMap<(String, String), Resolved>>,
    bytes: Cell<u64>,
}

/// The state a request's link properties resolve against.
#[derive(Clone, Copy)]
pub struct BasesLinks<'a> {
    state: &'a dyn StateView,
    memo: &'a BasesLinkMemo,
}

impl<'a> BasesLinks<'a> {
    /// Bind a state whose reads are fenced by the caller for the whole request.
    pub fn new(state: &'a dyn StateView, memo: &'a BasesLinkMemo) -> Self {
        Self { state, memo }
    }

    pub(super) fn capture(
        self,
        text: &str,
        link: &Link,
        from_path: &str,
        budget: &mut WorkBudget,
    ) -> Result<CapturedLink, EvaluationFailure> {
        let folder = links::folder_of(from_path);
        let key = (link.target.clone(), folder.to_owned());
        let memoized = self.memo.resolved.borrow().get(&key).cloned();
        let resolved = match memoized {
            Some(resolved) => resolved,
            None => {
                if !budget.charge(RESOLVE_STEPS, 0) {
                    return Err(budget.failure().expect("link resolution budget"));
                }
                let resolved = self.resolve(link, from_path);
                let bytes = (key.0.len() + key.1.len()) as u64
                    + resolved
                        .as_ref()
                        .map_or(0, |p| p.as_ref().map_or(0, String::len))
                        as u64
                    + 128;
                if self.memo.bytes.get() + bytes <= MAX_BASES_LINK_MEMO_BYTES {
                    self.memo.bytes.set(self.memo.bytes.get() + bytes);
                    self.memo
                        .resolved
                        .borrow_mut()
                        .insert(key, resolved.clone());
                }
                resolved
            }
        };
        let resolution = match &resolved {
            None => LinkResolution::Unavailable,
            Some(None) => LinkResolution::Unresolved,
            Some(Some(path)) => LinkResolution::Resolved(path),
        };
        CapturedLink::parse(text, None, resolution, budget)
    }

    fn resolve(self, link: &Link, from_path: &str) -> Resolved {
        match links::resolve(link, from_path, self.state) {
            Resolution::Record(id) => Some(self.state.record(&id).map(|record| record.path)),
            Resolution::File(id) => Some(self.state.file(&id).map(|file| file.path)),
            Resolution::Ambiguous(_) => None,
            Resolution::NotFound | Resolution::Invalid => Some(None),
        }
    }
}

/// The wikilink a whole property text spells, when its written form survives
/// a round trip. Obsidian keeps spaces in targets where the parser trims them,
/// and external or empty forms have no resolved file, so those still refuse.
pub(super) fn property_link(text: &str) -> Option<Link> {
    let link = links::parse_value(text, false)?;
    let written = text
        .strip_prefix("[[")?
        .strip_prefix(link.target.as_str())?;
    let bounded = written.starts_with(['#', '|', ']']);
    let plain = !link.embed && !link.target.contains(':');
    (bounded && plain).then_some(link)
}
#[cfg(test)]
mod tests;

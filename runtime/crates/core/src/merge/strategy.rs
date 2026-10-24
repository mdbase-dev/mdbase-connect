//! Merge strategies (spec 07 "Merge Strategies") and what the merge needs to
//! know about a record's types.
//!
//! The type registry is not part of the merge: it supplies [`MergeFacts`]
//! through [`MergeTypes`] for the first version's path and frontmatter, and the
//! strategy rules live here.

use std::collections::{BTreeMap, BTreeSet};

use crate::value::Map;

/// How a top-level field combines when both sides of a merge changed it
/// differently (spec 07, 12A).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum MergeStrategy {
    /// A field conflict.
    Conflict,
    /// The greater value.
    Max,
    /// The lesser value.
    Min,
    /// The observed-remove union of two lists.
    Union,
}

impl MergeStrategy {
    /// Parse a declared strategy name.
    pub fn parse(s: &str) -> Option<MergeStrategy> {
        match s {
            "conflict" => Some(MergeStrategy::Conflict),
            "max" => Some(MergeStrategy::Max),
            "min" => Some(MergeStrategy::Min),
            "union" => Some(MergeStrategy::Union),
            _ => None,
        }
    }

    /// The strategy's name.
    pub fn as_str(self) -> &'static str {
        match self {
            MergeStrategy::Conflict => "conflict",
            MergeStrategy::Max => "max",
            MergeStrategy::Min => "min",
            MergeStrategy::Union => "union",
        }
    }
}

/// Two matched types declare different strategies for one field
/// (`type_conflict`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StrategyConflict {
    /// The field.
    pub field: String,
}

/// The merge-relevant facts of the types a record matches, combined.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MergeFacts {
    /// `collection.merge` declarations by top-level field. More than one
    /// strategy for a field means the matched types disagree.
    pub declared: BTreeMap<String, BTreeSet<MergeStrategy>>,
    /// Top-level fields a matched type's lifecycle assigns with `{ now: true }`
    /// or `{ today: true }`.
    pub time_fields: BTreeSet<String>,
    /// Top-level properties a matched type's schema declares with
    /// `uniqueItems: true`.
    pub unique_items: BTreeSet<String>,
}

impl MergeFacts {
    /// Add one matched type's facts.
    pub fn add_type(
        &mut self,
        declared: &BTreeMap<String, MergeStrategy>,
        time_fields: &BTreeSet<String>,
        unique_items: &BTreeSet<String>,
    ) {
        for (field, s) in declared {
            self.declared.entry(field.clone()).or_default().insert(*s);
        }
        self.time_fields.extend(time_fields.iter().cloned());
        self.unique_items.extend(unique_items.iter().cloned());
    }

    /// The strategy of `field` (spec 07): its declaration (identical
    /// declarations from several types coalesce; different ones are a
    /// [`StrategyConflict`]), otherwise `max` for a lifecycle `now`/`today`
    /// field, `union` for `tags` and `uniqueItems` arrays, and `conflict`.
    pub fn strategy(&self, field: &str) -> Result<MergeStrategy, StrategyConflict> {
        if let Some(set) = self.declared.get(field) {
            let mut it = set.iter();
            if let (Some(s), None) = (it.next(), it.next()) {
                return Ok(*s);
            }
            if !set.is_empty() {
                return Err(StrategyConflict {
                    field: field.to_owned(),
                });
            }
        }
        if self.time_fields.contains(field) {
            return Ok(MergeStrategy::Max);
        }
        if field == "tags" || self.unique_items.contains(field) {
            return Ok(MergeStrategy::Union);
        }
        Ok(MergeStrategy::Conflict)
    }
}

/// What the merge needs from the type registry. `types::Catalog` implements
/// it.
pub trait MergeTypes {
    /// The combined facts of the types a record at `path` with `frontmatter`
    /// matches (spec 07 membership).
    fn merge_facts(&self, path: &str, frontmatter: &Map) -> MergeFacts;
}

/// The same facts for every record (tests, and records without types).
impl MergeTypes for MergeFacts {
    fn merge_facts(&self, _path: &str, _frontmatter: &Map) -> MergeFacts {
        self.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_declarations() {
        let mut f = MergeFacts::default();
        let decl: BTreeMap<String, MergeStrategy> = [
            ("completedDate".to_owned(), MergeStrategy::Max),
            ("dateModified".to_owned(), MergeStrategy::Conflict),
        ]
        .into_iter()
        .collect();
        let time: BTreeSet<String> = ["dateModified".to_owned(), "dateCreated".to_owned()].into();
        let uniq: BTreeSet<String> = ["blocked_by".to_owned()].into();
        f.add_type(&decl, &time, &uniq);
        assert_eq!(f.strategy("completedDate"), Ok(MergeStrategy::Max));
        assert_eq!(f.strategy("dateModified"), Ok(MergeStrategy::Conflict));
        assert_eq!(f.strategy("dateCreated"), Ok(MergeStrategy::Max));
        assert_eq!(f.strategy("tags"), Ok(MergeStrategy::Union));
        assert_eq!(f.strategy("blocked_by"), Ok(MergeStrategy::Union));
        assert_eq!(f.strategy("title"), Ok(MergeStrategy::Conflict));
        // A second type agreeing coalesces; disagreeing is a type_conflict.
        f.add_type(&decl, &BTreeSet::new(), &BTreeSet::new());
        assert_eq!(f.strategy("completedDate"), Ok(MergeStrategy::Max));
        let other: BTreeMap<String, MergeStrategy> =
            [("completedDate".to_owned(), MergeStrategy::Min)]
                .into_iter()
                .collect();
        f.add_type(&other, &BTreeSet::new(), &BTreeSet::new());
        assert_eq!(
            f.strategy("completedDate"),
            Err(StrategyConflict {
                field: "completedDate".into()
            })
        );
    }
}

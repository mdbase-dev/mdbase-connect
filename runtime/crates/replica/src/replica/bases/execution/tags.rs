//! Shared named1.12.7 capture domain; no effective defaults/empty fallback.
use mdbn_core::{
    doc::Document,
    views::bases::{EvaluationFailure, SourceTags, WorkBudget, capture_source_tags},
};
pub(super) fn capture(
    document: &Document,
    budget: &mut WorkBudget,
) -> Result<Option<SourceTags>, EvaluationFailure> {
    capture_source_tags(document, budget)
}
#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_core::doc::RecordFormat;
    #[test]
    fn simple_raw_tags_known_empty_and_bounds_are_distinct() {
        let exact = |tags: &[&str]| SourceTags::exact(tags.iter().map(|t| (*t).into()).collect());
        let bound = |tags: &[&str]| SourceTags::bounded(tags.iter().map(|t| (*t).into()).collect());
        for (source, want) in [
            (
                "---\ntags: [task, work/sub]\n---\n# Heading",
                exact(&["#task", "#work/sub"]),
            ),
            ("# Heading\nPlain body", exact(&[])),
            ("---\ntags: '#task'\n---\n", exact(&["#task"])),
            (
                "---\ntags: [task]\n---\nBody #other",
                exact(&["#other", "#task"]),
            ),
            (
                "---\ntags: [task]\n---\n[[note#heading]]",
                exact(&["#task"]),
            ),
            ("---\ntags: [task, 5]\n---\n", bound(&["#task"])),
            ("---\ntags: 'task work'\n---\n", bound(&["#task work"])),
            ("---\ntags: [task]\n---\n```\n#tag\n```", exact(&["#task"])),
            (
                "---\ntags: [task]\n---\n[link](target) #tag",
                exact(&["#tag", "#task"]),
            ),
        ] {
            let document = Document::parse(source, RecordFormat::Markdown);
            assert_eq!(
                capture(&document, &mut WorkBudget::new()).unwrap(),
                Some(want)
            );
        }
    }
}

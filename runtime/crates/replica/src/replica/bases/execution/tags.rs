//! Shared named1.12.7 capture domain; no effective defaults/empty fallback.
use mdbn_core::{
    doc::Document,
    views::bases::{EvaluationFailure, WorkBudget, capture_source_tags},
};
pub(super) fn capture(
    document: &Document,
    budget: &mut WorkBudget,
) -> Result<Option<Vec<String>>, EvaluationFailure> {
    capture_source_tags(document, budget)
}
#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_core::doc::RecordFormat;
    #[test]
    fn simple_raw_tags_known_empty_and_unavailable_are_distinct() {
        for (source, want) in [
            (
                "---\ntags: [task, work/sub]\n---\n# Heading",
                Some(vec!["#task".into(), "#work/sub".into()]),
            ),
            ("# Heading\nPlain body", Some(vec![])),
            ("---\ntags: '#task'\n---\n", Some(vec!["#task".into()])),
            (
                "---\ntags: [task]\n---\nBody #other",
                Some(vec!["#other".into(), "#task".into()]),
            ),
            (
                "---\ntags: [task]\n---\n[[note#heading]]",
                Some(vec!["#task".into()]),
            ),
            ("---\ntags: [task, 5]\n---\n", None),
            ("---\ntags: 'task work'\n---\n", None),
            ("---\ntags: [task]\n---\n```\n#tag\n```", None),
        ] {
            let document = Document::parse(source, RecordFormat::Markdown);
            assert_eq!(capture(&document, &mut WorkBudget::new()).unwrap(), want);
        }
    }
}

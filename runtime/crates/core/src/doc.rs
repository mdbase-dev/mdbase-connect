//! Record documents: Markdown with YAML frontmatter, and YAML document records
//! (spec 03).
//!
//! A [`Document`] owns its exact source text and never reformats it: an
//! unchanged document renders back byte for byte, including its byte-order mark,
//! delimiters, line endings and trailing newline. Writes go through
//! [`crate::writer`], which follows the format fidelity rule of spec 12A.
//!
//! **Markdown records.** Frontmatter is present when the first bytes after an
//! optional byte-order mark are `---` followed by a line ending, and a later line
//! is exactly `---` (with `\n` or `\r\n`, or at the end of the file). Otherwise
//! the whole file is body: no opening delimiter, whitespace before it, or no
//! closing delimiter all mean no frontmatter.
//!
//! **YAML document records** (`.base`): the whole file (after a byte-order mark)
//! is the frontmatter, and the body is always empty.
//!
//! **Frontmatter state.** Persisted frontmatter is the parsed mapping. When the
//! YAML is invalid or is not a mapping, the persisted frontmatter is `{}` and
//! the state says why (spec 03 `invalid_frontmatter`).

use std::ops::Range;

use crate::value::{Map, Value};
use crate::yaml::{Parsed, YamlError};

/// The record format, fixed by the file extension (spec 03).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordFormat {
    /// Markdown with optional YAML frontmatter.
    Markdown,
    /// A YAML document record: the whole file is frontmatter.
    YamlDocument,
}

impl RecordFormat {
    /// The format of a record at `path`: `.base` files are YAML document records,
    /// every other record extension is Markdown.
    pub fn for_path(path: &str) -> RecordFormat {
        let name = path.rsplit('/').next().unwrap_or(path);
        match name.rsplit_once('.') {
            Some((_, "base")) => RecordFormat::YamlDocument,
            _ => RecordFormat::Markdown,
        }
    }
}

/// The line ending style of a document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEnding {
    /// `\n`.
    Lf,
    /// `\r\n`.
    CrLf,
}

impl LineEnding {
    /// The line ending as text.
    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
        }
    }
}

/// Why persisted frontmatter is `{}` although the file has a frontmatter block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrontmatterProblem {
    /// The YAML does not parse under the profile.
    Syntax(YamlError),
    /// The YAML is a scalar or sequence (`details.reason: non_mapping_frontmatter`).
    NotMapping,
}

impl FrontmatterProblem {
    /// The `details.reason` of the `invalid_frontmatter` issue.
    pub fn reason(&self) -> &'static str {
        match self {
            FrontmatterProblem::Syntax(_) => "yaml_syntax",
            FrontmatterProblem::NotMapping => "non_mapping_frontmatter",
        }
    }
}

/// Where the frontmatter lives in the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FrontmatterBlock {
    /// The opening delimiter line including its line ending (empty range for a
    /// YAML document record).
    pub open: Range<usize>,
    /// The YAML text.
    pub yaml: Range<usize>,
    /// The closing delimiter line including its line ending, if any.
    pub close: Range<usize>,
}

/// A parsed record document.
#[derive(Debug, Clone)]
pub struct Document {
    source: String,
    format: RecordFormat,
    bom: bool,
    block: Option<FrontmatterBlock>,
    parsed: Option<Parsed>,
    problem: Option<FrontmatterProblem>,
    frontmatter: Map,
    body: Range<usize>,
    eol: LineEnding,
}

const BOM: &str = "\u{feff}";

impl Document {
    /// Parse `source` as a record of `format`. Never fails: problems with the
    /// frontmatter are reported by [`Document::problem`].
    pub fn parse(source: impl Into<String>, format: RecordFormat) -> Document {
        let source: String = source.into();
        let bom = source.starts_with(BOM);
        let start = if bom { BOM.len() } else { 0 };
        let block = match format {
            RecordFormat::YamlDocument => Some(FrontmatterBlock {
                open: start..start,
                yaml: start..source.len(),
                close: source.len()..source.len(),
            }),
            RecordFormat::Markdown => find_frontmatter(&source, start),
        };
        let body = match (&block, format) {
            (_, RecordFormat::YamlDocument) => source.len()..source.len(),
            (Some(b), _) => b.close.end..source.len(),
            (None, _) => start..source.len(),
        };
        let eol = match &block {
            Some(b) if format == RecordFormat::Markdown => {
                if source[b.open.clone()].ends_with("\r\n") {
                    LineEnding::CrLf
                } else {
                    LineEnding::Lf
                }
            }
            _ => first_line_ending(&source[start..]),
        };
        let (parsed, problem, frontmatter) = match &block {
            None => (None, None, Map::new()),
            Some(b) => match Parsed::new(&source[b.yaml.clone()]) {
                Err(e) => (None, Some(FrontmatterProblem::Syntax(e)), Map::new()),
                Ok(p) => match &p.value {
                    None => (Some(p), None, Map::new()),
                    Some(Value::Map(m)) => {
                        let m = m.clone();
                        (Some(p), None, m)
                    }
                    Some(_) => (Some(p), Some(FrontmatterProblem::NotMapping), Map::new()),
                },
            },
        };
        Document {
            source,
            format,
            bom,
            block,
            parsed,
            problem,
            frontmatter,
            body,
            eol,
        }
    }

    /// Parse a record at `path`, with the format its extension implies.
    pub fn parse_at(path: &str, source: impl Into<String>) -> Document {
        Document::parse(source, RecordFormat::for_path(path))
    }

    /// Parse one record using fixed frontmatter structural limits. Resource
    /// failures are outer typed errors, never invalid-frontmatter empty maps.
    /// Source is borrowed through preflight, then copied only after admission.
    /// Historical/local readability callers may explicitly keep `parse_at`.
    pub fn parse_at_bounded(
        path: &str,
        source: &str,
    ) -> Result<(Document, crate::yaml::budget::Footprint), crate::yaml::budget::LimitExceeded>
    {
        let format = RecordFormat::for_path(path);
        let parts = bounded_frontmatter(format, source)?;
        let bom = source.starts_with(BOM);
        let start = if bom { BOM.len() } else { 0 };
        let body = match (&parts.block, format) {
            (_, RecordFormat::YamlDocument) => source.len()..source.len(),
            (Some(b), _) => b.close.end..source.len(),
            (None, _) => start..source.len(),
        };
        let eol = match &parts.block {
            Some(b) if format == RecordFormat::Markdown => {
                if source[b.open.clone()].ends_with("\r\n") {
                    LineEnding::CrLf
                } else {
                    LineEnding::Lf
                }
            }
            _ => first_line_ending(&source[start..]),
        };
        Ok((
            Document {
                source: source.to_owned(),
                format,
                bom,
                block: parts.block,
                parsed: parts.parsed,
                problem: parts.problem,
                frontmatter: parts.frontmatter,
                body,
                eol,
            },
            parts.footprint,
        ))
    }

    /// The exact source text.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// The record format.
    pub fn format(&self) -> RecordFormat {
        self.format
    }

    /// Whether the source starts with a byte-order mark.
    pub fn has_bom(&self) -> bool {
        self.bom
    }

    /// The line ending style: that of the opening delimiter, or of the first line
    /// of a document without frontmatter (`\n` when there is none).
    pub fn line_ending(&self) -> LineEnding {
        self.eol
    }

    /// Whether the document has a frontmatter block (always true for YAML
    /// document records).
    pub fn has_frontmatter(&self) -> bool {
        self.block.is_some()
    }

    /// The persisted frontmatter mapping (`{}` when absent or invalid).
    pub fn frontmatter(&self) -> &Map {
        &self.frontmatter
    }

    /// Why the frontmatter block could not be read as a mapping, if it could not.
    pub fn problem(&self) -> Option<&FrontmatterProblem> {
        self.problem.as_ref()
    }

    /// The parsed frontmatter value, whatever its shape: `None` without a block
    /// or with invalid YAML; `Some(Null)` for an empty block.
    pub fn frontmatter_value(&self) -> Option<Value> {
        let p = self.parsed.as_ref()?;
        Some(p.value.clone().unwrap_or(Value::Null))
    }

    /// The YAML text of the frontmatter block, if there is one.
    pub fn frontmatter_source(&self) -> Option<&str> {
        self.block.as_ref().map(|b| &self.source[b.yaml.clone()])
    }

    /// The frontmatter block including its delimiters (empty without one): the
    /// unit compared when frontmatter merges as a whole (spec 12A).
    pub fn frontmatter_block_source(&self) -> &str {
        match &self.block {
            Some(b) => &self.source[b.open.start..b.close.end],
            None => "",
        }
    }

    /// The body.
    pub fn body(&self) -> &str {
        &self.source[self.body.clone()]
    }

    pub(crate) fn parsed(&self) -> Option<&Parsed> {
        self.parsed.as_ref()
    }

    /// The source before the frontmatter block's YAML (byte-order mark and
    /// opening delimiter).
    pub(crate) fn prefix(&self) -> &str {
        match &self.block {
            Some(b) => &self.source[..b.yaml.start],
            None => &self.source[..self.body.start],
        }
    }

    /// The source between the YAML and the body (the closing delimiter).
    pub(crate) fn delimiter_after_yaml(&self) -> &str {
        match &self.block {
            Some(b) => &self.source[b.yaml.end..b.close.end],
            None => "",
        }
    }
}

/// Preflight a borrowed source before caller cloning/planning/index hydration.
/// Includes the document's final frontmatter clone in the conservative estimate.
pub fn check_frontmatter_at(
    path: &str,
    source: &str,
) -> Result<crate::yaml::budget::Footprint, crate::yaml::budget::LimitExceeded> {
    Ok(bounded_frontmatter(RecordFormat::for_path(path), source)?.footprint)
}

struct BoundedFrontmatter {
    block: Option<FrontmatterBlock>,
    parsed: Option<Parsed>,
    problem: Option<FrontmatterProblem>,
    frontmatter: Map,
    footprint: crate::yaml::budget::Footprint,
}
fn bounded_frontmatter(
    format: RecordFormat,
    source: &str,
) -> Result<BoundedFrontmatter, crate::yaml::budget::LimitExceeded> {
    let start = if source.starts_with(BOM) {
        BOM.len()
    } else {
        0
    };
    let block = match format {
        RecordFormat::YamlDocument => Some(FrontmatterBlock {
            open: start..start,
            yaml: start..source.len(),
            close: source.len()..source.len(),
        }),
        RecordFormat::Markdown => find_frontmatter(source, start),
    };
    let mut budget = crate::yaml::budget::Budget::new();
    let (parsed, problem, frontmatter) = match &block {
        None => (None, None, Map::new()),
        Some(b) => match Parsed::with_budget(&source[b.yaml.clone()], &mut budget) {
            Err(YamlError {
                kind: crate::yaml::ErrorKind::ResourceLimit(e),
                ..
            }) => return Err(e),
            Err(e) => (None, Some(FrontmatterProblem::Syntax(e)), Map::new()),
            Ok(p) => match &p.value {
                None => (Some(p), None, Map::new()),
                Some(value @ Value::Map(m)) => {
                    budget.copy_value(value, 1, false)?;
                    let frontmatter = m.clone();
                    (Some(p), None, frontmatter)
                }
                Some(_) => (Some(p), Some(FrontmatterProblem::NotMapping), Map::new()),
            },
        },
    };
    Ok(BoundedFrontmatter {
        block,
        parsed,
        problem,
        frontmatter,
        footprint: budget.footprint,
    })
}

/// The line ending of the first line break in `s` (`\n` when there is none).
fn first_line_ending(s: &str) -> LineEnding {
    match s.find('\n') {
        Some(i) if i > 0 && s.as_bytes()[i - 1] == b'\r' => LineEnding::CrLf,
        _ => LineEnding::Lf,
    }
}

/// Locate Markdown frontmatter starting at `start` (after a byte-order mark).
fn find_frontmatter(src: &str, start: usize) -> Option<FrontmatterBlock> {
    let rest = &src[start..];
    let open_len = if rest.starts_with("---\n") {
        4
    } else if rest.starts_with("---\r\n") {
        5
    } else {
        return None;
    };
    let yaml_start = start + open_len;
    let mut pos = yaml_start;
    while pos < src.len() {
        let line_end = src[pos..].find('\n').map_or(src.len(), |i| pos + i + 1);
        let line = &src[pos..line_end];
        if matches!(line, "---" | "---\n" | "---\r\n") {
            return Some(FrontmatterBlock {
                open: start..yaml_start,
                yaml: yaml_start..pos,
                close: pos..line_end,
            });
        }
        pos = line_end;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn md(s: &str) -> Document {
        Document::parse(s, RecordFormat::Markdown)
    }

    #[test]
    fn markdown_frontmatter_and_body() {
        let d = md("---\ntitle: T\n---\nBody\n");
        assert!(d.has_frontmatter());
        assert_eq!(d.frontmatter().get("title"), Some(&Value::string("T")));
        assert_eq!(d.body(), "Body\n");
        assert_eq!(d.frontmatter_source(), Some("title: T\n"));
        assert_eq!(d.line_ending(), LineEnding::Lf);
    }

    #[test]
    fn no_frontmatter_cases() {
        for src in [
            "Body only\n",
            " ---\na: 1\n---\n",
            "\n---\na: 1\n---\n",
            "---\na: 1\n",
            "--- \na: 1\n---\n",
            "---",
            "",
        ] {
            let d = md(src);
            assert!(!d.has_frontmatter(), "{src:?}");
            assert_eq!(d.body(), src);
            assert!(d.frontmatter().is_empty());
        }
    }

    #[test]
    fn bom_crlf_and_closing_at_eof() {
        let d = md("\u{feff}---\r\na: 1\r\n---\r\nx\r\n");
        assert!(d.has_bom());
        assert_eq!(d.line_ending(), LineEnding::CrLf);
        assert_eq!(d.frontmatter().get("a"), Some(&Value::int(1)));
        assert_eq!(d.body(), "x\r\n");
        let d = md("---\na: 1\n---");
        assert_eq!(d.body(), "");
        assert_eq!(d.frontmatter().len(), 1);
    }

    #[test]
    fn empty_and_invalid_frontmatter() {
        let d = md("---\n---\nb\n");
        assert!(d.has_frontmatter() && d.frontmatter().is_empty() && d.problem().is_none());
        assert_eq!(d.frontmatter_value(), Some(Value::Null));
        let d = md("---\n- a\n---\nb\n");
        assert_eq!(d.problem(), Some(&FrontmatterProblem::NotMapping));
        assert_eq!(d.problem().unwrap().reason(), "non_mapping_frontmatter");
        let d = md("---\na: [\n---\nb\n");
        assert_eq!(d.problem().unwrap().reason(), "yaml_syntax");
        assert!(d.frontmatter().is_empty());
        assert_eq!(d.body(), "b\n");
    }

    #[test]
    fn yaml_document_records() {
        assert_eq!(
            RecordFormat::for_path("views/a.base"),
            RecordFormat::YamlDocument
        );
        assert_eq!(RecordFormat::for_path("a.md"), RecordFormat::Markdown);
        assert_eq!(RecordFormat::for_path("base"), RecordFormat::Markdown);
        let d = Document::parse_at("v/x.base", "views:\n  - type: table\n");
        assert_eq!(d.body(), "");
        assert!(d.frontmatter().contains_key("views"));
        let d = Document::parse_at("v/x.base", "");
        assert!(d.frontmatter().is_empty() && d.problem().is_none());
    }
}

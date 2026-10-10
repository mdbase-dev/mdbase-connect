//! Links (spec 08): parsing, resolution, and rename reference planning.
//!
//! - [`parse_value`] parses one link value; [`parse_body`] and
//!   [`frontmatter_links`] find the links of a record.
//! - [`resolve`] resolves one link from a source record against a
//!   [`StateView`]: explicit paths, configured IDs (ambiguous IDs never fall
//!   back to filenames), and filename matches with the rc.5 tiebreakers
//!   (same directory, fewest segments, code-point order; path-key-equivalent
//!   winners stay ambiguous).
//! - [`index_keys`] / [`target_keys`] define the **link index** a state keeps
//!   ([`StateView::referrers`], [`StateView::link_targets`]). Keys
//!   over-approximate; candidates are always re-resolved.
//! - [`plan_reference_updates`] computes the rewritten documents of every
//!   referrer when a record or file moves (`rename`/`file_move` with
//!   `update_refs`, spec 12), with format fidelity.

use std::collections::{BTreeMap, BTreeSet};

use crate::doc::Document;
use crate::ids::{RecordId, Uuid};
use crate::paths::path_key;
use crate::state::{PathHolder, StateView};
use crate::types::Catalog;
use crate::value::{Map, Value};
use crate::writer::{self, Change};

/// The syntax a link was written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum LinkSyntax {
    /// `[[target#anchor|alias]]`, `![[target]]`.
    Wikilink,
    /// `[text](target)`, `![alt](target)`.
    Markdown,
    /// A bare path in a declared link field.
    Bare,
}

/// One parsed link occurrence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    /// Syntax.
    pub syntax: LinkSyntax,
    /// The occurrence exactly as written.
    pub raw: String,
    /// The target as written (no anchor, no alias, no angle brackets).
    pub target: String,
    /// The anchor after `#`, without the `#`.
    pub anchor: Option<String>,
    /// Wikilink alias or Markdown link text.
    pub alias: Option<String>,
    /// An embed (`!` prefix).
    pub embed: bool,
    /// Markdown destination written as `<...>`.
    pub angle: bool,
    /// Byte span of `raw` in the body (body links only).
    pub span: Option<(u64, u64)>,
    /// The top-level frontmatter field holding it, and the list index.
    pub field: Option<(String, Option<u64>)>,
}

impl Link {
    fn new(syntax: LinkSyntax, raw: &str, target: &str) -> Link {
        Link {
            syntax,
            raw: raw.to_owned(),
            target: target.to_owned(),
            anchor: None,
            alias: None,
            embed: false,
            angle: false,
            span: None,
            field: None,
        }
    }

    /// Whether the target resolves from the containing folder (spec 08).
    pub fn is_relative(&self) -> bool {
        match self.syntax {
            LinkSyntax::Wikilink => self.target.starts_with("./") || self.target.starts_with("../"),
            LinkSyntax::Markdown | LinkSyntax::Bare => !self.target.starts_with('/'),
        }
    }

    /// The link rendered with a different target, keeping syntax, embed,
    /// anchor and alias.
    pub fn with_target(&self, target: &str) -> String {
        let anchor = self
            .anchor
            .as_ref()
            .map(|a| format!("#{a}"))
            .unwrap_or_default();
        let bang = if self.embed { "!" } else { "" };
        match self.syntax {
            LinkSyntax::Wikilink => {
                let alias = self
                    .alias
                    .as_ref()
                    .map(|a| format!("|{a}"))
                    .unwrap_or_default();
                format!("{bang}[[{target}{anchor}{alias}]]")
            }
            LinkSyntax::Markdown => {
                let text = self.alias.clone().unwrap_or_default();
                let dest = if self.angle {
                    format!("<{target}{anchor}>")
                } else {
                    format!("{}{anchor}", target.replace(' ', "%20"))
                };
                format!("{bang}[{text}]({dest})")
            }
            LinkSyntax::Bare => format!("{target}{anchor}"),
        }
    }
}

/// Parse one complete link value (`[[...]]`, `[...](...)`, or, when
/// `allow_bare`, a bare path). `None` when the value is not a link.
pub fn parse_value(value: &str, allow_bare: bool) -> Option<Link> {
    let v = value.trim();
    if let Some((link, len)) = wikilink_at(v, 0)
        && len == v.len()
    {
        return Some(link);
    }
    if let Some((link, len)) = markdown_link_at(v, 0)
        && len == v.len()
    {
        return Some(link);
    }
    if allow_bare && !v.is_empty() && !v.contains(['\n', '[', ']']) && !is_external(v) {
        let (target, anchor) = split_anchor(v);
        let mut link = Link::new(LinkSyntax::Bare, v, target);
        link.anchor = anchor;
        return (!link.target.is_empty()).then_some(link);
    }
    None
}

fn split_anchor(s: &str) -> (&str, Option<String>) {
    match s.find('#') {
        Some(i) => (&s[..i], Some(s[i + 1..].to_owned())),
        None => (s, None),
    }
}

fn is_external(target: &str) -> bool {
    // A URI scheme: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":".
    let Some(colon) = target.find(':') else {
        return false;
    };
    let scheme = &target[..colon];
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// A wikilink starting at byte `at` (`[[` or `![[`): the link and its length.
fn wikilink_at(s: &str, at: usize) -> Option<(Link, usize)> {
    let rest = &s[at..];
    let (embed, inner_start) = if rest.starts_with("![[") {
        (true, 3)
    } else if rest.starts_with("[[") {
        (false, 2)
    } else {
        return None;
    };
    let close = rest[inner_start..].find("]]")? + inner_start;
    let inner = &rest[inner_start..close];
    if inner.contains(['[', ']', '\n', '\r']) {
        return None;
    }
    let (target_part, alias) = match inner.find('|') {
        Some(i) => (&inner[..i], Some(inner[i + 1..].to_owned())),
        None => (inner, None),
    };
    let (target, anchor) = split_anchor(target_part);
    let target = target.trim();
    if target.is_empty() {
        return None;
    }
    let len = close + 2;
    let mut link = Link::new(LinkSyntax::Wikilink, &rest[..len], target);
    link.alias = alias;
    link.anchor = anchor;
    link.embed = embed;
    Some((link, len))
}

/// A Markdown link starting at byte `at` (`[` or `![`): the link and its length.
fn markdown_link_at(s: &str, at: usize) -> Option<(Link, usize)> {
    let rest = &s[at..];
    let (embed, open) = if rest.starts_with("![") {
        (true, 1)
    } else if rest.starts_with('[') && !rest.starts_with("[[") {
        (false, 0)
    } else {
        return None;
    };
    let text_end = rest[open + 1..].find(']')? + open + 1;
    let text = &rest[open + 1..text_end];
    if text.contains(['[', '\n']) || !rest[text_end..].starts_with("](") {
        return None;
    }
    let dest_start = text_end + 2;
    let (dest, angle, len) = if rest[dest_start..].starts_with('<') {
        let close = rest[dest_start + 1..].find('>')? + dest_start + 1;
        let after = rest[close + 1..].find(')')? + close + 1;
        if rest[close + 1..after].trim().starts_with('"')
            || rest[close + 1..after].trim().is_empty()
        {
            (&rest[dest_start + 1..close], true, after + 1)
        } else {
            return None;
        }
    } else {
        let close = rest[dest_start..].find(')')? + dest_start;
        let inner = &rest[dest_start..close];
        // Optional title: `dest "title"`.
        let dest = inner.split(' ').next().unwrap_or(inner);
        (dest, false, close + 1)
    };
    if dest.is_empty() || dest.contains('\n') || dest.starts_with('#') || is_external(dest) {
        return None;
    }
    let (target, anchor) = split_anchor(dest);
    let target = if angle {
        target.to_owned()
    } else {
        target.replace("%20", " ")
    };
    if target.is_empty() {
        return None;
    }
    let mut link = Link::new(LinkSyntax::Markdown, &rest[..len], &target);
    link.alias = Some(text.to_owned());
    link.anchor = anchor;
    link.embed = embed;
    link.angle = angle;
    Some((link, len))
}

/// Links in a Markdown body, in order of appearance: wikilinks and Markdown
/// links (embeds included, flagged). Fenced code blocks and inline code spans
/// are skipped (spec 08).
pub fn parse_body(body: &str) -> Vec<Link> {
    let mut out = Vec::new();
    let mut fence: Option<(u8, usize)> = None;
    let mut line_start = 0usize;
    for line in body.split_inclusive('\n') {
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let fence_char = trimmed.bytes().next().filter(|c| *c == b'`' || *c == b'~');
        let run = fence_char.map_or(0, |c| trimmed.bytes().take_while(|b| *b == c).count());
        match fence {
            Some((c, n)) => {
                if indent < 4
                    && fence_char == Some(c)
                    && run >= n
                    && trimmed[run..].trim().is_empty()
                {
                    fence = None;
                }
            }
            None if indent < 4 && run >= 3 => {
                let c = fence_char.unwrap_or(b'`');
                if !(c == b'`' && trimmed[run..].contains('`')) {
                    fence = Some((c, run));
                }
            }
            None => scan_line(line, line_start, &mut out),
        }
        line_start += line.len();
    }
    out
}

fn scan_line(line: &str, offset: usize, out: &mut Vec<Link>) {
    let bytes = line.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'`' => {
                let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
                let ticks = &line[i..i + run];
                // Skip to the matching closing run, if any.
                match line[i + run..].find(ticks) {
                    Some(j) => i += run + j + run,
                    None => i += run,
                }
            }
            b'\\' => i += 2,
            b'!' | b'[' => {
                let found = wikilink_at(line, i).or_else(|| markdown_link_at(line, i));
                match found {
                    Some((mut link, len)) => {
                        link.span = Some((to_u64(offset + i), to_u64(offset + i + len)));
                        out.push(link);
                        i += len;
                    }
                    None => i += 1,
                }
            }
            _ => i += 1,
        }
    }
}

fn to_u64(n: usize) -> u64 {
    u64::try_from(n).unwrap_or(u64::MAX)
}

/// Frontmatter links (spec 08 `file.links` order): values of fields the
/// matched `types` declare in `collection.links` (wikilink, Markdown or bare
/// path; strings or list items), in declaration order, then every other
/// top-level string or list item whose complete value is a wikilink, in
/// frontmatter order.
pub fn frontmatter_links(catalog: &Catalog, types: &[String], frontmatter: &Map) -> Vec<Link> {
    let mut declared: Vec<&str> = Vec::new();
    for t in types.iter().filter_map(|n| catalog.type_named(n)) {
        for f in t.link_fields.keys() {
            if !declared.contains(&f.as_str()) {
                declared.push(f);
            }
        }
    }
    let mut out = Vec::new();
    let push = |field: &str, allow_bare: bool, out: &mut Vec<Link>| {
        let mut add = |s: &str, idx: Option<u64>| {
            if let Some(mut l) = parse_value(s, allow_bare)
                && (allow_bare || l.syntax == LinkSyntax::Wikilink)
            {
                l.field = Some((field.to_owned(), idx));
                out.push(l);
            }
        };
        match frontmatter.get(field) {
            Some(Value::Text(s)) => add(s, None),
            Some(Value::List(items)) => {
                for (i, item) in items.iter().enumerate() {
                    if let Value::Text(s) = item {
                        add(s, Some(to_u64(i)));
                    }
                }
            }
            _ => {}
        }
    };
    for f in &declared {
        push(f, true, &mut out);
    }
    for (k, _) in frontmatter.iter() {
        if !declared.contains(&k) {
            push(k, false, &mut out);
        }
    }
    out
}

/// Every link of a record: frontmatter links then body links (embeds
/// included). Uses the record's membership under `catalog`.
pub fn record_links(catalog: &Catalog, path: &str, source: &str) -> Vec<Link> {
    let doc = Document::parse_at(path, source);
    let types = catalog.membership(path, doc.frontmatter()).types;
    let mut out = frontmatter_links(catalog, &types, doc.frontmatter());
    out.extend(parse_body(doc.body()));
    out
}

/// Link resolution outcome (spec 08).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Resolution {
    /// Resolved to exactly one record.
    Record(RecordId),
    /// Resolved to a non-record file.
    File(crate::ids::FileId),
    /// Several candidates remain (`ambiguous_link`). Candidate paths, sorted.
    Ambiguous(Vec<String>),
    /// Nothing matches (`link_not_found`).
    NotFound,
    /// The target escapes the collection root (an invalid link).
    Invalid,
}

impl Resolution {
    /// The resolved record or file ID.
    pub fn target(&self) -> Option<Uuid> {
        match self {
            Resolution::Record(id) | Resolution::File(id) => Some(*id),
            _ => None,
        }
    }
}

/// A link index key. Records are indexed under the keys of their outgoing
/// links; a record is found by the keys of its own path and ID.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct LinkKey(pub String);

fn folder_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(d, _)| d)
}

fn basename(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, b)| b)
}

/// `name` without its final extension when that extension is a record
/// extension under `catalog`.
fn strip_record_ext<'a>(catalog: &Catalog, name: &'a str) -> &'a str {
    match name.rsplit_once('.') {
        Some((stem, ext))
            if !stem.is_empty()
                && catalog
                    .settings()
                    .record_extensions
                    .iter()
                    .any(|e| e.eq_ignore_ascii_case(ext)) =>
        {
            stem
        }
        _ => name,
    }
}

/// Normalize `.` and `..` segments. `None` when the path escapes the root.
fn normalize(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    Some(parts.join("/"))
}

/// The collection path a path-form link names (before extension probing),
/// or `None` for a simple wikilink. `Err(())` when it escapes the root.
#[allow(clippy::result_unit_err)]
pub fn link_path(link: &Link, from_path: &str) -> Option<Result<String, ()>> {
    let t = link.target.as_str();
    let rooted = t.strip_prefix('/');
    let joined = match (link.syntax, rooted) {
        (_, Some(r)) => r.to_owned(),
        (LinkSyntax::Wikilink, None) if !link.is_relative() && !t.contains('/') => return None,
        (LinkSyntax::Wikilink, None) if !link.is_relative() => t.to_owned(),
        _ => {
            let dir = folder_of(from_path);
            if dir.is_empty() {
                t.to_owned()
            } else {
                format!("{dir}/{t}")
            }
        }
    };
    Some(normalize(&joined).filter(|p| !p.is_empty()).ok_or(()))
}

fn holder_at(state: &dyn StateView, path: &str) -> Option<PathHolder> {
    state.at_path_key(&path_key(path))
}

/// Resolve `link`, written in the record at `from_path`, against `state`.
pub fn resolve(link: &Link, from_path: &str, state: &dyn StateView) -> Resolution {
    let catalog = state.catalog();
    match link_path(link, from_path) {
        Some(Err(())) => Resolution::Invalid,
        Some(Ok(p)) => {
            let mut probes = vec![p.clone()];
            if strip_record_ext(&catalog, basename(&p)) == basename(&p) {
                for ext in &catalog.settings().record_extensions {
                    probes.push(format!("{p}.{ext}"));
                }
            }
            for probe in probes {
                match holder_at(state, &probe) {
                    Some(PathHolder::Record(id)) => return Resolution::Record(id),
                    Some(PathHolder::File(id)) => return Resolution::File(id),
                    None => {}
                }
            }
            Resolution::NotFound
        }
        None => resolve_simple(&link.target, from_path, state, &catalog),
    }
}

fn resolve_simple(
    target: &str,
    from_path: &str,
    state: &dyn StateView,
    catalog: &Catalog,
) -> Resolution {
    if let Some(field) = &catalog.settings().id_field {
        let mut hits: Vec<(String, RecordId)> = state
            .link_targets(&[id_key(target)])
            .into_iter()
            .filter_map(|id| state.record(&id).map(|r| (r, id)))
            .filter(|(r, _)| {
                Document::parse_at(&r.path, &*r.source)
                    .frontmatter()
                    .get(field)
                    .and_then(Value::as_str)
                    == Some(target)
            })
            .map(|(r, id)| (r.path, id))
            .collect();
        hits.sort();
        match hits.len() {
            0 => {}
            1 => return Resolution::Record(hits[0].1),
            _ => return Resolution::Ambiguous(hits.into_iter().map(|h| h.0).collect()),
        }
    }
    let want = path_key(strip_record_ext(catalog, target));
    let mut candidates: Vec<(String, RecordId)> = state
        .link_targets(&[name_key(&want)])
        .into_iter()
        .filter_map(|id| state.record(&id).map(|r| (r.path, id)))
        .filter(|(p, _)| path_key(strip_record_ext(catalog, basename(p))) == want)
        .collect();
    candidates.sort();
    if candidates.is_empty() {
        return Resolution::NotFound;
    }
    if candidates.len() > 1 {
        let dir = folder_of(from_path);
        if candidates.iter().any(|(p, _)| folder_of(p) == dir) {
            candidates.retain(|(p, _)| folder_of(p) == dir);
        }
        let depth = |p: &str| p.split('/').count();
        let min = candidates.iter().map(|(p, _)| depth(p)).min().unwrap_or(0);
        candidates.retain(|(p, _)| depth(p) == min);
        // Sorted, so the first is the smallest in code-point order.
        let winner_key = path_key(&candidates[0].0);
        let tied: Vec<String> = candidates
            .iter()
            .filter(|(p, _)| path_key(p) == winner_key)
            .map(|(p, _)| p.clone())
            .collect();
        if tied.len() > 1 {
            return Resolution::Ambiguous(tied);
        }
    }
    Resolution::Record(candidates[0].1)
}

fn name_key(stem_key: &str) -> LinkKey {
    LinkKey(format!("n:{stem_key}"))
}

fn id_key(id: &str) -> LinkKey {
    LinkKey(format!("i:{id}"))
}

/// Index keys of the outgoing links of a record (for the link index): the
/// path key of each target's final segment without a record extension.
pub fn index_keys(catalog: &Catalog, path: &str, source: &str) -> Vec<LinkKey> {
    let mut keys: BTreeSet<LinkKey> = BTreeSet::new();
    for l in record_links(catalog, path, source) {
        // Keep the raw key for compatibility with previously materialized
        // indexes, but also index the resolver's normalized path basename.
        keys.insert(name_index_key(catalog, &l.target));
        if let Some(Ok(canonical)) = link_path(&l, path) {
            keys.insert(name_index_key(catalog, &canonical));
        }
        if catalog.settings().id_field.is_some() && l.syntax == LinkSyntax::Wikilink {
            keys.insert(id_key(&l.target));
        }
    }
    keys.into_iter().collect()
}

/// The name index key of a link target: the path key of its final segment
/// without a record extension. Path-form targets must first pass through
/// [`link_path`]; raw dot-segment/trailing-slash basenames are not canonical.
pub fn name_index_key(catalog: &Catalog, target: &str) -> LinkKey {
    name_key(&path_key(strip_record_ext(catalog, basename(target))))
}

/// Keys under which a record or file at `path` is found: its name key, and,
/// when an ID field is configured, its ID key.
pub fn target_keys(catalog: &Catalog, path: &str, source: Option<&str>) -> Vec<LinkKey> {
    let mut keys = vec![name_key(&path_key(strip_record_ext(
        catalog,
        basename(path),
    )))];
    if let (Some(field), Some(src)) = (&catalog.settings().id_field, source)
        && let Some(id) = Document::parse_at(path, src)
            .frontmatter()
            .get(field)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    {
        keys.push(id_key(id));
    }
    keys.sort();
    keys
}

/// One link that resolves to a record or file (a backlink).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomingLink {
    /// The referring record.
    pub id: RecordId,
    /// Its path.
    pub path: String,
    /// The link.
    pub link: Link,
}

/// Every link in another record that resolves to `target` (a record or file
/// ID) in `state`, ordered by referring path then position. Found through the
/// link index ([`StateView::referrers`]) and re-resolved.
pub fn links_to(state: &dyn StateView, target: Uuid) -> Vec<IncomingLink> {
    let catalog = state.catalog();
    let (path, source) = match (state.record(&target), state.file(&target)) {
        (Some(r), _) => (r.path, Some(r.source)),
        (None, Some(f)) => (f.path, None),
        (None, None) => return Vec::new(),
    };
    let keys = target_keys(&catalog, &path, source.as_deref());
    let mut out: Vec<IncomingLink> = Vec::new();
    for rid in state.referrers(&keys) {
        let Some(r) = state.record(&rid) else {
            continue;
        };
        for l in record_links(&catalog, &r.path, &r.source) {
            if resolve(&l, &r.path, state).target() == Some(target) {
                out.push(IncomingLink {
                    id: rid,
                    path: r.path.clone(),
                    link: l,
                });
            }
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// One rewritten link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RewrittenLink {
    /// The frontmatter field, or `None` for the body.
    pub field: Option<String>,
    /// The link as it was.
    pub old_value: String,
    /// The link as rewritten.
    pub new_value: String,
}

/// One referrer rewrite produced by a move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReferenceUpdate {
    /// The referring record.
    pub id: RecordId,
    /// Its path (after the move, if it is the moved record itself).
    pub path: String,
    /// Its new exact document.
    pub doc: String,
    /// The rewritten links, in document order.
    pub links: Vec<RewrittenLink>,
}

/// Relative path from folder `from_dir` to `to`, with `./` for the same folder.
fn relative(from_dir: &str, to: &str) -> String {
    let src: Vec<&str> = from_dir.split('/').filter(|s| !s.is_empty()).collect();
    let dst: Vec<&str> = to.split('/').collect();
    let (dst_dirs, name) = dst.split_at(dst.len() - 1);
    let common = src.iter().zip(dst_dirs).take_while(|(a, b)| a == b).count();
    let mut out = String::new();
    if src.len() == common {
        out.push_str("./");
    } else {
        for _ in common..src.len() {
            out.push_str("../");
        }
    }
    for d in &dst_dirs[common..] {
        out.push_str(d);
        out.push('/');
    }
    out.push_str(name[0]);
    out
}

/// A new target string for `link` (in a record at `from_path`) naming `to`,
/// in the link's own style. `post` is the state after the move, used to check
/// that a simple name still resolves to `moved`.
fn new_target(
    link: &Link,
    from_path: &str,
    to: &str,
    moved: Uuid,
    post: &dyn StateView,
    catalog: &Catalog,
) -> String {
    let had_ext = strip_record_ext(catalog, basename(&link.target)) != basename(&link.target);
    let shape = |p: &str| -> String {
        if had_ext || strip_record_ext(catalog, basename(p)) == basename(p) {
            p.to_owned()
        } else {
            let stem_len = strip_record_ext(catalog, basename(p)).len();
            let cut = p.len() - basename(p).len() + stem_len;
            p[..cut].to_owned()
        }
    };
    match link.syntax {
        LinkSyntax::Wikilink if link.target.starts_with('/') => format!("/{}", shape(to)),
        LinkSyntax::Wikilink if link.is_relative() => shape(&relative(folder_of(from_path), to)),
        LinkSyntax::Wikilink if !link.target.contains('/') => {
            let simple = shape(basename(to));
            let mut probe = link.clone();
            probe.target = simple.clone();
            if resolve(&probe, from_path, post).target() == Some(moved) {
                simple
            } else {
                shape(to)
            }
        }
        LinkSyntax::Wikilink => shape(to),
        LinkSyntax::Markdown | LinkSyntax::Bare if link.target.starts_with('/') => {
            format!("/{}", shape(to))
        }
        LinkSyntax::Markdown | LinkSyntax::Bare => {
            let rel = relative(folder_of(from_path), to);
            let rel = if link.target.starts_with("./") {
                rel
            } else {
                rel.strip_prefix("./").map_or(rel.clone(), str::to_owned)
            };
            shape(&rel)
        }
    }
}

/// Rewrites of every record whose links resolve to `moved` in `pre` and no
/// longer resolve to it in `post` (spec 12 rename with `update_refs`). `post`
/// is the state with the move applied. Links keep their syntax, embed flag,
/// alias and anchor; only the target text changes. Unresolved and ambiguous
/// links, and links that still resolve (for example ID links), are left
/// alone. Ordered by referring path.
pub fn plan_reference_updates(
    pre: &dyn StateView,
    post: &dyn StateView,
    moved: Uuid,
    to: &str,
) -> Vec<ReferenceUpdate> {
    let catalog = pre.catalog();
    let Some(old_path) = pre
        .record(&moved)
        .map(|r| r.path)
        .or_else(|| pre.file(&moved).map(|f| f.path))
    else {
        return Vec::new();
    };
    let mut keys = target_keys(
        &catalog,
        &old_path,
        pre.record(&moved).as_ref().map(|r| &*r.source),
    );
    keys.extend(target_keys(&catalog, to, None));
    let mut out: BTreeMap<String, ReferenceUpdate> = BTreeMap::new();
    for rid in pre.referrers(&keys) {
        let (Some(before), Some(after)) = (pre.record(&rid), post.record(&rid)) else {
            continue;
        };
        let doc = Document::parse_at(&before.path, &*before.source);
        let types = catalog.membership(&before.path, doc.frontmatter()).types;
        let fm_links = frontmatter_links(&catalog, &types, doc.frontmatter());
        let body_links = parse_body(doc.body());
        let mut field_changes: BTreeMap<String, Value> = BTreeMap::new();
        let mut rewritten = Vec::new();
        let decide = |l: &Link| -> Option<String> {
            if resolve(l, &before.path, pre).target() != Some(moved)
                || resolve(l, &after.path, post).target() == Some(moved)
            {
                return None;
            }
            let t = new_target(l, &after.path, to, moved, post, &catalog);
            Some(l.with_target(&t))
        };
        for l in &fm_links {
            let Some(new_raw) = decide(l) else { continue };
            let Some((field, idx)) = &l.field else {
                continue;
            };
            let current = field_changes
                .get(field)
                .cloned()
                .or_else(|| doc.frontmatter().get(field).cloned());
            let new_value = match (current, idx) {
                (Some(Value::List(mut items)), Some(i)) => {
                    if let Some(slot) = usize::try_from(*i).ok().and_then(|i| items.get_mut(i)) {
                        *slot = Value::string(replace_link(
                            slot.as_str().unwrap_or(""),
                            &l.raw,
                            &new_raw,
                        ));
                    }
                    Value::List(items)
                }
                (Some(Value::Text(s)), None) => Value::string(replace_link(&s, &l.raw, &new_raw)),
                _ => continue,
            };
            field_changes.insert(field.clone(), new_value);
            rewritten.push(RewrittenLink {
                field: Some(field.clone()),
                old_value: l.raw.clone(),
                new_value: new_raw,
            });
        }
        let mut body = doc.body().to_owned();
        let mut body_rewrites: Vec<(usize, usize, String)> = Vec::new();
        for l in &body_links {
            let Some(new_raw) = decide(l) else { continue };
            let Some((s, e)) = l.span else { continue };
            let (Ok(s), Ok(e)) = (usize::try_from(s), usize::try_from(e)) else {
                continue;
            };
            rewritten.push(RewrittenLink {
                field: None,
                old_value: l.raw.clone(),
                new_value: new_raw.clone(),
            });
            body_rewrites.push((s, e, new_raw));
        }
        if rewritten.is_empty() {
            continue;
        }
        for (s, e, new_raw) in body_rewrites.into_iter().rev() {
            body.replace_range(s..e, &new_raw);
        }
        // The post state's document may already differ (the moved record
        // itself); rewrite against what the record holds after the move.
        let base = Document::parse_at(&after.path, &*after.source);
        let changes: Vec<(String, Change)> = field_changes
            .into_iter()
            .map(|(k, v)| (k, Change::Set(v)))
            .collect();
        let body_arg = (body != doc.body()).then_some(body.as_str());
        let Ok(new_doc) = writer::write(&base, &changes, body_arg) else {
            continue;
        };
        out.insert(
            after.path.clone(),
            ReferenceUpdate {
                id: rid,
                path: after.path,
                doc: new_doc,
                links: rewritten,
            },
        );
    }
    out.into_values().collect()
}

/// Replace the link text `old` with `new` in a frontmatter string whose
/// complete value is the link (surrounding whitespace kept).
fn replace_link(s: &str, old: &str, new: &str) -> String {
    match s.find(old) {
        Some(i) => format!("{}{new}{}", &s[..i], &s[i + old.len()..]),
        None => new.to_owned(),
    }
}

// ------------------------------------------------------------ CEL link host

/// The link value `file.links` and `link()` produce for `link` (spec 08):
/// `[[target]]` for a wikilink that resolves from the root or by name, and
/// a `./`- or `../`-prefixed path for one that resolves from the containing
/// folder (Markdown links, bare paths, relative wikilinks). Alias and anchor
/// are dropped.
pub fn link_value(link: &Link) -> String {
    let t = link.target.as_str();
    match link.syntax {
        LinkSyntax::Wikilink if link.is_relative() => t.to_owned(),
        LinkSyntax::Wikilink => format!("[[{t}]]"),
        LinkSyntax::Markdown | LinkSyntax::Bare => {
            if t.starts_with('/') || t.starts_with("./") || t.starts_with("../") {
                t.to_owned()
            } else {
                format!("./{t}")
            }
        }
    }
}

/// Inline body tags (spec 08): `#tag` at the start of a line or after
/// whitespace, outside code; returned without `#`, in order.
pub fn parse_tags(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        let mut in_code = false;
        let mut prev_ws = true;
        let chars: Vec<(usize, char)> = line.char_indices().collect();
        let mut i = 0;
        while i < chars.len() {
            let (pos, c) = chars[i];
            if c == '`' {
                in_code = !in_code;
            } else if c == '#' && prev_ws && !in_code {
                let rest = &line[pos + 1..];
                let tag: String = rest
                    .chars()
                    .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '-' | '/'))
                    .collect();
                if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) {
                    i += tag.chars().count();
                    out.push(tag);
                }
            }
            prev_ws = c.is_whitespace();
            i += 1;
        }
    }
    out
}

/// `file.tags` (spec 08): frontmatter `tags` (a string or a list of strings,
/// `#` stripped) then inline body tags.
pub fn record_tags(frontmatter: &Map, body: &str) -> Vec<String> {
    let mut out: Vec<String> = match frontmatter.get("tags") {
        Some(Value::Text(s)) => vec![s.trim_start_matches('#').to_owned()],
        Some(Value::List(l)) => l
            .iter()
            .filter_map(Value::as_str)
            .map(|s| s.trim_start_matches('#').to_owned())
            .collect(),
        _ => Vec::new(),
    };
    out.extend(parse_tags(body));
    out
}

/// Link resolution for CEL's link helpers (`link()`, `asFile()`,
/// `file.asLink()`, `file.hasLink()`, `file.links`, `file.embeds`,
/// `file.backlinks`) over a [`StateView`]. Link values are strings in the
/// [`link_value`] form, so `file.links == ["[[a]]"]` compares as the spec's
/// fixtures expect.
pub struct CelLinks<'a> {
    state: &'a dyn StateView,
    catalog: std::sync::Arc<Catalog>,
}

impl std::fmt::Debug for CelLinks<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("CelLinks")
    }
}

impl<'a> CelLinks<'a> {
    /// A host over `state`.
    pub fn new(state: &'a dyn StateView) -> CelLinks<'a> {
        CelLinks {
            catalog: state.catalog(),
            state,
        }
    }

    fn record_at(&self, path: &str) -> Option<crate::state::StoredRecord> {
        match self.state.at_path_key(&path_key(path)) {
            Some(PathHolder::Record(id)) => self.state.record(&id),
            _ => None,
        }
    }

    /// The link a CEL value names, as written at `from`.
    fn parse(value: &crate::cel::CelValue) -> Result<Option<Link>, String> {
        match value {
            crate::cel::CelValue::String(s) => Ok(parse_value(s, true)),
            crate::cel::CelValue::Null => Ok(None),
            other => Err(format!("link() takes a string, not {}", other.type_name())),
        }
    }

    fn resolve_value(
        &self,
        value: &crate::cel::CelValue,
        from: &str,
    ) -> Result<Resolution, String> {
        Ok(match Self::parse(value)? {
            Some(l) => resolve(&l, from, self.state),
            None => Resolution::NotFound,
        })
    }

    /// The record at `path` in query-candidate shape: effective fields at
    /// top level, `record`, `raw` and `file`, with origin `path`.
    pub fn candidate(&self, path: &str) -> Option<crate::cel::CelValue> {
        use crate::cel::{CelMap, CelValue, Key};
        let rec = self.record_at(path)?;
        let doc = Document::parse_at(&rec.path, &*rec.source);
        let fm = doc.frontmatter();
        let types = self.catalog.membership(&rec.path, fm).types;
        let effective = self.catalog.effective_frontmatter(&types, fm);
        let mut m = CelMap::new().with_origin(&rec.path);
        let key = |s: &str| Key::String(std::sync::Arc::from(s));
        for (k, v) in effective.iter() {
            m.insert(key(k), CelValue::from_value(v));
        }
        m.insert(
            key("record"),
            CelValue::from_value(&Value::Map(effective.clone())),
        );
        m.insert(key("raw"), CelValue::from_value(&Value::Map(fm.clone())));
        m.insert(
            key("file"),
            CelValue::from_value(&self.file_value(&rec.path, fm, doc.body())),
        );
        Some(CelValue::Map(std::sync::Arc::new(m)))
    }

    /// The `file` binding of a record: path names, folder and tags (spec 10).
    /// `links`, `embeds` and `backlinks` are supplied lazily through
    /// [`crate::cel::LinkHost::file_member`].
    pub fn file_value(&self, path: &str, frontmatter: &Map, body: &str) -> Value {
        let mut v = crate::query::file_value(path, None);
        if let Value::Map(m) = &mut v {
            m.insert(
                "tags",
                Value::List(
                    record_tags(frontmatter, body)
                        .into_iter()
                        .map(Value::string)
                        .collect(),
                ),
            );
        }
        v
    }
}

impl crate::cel::LinkHost for CelLinks<'_> {
    fn link(
        &self,
        value: &crate::cel::CelValue,
        from: &str,
    ) -> Result<crate::cel::CelValue, String> {
        let _ = from;
        Ok(match Self::parse(value)? {
            Some(l) => crate::cel::CelValue::string(&link_value(&l)),
            None => crate::cel::CelValue::Null,
        })
    }

    fn as_file(
        &self,
        value: &crate::cel::CelValue,
        from: &str,
    ) -> Result<crate::cel::CelValue, String> {
        Ok(match self.resolve_value(value, from)? {
            Resolution::Record(id) => self
                .state
                .record(&id)
                .and_then(|r| self.candidate(&r.path))
                .unwrap_or(crate::cel::CelValue::Null),
            _ => crate::cel::CelValue::Null,
        })
    }

    fn as_link(&self, path: &str) -> Result<crate::cel::CelValue, String> {
        // Rooted, so the value resolves to this record from anywhere.
        let stem = strip_record_ext(&self.catalog, basename(path));
        let dir = folder_of(path);
        let target = if dir.is_empty() {
            format!("/{stem}")
        } else {
            format!("{dir}/{stem}")
        };
        Ok(crate::cel::CelValue::string(&format!("[[{target}]]")))
    }

    fn has_link(&self, path: &str, value: &crate::cel::CelValue) -> Result<bool, String> {
        let Some(want) = self.resolve_value(value, path)?.target() else {
            return Ok(false);
        };
        let Some(rec) = self.record_at(path) else {
            return Ok(false);
        };
        Ok(record_links(&self.catalog, &rec.path, &rec.source)
            .iter()
            .any(|l| resolve(l, &rec.path, self.state).target() == Some(want)))
    }

    fn file_member(
        &self,
        path: &str,
        member: &str,
    ) -> Result<Option<crate::cel::CelValue>, String> {
        let Some(rec) = self.record_at(path) else {
            return Ok(None);
        };
        let strings = |v: Vec<String>| {
            crate::cel::CelValue::from_value(&Value::List(
                v.into_iter().map(Value::string).collect(),
            ))
        };
        Ok(Some(match member {
            "links" | "embeds" => {
                let embeds = member == "embeds";
                strings(
                    record_links(&self.catalog, &rec.path, &rec.source)
                        .iter()
                        .filter(|l| l.embed == embeds)
                        .map(link_value)
                        .collect(),
                )
            }
            "backlinks" => {
                let keys = target_keys(&self.catalog, &rec.path, Some(&rec.source));
                let mut from: Vec<String> = self
                    .state
                    .referrers(&keys)
                    .into_iter()
                    .filter_map(|id| self.state.record(&id))
                    .filter(|r| {
                        record_links(&self.catalog, &r.path, &r.source)
                            .iter()
                            .any(|l| resolve(l, &r.path, self.state).target() == Some(rec.id))
                    })
                    .map(|r| r.path)
                    .collect();
                from.sort();
                from.dedup();
                let mut out = Vec::new();
                for p in from {
                    if let Ok(crate::cel::CelValue::String(s)) =
                        crate::cel::LinkHost::as_link(self, &p)
                    {
                        out.push(s.to_string());
                    }
                }
                strings(out)
            }
            _ => return Ok(None),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_forms() {
        let l = parse_value("[[people/alice#bio|Alice]]", false).unwrap();
        assert_eq!(l.target, "people/alice");
        assert_eq!(l.anchor.as_deref(), Some("bio"));
        assert_eq!(l.alias.as_deref(), Some("Alice"));
        assert_eq!(l.with_target("x"), "[[x#bio|Alice]]");
        let m = parse_value("[notes](plan.md#goals)", false).unwrap();
        assert_eq!(
            (m.target.as_str(), m.anchor.as_deref()),
            ("plan.md", Some("goals"))
        );
        assert!(parse_value("see tasks/other.md", false).is_none());
        assert!(parse_value("https://example.com", true).is_none());
        assert_eq!(
            parse_value("people/bob.md", true).unwrap().syntax,
            LinkSyntax::Bare
        );
    }

    #[test]
    fn body_skips_code() {
        let body = "a [[x]] `[[no]]` ![[e]]\n```\n[[fenced]]\n```\n[t](y.md) [u](http://z)\n";
        let links = parse_body(body);
        let targets: Vec<&str> = links.iter().map(|l| l.target.as_str()).collect();
        assert_eq!(targets, ["x", "e", "y.md"]);
        assert!(links[1].embed);
        let (s, e) = links[2].span.unwrap();
        assert_eq!(&body[s as usize..e as usize], "[t](y.md)");
    }

    #[test]
    fn tags_and_values() {
        assert_eq!(
            parse_tags("a #x and #y/z\n`#no` url#frag #1\n"),
            ["x", "y/z"]
        );
        let l = parse_value("[notes](plan.md#goals)", false).unwrap();
        assert_eq!(link_value(&l), "./plan.md");
        let w = parse_value("[[people/alice|Alice]]", false).unwrap();
        assert_eq!(link_value(&w), "[[people/alice]]");
    }

    #[test]
    fn relative_paths() {
        assert_eq!(relative("notes", "notes/a.md"), "./a.md");
        assert_eq!(relative("docs", "archive/d.md"), "../archive/d.md");
        assert_eq!(relative("", "a/b.md"), "./a/b.md");
        assert_eq!(normalize("a/../../b"), None);
    }
}

//! The span-tracking YAML parser: source text → [`Node`] tree.
//!
//! A hand-written recursive-descent parser over the mdbase YAML profile (see the
//! [module docs](super)). Every node records the byte span it came from, its
//! collection style (block or flow) and scalar style, which is what the
//! format-preserving writer needs. Composition into values (tags, anchors,
//! scalar resolution) is a separate step in `compose`.
//!
//! Limits are deterministic and independent of the platform: nesting depth is
//! bounded by [`MAX_DEPTH`] so recursion can never exhaust the (small) WASM stack.

use super::{ErrorKind, YamlError};
use std::cell::Cell;

/// Maximum nesting depth of collections and properties.
pub(crate) const MAX_DEPTH: u32 = 100;

/// A byte range in the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Span {
    pub start: usize,
    pub end: usize,
}

/// How a scalar was written.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScalarStyle {
    /// Unquoted.
    Plain,
    /// `'single quoted'`.
    SingleQuoted,
    /// `"double quoted"`.
    DoubleQuoted,
    /// `|` block scalar.
    Literal,
    /// `>` block scalar.
    Folded,
}

/// One node of the parse tree.
#[derive(Debug, Clone)]
pub(crate) struct Node {
    /// From the first property (anchor/tag) or content byte to the end of content.
    pub span: Span,
    /// `&anchor` name.
    pub anchor: Option<String>,
    /// The tag as written (`!!str`, `!`, `!local`, `!<verbatim>`).
    pub tag: Option<String>,
    /// The content.
    pub kind: Kind,
}

#[derive(Debug, Clone)]
pub(crate) enum Kind {
    /// A scalar with its decoded text. An empty plain scalar is an empty node.
    Scalar { style: ScalarStyle, text: String },
    /// A sequence.
    Seq { flow: bool, items: Vec<Node> },
    /// A mapping (pairs in source order; duplicates are rejected at compose).
    Map {
        flow: bool,
        pairs: Vec<(Node, Node)>,
    },
    /// `*alias`.
    Alias(String),
}

impl Node {
    fn empty(at: usize) -> Node {
        Node {
            span: Span { start: at, end: at },
            anchor: None,
            tag: None,
            kind: Kind::Scalar {
                style: ScalarStyle::Plain,
                text: String::new(),
            },
        }
    }
}

/// A parsed YAML stream with at most one document.
#[derive(Debug, Clone)]
pub(crate) struct Document {
    /// The root node, or `None` for an empty document.
    pub root: Option<Node>,
}

/// Parse `src` (one document; an empty source is an empty document).
pub(crate) fn parse(src: &str) -> Result<Document, YamlError> {
    parse_with_budget(src, None)
}

pub(crate) fn parse_with_budget(
    src: &str,
    budget: Option<&mut super::budget::Budget>,
) -> Result<Document, YamlError> {
    let mut p = Parser {
        src,
        b: src.as_bytes(),
        pos: 0,
        depth: 0,
        collection_depth: 0,
        budget,
        line_bounds: Cell::new(None),
        #[cfg(test)]
        line_search_work: Cell::new(0),
    };
    let result = p.document();
    // Speculative implicit-key parsing must never swallow a resource refusal.
    if let Some(e) = p.budget.as_ref().and_then(|b| b.failure()) {
        return p.err(ErrorKind::ResourceLimit(e));
    }
    result
}

struct Parser<'a, 'b> {
    src: &'a str,
    b: &'a [u8],
    pos: usize,
    depth: u32,
    collection_depth: u32,
    budget: Option<&'b mut super::budget::Budget>,
    // One physical line, cached across all tokens and same-line lookahead.
    // Searching the entire prefix/suffix for every flow item is quadratic.
    line_bounds: Cell<Option<(usize, usize)>>,
    #[cfg(test)]
    line_search_work: Cell<usize>,
}

/// Whether `c` is a flow indicator.
fn is_flow_indicator(c: u8) -> bool {
    matches!(c, b',' | b'[' | b']' | b'{' | b'}')
}

fn is_ws(c: u8) -> bool {
    c == b' ' || c == b'\t'
}

/// Result type of the parser.
type R<T> = Result<T, YamlError>;

impl Parser<'_, '_> {
    fn collection_enter(&mut self) -> R<()> {
        self.collection_depth += 1;
        if let Some(b) = self.budget.as_mut() {
            b.depth(self.collection_depth)
                .map_err(|e| YamlError::at(self.src, self.pos, ErrorKind::ResourceLimit(e)))?;
        }
        Ok(())
    }
    fn owned_range(&mut self, start: usize, end: usize) -> R<String> {
        if let Some(b) = self.budget.as_mut() {
            b.depth(self.collection_depth + 1)
                .and_then(|()| b.owned_string(end - start))
                .map_err(|e| YamlError::at(self.src, start, ErrorKind::ResourceLimit(e)))?;
        }
        Ok(self.src[start..end].to_owned())
    }
    fn push_char(&mut self, out: &mut String, ch: char) -> R<()> {
        if let Some(b) = self.budget.as_mut() {
            b.depth(self.collection_depth + 1)
                .and_then(|()| b.reserve_string(out, ch.len_utf8()))
                .map_err(|e| YamlError::at(self.src, self.pos, ErrorKind::ResourceLimit(e)))?;
        }
        out.push(ch);
        Ok(())
    }
    fn push_str(&mut self, out: &mut String, text: &str) -> R<()> {
        if let Some(b) = self.budget.as_mut() {
            b.reserve_string(out, text.len())
                .map_err(|e| YamlError::at(self.src, self.pos, ErrorKind::ResourceLimit(e)))?;
        }
        out.push_str(text);
        Ok(())
    }
    fn reserve_slot<T>(&mut self, out: &mut Vec<T>, slot_bytes: u64) -> R<()> {
        if let Some(b) = self.budget.as_mut() {
            b.reserve_vec(out, slot_bytes)
                .map_err(|e| YamlError::at(self.src, self.pos, ErrorKind::ResourceLimit(e)))?;
        }
        Ok(())
    }
    // ------------------------------------------------------------ primitives

    fn err<T>(&self, kind: ErrorKind) -> R<T> {
        Err(YamlError::at(self.src, self.pos, kind))
    }

    fn err_at<T>(&self, pos: usize, kind: ErrorKind) -> R<T> {
        Err(YamlError::at(self.src, pos, kind))
    }

    fn ch(&self) -> Option<u8> {
        self.b.get(self.pos).copied()
    }

    fn ch_at(&self, i: usize) -> Option<u8> {
        self.b.get(i).copied()
    }

    fn eof(&self) -> bool {
        self.pos >= self.b.len()
    }

    /// A line break starts at `i` (`\n` or `\r\n`). A bare `\r` is an error
    /// raised by [`Self::check_cr`].
    fn is_break_at(&self, i: usize) -> bool {
        match self.ch_at(i) {
            Some(b'\n') => true,
            Some(b'\r') => self.ch_at(i + 1) == Some(b'\n'),
            _ => false,
        }
    }

    fn at_break(&self) -> bool {
        self.is_break_at(self.pos)
    }

    /// Whitespace, a line break or the end of input at `i`.
    fn is_blank_at(&self, i: usize) -> bool {
        match self.ch_at(i) {
            None => true,
            Some(c) => is_ws(c) || self.is_break_at(i),
        }
    }

    fn check_cr(&self) -> R<()> {
        if self.ch() == Some(b'\r') && !self.at_break() {
            return self.err(ErrorKind::BareCarriageReturn);
        }
        Ok(())
    }

    /// Consume a line break if there is one.
    fn eat_break(&mut self) -> bool {
        match self.ch() {
            Some(b'\n') => {
                self.pos += 1;
                true
            }
            Some(b'\r') if self.ch_at(self.pos + 1) == Some(b'\n') => {
                self.pos += 2;
                true
            }
            _ => false,
        }
    }

    fn physical_line(&self, pos: usize) -> (usize, usize) {
        let cached = self.line_bounds.get();
        if let Some((start, end)) = cached
            && start <= pos
            && pos <= end
        {
            return (start, end);
        }
        let from = cached
            .filter(|(_, end)| pos > *end)
            .map_or(0, |(_, end)| end + 1);
        let before = &self.b[from..pos];
        let previous = before.iter().rposition(|&c| c == b'\n');
        let start = previous.map_or(from, |i| from + i + 1);
        let after = &self.b[pos..];
        let next = after.iter().position(|&c| c == b'\n');
        let end = next.map_or(self.b.len(), |i| pos + i);
        #[cfg(test)]
        self.line_search_work.set(
            self.line_search_work.get()
                + previous.map_or(before.len(), |i| before.len() - i)
                + next.map_or(after.len(), |i| i + 1),
        );
        self.line_bounds.set(Some((start, end)));
        (start, end)
    }

    fn line_start(&self, pos: usize) -> usize {
        self.physical_line(pos).0
    }

    /// Column (in bytes) of `pos`. Indentation is ASCII spaces, so byte columns
    /// are exact where they matter.
    fn column(&self, pos: usize) -> i64 {
        i64::try_from(pos - self.line_start(pos)).unwrap_or(i64::MAX)
    }

    fn col(&self) -> i64 {
        self.column(self.pos)
    }

    /// The number of spaces at the cursor (at the start of a line: its
    /// indentation).
    fn leading_spaces(&self) -> i64 {
        let n = self.b[self.pos..]
            .iter()
            .take_while(|&&c| c == b' ')
            .count();
        i64::try_from(n).unwrap_or(i64::MAX)
    }

    fn skip_ws(&mut self) {
        while self.ch().is_some_and(is_ws) {
            self.pos += 1;
        }
    }

    fn skip_to_eol(&mut self) {
        while let Some(c) = self.ch() {
            if c == b'\n' || (c == b'\r' && self.ch_at(self.pos + 1) == Some(b'\n')) {
                break;
            }
            self.pos += 1;
        }
    }

    /// At `---` or `...` in column 0, followed by a blank.
    fn at_doc_marker(&self) -> bool {
        self.col() == 0
            && (self.b[self.pos..].starts_with(b"---") || self.b[self.pos..].starts_with(b"..."))
            && self.is_blank_at(self.pos + 3)
    }

    /// Skip whitespace, comments and line breaks up to the next content.
    ///
    /// In block context a tab in the indentation of a content line is an error
    /// (YAML forbids tab indentation). A `#` starts a comment only at the start
    /// of a line or after whitespace.
    fn skip_blank(&mut self, block: bool) -> R<()> {
        let mut line_begin = self.col() == 0;
        let mut tab_in_indent = false;
        loop {
            self.check_cr()?;
            match self.ch() {
                Some(b' ') => self.pos += 1,
                Some(b'\t') => {
                    if line_begin {
                        tab_in_indent = true;
                    }
                    self.pos += 1;
                }
                Some(b'#') => {
                    let prev_ws = self.pos == 0 || {
                        let p = self.b[self.pos - 1];
                        is_ws(p) || p == b'\n'
                    };
                    if !prev_ws {
                        return Ok(());
                    }
                    self.skip_to_eol();
                }
                _ if self.at_break() => {
                    self.eat_break();
                    line_begin = true;
                    tab_in_indent = false;
                }
                _ => {
                    if block && line_begin && tab_in_indent && !self.eof() {
                        return self.err(ErrorKind::TabIndentation);
                    }
                    return Ok(());
                }
            }
        }
    }

    fn enter(&mut self) -> R<()> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return self.err(ErrorKind::TooDeep);
        }
        Ok(())
    }

    fn leave(&mut self) {
        self.depth -= 1;
    }

    // ------------------------------------------------------------- document

    fn document(&mut self) -> R<Document> {
        self.skip_blank(true)?;
        if self.ch() == Some(b'%') && self.col() == 0 {
            return self.err(ErrorKind::Unsupported("directives"));
        }
        // `--- value`: content on the start-marker line, where (as after `key:`)
        // no block collection may begin.
        let mut same_line = false;
        if self.at_doc_marker() && self.b[self.pos] == b'-' {
            self.pos += 3;
            self.skip_ws();
            if self.ch() == Some(b'#') || self.at_break() || self.eof() {
                self.skip_blank(true)?;
            } else {
                same_line = true;
            }
        }
        let root = if self.eof() || self.at_doc_marker() {
            None
        } else {
            Some(self.block_node(-1, same_line)?)
        };
        self.skip_blank(true)?;
        if self.at_doc_marker() {
            if self.b[self.pos] == b'.' {
                self.pos += 3;
                self.skip_blank(true)?;
                if !self.eof() {
                    return self.err(ErrorKind::MultipleDocuments);
                }
            } else {
                return self.err(ErrorKind::MultipleDocuments);
            }
        }
        if !self.eof() {
            return self.err(ErrorKind::UnexpectedContent);
        }
        Ok(Document { root })
    }

    // ----------------------------------------------------------- properties

    /// Parse `&anchor` and `!tag` properties at the cursor (in any order, each at
    /// most once). Returns the start position if any were found.
    fn props(&mut self, flow: bool) -> R<(Option<String>, Option<String>, Option<usize>)> {
        let mut anchor = None;
        let mut tag = None;
        let mut first = None;
        loop {
            match self.ch() {
                Some(b'&') if anchor.is_none() => {
                    first.get_or_insert(self.pos);
                    self.pos += 1;
                    let name = self.name_token()?;
                    if name.is_empty() {
                        return self.err(ErrorKind::InvalidAnchor);
                    }
                    anchor = Some(name);
                }
                Some(b'!') if tag.is_none() => {
                    first.get_or_insert(self.pos);
                    tag = Some(self.tag_token(flow)?);
                }
                Some(b'&' | b'!') => return self.err(ErrorKind::DuplicateProperty),
                _ => break,
            }
            let before = self.pos;
            self.skip_ws();
            if self.pos == before && !self.at_break() && !self.eof() {
                return self.err(ErrorKind::UnexpectedContent);
            }
        }
        Ok((anchor, tag, first))
    }

    /// An anchor or alias name: up to a blank or flow indicator.
    fn name_token(&mut self) -> R<String> {
        let start = self.pos;
        while let Some(c) = self.ch() {
            if self.is_blank_at(self.pos) || is_flow_indicator(c) || c == b'\r' {
                break;
            }
            self.pos += char_len(c);
        }
        self.owned_range(start, self.pos)
    }

    fn tag_token(&mut self, flow: bool) -> R<String> {
        let start = self.pos;
        self.pos += 1; // '!'
        if self.ch() == Some(b'<') {
            while let Some(c) = self.ch() {
                self.pos += char_len(c);
                if c == b'>' {
                    return self.owned_range(start, self.pos);
                }
                if self.at_break() {
                    break;
                }
            }
            return self.err_at(start, ErrorKind::InvalidTag);
        }
        while let Some(c) = self.ch() {
            if self.is_blank_at(self.pos) || (flow && is_flow_indicator(c)) || c == b'\r' {
                break;
            }
            self.pos += char_len(c);
        }
        self.owned_range(start, self.pos)
    }

    fn with_props(
        node: Node,
        anchor: Option<String>,
        tag: Option<String>,
        start: Option<usize>,
    ) -> R<Node> {
        let mut node = node;
        if anchor.is_some() {
            node.anchor = anchor;
        }
        if tag.is_some() {
            node.tag = tag;
        }
        if let Some(s) = start {
            node.span.start = s.min(node.span.start);
        }
        Ok(node)
    }

    // ---------------------------------------------------------- block nodes

    /// A block node whose content starts at the cursor.
    ///
    /// `parent` is the indentation of the enclosing block collection (-1 at the
    /// top level). `after_key` means the content follows `key:` on the same line,
    /// where an inline block mapping or sequence is not allowed.
    fn block_node(&mut self, parent: i64, after_key: bool) -> R<Node> {
        self.enter()?;
        let r = self.block_node_inner(parent, after_key);
        self.leave();
        r
    }

    fn block_node_inner(&mut self, parent: i64, after_key: bool) -> R<Node> {
        let start = self.pos;
        let (anchor, tag, pstart) = self.props(false)?;
        let mut after_key = after_key;
        if pstart.is_some() && (self.at_break() || self.eof() || self.ch() == Some(b'#')) {
            // Properties alone on their line: the content is on the next lines.
            let mark = self.pos;
            self.skip_blank(true)?;
            let c = self.col();
            let compact_seq = c == parent && self.at_seq_entry();
            if self.eof() || self.at_doc_marker() || (c <= parent && !compact_seq) {
                self.pos = mark;
                let node = Node::empty(mark);
                return Self::with_props(node, anchor, tag, pstart);
            }
            after_key = false;
            if compact_seq {
                let seq = self.block_seq(c)?;
                return Self::with_props(seq, anchor, tag, pstart);
            }
        } else if pstart.is_some() {
            // Properties then content on the same line.
            if !after_key && self.implicit_key_ahead()? {
                return self.err_at(start, ErrorKind::Unsupported("properties on a mapping key"));
            }
        }
        let c = self.col();
        let node = match self.ch() {
            Some(b'-') if self.is_blank_at(self.pos + 1) => {
                if after_key {
                    return self.err(ErrorKind::SeqInInlineValue);
                }
                self.block_seq(c)?
            }
            Some(b'[' | b'{') => {
                let node = self.flow_collection(parent)?;
                self.reject_complex_key()?;
                node
            }
            Some(b'|' | b'>') => self.block_scalar(parent)?,
            Some(b'*') => {
                let node = self.alias()?;
                self.reject_complex_key()?;
                node
            }
            Some(b'?') if self.is_blank_at(self.pos + 1) => {
                return self.err(ErrorKind::Unsupported("explicit keys (`? `)"));
            }
            Some(b':') if self.is_blank_at(self.pos + 1) => {
                return self.err(ErrorKind::Unsupported("empty mapping keys"));
            }
            Some(_) => {
                if let Some(key) = self.implicit_key()? {
                    if after_key {
                        return self.err_at(key.span.start, ErrorKind::MapInInlineValue);
                    }
                    self.block_map(c, key)?
                } else {
                    self.block_scalar_or_plain(parent)?
                }
            }
            None => Node::empty(self.pos),
        };
        Self::with_props(node, anchor, tag, pstart)
    }

    fn at_seq_entry(&self) -> bool {
        self.ch() == Some(b'-') && self.is_blank_at(self.pos + 1)
    }

    /// After a flow collection or alias in block context: `[a]: b` would make it a
    /// mapping key, which the profile does not support.
    fn reject_complex_key(&mut self) -> R<()> {
        let save = self.pos;
        self.skip_ws();
        if self.ch() == Some(b':') && self.is_blank_at(self.pos + 1) {
            return self.err(ErrorKind::Unsupported("collection or alias mapping keys"));
        }
        self.pos = save;
        Ok(())
    }

    /// Whether an implicit key starts at the cursor (without consuming it).
    fn implicit_key_ahead(&mut self) -> R<bool> {
        let save = self.pos;
        let r = self.implicit_key();
        self.pos = save;
        Ok(r?.is_some())
    }

    /// Try to read an implicit key (a single-line scalar followed by `:` and a
    /// blank). On success the cursor is just after the `:`; otherwise it is
    /// restored.
    fn implicit_key(&mut self) -> R<Option<Node>> {
        let save = self.pos;
        let line_end = self.line_end(self.pos);
        let key = match self.ch() {
            Some(b'"') | Some(b'\'') => {
                let node = match self.quoted(-1, false) {
                    Ok(n) => n,
                    Err(_) => {
                        self.pos = save;
                        return Ok(None);
                    }
                };
                if node.span.end > line_end {
                    self.pos = save;
                    return Ok(None);
                }
                node
            }
            Some(c) if self.plain_can_start(c, false) => {
                let (text, end) = self.plain_line_segment(false)?;
                if text.is_empty() {
                    self.pos = save;
                    return Ok(None);
                }
                Node {
                    span: Span { start: save, end },
                    anchor: None,
                    tag: None,
                    kind: Kind::Scalar {
                        style: ScalarStyle::Plain,
                        text,
                    },
                }
            }
            _ => return Ok(None),
        };
        self.skip_ws();
        if self.ch() == Some(b':') && self.is_blank_at(self.pos + 1) {
            self.pos += 1;
            Ok(Some(key))
        } else {
            self.pos = save;
            Ok(None)
        }
    }

    fn line_end(&self, pos: usize) -> usize {
        self.physical_line(pos).1
    }

    /// A block mapping at column `col` whose first key has been read.
    fn block_map(&mut self, col: i64, first_key: Node) -> R<Node> {
        self.collection_enter()?;
        let start = first_key.span.start;
        let mut pairs = Vec::new();
        let mut key = first_key;
        loop {
            let value = self.block_value(col)?;
            self.reserve_slot(&mut pairs, 256)?;
            pairs.push((key, value));
            let after = self.pos;
            self.skip_blank(true)?;
            if self.eof() || self.at_doc_marker() {
                self.pos = after;
                break;
            }
            let c = self.col();
            if c < col {
                break;
            }
            if c > col {
                return self.err(ErrorKind::BadIndentation);
            }
            if self.at_seq_entry() {
                return self.err(ErrorKind::ExpectedKey);
            }
            if self.ch() == Some(b'?') && self.is_blank_at(self.pos + 1) {
                return self.err(ErrorKind::Unsupported("explicit keys (`? `)"));
            }
            if matches!(self.ch(), Some(b'&' | b'!')) {
                return self.err(ErrorKind::Unsupported("properties on a mapping key"));
            }
            if matches!(self.ch(), Some(b'[' | b'{' | b'*')) {
                return self.err(ErrorKind::Unsupported("collection or alias mapping keys"));
            }
            match self.implicit_key()? {
                Some(k) => key = k,
                None => return self.err(ErrorKind::ExpectedKey),
            }
        }
        self.collection_depth -= 1;
        let end = pairs
            .last()
            .map_or(start, |(k, v)| v.span.end.max(k.span.end + 1));
        Ok(Node {
            span: Span { start, end },
            anchor: None,
            tag: None,
            kind: Kind::Map { flow: false, pairs },
        })
    }

    /// The value after `key:` of a block mapping at column `col`.
    fn block_value(&mut self, col: i64) -> R<Node> {
        self.skip_ws();
        self.check_cr()?;
        if self.at_break() || self.eof() || self.ch() == Some(b'#') {
            let mark = self.pos;
            self.skip_blank(true)?;
            if self.eof() || self.at_doc_marker() {
                self.pos = mark;
                return Ok(Node::empty(mark));
            }
            let c = self.col();
            if c > col {
                return self.block_node(col, false);
            }
            if c == col && self.at_seq_entry() {
                return self.block_seq(c);
            }
            self.pos = mark;
            return Ok(Node::empty(mark));
        }
        self.block_node(col, true)
    }

    /// A block sequence whose first `-` is at the cursor, in column `col`.
    fn block_seq(&mut self, col: i64) -> R<Node> {
        self.collection_enter()?;
        self.enter()?;
        let start = self.pos;
        let mut items = Vec::new();
        loop {
            let dash = self.pos;
            self.pos += 1; // '-'
            self.skip_ws();
            self.check_cr()?;
            let item = if self.at_break() || self.eof() || self.ch() == Some(b'#') {
                let mark = self.pos;
                self.skip_blank(true)?;
                if !self.eof() && !self.at_doc_marker() && self.col() > col {
                    self.block_node(col, false)?
                } else {
                    self.pos = mark;
                    Node::empty(dash + 1)
                }
            } else {
                self.block_node(col, false)?
            };
            self.reserve_slot(&mut items, 128)?;
            items.push(item);
            let after = self.pos;
            self.skip_blank(true)?;
            if self.eof() || self.at_doc_marker() {
                self.pos = after;
                break;
            }
            let c = self.col();
            if c < col {
                break;
            }
            if c > col {
                return self.err(ErrorKind::BadIndentation);
            }
            if !self.at_seq_entry() {
                // Same column, not an entry: belongs to the parent mapping.
                break;
            }
        }
        self.leave();
        self.collection_depth -= 1;
        let end = items
            .last()
            .map_or(start + 1, |n| n.span.end.max(start + 1));
        Ok(Node {
            span: Span { start, end },
            anchor: None,
            tag: None,
            kind: Kind::Seq { flow: false, items },
        })
    }

    fn alias(&mut self) -> R<Node> {
        let start = self.pos;
        self.pos += 1;
        let name = self.name_token()?;
        if name.is_empty() {
            return self.err_at(start, ErrorKind::InvalidAnchor);
        }
        Ok(Node {
            span: Span {
                start,
                end: self.pos,
            },
            anchor: None,
            tag: None,
            kind: Kind::Alias(name),
        })
    }

    fn block_scalar_or_plain(&mut self, parent: i64) -> R<Node> {
        match self.ch() {
            Some(b'"' | b'\'') => {
                let node = self.quoted(parent, false)?;
                // Anything after the closing quote on the same line must be a comment.
                self.skip_ws();
                if !(self.at_break() || self.eof() || self.ch() == Some(b'#')) {
                    return self.err(ErrorKind::UnexpectedContent);
                }
                Ok(node)
            }
            Some(c) if self.plain_can_start(c, false) => self.plain(parent, false),
            _ => self.err(ErrorKind::UnexpectedCharacter),
        }
    }

    // -------------------------------------------------------- plain scalars

    /// ns-plain-first: whether a plain scalar may start with `c` at the cursor.
    fn plain_can_start(&self, c: u8, flow: bool) -> bool {
        match c {
            b'-' | b'?' | b':' => {
                let next = self.ch_at(self.pos + 1);
                match next {
                    None => false,
                    Some(n) => !(self.is_blank_at(self.pos + 1) || flow && is_flow_indicator(n)),
                }
            }
            b',' | b'[' | b']' | b'{' | b'}' | b'#' | b'&' | b'*' | b'!' | b'|' | b'>' | b'\''
            | b'"' | b'%' | b'@' | b'`' => false,
            b'\r' | b'\n' | b' ' | b'\t' => false,
            _ => true,
        }
    }

    /// One line of a plain scalar from the cursor: stops at a line break, at `:`
    /// followed by a blank (or a flow indicator in flow context), at ` #`, and in
    /// flow context at a flow indicator. Returns the trimmed text and the byte
    /// position after its last non-blank character. The cursor stops at the
    /// terminator (trailing whitespace is consumed).
    fn plain_line_segment(&mut self, flow: bool) -> R<(String, usize)> {
        let start = self.pos;
        let mut end = self.pos;
        while let Some(c) = self.ch() {
            if self.at_break() || c == b'\r' {
                break;
            }
            if c == b':' {
                let next_blank = self.is_blank_at(self.pos + 1);
                let next_flow = flow && self.ch_at(self.pos + 1).is_some_and(is_flow_indicator);
                if next_blank || next_flow {
                    break;
                }
            }
            if flow && is_flow_indicator(c) {
                break;
            }
            if is_ws(c) {
                // Whitespace: part of the scalar only if non-blank text follows
                // that is not a comment.
                let mut j = self.pos;
                while self.ch_at(j).is_some_and(is_ws) {
                    j += 1;
                }
                if self.ch_at(j) == Some(b'#') || self.is_break_at(j) || self.ch_at(j).is_none() {
                    self.pos = j;
                    break;
                }
                self.pos = j;
                continue;
            }
            self.pos += char_len(c);
            end = self.pos;
        }
        Ok((self.owned_range(start, end)?, end))
    }

    /// A plain scalar, possibly over several lines (folded).
    fn plain(&mut self, parent: i64, flow: bool) -> R<Node> {
        let start = self.pos;
        let (first, mut end) = self.plain_line_segment(flow)?;
        let mut text = first;
        loop {
            // Stopped at a comment: the scalar ends.
            if self.ch() == Some(b'#') {
                break;
            }
            if !flow && self.ch() == Some(b':') {
                // `a: b: c` or a continuation line with a key.
                return self.err(ErrorKind::MapInInlineValue);
            }
            if !self.at_break() {
                break;
            }
            // Look ahead over empty lines to the next content line.
            let save = self.pos;
            let mut empties = 0u32;
            self.eat_break();
            loop {
                let ls = self.pos;
                self.skip_ws();
                if self.at_break() {
                    self.eat_break();
                    empties += 1;
                    continue;
                }
                let indent_ok = !self.b[ls..self.pos].contains(&b'\t') || flow;
                let c = self.ch();
                let ind = i64::try_from(self.pos - ls).unwrap_or(i64::MAX);
                let continues = match c {
                    None => false,
                    Some(b'#') => false,
                    Some(ch) => {
                        let marker = ind == 0 && {
                            let p = self.pos;
                            (self.b[p..].starts_with(b"---") || self.b[p..].starts_with(b"..."))
                                && self.is_blank_at(p + 3)
                        };
                        if marker {
                            false
                        } else if flow {
                            ind > parent
                                && !(is_flow_indicator(ch)
                                    || (ch == b':'
                                        && (self.is_blank_at(self.pos + 1)
                                            || self
                                                .ch_at(self.pos + 1)
                                                .is_some_and(is_flow_indicator))))
                        } else {
                            ind > parent && indent_ok
                        }
                    }
                };
                if !continues {
                    self.pos = save;
                    return Ok(Self::plain_node(start, end, text));
                }
                break;
            }
            let (seg, seg_end) = self.plain_line_segment(flow)?;
            if seg.is_empty() {
                // e.g. a line holding only `:` in flow context; leave it.
                self.pos = save;
                break;
            }
            if empties == 0 {
                self.push_char(&mut text, ' ')?;
            } else {
                for _ in 0..empties {
                    self.push_char(&mut text, '\n')?;
                }
            }
            self.push_str(&mut text, &seg)?;
            end = seg_end;
        }
        Ok(Self::plain_node(start, end, text))
    }

    fn plain_node(start: usize, end: usize, text: String) -> Node {
        Node {
            span: Span { start, end },
            anchor: None,
            tag: None,
            kind: Kind::Scalar {
                style: ScalarStyle::Plain,
                text,
            },
        }
    }

    // ------------------------------------------------------- quoted scalars

    /// A single- or double-quoted scalar starting at the cursor.
    fn quoted(&mut self, parent: i64, _flow: bool) -> R<Node> {
        let start = self.pos;
        let q = self.b[self.pos];
        let double = q == b'"';
        self.pos += 1;
        let mut text = String::new();
        // Length of `text` before the current run of unescaped trailing whitespace.
        let mut keep_len = 0usize;
        loop {
            self.check_cr()?;
            let Some(c) = self.ch() else {
                return self.err_at(start, ErrorKind::UnterminatedQuoted);
            };
            if self.at_break() {
                // Fold: drop trailing unescaped whitespace, count empty lines.
                text.truncate(keep_len);
                self.eat_break();
                let mut empties = 0u32;
                loop {
                    // At the start of a line: a document marker cannot be inside
                    // a quoted scalar.
                    if self.at_doc_marker() {
                        return self.err_at(start, ErrorKind::UnterminatedQuoted);
                    }
                    let spaces = self.leading_spaces();
                    self.skip_ws();
                    self.check_cr()?;
                    if self.at_break() {
                        self.eat_break();
                        empties += 1;
                        continue;
                    }
                    if self.eof() {
                        return self.err_at(start, ErrorKind::UnterminatedQuoted);
                    }
                    if spaces <= parent {
                        return self.err(ErrorKind::BadIndentation);
                    }
                    break;
                }
                if self.eof() {
                    return self.err_at(start, ErrorKind::UnterminatedQuoted);
                }
                if empties == 0 {
                    self.push_char(&mut text, ' ')?;
                } else {
                    for _ in 0..empties {
                        self.push_char(&mut text, '\n')?;
                    }
                }
                keep_len = text.len();
                continue;
            }
            if c == q {
                if !double && self.ch_at(self.pos + 1) == Some(b'\'') {
                    self.push_char(&mut text, '\'')?;
                    self.pos += 2;
                    keep_len = text.len();
                    continue;
                }
                self.pos += 1;
                break;
            }
            if double && c == b'\\' {
                self.pos += 1;
                if self.at_break() {
                    // Escaped line break: join without a space (whitespace before
                    // the `\` is kept), skip leading whitespace, and keep one
                    // newline per empty line.
                    self.eat_break();
                    loop {
                        if self.at_doc_marker() {
                            return self.err_at(start, ErrorKind::UnterminatedQuoted);
                        }
                        let spaces = self.leading_spaces();
                        self.skip_ws();
                        self.check_cr()?;
                        if self.at_break() {
                            self.eat_break();
                            self.push_char(&mut text, '\n')?;
                            continue;
                        }
                        if self.eof() {
                            return self.err_at(start, ErrorKind::UnterminatedQuoted);
                        }
                        if spaces <= parent {
                            return self.err(ErrorKind::BadIndentation);
                        }
                        break;
                    }
                    keep_len = text.len();
                    continue;
                }
                self.escape(&mut text)?;
                keep_len = text.len();
                continue;
            }
            let ch = self.next_char();
            self.push_char(&mut text, ch)?;
            if !is_ws(c) {
                keep_len = text.len();
            }
        }
        Ok(Node {
            span: Span {
                start,
                end: self.pos,
            },
            anchor: None,
            tag: None,
            kind: Kind::Scalar {
                style: if double {
                    ScalarStyle::DoubleQuoted
                } else {
                    ScalarStyle::SingleQuoted
                },
                text,
            },
        })
    }

    fn next_char(&mut self) -> char {
        let c = self.src[self.pos..].chars().next().unwrap_or('\u{FFFD}');
        self.pos += c.len_utf8();
        c
    }

    /// One escape after `\` in a double-quoted scalar.
    fn escape(&mut self, out: &mut String) -> R<()> {
        let at = self.pos - 1;
        let Some(c) = self.ch() else {
            return self.err_at(at, ErrorKind::InvalidEscape);
        };
        self.pos += 1;
        let simple = match c {
            b'0' => Some('\0'),
            b'a' => Some('\u{7}'),
            b'b' => Some('\u{8}'),
            b't' | b'\t' => Some('\t'),
            b'n' => Some('\n'),
            b'v' => Some('\u{b}'),
            b'f' => Some('\u{c}'),
            b'r' => Some('\r'),
            b'e' => Some('\u{1b}'),
            b' ' => Some(' '),
            b'"' => Some('"'),
            b'/' => Some('/'),
            b'\\' => Some('\\'),
            b'N' => Some('\u{85}'),
            b'_' => Some('\u{a0}'),
            b'L' => Some('\u{2028}'),
            b'P' => Some('\u{2029}'),
            _ => None,
        };
        if let Some(ch) = simple {
            self.push_char(out, ch)?;
            return Ok(());
        }
        let digits = match c {
            b'x' => 2,
            b'u' => 4,
            b'U' => 8,
            _ => return self.err_at(at, ErrorKind::InvalidEscape),
        };
        let hex = self
            .src
            .get(self.pos..self.pos + digits)
            .filter(|h| h.bytes().all(|b| b.is_ascii_hexdigit()));
        let Some(hex) = hex else {
            return self.err_at(at, ErrorKind::InvalidEscape);
        };
        let code = u32::from_str_radix(hex, 16).unwrap_or(u32::MAX);
        let Some(ch) = char::from_u32(code) else {
            return self.err_at(at, ErrorKind::InvalidEscape);
        };
        self.pos += digits;
        self.push_char(out, ch)?;
        Ok(())
    }

    // -------------------------------------------------------- block scalars

    /// A `|` or `>` block scalar at the cursor. `parent` is the indentation of the
    /// enclosing block collection (-1 at the top level).
    fn block_scalar(&mut self, parent: i64) -> R<Node> {
        let start = self.pos;
        let literal = self.b[self.pos] == b'|';
        self.pos += 1;
        let mut indent_ind: Option<i64> = None;
        let mut chomp = Chomp::Clip;
        for _ in 0..2 {
            match self.ch() {
                Some(d @ b'1'..=b'9') if indent_ind.is_none() => {
                    indent_ind = Some(i64::from(d - b'0'));
                    self.pos += 1;
                }
                Some(b'-') if chomp == Chomp::Clip => {
                    chomp = Chomp::Strip;
                    self.pos += 1;
                }
                Some(b'+') if chomp == Chomp::Clip => {
                    chomp = Chomp::Keep;
                    self.pos += 1;
                }
                _ => break,
            }
        }
        let header_end = self.pos;
        self.skip_ws();
        if self.ch() == Some(b'#') {
            if self.pos == header_end {
                return self.err(ErrorKind::InvalidBlockScalarHeader);
            }
            self.skip_to_eol();
        }
        self.check_cr()?;
        if !(self.at_break() || self.eof()) {
            return self.err(ErrorKind::InvalidBlockScalarHeader);
        }
        self.eat_break();
        let body_start = self.pos;

        let indent = match indent_ind {
            Some(m) => parent.max(0) + m,
            None => self.detect_block_indent(parent)?,
        };

        // Collect the lines of the scalar.
        let mut lines: Vec<BlockLine> = Vec::new();
        while !self.eof() {
            let ls = self.pos;
            if self.at_doc_marker() {
                break;
            }
            let mut p = ls;
            while self.ch_at(p) == Some(b' ') && i64::try_from(p - ls).unwrap_or(i64::MAX) < indent
            {
                p += 1;
            }
            let sp = i64::try_from(p - ls).unwrap_or(i64::MAX);
            if sp < indent || self.is_break_at(p) || self.ch_at(p).is_none() {
                // Up to the indentation and nothing else: an empty line. Fewer
                // spaces followed by content: the end of the scalar.
                let mut q = p;
                while self.ch_at(q) == Some(b' ') {
                    q += 1;
                }
                if !(self.is_break_at(q) || self.ch_at(q).is_none()) {
                    break;
                }
                self.pos = q;
                self.check_cr()?;
                let had_break = self.eat_break();
                self.reserve_slot(&mut lines, 64)?;
                lines.push(BlockLine {
                    text: String::new(),
                    empty: true,
                    had_break,
                    end: self.pos,
                });
                continue;
            }
            self.pos = p;
            let cs = self.pos;
            self.skip_to_eol();
            self.check_cr()?;
            let text = self.owned_range(cs, self.pos)?;
            let had_break = self.eat_break();
            self.reserve_slot(&mut lines, 64)?;
            lines.push(BlockLine {
                text,
                empty: false,
                had_break,
                end: self.pos,
            });
        }

        let last_content = lines.iter().rposition(|l| !l.empty);
        let mut value = String::new();
        if let Some(l) = last_content {
            let content = &lines[..=l];
            if literal {
                for (i, line) in content.iter().enumerate() {
                    if i > 0 {
                        self.push_char(&mut value, '\n')?;
                    }
                    self.push_str(&mut value, &line.text)?;
                }
            } else {
                fold_lines(content, &mut value, self)?;
            }
        }
        let trailing = &lines[last_content.map_or(0, |l| l + 1)..];
        let last_had_break = last_content.is_some_and(|l| lines[l].had_break);
        if chomp != Chomp::Strip && last_had_break {
            self.push_char(&mut value, '\n')?;
        }
        if chomp == Chomp::Keep {
            for line in trailing {
                if line.had_break {
                    self.push_char(&mut value, '\n')?;
                }
            }
        }
        // The node ends after its last content line (or, when kept, after the
        // trailing empty lines). Trailing empty lines that are not kept lie
        // between this node and the next one.
        let end = match (chomp, last_content) {
            (Chomp::Keep, _) => lines.last().map_or(body_start, |l| l.end),
            (_, Some(l)) => lines[l].end,
            (_, None) => body_start,
        };
        if chomp != Chomp::Keep {
            // Leave the cursor at the end of the node so that following empty
            // lines are seen by the caller as blank lines.
            self.pos = end;
        }
        Ok(Node {
            span: Span { start, end },
            anchor: None,
            tag: None,
            kind: Kind::Scalar {
                style: if literal {
                    ScalarStyle::Literal
                } else {
                    ScalarStyle::Folded
                },
                text: value,
            },
        })
    }

    /// Auto-detect a block scalar's content indentation: the indentation of its
    /// first non-empty line. An all-space leading line longer than that is an
    /// error (YAML 1.2 §8.1.1.1). Without content lines the scalar is empty.
    fn detect_block_indent(&self, parent: i64) -> R<i64> {
        let mut p = self.pos;
        let mut max_empty = 0i64;
        loop {
            let ls = p;
            while self.ch_at(p) == Some(b' ') {
                p += 1;
            }
            let sp = i64::try_from(p - ls).unwrap_or(i64::MAX);
            if self.is_break_at(p) {
                max_empty = max_empty.max(sp);
                p += if self.ch_at(p) == Some(b'\r') { 2 } else { 1 };
                continue;
            }
            if self.ch_at(p).is_none() || sp <= parent {
                // No content lines: the indentation is that of the longest empty
                // line (YAML 1.2 §8.1.1.1), so those lines are all empty.
                return Ok((parent + 1).max(max_empty));
            }
            if max_empty > sp {
                return self.err_at(ls, ErrorKind::BadIndentation);
            }
            return Ok(sp);
        }
    }

    // --------------------------------------------------------- flow context

    /// Skip blanks inside a flow collection nested in a block collection at
    /// indentation `parent`: continuation lines must be indented more than the
    /// parent (a line starting with the closing bracket is accepted too).
    fn skip_flow_blank(&mut self, parent: i64) -> R<()> {
        let line_before = self.line_start(self.pos);
        self.skip_blank(false)?;
        if self.at_doc_marker() {
            return self.err(ErrorKind::UnterminatedFlow);
        }
        if !self.eof() && self.line_start(self.pos) != line_before {
            let ls = self.line_start(self.pos);
            let spaces = i64::try_from(self.b[ls..].iter().take_while(|&&c| c == b' ').count())
                .unwrap_or(i64::MAX);
            if spaces <= parent && !matches!(self.ch(), Some(b']' | b'}')) {
                return self.err(ErrorKind::BadIndentation);
            }
        }
        Ok(())
    }

    /// `[ ... ]` or `{ ... }` at the cursor.
    fn flow_collection(&mut self, parent: i64) -> R<Node> {
        self.collection_enter()?;
        self.enter()?;
        let r = if self.b[self.pos] == b'[' {
            self.flow_seq(parent)
        } else {
            self.flow_map(parent)
        };
        self.leave();
        self.collection_depth -= 1;
        r
    }

    fn flow_seq(&mut self, parent: i64) -> R<Node> {
        let start = self.pos;
        self.pos += 1;
        let mut items = Vec::new();
        loop {
            self.skip_flow_blank(parent)?;
            match self.ch() {
                None => return self.err_at(start, ErrorKind::UnterminatedFlow),
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                Some(b'?') if self.is_blank_at(self.pos + 1) => {
                    return self.err(ErrorKind::Unsupported("explicit keys (`? `)"));
                }
                _ => {}
            }
            let item = self.flow_node(parent)?;
            self.skip_flow_blank(parent)?;
            let item = if self.ch() == Some(b':') && self.flow_value_indicator(&item) {
                // A single-pair mapping inside a sequence: `[a: 1]`.
                self.collection_enter()?;
                self.pos += 1;
                self.skip_flow_blank(parent)?;
                let value = if matches!(self.ch(), Some(b',' | b']')) {
                    Node::empty(self.pos)
                } else {
                    self.flow_node(parent)?
                };
                let span = Span {
                    start: item.span.start,
                    end: value.span.end.max(item.span.end + 1),
                };
                self.skip_flow_blank(parent)?;
                self.collection_depth -= 1;
                let mut pairs = Vec::new();
                self.reserve_slot(&mut pairs, 256)?;
                pairs.push((item, value));
                Node {
                    span,
                    anchor: None,
                    tag: None,
                    kind: Kind::Map { flow: true, pairs },
                }
            } else {
                item
            };
            self.reserve_slot(&mut items, 128)?;
            items.push(item);
            match self.ch() {
                Some(b',') => self.pos += 1,
                Some(b']') => {
                    self.pos += 1;
                    break;
                }
                None => return self.err_at(start, ErrorKind::UnterminatedFlow),
                _ => return self.err(ErrorKind::ExpectedFlowSeparator),
            }
        }
        Ok(Node {
            span: Span {
                start,
                end: self.pos,
            },
            anchor: None,
            tag: None,
            kind: Kind::Seq { flow: true, items },
        })
    }

    /// Whether the `:` at the cursor, after `key` in flow context, is a value
    /// indicator: followed by a blank or flow indicator, or directly after a
    /// quoted key (JSON-like `"a":1`).
    fn flow_value_indicator(&self, key: &Node) -> bool {
        let next = self.ch_at(self.pos + 1);
        let json_like = matches!(
            &key.kind,
            Kind::Scalar {
                style: ScalarStyle::SingleQuoted | ScalarStyle::DoubleQuoted,
                ..
            } | Kind::Seq { flow: true, .. }
                | Kind::Map { flow: true, .. }
        ) && key.span.end == self.pos;
        json_like || self.is_blank_at(self.pos + 1) || next.is_some_and(is_flow_indicator)
    }

    fn flow_map(&mut self, parent: i64) -> R<Node> {
        let start = self.pos;
        self.pos += 1;
        let mut pairs = Vec::new();
        loop {
            self.skip_flow_blank(parent)?;
            match self.ch() {
                None => return self.err_at(start, ErrorKind::UnterminatedFlow),
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                Some(b'?') if self.is_blank_at(self.pos + 1) => {
                    return self.err(ErrorKind::Unsupported("explicit keys (`? `)"));
                }
                Some(b':')
                    if self.is_blank_at(self.pos + 1)
                        || self.ch_at(self.pos + 1).is_some_and(is_flow_indicator) =>
                {
                    return self.err(ErrorKind::Unsupported("empty mapping keys"));
                }
                _ => {}
            }
            let key = self.flow_node(parent)?;
            self.skip_flow_blank(parent)?;
            let value = if self.ch() == Some(b':') && self.flow_value_indicator(&key) {
                self.pos += 1;
                self.skip_flow_blank(parent)?;
                if matches!(self.ch(), Some(b',' | b'}')) {
                    Node::empty(self.pos)
                } else {
                    let v = self.flow_node(parent)?;
                    self.skip_flow_blank(parent)?;
                    v
                }
            } else {
                Node::empty(key.span.end)
            };
            self.reserve_slot(&mut pairs, 256)?;
            pairs.push((key, value));
            match self.ch() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    break;
                }
                None => return self.err_at(start, ErrorKind::UnterminatedFlow),
                _ => return self.err(ErrorKind::ExpectedFlowSeparator),
            }
        }
        Ok(Node {
            span: Span {
                start,
                end: self.pos,
            },
            anchor: None,
            tag: None,
            kind: Kind::Map { flow: true, pairs },
        })
    }

    /// A node inside a flow collection.
    fn flow_node(&mut self, parent: i64) -> R<Node> {
        self.enter()?;
        let r = self.flow_node_inner(parent);
        self.leave();
        r
    }

    fn flow_node_inner(&mut self, parent: i64) -> R<Node> {
        let (anchor, tag, pstart) = self.props(true)?;
        if pstart.is_some() {
            self.skip_flow_blank(parent)?;
        }
        let node = match self.ch() {
            Some(b'[' | b'{') => self.flow_collection(parent)?,
            Some(b'*') => self.alias()?,
            Some(b'"' | b'\'') => self.quoted(parent, true)?,
            Some(b'|' | b'>') => {
                return self.err(ErrorKind::Unsupported(
                    "block scalars inside flow collections",
                ));
            }
            Some(c) if self.plain_can_start(c, true) => self.plain(parent, true)?,
            Some(b',' | b']' | b'}' | b':') if pstart.is_some() => Node::empty(self.pos),
            None => return self.err(ErrorKind::UnterminatedFlow),
            _ => return self.err(ErrorKind::UnexpectedCharacter),
        };
        Self::with_props(node, anchor, tag, pstart)
    }
}

#[cfg(test)]
mod line_cache_tests {
    use super::*;
    #[test]
    fn line_bounds_preserve_crlf_unicode_and_backward_lookahead() {
        let source = "é: one\r\nsecond: two\n\nlast";
        let parser = Parser {
            src: source,
            b: source.as_bytes(),
            pos: 0,
            depth: 0,
            collection_depth: 0,
            budget: None,
            line_bounds: Cell::new(None),
            line_search_work: Cell::new(0),
        };
        for pos in (0..=source.len())
            .chain((0..=source.len()).rev())
            .chain(0..=source.len())
        {
            let start = source.as_bytes()[..pos]
                .iter()
                .rposition(|&c| c == b'\n')
                .map_or(0, |i| i + 1);
            let end = source.as_bytes()[pos..]
                .iter()
                .position(|&c| c == b'\n')
                .map_or(source.len(), |i| pos + i);
            assert_eq!(parser.physical_line(pos), (start, end), "position {pos}");
        }
    }
    #[test]
    fn flow_line_search_work_is_linear_with_same_line_lookahead() {
        for n in [100, 1000, 5000] {
            for separator in [",", ",\n "] {
                let source = format!("[{}]", vec!["1"; n].join(separator));
                let mut parser = Parser {
                    src: &source,
                    b: source.as_bytes(),
                    pos: 0,
                    depth: 0,
                    collection_depth: 0,
                    budget: None,
                    line_bounds: Cell::new(None),
                    line_search_work: Cell::new(0),
                };
                parser.document().unwrap();
                assert!(
                    parser.line_search_work.get() <= source.len() * 4,
                    "n={n} work={} bytes={}",
                    parser.line_search_work.get(),
                    source.len()
                );
            }
        }
    }
}

/// Byte length of the UTF-8 sequence starting with `lead`.
fn char_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// Block scalar chomping indicator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chomp {
    Strip,
    Clip,
    Keep,
}

/// One line of a block scalar, with its indentation removed.
struct BlockLine {
    text: String,
    /// Only spaces (up to the indentation).
    empty: bool,
    /// Ended with a line break (not the end of input).
    had_break: bool,
    /// Byte position after the line and its break.
    end: usize,
}

/// Fold the content lines of a `>` scalar (YAML 1.2 §8.1.3).
///
/// A line break between two normal lines becomes a space; with `k` empty lines
/// between them it becomes `k` newlines. Around "more-indented" lines (starting
/// with a space or tab) line breaks are kept.
fn fold_lines(lines: &[BlockLine], out: &mut String, parser: &mut Parser<'_, '_>) -> R<()> {
    #[derive(PartialEq, Clone, Copy)]
    enum K {
        Normal,
        More,
    }
    let mut prev: Option<K> = None;
    let mut empties = 0usize;
    for line in lines {
        if line.empty {
            empties += 1;
            continue;
        }
        let kind = if line.text.starts_with([' ', '\t']) {
            K::More
        } else {
            K::Normal
        };
        match prev {
            None => {
                for _ in 0..empties {
                    parser.push_char(out, '\n')?;
                }
            }
            Some(K::Normal) if kind == K::Normal => {
                if empties == 0 {
                    parser.push_char(out, ' ')?;
                } else {
                    for _ in 0..empties {
                        parser.push_char(out, '\n')?;
                    }
                }
            }
            Some(_) => {
                for _ in 0..=empties {
                    parser.push_char(out, '\n')?;
                }
            }
        }
        parser.push_str(out, &line.text)?;
        prev = Some(kind);
        empties = 0;
    }
    Ok(())
}

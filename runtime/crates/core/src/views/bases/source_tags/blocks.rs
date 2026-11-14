//! Block containers for the tag scan: block quotes, list items and the code
//! blocks they hold. The model follows CommonMark's container matching where
//! Obsidian 1.12.7 was observed to agree, and gives up where Obsidian was seen
//! to differ or the structure is not modelled: lazy lines after code in an
//! item, empty items, tabs split across a container edge or after other
//! indentation, whitespace lines holding a tab, containers after a task
//! checkbox, and four-column indents in `1.` items. After giving up on a
//! paragraph or container, the caller's line checks take over until a
//! non-indented line after a blank line, where every container has closed.
//! After giving up inside a fence, they take over for the rest of the text.
use super::{Unsure, checkbox};
const MAX_DEPTH: usize = 32;
#[derive(Clone, Copy)]
enum Container {
    Quote,
    /// `width` columns continue the item.
    Item {
        width: usize,
        dotted: bool,
    },
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Leaf {
    /// Nothing an indented line could continue.
    Closed,
    Paragraph,
    /// A line that may or may not leave a paragraph open.
    Unknown,
    Fence {
        marker: u8,
        count: usize,
    },
    Indented,
}
pub(super) enum Line {
    /// The whole line is code.
    Code,
    Text(Unsure),
    /// Not modelled. With `rest`, a fenced block the model lost may still be
    /// open: no later text is settled, and none may be skipped as code.
    Fallback {
        rest: bool,
    },
}
pub(super) struct Blocks {
    stack: Vec<Container>,
    leaf: Leaf,
    /// Set once the model gives up, to the `rest` it reported.
    lost: Option<bool>,
    after_blank: bool,
}
impl Default for Blocks {
    fn default() -> Self {
        Self {
            stack: Vec::new(),
            leaf: Leaf::Closed,
            lost: None,
            after_blank: false,
        }
    }
}
impl Blocks {
    /// Classify the next line, without its `\n`.
    pub(super) fn line(&mut self, line: &str) -> Line {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let blank = is_blank(line);
        // Obsidian does not read a whitespace line with a tab as blank.
        let tabbed = blank && line.contains('\t');
        if let Some(rest) = self.lost {
            // A lost fence may close anywhere, so only a lost paragraph or
            // container is known to end.
            if rest || !(self.after_blank && !blank && !line.starts_with([' ', '\t'])) {
                self.after_blank = blank && !tabbed;
                return Line::Fallback { rest };
            }
            *self = Self::default();
        }
        self.after_blank = blank && !tabbed;
        let fence = match self.leaf {
            Leaf::Fence { marker, .. } => Some(marker),
            _ => None,
        };
        // Obsidian measures a tab after anything but tabs its own way. Inside
        // a fence with no container, only a closing fence would depend on it.
        let odd = match fence {
            Some(marker) if self.stack.is_empty() => {
                let text = line.trim_start_matches([' ', '\t']);
                text.as_bytes().first() == Some(&marker)
                    && line[..line.len() - text.len()]
                        .trim_start_matches('\t')
                        .contains('\t')
            }
            // Code continues over such a line whether or not it is blank.
            _ if tabbed => {
                !(self.stack.is_empty() && matches!(self.leaf, Leaf::Fence { .. } | Leaf::Indented))
            }
            _ => !blank && odd_tab(line),
        };
        let result = if odd {
            Line::Fallback { rest: false }
        } else {
            self.classify(Cursor::new(line))
        };
        match result {
            Line::Fallback { rest } => {
                // The caller cannot tell where a fence it did not see ends.
                let rest = rest || fence.is_some();
                self.lost = Some(rest);
                Line::Fallback { rest }
            }
            result => result,
        }
    }
    fn classify(&mut self, mut c: Cursor<'_>) -> Line {
        let mut matched = 0;
        // Containers closed by this line: Obsidian may still continue them.
        let mut closed = false;
        while let Some(container) = self.stack.get(matched) {
            let continues = match *container {
                Container::Quote => c.quote(),
                Container::Item { width, .. } => {
                    c.blank() || (c.indent() >= width && c.advance(width))
                }
            };
            if !continues {
                break;
            }
            matched += 1;
            // Obsidian splits a tab across a container edge its own way, so
            // rely on the split only where keeping or dropping the rest of
            // the tab gives the same reading.
            if c.spare > 0 && matched < self.stack.len() {
                return Line::Fallback { rest: false };
            }
        }
        if c.spare > 0 && (c.indent() >= 4) != (c.indent() - c.spare >= 4) {
            return Line::Fallback { rest: false };
        }
        if matched < self.stack.len() {
            if !c.blank() {
                match self.leaf {
                    Leaf::Fence { .. } => return Line::Fallback { rest: true },
                    Leaf::Paragraph => match starts_block(c.clone()) {
                        Start::Lazy => return Line::Text(Unsure::No),
                        Start::Unknown => return Line::Fallback { rest: false },
                        Start::Block => {}
                    },
                    // Obsidian continues an item past a line that CommonMark
                    // would not, so only a block start is known to close it.
                    Leaf::Closed | Leaf::Indented | Leaf::Unknown => {
                        if !matches!(starts_block(c.clone()), Start::Block) {
                            return Line::Fallback { rest: false };
                        }
                    }
                }
            }
            self.stack.truncate(matched);
            self.leaf = Leaf::Closed;
            closed = true;
        }
        match self.leaf {
            Leaf::Fence { marker, count } => {
                if c.indent() <= 3 {
                    c.advance(c.indent());
                    let rest = c.rest();
                    let run = rest.bytes().take_while(|b| *b == marker).count();
                    if run >= count && is_blank(&rest[run..]) {
                        self.leaf = Leaf::Closed;
                    }
                }
                return Line::Code;
            }
            Leaf::Indented if c.blank() || c.indent() >= 4 => return Line::Code,
            Leaf::Indented => self.leaf = Leaf::Closed,
            _ => {}
        }
        // Indented code and containers after a task checkbox start at a column
        // the stack cannot express.
        let mut checked = false;
        loop {
            if c.blank() {
                self.leaf = Leaf::Closed;
                return Line::Text(Unsure::No);
            }
            let indent = c.indent();
            if checked && indent >= 4 {
                return Line::Fallback { rest: false };
            }
            if indent >= 4 {
                return match self.leaf {
                    Leaf::Paragraph => Line::Text(Unsure::No),
                    Leaf::Closed if !closed && !self.dotted() => {
                        self.leaf = Leaf::Indented;
                        Line::Code
                    }
                    _ => {
                        self.leaf = Leaf::Unknown;
                        Line::Text(Unsure::Line)
                    }
                };
            }
            c.advance(indent);
            let rest = c.rest();
            if let Some((marker, count)) = fence_open(rest) {
                self.leaf = Leaf::Fence { marker, count };
                return Line::Code;
            }
            // Every line walks the stack, so deep nesting is not modelled.
            if (checked || self.stack.len() >= MAX_DEPTH)
                && (rest.starts_with('>') || list_marker(rest).is_some())
            {
                return Line::Fallback { rest: false };
            }
            if c.quote() {
                self.stack.push(Container::Quote);
                self.leaf = Leaf::Closed;
                continue;
            }
            let setext = self.leaf == Leaf::Paragraph && setext(rest);
            // Obsidian need not read a lone `-` under a paragraph as an underline.
            if setext && list_marker(rest).is_some() {
                return Line::Fallback { rest: false };
            }
            if setext || thematic(rest) || heading(rest) {
                self.leaf = Leaf::Closed;
                return Line::Text(Unsure::No);
            }
            if let Some(marker) = list_marker(rest) {
                // Obsidian continues an empty item at other widths.
                if is_blank(&rest[marker.len..]) {
                    return Line::Fallback { rest: false };
                }
                if !(marker.bullet || marker.one) {
                    match self.leaf {
                        Leaf::Paragraph => return Line::Text(Unsure::No),
                        Leaf::Unknown => return Line::Fallback { rest: false },
                        _ => {}
                    }
                }
                c.bump(marker.len);
                let gap = c.indent();
                let gap = if gap >= 5 { 1 } else { gap };
                self.stack.push(Container::Item {
                    width: indent + marker.len + gap,
                    dotted: marker.dotted,
                });
                self.leaf = Leaf::Closed;
                c.advance(gap);
                // Obsidian reads what follows a task checkbox as a new block.
                if let Some(len) = checkbox(c.rest()) {
                    let after = &c.rest()[len..];
                    if len != 3 || !after.starts_with(' ') || is_blank(after) {
                        return Line::Fallback { rest: false };
                    }
                    c.bump(len + 1);
                    checked = true;
                }
                continue;
            }
            // Link reference definitions can continue onto later lines.
            let unsure = if rest.starts_with('[') && rest.contains("]:") {
                Unsure::Paragraph
            } else {
                Unsure::No
            };
            // Obsidian reads the line after a callout header as a new block.
            let prose = !rest.starts_with(['#', '|', '<'])
                && !rest.starts_with("[!")
                && rest.chars().any(char::is_alphanumeric);
            self.leaf = if prose {
                Leaf::Paragraph
            } else {
                Leaf::Unknown
            };
            return Line::Text(unsure);
        }
    }
    // Obsidian reads four-column indents in `1.` items inconsistently.
    fn dotted(&self) -> bool {
        self.stack
            .iter()
            .any(|container| matches!(container, Container::Item { dotted: true, .. }))
    }
}
enum Start {
    /// Paragraph text: a lazy continuation line.
    Lazy,
    /// A block that interrupts the paragraph and closes the containers.
    Block,
    Unknown,
}
fn starts_block(mut c: Cursor<'_>) -> Start {
    let indent = c.indent();
    if indent >= 4 {
        return Start::Unknown;
    }
    c.advance(indent);
    let rest = c.rest();
    if fence_open(rest).is_some()
        || rest.starts_with('>')
        || thematic(rest)
        || heading(rest)
        || list_marker(rest)
            .is_some_and(|marker| (marker.bullet || marker.one) && !is_blank(&rest[marker.len..]))
    {
        Start::Block
    } else if list_marker(rest).is_some()
        || rest.starts_with(['<', '|', '$', '=', '-', '*', '+', '_'])
    {
        Start::Unknown
    } else {
        Start::Lazy
    }
}
// Whether a tab in the container prefix follows anything but tabs.
fn odd_tab(line: &str) -> bool {
    let mut rest = line;
    let mut tabs_only = true;
    loop {
        let text = rest.trim_start_matches([' ', '\t']);
        for b in rest[..rest.len() - text.len()].bytes() {
            if b == b'\t' && !tabs_only {
                return true;
            }
            tabs_only &= b == b'\t';
        }
        rest = if let Some(text) = text.strip_prefix('>') {
            text
        } else if let Some(marker) = list_marker(text) {
            &text[marker.len..]
        } else {
            return false;
        };
        tabs_only = false;
    }
}
fn is_blank(text: &str) -> bool {
    text.bytes().all(|b| matches!(b, b' ' | b'\t'))
}
// CommonMark fence opening, after indentation: a backtick fence's info
// string cannot contain a backtick.
pub(super) fn fence_open(rest: &str) -> Option<(u8, usize)> {
    let marker @ (b'`' | b'~') = *rest.as_bytes().first()? else {
        return None;
    };
    let count = rest.bytes().take_while(|b| *b == marker).count();
    (count >= 3 && !(marker == b'`' && rest[count..].contains('`'))).then_some((marker, count))
}
fn thematic(rest: &str) -> bool {
    let Some(marker @ (b'*' | b'-' | b'_')) = rest.bytes().next() else {
        return false;
    };
    rest.bytes()
        .all(|b| matches!(b, b' ' | b'\t') || b == marker)
        && rest.bytes().filter(|b| *b == marker).count() >= 3
}
fn setext(rest: &str) -> bool {
    let underline = rest.trim_end_matches([' ', '\t']);
    underline.bytes().all(|b| b == b'=') || underline.bytes().all(|b| b == b'-')
}
fn heading(rest: &str) -> bool {
    let level = rest.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&level)
        && rest[level..]
            .chars()
            .next()
            .is_none_or(|c| c == ' ' || c == '\t')
}
struct Marker {
    len: usize,
    bullet: bool,
    /// An ordered marker numbered 1, which may interrupt a paragraph.
    one: bool,
    dotted: bool,
}
fn list_marker(rest: &str) -> Option<Marker> {
    let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
    let marker = if digits == 0 {
        rest.starts_with(['-', '*', '+']).then_some(Marker {
            len: 1,
            bullet: true,
            one: false,
            dotted: false,
        })?
    } else {
        let delimiter = *rest.as_bytes().get(digits)?;
        if digits > 9 || !matches!(delimiter, b'.' | b')') {
            return None;
        }
        Marker {
            len: digits + 1,
            bullet: false,
            one: rest[..digits].trim_start_matches('0') == "1",
            dotted: delimiter == b'.',
        }
    };
    let after = &rest[marker.len..];
    (after.is_empty() || after.starts_with([' ', '\t'])).then_some(marker)
}
/// A position in a line, counting columns with tab stops of four. A tab
/// partly consumed by a container leaves `spare` columns of indentation.
#[derive(Clone)]
struct Cursor<'a> {
    line: &'a str,
    at: usize,
    column: usize,
    spare: usize,
}
impl<'a> Cursor<'a> {
    fn new(line: &'a str) -> Self {
        Self {
            line,
            at: 0,
            column: 0,
            spare: 0,
        }
    }
    fn rest(&self) -> &'a str {
        &self.line[self.at..]
    }
    fn blank(&self) -> bool {
        is_blank(self.rest())
    }
    /// Columns of indentation from here.
    fn indent(&self) -> usize {
        let mut column = self.column + self.spare;
        for b in self.rest().bytes() {
            match b {
                b' ' => column += 1,
                b'\t' => column += 4 - column % 4,
                _ => break,
            }
        }
        column - self.column
    }
    /// Consume `columns` of indentation; always true, for use in conditions.
    fn advance(&mut self, mut columns: usize) -> bool {
        while columns > 0 {
            if self.spare > 0 {
                let used = columns.min(self.spare);
                self.spare -= used;
                self.column += used;
                columns -= used;
                continue;
            }
            match self.line.as_bytes().get(self.at) {
                Some(b' ') => {
                    self.at += 1;
                    self.column += 1;
                    columns -= 1;
                }
                Some(b'\t') => {
                    self.at += 1;
                    self.spare = 4 - self.column % 4;
                }
                _ => break,
            }
        }
        true
    }
    /// Consume single-column marker bytes.
    fn bump(&mut self, bytes: usize) {
        self.spare = 0;
        self.at += bytes;
        self.column += bytes;
    }
    /// Match a block quote marker and its optional following space.
    fn quote(&mut self) -> bool {
        let indent = self.indent();
        let mut next = self.clone();
        next.advance(indent);
        if indent > 3 || !next.rest().starts_with('>') {
            return false;
        }
        next.bump(1);
        if next.indent() > 0 {
            next.advance(1);
        }
        *self = next;
        true
    }
}

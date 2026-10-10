//! Deterministic generators for property tests (no external crates: the
//! portable core keeps its dependency tree minimal, and a fixed PRNG makes every
//! failure reproducible from its seed).
#![allow(dead_code)]

use mdbn_core::value::{Map, Value};

/// SplitMix64.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }
    pub fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.next() % n }
    }
    pub fn usize(&mut self, n: usize) -> usize {
        self.below(n as u64) as usize
    }
    pub fn chance(&mut self, num: u64, den: u64) -> bool {
        self.below(den) < num
    }
    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.usize(items.len())]
    }
}

/// Words that are safe as plain scalars and resolve to strings.
pub const WORDS: &[&str] = &[
    "open",
    "done",
    "Café",
    "naïve",
    "x",
    "Call Bob",
    "a-b",
    "a_b",
    "path/to/x",
    "http://x.y/z",
    "x#y",
    "a:b",
    "日本",
    "😀 emoji",
    "Q3 plan",
    "-dash",
    "?q",
    "end.",
    "it's",
];

pub const KEYS: &[&str] = &[
    "title",
    "status",
    "tags",
    "priority",
    "due",
    "notes",
    "items",
    "meta",
    "a",
    "b",
    "c",
    "dateModified",
    "owner",
    "k-1",
    "with space",
];

/// Renders a value in block context: `(indentation, trailing comment) -> text`.
pub type BlockRender = Box<dyn Fn(usize, &str) -> String>;

/// A generated YAML value: its text in some style and the value it denotes.
pub struct Gen {
    pub value: Value,
    /// Block rendering of a top-level entry value at a given indentation:
    /// returns the text after `key:` (starting with a space or a line break).
    pub block: BlockRender,
    /// Flow rendering, if this value can appear inside a flow collection.
    pub flow: Option<String>,
}

fn dq(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub fn gen_scalar(r: &mut Rng) -> Gen {
    let (value, text): (Value, String) = match r.below(10) {
        0 => (Value::Null, r.pick(&["null", "~", "Null"]).to_string()),
        1 => {
            let b = r.chance(1, 2);
            (Value::Bool(b), if b { "true" } else { "False" }.to_owned())
        }
        2 => {
            let i = (r.next() as i64) >> r.below(60);
            (Value::int(i), i.to_string())
        }
        3 => {
            let f = (r.below(100_000) as f64) / 64.0;
            (Value::Float(f), format!("{f:?}"))
        }
        4 => {
            let w = r.pick(WORDS).to_string();
            let t = dq(&w);
            (Value::string(w), t)
        }
        5 => {
            let w = format!(
                "{} {}",
                r.pick(WORDS),
                r.pick(&["\"q\"", "\\", "\t", "true", "# not"])
            );
            let t = dq(&w);
            (Value::string(w), t)
        }
        6 => {
            let w = r
                .pick(&["it's", "", " pad ", "a: b", "#x", "yes"])
                .to_string();
            let t = sq(&w);
            (Value::string(w), t)
        }
        _ => {
            let w = r.pick(WORDS).to_string();
            (Value::string(w.clone()), w)
        }
    };
    let flow_ok = !matches!(&value, Value::Text(s) if text == *s && (s.contains([',', '[', ']', '{', '}']) || s.contains(": ")));
    let t2 = text.clone();
    Gen {
        value,
        block: Box::new(move |_, comment| format!(" {t2}{comment}\n")),
        flow: flow_ok.then_some(text),
    }
}

pub fn gen_value(r: &mut Rng, depth: u32) -> Gen {
    let k = if depth >= 3 { 0 } else { r.below(9) };
    match k {
        0..=3 => gen_scalar(r),
        4 => {
            // Block scalar.
            let lines: Vec<String> = (0..1 + r.usize(3))
                .map(|_| r.pick(WORDS).to_string())
                .collect();
            let literal = r.chance(1, 2);
            let chomp = *r.pick(&["", "-"]);
            let mut text = if literal {
                lines.join("\n")
            } else {
                lines.join(" ")
            };
            match chomp {
                "-" => {}
                _ => text.push('\n'),
            }
            let lines2 = lines.clone();
            Gen {
                value: Value::string(text),
                block: Box::new(move |ind, comment| {
                    let mut s =
                        format!(" {}{}{}\n", if literal { "|" } else { ">" }, chomp, comment);
                    for l in &lines2 {
                        s.push_str(&" ".repeat(ind + 2));
                        s.push_str(l);
                        s.push('\n');
                    }
                    s
                }),
                flow: None,
            }
        }
        5 | 6 => {
            // Sequence.
            let items: Vec<Gen> = (0..r.usize(4)).map(|_| gen_value(r, depth + 1)).collect();
            let value = Value::List(items.iter().map(|g| g.value.clone()).collect());
            let flow = items
                .iter()
                .map(|g| g.flow.clone())
                .collect::<Option<Vec<_>>>()
                .map(|f| format!("[{}]", f.join(", ")));
            let use_flow = flow.is_some() && (items.is_empty() || r.chance(1, 2));
            let compact = depth == 0 && r.chance(1, 3);
            let flow2 = flow.clone();
            Gen {
                value,
                block: Box::new(move |ind, comment| {
                    if use_flow {
                        return format!(" {}{}\n", flow2.as_deref().unwrap_or("[]"), comment);
                    }
                    let item_ind = if compact { ind } else { ind + 2 };
                    let mut s = format!("{comment}\n");
                    for it in &items {
                        s.push_str(&" ".repeat(item_ind));
                        s.push('-');
                        s.push_str(&(it.block)(item_ind, ""));
                    }
                    s
                }),
                flow,
            }
        }
        _ => {
            // Mapping.
            let mut pairs: Vec<(String, Gen)> = Vec::new();
            for _ in 0..1 + r.usize(3) {
                let key = r.pick(KEYS).to_string();
                if pairs.iter().any(|(k, _)| *k == key) {
                    continue;
                }
                pairs.push((key, gen_value(r, depth + 1)));
            }
            let value = Value::Map(
                pairs
                    .iter()
                    .map(|(k, g)| (k.clone(), g.value.clone()))
                    .collect::<Map>(),
            );
            let flow = pairs
                .iter()
                .map(|(k, g)| g.flow.clone().map(|f| format!("{k}: {f}")))
                .collect::<Option<Vec<_>>>()
                .map(|f| format!("{{{}}}", f.join(", ")));
            let use_flow = flow.is_some() && r.chance(1, 3);
            let flow2 = flow.clone();
            Gen {
                value,
                block: Box::new(move |ind, comment| {
                    if use_flow {
                        return format!(" {}{}\n", flow2.as_deref().unwrap_or("{}"), comment);
                    }
                    let mut s = format!("{comment}\n");
                    for (k, g) in &pairs {
                        s.push_str(&" ".repeat(ind + 2));
                        s.push_str(k);
                        s.push(':');
                        s.push_str(&(g.block)(ind + 2, ""));
                    }
                    s
                }),
                flow,
            }
        }
    }
}

/// A frontmatter source with comments and blank lines, and its mapping.
pub fn gen_frontmatter(r: &mut Rng) -> (String, Map) {
    let mut text = String::new();
    let mut map = Map::new();
    if r.chance(1, 4) {
        text.push_str("# leading comment\n");
    }
    for _ in 0..r.usize(7) {
        let key = r.pick(KEYS).to_string();
        if map.contains_key(&key) {
            continue;
        }
        let g = gen_value(r, 0);
        let comment = if r.chance(1, 4) { "  # note" } else { "" };
        let key_text = if key.contains(' ') || r.chance(1, 8) {
            format!("\"{key}\"")
        } else {
            key.clone()
        };
        text.push_str(&key_text);
        text.push(':');
        text.push_str(&(g.block)(0, comment));
        map.insert(key, g.value);
        match r.below(6) {
            0 => text.push('\n'),
            1 => text.push_str("# between\n"),
            2 => text.push_str(" # indented trailing\n"),
            _ => {}
        }
    }
    (text, map)
}

/// A string from an alphabet of characters that are hard for YAML emitters.
pub fn nasty_string(r: &mut Rng) -> String {
    const PARTS: &[&str] = &[
        "a",
        "Z",
        " ",
        "  ",
        "\t",
        "\n",
        "\r",
        "\r\n",
        "#",
        " #",
        ":",
        ": ",
        "-",
        "- ",
        "?",
        ",",
        "[",
        "]",
        "{",
        "}",
        "'",
        "\"",
        "\\",
        "|",
        ">",
        "&",
        "*",
        "!",
        "%",
        "@",
        "`",
        "~",
        "null",
        "true",
        "yes",
        "1",
        "0x1F",
        "1e3",
        ".inf",
        "é",
        "😀",
        "\u{85}",
        "\u{2028}",
        "\u{feff}",
        "\u{0}",
        "\u{1b}",
        "\u{7f}",
        "---",
        "...",
        "<<",
        "=",
        "2026-10-01",
    ];
    let n = r.usize(6);
    (0..n).map(|_| *r.pick(PARTS)).collect()
}

/// A value built from nasty strings, numbers and nesting.
pub fn nasty_value(r: &mut Rng, depth: u32) -> Value {
    match if depth > 2 { r.below(5) } else { r.below(8) } {
        0 => Value::Null,
        1 => Value::Bool(r.chance(1, 2)),
        2 => Value::int((r.next() as i64) >> r.below(64)),
        3 => Value::Float(f64::from_bits(r.next())).clone_if_finite(),
        4 => Value::string(nasty_string(r)),
        5 | 6 => Value::List((0..r.usize(4)).map(|_| nasty_value(r, depth + 1)).collect()),
        _ => {
            let mut m = Map::new();
            for _ in 0..r.usize(4) {
                m.insert(nasty_string(r), nasty_value(r, depth + 1));
            }
            Value::Map(m)
        }
    }
}

pub trait FiniteOr {
    fn clone_if_finite(self) -> Value;
}

impl FiniteOr for Value {
    fn clone_if_finite(self) -> Value {
        match self {
            Value::Float(f) if !f.is_finite() => Value::Float(0.5),
            v => v,
        }
    }
}

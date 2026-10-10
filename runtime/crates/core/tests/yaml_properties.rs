//! Property tests for the YAML profile parser and the format-preserving writer,
//! over generated documents whose intended values are known by construction.

mod support;

use mdbn_core::doc::{Document, RecordFormat};
use mdbn_core::value::Value;
use mdbn_core::writer::{Change, entry_copy, write};
use mdbn_core::yaml::parse_value;
use support::{Rng, gen_frontmatter, gen_value};

const CASES: u64 = 3000;

#[test]
fn generated_yaml_parses_to_its_intended_value() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (text, map) = gen_frontmatter(&mut r);
        let got = parse_value(&text).unwrap_or_else(|e| panic!("seed {seed}: {e}\n{text}"));
        let got = got.unwrap_or(Value::Map(Default::default()));
        assert_eq!(got, Value::Map(map.clone()), "seed {seed}\n{text}");
    }
}

#[test]
fn unchanged_documents_round_trip_exactly() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (text, _) = gen_frontmatter(&mut r);
        let src = format!("---\n{text}---\nbody\n");
        let d = Document::parse(src.clone(), RecordFormat::Markdown);
        assert_eq!(write(&d, &[], None).unwrap(), src, "seed {seed}");
    }
}

#[test]
fn writes_change_only_what_they_mean_to() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (text, map) = gen_frontmatter(&mut r);
        let crlf = r.chance(1, 5);
        let mut src = format!("---\n{text}---\nbody\n");
        if crlf {
            src = src.replace('\n', "\r\n");
        }
        let d = Document::parse(src.clone(), RecordFormat::Markdown);
        assert!(
            d.problem().is_none(),
            "seed {seed}: {:?}\n{src}",
            d.problem()
        );
        // Random changes: set existing or new keys, remove keys.
        let mut changes = Vec::new();
        let mut expected = map.clone();
        for _ in 0..1 + r.usize(3) {
            let key = r.pick(support::KEYS).to_string();
            if r.chance(1, 4) {
                changes.push((key.clone(), Change::Remove));
                expected.remove(&key);
            } else {
                let v = gen_value(&mut r, 1).value;
                changes.push((key.clone(), Change::Set(v.clone())));
                expected.insert(key, v);
            }
        }
        let out = write(&d, &changes, None).unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        let nd = Document::parse(out.clone(), RecordFormat::Markdown);
        assert!(
            nd.problem().is_none(),
            "seed {seed}: {:?}\n{out}",
            nd.problem()
        );
        assert_eq!(nd.frontmatter(), &expected, "seed {seed}\n{src}\n=>\n{out}");
        assert_eq!(nd.body(), d.body());
        assert_eq!(
            out.contains("\r\n"),
            crlf,
            "seed {seed}: line endings\n{out:?}"
        );
        if crlf {
            assert!(
                !out.replace("\r\n", "").contains('\n'),
                "seed {seed}: mixed line endings\n{out:?}"
            );
        }
        // Untouched entries are byte-identical.
        for k in map.keys() {
            if changes.iter().any(|(c, _)| c == k) {
                continue;
            }
            let before = entry_copy(&d, k).unwrap();
            let after = entry_copy(&nd, k).unwrap_or_else(|| panic!("seed {seed}: {k} lost"));
            assert_eq!(
                before.text(),
                after.text(),
                "seed {seed}: entry {k} changed\n{out}"
            );
        }
        // Writing the same changes again is a no-op (idempotence).
        assert_eq!(write(&nd, &changes, None).unwrap(), out, "seed {seed}");
    }
}

#[test]
fn mutated_input_never_panics() {
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let (text, _) = gen_frontmatter(&mut r);
        let mut bytes = text.into_bytes();
        for _ in 0..1 + r.usize(4) {
            if bytes.is_empty() {
                break;
            }
            let i = r.usize(bytes.len());
            match r.below(4) {
                0 => {
                    bytes.remove(i);
                }
                1 => bytes.insert(i, *r.pick(b" \t\n-:#[]{}'\"|>&*!?,\\")),
                2 => bytes[i] = *r.pick(b" \n:-[{"),
                _ => {
                    let j = r.usize(bytes.len());
                    bytes.swap(i, j);
                }
            }
        }
        let Ok(text) = String::from_utf8(bytes) else {
            continue;
        };
        let src = format!("---\n{text}\n---\n");
        let d = Document::parse(src, RecordFormat::Markdown);
        if d.problem().is_none() {
            let out = write(&d, &[("zz".into(), Change::Set(Value::int(1)))], None).unwrap();
            let nd = Document::parse(out, RecordFormat::Markdown);
            assert_eq!(
                nd.frontmatter().get("zz"),
                Some(&Value::int(1)),
                "seed {seed}"
            );
        }
    }
}

#[test]
#[ignore]
fn debug_seed() {
    let seed: u64 = 8;
    let mut r = Rng::new(seed);
    let (text, _map) = gen_frontmatter(&mut r);
    let _crlf = r.chance(1, 5);
    println!("{text}");
    for _ in 0..1 + r.usize(3) {
        let key = r.pick(support::KEYS).to_string();
        if r.chance(1, 4) {
            println!("remove {key}");
        } else {
            let v = gen_value(&mut r, 1).value;
            println!("set {key} = {}", v.to_json());
        }
    }
}

#[test]
fn any_value_can_be_written_and_read_back_exactly() {
    const PREVIOUS: &[&str] = &[
        "",
        " plain",
        " 'single'",
        " \"double\"",
        " [flow]",
        " {f: 1}",
        "\n  - block",
        "\n- compact",
        "\n  k: v",
        " |\n  literal\n",
        " >\n  folded\n",
        " x # comment",
    ];
    for seed in 0..CASES {
        let mut r = Rng::new(seed);
        let prev = *r.pick(PREVIOUS);
        let src = format!("---\nbefore: 1\nk:{prev}\nafter: 2\n---\nbody\n");
        let d = Document::parse(src, RecordFormat::Markdown);
        assert!(d.problem().is_none(), "{prev:?}");
        let v = support::nasty_value(&mut r, 0);
        let key = if r.chance(1, 4) {
            support::nasty_string(&mut r)
        } else {
            "k".to_owned()
        };
        let out = write(&d, &[(key.clone(), Change::Set(v.clone()))], None)
            .unwrap_or_else(|e| panic!("seed {seed}: {e}"));
        let nd = Document::parse(out.clone(), RecordFormat::Markdown);
        assert!(
            nd.problem().is_none(),
            "seed {seed}: {:?}\n{out}",
            nd.problem()
        );
        let got = nd
            .frontmatter()
            .get(&key)
            .unwrap_or_else(|| panic!("seed {seed}: key lost\n{out}"));
        // Debug output distinguishes integers from floats and keeps map order.
        assert_eq!(format!("{got:?}"), format!("{v:?}"), "seed {seed}\n{out}");
        assert_eq!(nd.body(), "body\n");
        assert_eq!(
            nd.frontmatter().get("after"),
            Some(&Value::int(2)),
            "seed {seed}\n{out}"
        );
    }
}

//! Input = document + `\0` + YAML mapping of changes (null removes a key): the
//! write reads back as exactly the intended mapping, and untouched entries keep
//! their bytes.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mdbn_core::doc::{Document, RecordFormat};
use mdbn_core::value::Value;
use mdbn_core::writer::{Change, entry_copy, write};
use mdbn_core::yaml::parse_value;

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    let Some((doc, changes)) = text.split_once('\0') else { return };
    let Ok(Some(Value::Map(changes))) = parse_value(changes) else { return };
    let d = Document::parse(doc, RecordFormat::Markdown);
    if d.problem().is_some() {
        return;
    }
    let mut list = Vec::new();
    let mut expected = d.frontmatter().clone();
    for (k, v) in changes.iter() {
        if v.is_null() {
            list.push((k.to_owned(), Change::Remove));
            expected.remove(k);
        } else {
            list.push((k.to_owned(), Change::Set(v.clone())));
            expected.insert(k, v.clone());
        }
    }
    let out = write(&d, &list, None).unwrap();
    let nd = Document::parse(out.clone(), RecordFormat::Markdown);
    assert!(nd.problem().is_none(), "{out}");
    assert_eq!(nd.frontmatter(), &expected, "{out}");
    assert_eq!(nd.body(), d.body());
    let anchors = d.frontmatter_source().is_some_and(|s| s.contains('&'));
    if !anchors {
        for k in d.frontmatter().keys() {
            if changes.contains_key(k) {
                continue;
            }
            let before = entry_copy(&d, k).unwrap();
            let after = entry_copy(&nd, k).unwrap();
            assert_eq!(before.text(), after.text(), "{k}");
        }
    }
});

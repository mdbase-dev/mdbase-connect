//! Any input: parsing never panics, and a document that parses can take a new
//! key and an unchanged write is the identity.
#![no_main]

use libfuzzer_sys::fuzz_target;
use mdbn_core::doc::{Document, RecordFormat};
use mdbn_core::value::Value;
use mdbn_core::writer::{Change, render_new, write};

fuzz_target!(|data: &[u8]| {
    let Ok(text) = std::str::from_utf8(data) else { return };
    for format in [RecordFormat::Markdown, RecordFormat::YamlDocument] {
        let d = Document::parse(text, format);
        assert_eq!(write(&d, &[], None).unwrap(), text);
        if d.problem().is_some() {
            continue;
        }
        // The parsed mapping re-emits and reads back exactly.
        let fm = d.frontmatter().clone();
        let fresh = render_new(&fm, "", RecordFormat::YamlDocument, mdbn_core::doc::LineEnding::Lf).unwrap();
        let back = Document::parse(fresh, RecordFormat::YamlDocument);
        assert_eq!(back.frontmatter(), &fm);
        // Adding a key keeps every other value.
        let out = write(&d, &[("zz_fuzz".into(), Change::Set(Value::int(1)))], None).unwrap();
        let nd = Document::parse(out, format);
        assert!(nd.problem().is_none());
        assert_eq!(nd.frontmatter().get("zz_fuzz"), Some(&Value::int(1)));
        for (k, v) in fm.iter() {
            if k != "zz_fuzz" {
                assert_eq!(nd.frontmatter().get(k), Some(v), "{k}");
            }
        }
    }
});

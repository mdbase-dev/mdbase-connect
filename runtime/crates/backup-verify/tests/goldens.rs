#![cfg(not(target_arch = "wasm32"))]
//! Independent SDK/Node complete-cut bytes, not just a synthetic completion.
#[path = "support/cut.rs"]
mod cut;
use mdbn_backup_verify::CutVerifier;
use mdbn_log_service::OfflineDecodeBudget;
use mdbn_wire::{common::B32, hash::sha256};
use std::collections::BTreeMap;

fn unhex(text: &str) -> Vec<u8> {
    assert_eq!(text.len() % 2, 0);
    text.as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
#[test]
fn independently_signed_full_cut_goldens_match_bytes_and_verify_complete_closure() {
    for (name, vector, compacted, indexed, different, extra, large) in [
        (
            "ordinary",
            include_str!("vectors/cut-ordinary-v1.txt"),
            false,
            false,
            false,
            false,
            false,
        ),
        (
            "compacted",
            include_str!("vectors/cut-compacted-v1.txt"),
            true,
            false,
            false,
            false,
            false,
        ),
        (
            "indexed-extra-publisher",
            include_str!("vectors/cut-indexed-extra-publisher-v1.txt"),
            false,
            true,
            true,
            true,
            false,
        ),
        (
            "near9",
            include_str!("vectors/cut-near9-v1.txt"),
            false,
            false,
            false,
            false,
            true,
        ),
    ] {
        let mut fields: BTreeMap<_, _> = vector
            .lines()
            .map(|line| {
                let (field, value) = line.split_once('=').unwrap();
                (field, unhex(value))
            })
            .collect();
        let fixture = if different || extra {
            cut::source(compacted, indexed, large, different, extra)
        } else {
            cut::fixture(compacted, indexed, large)
        };
        let trust = fields.remove("trust").unwrap();
        let completion = fields.remove("completion").unwrap();
        let header = fields.remove("header").unwrap();
        let finish = fields.remove("finish").unwrap();
        assert_eq!(trust, fixture.trust, "{name}: trust");
        assert_eq!(completion, fixture.completion, "{name}: signed completion");
        assert_eq!(header, fixture.header, "{name}: header");
        assert_eq!(finish, fixture.finish, "{name}: finish");
        let work = OfflineDecodeBudget::new();
        let mut verifier = CutVerifier::new(&trust, &completion, &work).unwrap();
        verifier.bind_header(&header, &finish).unwrap();
        for (number, expected) in fixture.pages.iter().enumerate() {
            let page = fields
                .remove(format!("page{}", number + 1).as_str())
                .unwrap();
            assert_eq!(&page, expected, "{name}: page {number}");
            verifier.push_page(&page).unwrap();
        }
        verifier.finish_pages().unwrap();
        for (address, expected) in &fixture.objects {
            let prefix = if large { "object_hash" } else { "object" };
            let raw = fields
                .remove(format!("{prefix}_{}", address.to_hex()).as_str())
                .unwrap();
            if large {
                assert_eq!(
                    raw,
                    sha256(expected).0,
                    "{name}: independent large object checksum"
                );
                verifier.push_object(address, expected).unwrap();
            } else {
                assert_eq!(&raw, expected, "{name}: complete object bytes");
                assert_eq!(sha256(&raw), *address);
                verifier.push_object(&B32(address.0), &raw).unwrap();
            }
        }
        assert!(fields.is_empty(), "{name}: no ignored vector inventory");
        let result = verifier.finish().unwrap();
        assert!(result.json_line().contains("\"items\":4"));
        assert!(
            result
                .json_line()
                .contains("\"current_authority_verified\":false")
        );
    }
}

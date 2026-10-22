//! Read-only per-item digest sample of the hosted target, for a post-routed
//! verifier. Digests, sizes and IDs only: no path, document or file byte leaves.
//!
//! Request: CBOR `[records, files]`, each a list of 16-byte IDs (at most
//! [`MAX_RECORDS`] records and [`MAX_FILES`] files, no duplicates, at least one).
//! Reply: CBOR `[records, files]`, one `[id, state, content, size]` per requested
//! ID in request order. `state` is [`MISSING`], [`PRESENT`] or [`UNSUPPORTED`]
//! (a file that is not an ordinary `AttachmentV1`); `content` (32 bytes) and
//! `size` are `null` unless present. A record's content is its revision
//! (`SHA-256` of the document) and its size the document's UTF-8 bytes; a file's
//! are the attachment's whole plaintext hash and plaintext bytes.

use mdbn_replica::store::{FileRow, RecordRow, Store};
use mdbn_wire::attachment::FileContent;
use mdbn_wire::cbor::{self, Cbor};
use mdbn_wire::common::{B16, Uuid};
use mdbn_wire::unindexed_markdown::FileKindV1;

/// Records per sample.
pub const MAX_RECORDS: usize = 5;
/// Files per sample.
pub const MAX_FILES: usize = 1;
/// Not in the target.
pub const MISSING: u64 = 0;
/// In the target; content and size follow.
pub const PRESENT: u64 = 1;
/// A file whose content is not an ordinary attachment.
pub const UNSUPPORTED: u64 = 2;

/// Why a sample was refused. Carries no content.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SampleError {
    /// The request is not the documented shape or bound.
    Invalid,
    /// The store could not be read.
    Storage,
    /// A stored record's revision does not match its document.
    Corrupt,
}

/// Parse a request into (record IDs, file IDs).
pub fn decode_request(bytes: &[u8]) -> Result<(Vec<Uuid>, Vec<Uuid>), SampleError> {
    let Ok(Cbor::Array(parts)) = cbor::decode(bytes) else {
        return Err(SampleError::Invalid);
    };
    let [records, files] = parts.as_slice() else {
        return Err(SampleError::Invalid);
    };
    let ids = |c: &Cbor, max: usize| -> Result<Vec<Uuid>, SampleError> {
        let Cbor::Array(items) = c else {
            return Err(SampleError::Invalid);
        };
        if items.len() > max {
            return Err(SampleError::Invalid);
        }
        let mut out: Vec<Uuid> = Vec::with_capacity(items.len());
        for item in items {
            let Cbor::Bytes(b) = item else {
                return Err(SampleError::Invalid);
            };
            let id = B16(b.as_slice().try_into().map_err(|_| SampleError::Invalid)?);
            if id.0 == [0; 16] || out.contains(&id) {
                return Err(SampleError::Invalid);
            }
            out.push(id);
        }
        Ok(out)
    };
    let (records, files) = (ids(records, MAX_RECORDS)?, ids(files, MAX_FILES)?);
    if records.is_empty() && files.is_empty() {
        return Err(SampleError::Invalid);
    }
    Ok((records, files))
}

fn item(id: &Uuid, state: u64, content: Option<[u8; 32]>, size: Option<u64>) -> Cbor {
    Cbor::Array(vec![
        Cbor::Bytes(id.0.to_vec()),
        Cbor::Uint(state),
        content.map_or(Cbor::Null, |c| Cbor::Bytes(c.to_vec())),
        size.map_or(Cbor::Null, Cbor::Uint),
    ])
}

fn record_item(id: &Uuid, row: Option<RecordRow>) -> Result<Cbor, SampleError> {
    let Some(r) = row else {
        return Ok(item(id, MISSING, None, None));
    };
    if r.id != *id || r.revision != mdbn_wire::hash::sha256(r.doc.as_bytes()) {
        return Err(SampleError::Corrupt);
    }
    Ok(item(
        id,
        PRESENT,
        Some(r.revision.0),
        Some(r.doc.len() as u64),
    ))
}

fn file_item(id: &Uuid, row: Option<FileRow>) -> Result<Cbor, SampleError> {
    let Some(f) = row else {
        return Ok(item(id, MISSING, None, None));
    };
    if f.id != *id {
        return Err(SampleError::Corrupt);
    }
    Ok(match (&f.content, f.kind) {
        (FileContent::AttachmentV1(c), FileKindV1::Ordinary) => item(
            id,
            PRESENT,
            Some(c.whole_plain_hash.0),
            Some(c.total_plain_bytes),
        ),
        _ => item(id, UNSUPPORTED, None, None),
    })
}

/// Answer a decoded request from the target store.
pub fn sample<S: Store>(
    store: &S,
    records: &[Uuid],
    files: &[Uuid],
) -> Result<Vec<u8>, SampleError> {
    let mut r = Vec::with_capacity(records.len());
    for id in records {
        r.push(record_item(
            id,
            store.record(id).map_err(|_| SampleError::Storage)?,
        )?);
    }
    let mut f = Vec::with_capacity(files.len());
    for id in files {
        f.push(file_item(
            id,
            store.file(id).map_err(|_| SampleError::Storage)?,
        )?);
    }
    cbor::encode(&Cbor::Array(vec![Cbor::Array(r), Cbor::Array(f)]))
        .map_err(|_| SampleError::Invalid)
}

/// Decode a request and answer it.
pub fn answer<S: Store>(store: &S, request: &[u8]) -> Result<Vec<u8>, SampleError> {
    let (records, files) = decode_request(request)?;
    sample(store, &records, &files)
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_replica::mem::MemStore;
    use mdbn_replica::store::{FileLocal, RecordMeta, Tx};
    use mdbn_wire::attachment::{AttachmentContentV1, AttachmentRefV1};
    use mdbn_wire::common::B32;
    use mdbn_wire::intent::MediaClass;

    fn req(records: &[[u8; 16]], files: &[[u8; 16]]) -> Vec<u8> {
        let list =
            |ids: &[[u8; 16]]| Cbor::Array(ids.iter().map(|i| Cbor::Bytes(i.to_vec())).collect());
        cbor::encode(&Cbor::Array(vec![list(records), list(files)])).unwrap()
    }

    fn record(id: u8, doc: &str) -> RecordRow {
        RecordRow {
            id: B16([id; 16]),
            path: format!("private/{id}.md"),
            path_key: format!("private/{id}.md"),
            doc: doc.into(),
            revision: mdbn_wire::hash::sha256(doc.as_bytes()),
            modified_seq: 1,
            bucket: 0,
            meta: RecordMeta::default(),
        }
    }

    fn file(id: u8, content: FileContent) -> FileRow {
        FileRow {
            kind: FileKindV1::Ordinary,
            id: B16([id; 16]),
            path: "private/photo.png".into(),
            path_key: "private/photo.png".into(),
            content,
            media: MediaClass::Other,
            modified_seq: 1,
            mtime: None,
            bucket: 0,
            local: FileLocal::Remote,
        }
    }

    fn attachment(hash: u8, size: u64) -> FileContent {
        FileContent::AttachmentV1(AttachmentContentV1 {
            reference: AttachmentRefV1 {
                collection: B16([9; 16]),
                key_epoch: 1,
                attachment_id: B32([8; 32]),
                manifest_cipher_hash: B32([7; 32]),
            },
            whole_plain_hash: B32([hash; 32]),
            total_plain_bytes: size,
        })
    }

    fn store() -> MemStore {
        let mut s = MemStore::new();
        s.commit(Tx {
            records_put: vec![record(1, "secret one"), record(2, "secret two")],
            files_put: vec![file(5, attachment(0x55, 4096))],
            ..Tx::default()
        })
        .unwrap();
        s
    }

    #[test]
    fn answers_digests_and_sizes_only_in_request_order() {
        let s = store();
        let out = answer(&s, &req(&[[2; 16], [3; 16], [1; 16]], &[[5; 16]])).unwrap();
        let Cbor::Array(parts) = cbor::decode(&out).unwrap() else {
            panic!()
        };
        let rev = |d: &str| Cbor::Bytes(mdbn_wire::hash::sha256(d.as_bytes()).0.to_vec());
        let id = |n: u8| Cbor::Bytes(vec![n; 16]);
        assert_eq!(
            parts[0],
            Cbor::Array(vec![
                Cbor::Array(vec![
                    id(2),
                    Cbor::Uint(PRESENT),
                    rev("secret two"),
                    Cbor::Uint(10)
                ]),
                Cbor::Array(vec![id(3), Cbor::Uint(MISSING), Cbor::Null, Cbor::Null]),
                Cbor::Array(vec![
                    id(1),
                    Cbor::Uint(PRESENT),
                    rev("secret one"),
                    Cbor::Uint(10)
                ]),
            ])
        );
        assert_eq!(
            parts[1],
            Cbor::Array(vec![Cbor::Array(vec![
                id(5),
                Cbor::Uint(PRESENT),
                Cbor::Bytes(vec![0x55; 32]),
                Cbor::Uint(4096)
            ])])
        );
        // No document or path bytes anywhere in the reply.
        for needle in [&b"secret"[..], b"private"] {
            assert!(!out.windows(needle.len()).any(|w| w == needle));
        }
    }

    #[test]
    fn non_attachment_files_are_unsupported_not_guessed() {
        let mut s = MemStore::new();
        let mut legacy = file(6, attachment(1, 1));
        legacy.kind = FileKindV1::UnindexedOversizedMarkdown;
        s.commit(Tx {
            files_put: vec![legacy],
            ..Tx::default()
        })
        .unwrap();
        let out = answer(&s, &req(&[], &[[6; 16]])).unwrap();
        let Cbor::Array(parts) = cbor::decode(&out).unwrap() else {
            panic!()
        };
        assert_eq!(
            parts[1],
            Cbor::Array(vec![Cbor::Array(vec![
                Cbor::Bytes(vec![6; 16]),
                Cbor::Uint(UNSUPPORTED),
                Cbor::Null,
                Cbor::Null
            ])])
        );
    }

    #[test]
    fn requests_are_bounded_and_exact() {
        let s = store();
        for bad in [
            req(&[], &[]),
            req(&[[1; 16], [1; 16]], &[]),
            req(&[[1; 16], [2; 16], [3; 16], [4; 16], [6; 16], [7; 16]], &[]),
            req(&[], &[[5; 16], [6; 16]]),
            req(&[[0; 16]], &[]),
            cbor::encode(&Cbor::Array(vec![
                Cbor::Array(vec![Cbor::Bytes(vec![1; 15])]),
                Cbor::Array(vec![]),
            ]))
            .unwrap(),
            cbor::encode(&Cbor::Array(vec![Cbor::Array(vec![])])).unwrap(),
            b"junk".to_vec(),
        ] {
            assert_eq!(answer(&s, &bad), Err(SampleError::Invalid));
        }
    }
}

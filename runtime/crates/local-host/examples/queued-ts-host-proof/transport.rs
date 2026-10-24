//! Private fixture encoding ONLY; no exported runtime or public RPC surface.
use mdbn_store_file::host::{FileOp, FileOpOutput, FileOpResult};
use mdbn_store_file::platform::{
    DirEntry, FileKind, FileMeta, FlushScope, FsError, FsErrorKind, Guarded, Holders, RangeHandle,
    ReadResult,
};
use serde_json::{Value, json};
pub(super) fn request(op: FileOp) -> Value {
    match op {
        FileOp::Stat { path } => json!({"op":"Stat","path":path.as_str()}),
        FileOp::Read { path } => json!({"op":"Read","path":path.as_str()}),
        FileOp::ReadRange { path, offset, len } => {
            json!({"op":"ReadRange","path":path.as_str(),"offset":offset,"len":len})
        }
        FileOp::OpenRangeRead { path } => json!({"op":"OpenRangeRead","path":path.as_str()}),
        FileOp::ReadAt {
            handle,
            offset,
            len,
        } => json!({"op":"ReadAt","handle":handle.0.to_string(),"offset":offset,"len":len}),
        FileOp::RangeMeta { handle } => json!({"op":"RangeMeta","handle":handle.0.to_string()}),
        FileOp::CloseRangeRead { handle } => {
            json!({"op":"CloseRangeRead","handle":handle.0.to_string()})
        }
        FileOp::List { dir } => json!({"op":"List","dir":dir.as_str()}),
        FileOp::CreateDirAll { dir } => json!({"op":"CreateDirAll","dir":dir.as_str()}),
        FileOp::WriteNew {
            path,
            bytes,
            durable,
        } => json!({"op":"WriteNew","path":path.as_str(),"bytes":bytes,"durable":durable}),
        FileOp::RemoveFile { path } => json!({"op":"RemoveFile","path":path.as_str()}),
        FileOp::RenameNoreplace { from, to } => {
            json!({"op":"RenameNoreplace","from":from.as_str(),"to":to.as_str()})
        }
        FileOp::OtherHolders { path } => json!({"op":"OtherHolders","path":path.as_str()}),
        FileOp::GuardedCreate { path, bytes } => {
            json!({"op":"GuardedCreate","path":path.as_str(),"bytes":bytes})
        }
        FileOp::GuardedReplace { path, expect, new } => {
            json!({"op":"GuardedReplace","path":path.as_str(),"expect":expect,"new":new})
        }
        FileOp::GuardedTrash { path, expect } => {
            json!({"op":"GuardedTrash","path":path.as_str(),"expect":expect})
        }
        FileOp::Flush { scope } => {
            json!({"op":"Flush","scope":match scope { FlushScope::Full=>json!({"kind":"Full"}),FlushScope::Barrier=>json!({"kind":"Barrier"}),FlushScope::File(path)=>json!({"kind":"File","path":path.as_str()}),FlushScope::Dir(path)=>json!({"kind":"Dir","path":path.as_str()}) }})
        }
        op => panic!("unexpected original fixture operation: {op:?}"),
    }
}
fn kind(v: &Value) -> FileKind {
    match v.as_str().unwrap() {
        "File" => FileKind::File,
        "Dir" => FileKind::Dir,
        "Other" => FileKind::Other,
        _ => panic!("bad fixture file kind"),
    }
}
fn bytes(v: &Value) -> Vec<u8> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|b| u8::try_from(b.as_u64().unwrap()).unwrap())
        .collect()
}
fn meta(v: &Value) -> FileMeta {
    assert!(
        v["id"].is_null(),
        "whole-file vault provider never invents inode identity"
    );
    FileMeta {
        kind: kind(&v["kind"]),
        size: v["size"].as_u64().unwrap(),
        mtime_ns: v["mtimeNs"].as_str().unwrap().parse().unwrap(),
        ctime_ns: if v["ctimeNs"].is_null() {
            None
        } else {
            Some(v["ctimeNs"].as_str().unwrap().parse().unwrap())
        },
        id: None,
    }
}
pub(super) fn completion(done: &Value) -> FileOpResult {
    assert_eq!(done["kind"], "File");
    let result = &done["result"];
    if result["ok"] != true {
        let kind = match result["error"]["kind"].as_str().unwrap() {
            "NotFound" => FsErrorKind::NotFound,
            "AlreadyExists" => FsErrorKind::AlreadyExists,
            "Busy" => FsErrorKind::Busy,
            "WrongKind" => FsErrorKind::WrongKind,
            "PermissionDenied" => FsErrorKind::PermissionDenied,
            "NoSpace" => FsErrorKind::NoSpace,
            "InvalidPath" => FsErrorKind::InvalidPath,
            "Unsupported" => FsErrorKind::Unsupported,
            "BadHandle" => FsErrorKind::BadHandle,
            "Other" => FsErrorKind::Other,
            _ => panic!("bad original host error"),
        };
        return Err(FsError::new(
            kind,
            result["error"]["detail"].as_str().unwrap(),
        ));
    }
    let output = &result["value"];
    let v = &output["value"];
    Ok(match output["kind"].as_str().unwrap() {
        "Unit" => FileOpOutput::Unit,
        "Meta" => FileOpOutput::Meta(meta(v)),
        "Read" => FileOpOutput::Read(ReadResult {
            bytes: bytes(&v["bytes"]),
            meta: meta(&v["meta"]),
        }),
        "Range" => FileOpOutput::Range {
            handle: RangeHandle(v["handle"].as_str().unwrap().parse().unwrap()),
            meta: meta(&v["meta"]),
        },
        "Bytes" => FileOpOutput::Bytes(bytes(v)),
        "Entries" => FileOpOutput::Entries(
            v.as_array()
                .unwrap()
                .iter()
                .map(|v| DirEntry {
                    name: v["name"].as_str().unwrap().into(),
                    kind: kind(&v["kind"]),
                })
                .collect(),
        ),
        "Guarded" => FileOpOutput::Guarded(match v["kind"].as_str().unwrap() {
            "Done" => Guarded::Done,
            "Exists" => Guarded::Exists,
            "Missing" => Guarded::Missing,
            "Mismatch" => Guarded::Mismatch(bytes(&v["current"])),
            _ => panic!("bad original guarded outcome"),
        }),
        "Holders" => FileOpOutput::Holders(match v.as_str().unwrap() {
            "None" => Holders::None,
            "Some" => Holders::Some,
            "Unknown" => Holders::Unknown,
            _ => panic!("bad original holder state"),
        }),
        _ => panic!("unexpected original fixture output"),
    })
}

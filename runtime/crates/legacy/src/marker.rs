//! `.mdbase/connect-role.json`, the folder role marker.
//!
//! - **v1** (`MC/crates/connect-core/src/registry/identity.rs:11-64`): a hosted
//!   mirror, `{"version":1,"role":"mirror","collection_id":<uuid>}`.
//! - **v2** (local takeover marker): claimed by mdbase-next,
//!   `{"version":2,"role":"replica","collection":<uuid>,"replica_id":<uuid>,
//!   "runtime":"mdbase-next","claimed_at":…,"notice":…}`. It has no `collection_id`
//!   key, so every old reader fails closed, and an old `mirror remove` can't delete it.
//!
//! This module only *recognises* markers. Writing the v2 marker belongs to the file
//! layer, which also watches it (migration request protocol).

use std::path::Path;

use crate::{Error, Result, is_uuid};

/// What a folder's marker says.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Marker {
    /// No `.mdbase/connect-role.json`: an ordinary (local-authority or unmanaged)
    /// folder.
    Absent,
    /// A v1 hosted-mirror marker.
    Mirror {
        /// The hosted collection ID.
        collection_id: String,
    },
    /// A v2 claim by mdbase-next.
    Claimed {
        /// The collection ID.
        collection: String,
        /// The claiming replica.
        replica_id: String,
    },
    /// Present but neither of the above. Old connectors fail closed on it, and so does
    /// migration: the folder is reported, not adopted.
    Invalid(String),
}

/// Read the marker under `root`.
pub fn read(root: &Path) -> Result<Marker> {
    let dir = root.join(".mdbase");
    match std::fs::symlink_metadata(&dir) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Marker::Absent),
        Err(e) => return Err(Error::io(&dir, e)),
        Ok(m) if !m.is_dir() => {
            return Ok(Marker::Invalid(".mdbase is not a directory".into()));
        }
        Ok(_) => {}
    }
    let path = dir.join("connect-role.json");
    let meta = match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Marker::Absent),
        Err(e) => return Err(Error::io(&path, e)),
        Ok(m) => m,
    };
    if !meta.is_file() {
        return Ok(Marker::Invalid("marker is not a regular file".into()));
    }
    let bytes = std::fs::read(&path).map_err(|e| Error::io(&path, e))?;
    Ok(parse(&bytes))
}

/// Classify marker bytes.
pub fn parse(bytes: &[u8]) -> Marker {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) else {
        return Marker::Invalid("not JSON".into());
    };
    let Some(obj) = v.as_object() else {
        return Marker::Invalid("not a JSON object".into());
    };
    let s = |k: &str| obj.get(k).and_then(|x| x.as_str());
    match (obj.get("version").and_then(|x| x.as_u64()), s("role")) {
        (Some(1), Some("mirror")) => match s("collection_id") {
            Some(id) if is_uuid(id) => Marker::Mirror {
                collection_id: id.to_owned(),
            },
            _ => Marker::Invalid("v1 marker without a valid collection_id".into()),
        },
        (Some(2), Some("replica")) => {
            if obj.contains_key("collection_id") {
                // Would be deletable by an old `mirror remove` (legacy reader compatibility).
                return Marker::Invalid("v2 marker must not carry collection_id".into());
            }
            match (s("collection"), s("replica_id")) {
                (Some(c), Some(r)) if is_uuid(c) && is_uuid(r) => Marker::Claimed {
                    collection: c.to_owned(),
                    replica_id: r.to_owned(),
                },
                _ => Marker::Invalid("v2 marker without valid collection/replica_id".into()),
            }
        }
        _ => Marker::Invalid("unsupported version or role".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str = "4c18af2e-b04a-4b77-b83e-493c3695962e";
    const R: &str = "0b9f3e7a-3c51-4a8e-9d2f-6e1b2c3d4e5f";

    #[test]
    fn recognises_v1_and_v2() {
        let v1 = format!(r#"{{"version":1,"role":"mirror","collection_id":"{C}"}}"#);
        assert_eq!(
            parse(v1.as_bytes()),
            Marker::Mirror {
                collection_id: C.into()
            }
        );
        let v2 = format!(
            r#"{{"version":2,"role":"replica","collection":"{C}","replica_id":"{R}","runtime":"mdbase-next","claimed_at":"2026-10-04T01:30:00Z","notice":"…"}}"#
        );
        assert_eq!(
            parse(v2.as_bytes()),
            Marker::Claimed {
                collection: C.into(),
                replica_id: R.into()
            }
        );
    }

    /// The legacy marker compatibility table, plus a v2 marker that wrongly keeps `collection_id`.
    #[test]
    fn malformed_markers_are_invalid() {
        for bad in [
            r#"{"version":2,"role":"replica"}"#.to_owned(),
            "{broken".to_owned(),
            String::new(),
            format!(r#"{{"version":1,"role":"replica","collection_id":"{C}"}}"#),
            format!(r#"{{"version":"2","role":"replica","collection":"{C}","replica_id":"{R}"}}"#),
            format!(r#"{{"version":300,"role":"replica","collection":"{C}","replica_id":"{R}"}}"#),
            format!(
                r#"{{"version":2,"role":"replica","collection":"{C}","collection_id":"{C}","replica_id":"{R}"}}"#
            ),
        ] {
            assert!(matches!(parse(bad.as_bytes()), Marker::Invalid(_)), "{bad}");
        }
    }
}

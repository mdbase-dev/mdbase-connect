// A strict fake of the log service's object API: it enforces the 1 MiB inline cap,
// hands out a direct transfer for anything larger, checks the uploaded bytes against
// the declared checksum, and shows an object only after `commit_object`.

use std::collections::BTreeMap;

use super::{INLINE_MAX, ObjectStore};
use mdbn_wire::common::{B32, DataMap, Hash, Uuid};
use mdbn_wire::log_service::{
    CommitObjectParams, DirectTransfer, PutObjectParams, PutObjectResult, PutStatus,
};

/// A staged direct transfer: collection, address, size, checksum, uploaded bytes.
type Staged = (Uuid, B32, u64, Hash, Option<Vec<u8>>);

#[derive(Default)]
pub struct StrictStore {
    committed: BTreeMap<(Uuid, B32), Vec<u8>>,
    staged: BTreeMap<String, Staged>,
    pub inline_puts: u64,
    pub direct_puts: u64,
}

impl StrictStore {
    pub fn objects(&self, collection: &Uuid) -> Vec<(B32, Vec<u8>)> {
        self.committed
            .iter()
            .filter(|((c, _), _)| c == collection)
            .map(|((_, a), b)| (*a, b.clone()))
            .collect()
    }
}

impl ObjectStore for StrictStore {
    fn has_objects(&mut self, c: &Uuid, addrs: &[B32]) -> Result<Vec<bool>, String> {
        if addrs.len() > 1024 {
            return Err("too many addresses".into());
        }
        Ok(addrs
            .iter()
            .map(|a| self.committed.contains_key(&(*c, *a)))
            .collect())
    }

    fn put_object(&mut self, p: PutObjectParams) -> Result<PutObjectResult, String> {
        if self.committed.contains_key(&(p.collection, p.address)) {
            return Ok(PutObjectResult {
                status: PutStatus::Exists,
                direct: None,
            });
        }
        match p.bytes {
            Some(b) => {
                if b.0.len() > INLINE_MAX {
                    return Err("inline object over 1 MiB".into());
                }
                if b.0.len() as u64 != p.size || mdbn_wire::hash::sha256(&b.0) != p.checksum {
                    return Err("inline checksum".into());
                }
                self.inline_puts += 1;
                self.committed.insert((p.collection, p.address), b.0);
                Ok(PutObjectResult {
                    status: PutStatus::Stored,
                    direct: None,
                })
            }
            None => {
                let url = format!("https://r2.test/{}", p.address.to_hex());
                self.staged.insert(
                    url.clone(),
                    (p.collection, p.address, p.size, p.checksum, None),
                );
                Ok(PutObjectResult {
                    status: PutStatus::Upload,
                    direct: Some(DirectTransfer {
                        url,
                        headers: DataMap(Vec::new()),
                        expires_at: 0,
                    }),
                })
            }
        }
    }

    fn upload_direct(&mut self, d: &DirectTransfer, bytes: &[u8]) -> Result<(), String> {
        let s = self.staged.get_mut(&d.url).ok_or("unknown transfer")?;
        if bytes.len() as u64 != s.2 || mdbn_wire::hash::sha256(bytes) != s.3 {
            return Err("direct upload checksum".into());
        }
        s.4 = Some(bytes.to_vec());
        self.direct_puts += 1;
        Ok(())
    }

    fn commit_object(&mut self, p: CommitObjectParams) -> Result<(), String> {
        let url = format!("https://r2.test/{}", p.address.to_hex());
        let (c, a, _, _, bytes) = self.staged.remove(&url).ok_or("nothing to commit")?;
        let bytes = bytes.ok_or("commit before upload")?;
        if c != p.collection || a != p.address {
            return Err("commit mismatch".into());
        }
        self.committed.insert((c, a), bytes);
        Ok(())
    }
}

/// Incompressible bytes, so sealed parts keep their size.
pub fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut out = Vec::with_capacity(len + 8);
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

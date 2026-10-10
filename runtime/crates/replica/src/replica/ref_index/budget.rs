//! Allocation-free decode admission for clear ref-index envelopes/payloads.
//! This only budgets structure; the existing Wire decoder verifies canonical
//! encoding, kind, collection, shape, ordering and content address afterwards.

pub(super) const MAX_OBJECT_BYTES: usize = 1 << 20;
const ENVELOPE_NODES: usize = 64;
const PAYLOAD_NODES: usize = 16;
const MAX_DEPTH: usize = 16;

struct Scan<'a> {
    bytes: &'a [u8],
    pos: usize,
    nodes: usize,
}

impl<'a> Scan<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        let end = self.pos.checked_add(n).ok_or("ref-index decode budget")?;
        let value = self.bytes.get(self.pos..end).ok_or("ref-index truncated")?;
        self.pos = end;
        Ok(value)
    }

    fn head(&mut self) -> Result<(u8, u64), &'static str> {
        if self.nodes == 0 {
            return Err("ref-index decode budget");
        }
        self.nodes -= 1;
        let byte = self.take(1)?[0];
        let major = byte >> 5;
        let ai = byte & 31;
        let n = match ai {
            0..=23 => u64::from(ai),
            24..=27 => {
                let raw = self.take(1 << (ai - 24))?;
                raw.iter().fold(0u64, |n, b| (n << 8) | u64::from(*b))
            }
            _ => return Err("ref-index unsupported structure"),
        };
        if major == 7 && !matches!(ai, 20..=22 | 27) {
            return Err("ref-index unsupported structure");
        }
        Ok((major, n))
    }

    fn value(&mut self, depth: usize) -> Result<(), &'static str> {
        let head = self.head()?;
        self.after_head(head, depth)
    }

    fn after_head(&mut self, (major, n): (u8, u64), depth: usize) -> Result<(), &'static str> {
        if depth > MAX_DEPTH {
            return Err("ref-index decode depth budget");
        }
        match major {
            0 | 1 | 7 => Ok(()),
            2 | 3 => {
                let n = usize::try_from(n).map_err(|_| "ref-index decode budget")?;
                self.take(n).map(|_| ())
            }
            4 | 5 => {
                let n = usize::try_from(n).map_err(|_| "ref-index decode budget")?;
                let children = n
                    .checked_mul(if major == 5 { 2 } else { 1 })
                    .ok_or("ref-index decode budget")?;
                // Check declared container allocation BEFORE descending, even
                // for a malformed/truncated body with only one encoded child.
                if children > self.nodes {
                    return Err("ref-index decode budget");
                }
                for _ in 0..children {
                    self.value(depth + 1)?;
                }
                Ok(())
            }
            _ => Err("ref-index unsupported structure"),
        }
    }
}

pub(super) fn preflight(bytes: &[u8]) -> Result<(), &'static str> {
    if bytes.len() > MAX_OBJECT_BYTES {
        return Err("ref-index object byte budget");
    }
    let mut envelope = Scan {
        bytes,
        pos: 0,
        nodes: ENVELOPE_NODES,
    };
    let (major, fields) = envelope.head()?;
    if major != 5 || fields > (ENVELOPE_NODES / 2) as u64 {
        return Err("ref-index envelope structure budget");
    }
    let mut body = None;
    for _ in 0..fields {
        let (major, key) = envelope.head()?;
        if major != 0 {
            return Err("ref-index envelope key structure");
        }
        let value = envelope.head()?;
        if key == 11 {
            if body.is_some() || value.0 != 2 {
                return Err("ref-index body structure");
            }
            let len = usize::try_from(value.1).map_err(|_| "ref-index decode budget")?;
            body = Some(envelope.take(len)?);
        } else {
            envelope.after_head(value, 1)?;
        }
    }
    if envelope.pos != bytes.len() {
        return Err("ref-index trailing bytes");
    }
    let bytes = body.ok_or("ref-index body missing")?;
    let mut payload = Scan {
        bytes,
        pos: 0,
        nodes: PAYLOAD_NODES,
    };
    payload.value(0)?;
    if payload.pos != bytes.len() {
        return Err("ref-index payload trailing bytes");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mdbn_wire::{
        common::{B16, B32},
        ref_index::ref_index_item,
        schema::Wire,
    };

    #[test]
    fn canonical_maximum_index_fits_and_raw_one_over_refuses() {
        let refs: Vec<_> = (0u64..8192)
            .map(|i| {
                let mut a = [0u8; 32];
                a[..8].copy_from_slice(&i.to_be_bytes());
                B32(a)
            })
            .collect();
        let raw = ref_index_item(B16([3; 16]), &refs)
            .unwrap()
            .to_bytes()
            .unwrap();
        assert!(preflight(&raw).is_ok());
        assert!(preflight(&vec![0; MAX_OBJECT_BYTES + 1]).is_err());
    }

    #[test]
    fn advertised_container_limits_refuse_before_recursive_decode() {
        let mut scan = Scan {
            bytes: &[0x98, 65],
            pos: 0,
            nodes: 64,
        };
        assert_eq!(scan.value(0), Err("ref-index decode budget"));
        let mut scan = Scan {
            bytes: &[0xb8, 33],
            pos: 0,
            nodes: 64,
        };
        assert_eq!(scan.value(0), Err("ref-index decode budget"));
    }
}

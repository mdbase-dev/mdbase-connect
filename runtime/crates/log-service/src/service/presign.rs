//! Pre-signed direct-transfer URLs: signing, parsing and verification.

use super::*;

/// Base64 (standard, padded), for the checksum header.
pub fn base64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16
            | (*c.get(1).unwrap_or(&0) as u32) << 8
            | *c.get(2).unwrap_or(&0) as u32;
        s.push(T[(n >> 18) as usize & 63] as char);
        s.push(T[(n >> 12) as usize & 63] as char);
        s.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        s.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    s
}

/// A verified direct-transfer request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectOp {
    /// `put` or `get`.
    pub put: bool,
    /// Collection.
    pub collection: Uuid,
    /// Address.
    pub address: B32,
    /// MAC-bound complete encoded-object size for both PUT and GET.
    pub sealed_size: u64,
    /// MAC-bound SHA-256 of the complete encoded object (not a range hash).
    pub sealed_checksum: B32,
    /// MAC-bound expiry, retained for bounded multipart session binding.
    pub expires_ms: i64,
    /// For `put`: the exact size and checksum the body must have.
    pub expect: Option<(u64, B32)>,
    /// For `put`: the uploading device. The bytes go to its staging key
    /// ([`staging_key`]), never to the object's final key.
    pub device: Option<Uuid>,
    /// MAC-bound region of the collection: which bucket holds the bytes.
    /// `None` is the host's original bucket.
    pub region: Option<Region>,
}

/// Where a device's direct upload lands until `commit_object` verifies it and
/// copies it, write-once, to the final key. Staging is per device, so a stale or
/// revoked device's URL can never touch a committed object or another device's
/// upload. Staging keys expire by object-store lifecycle (24 h).
pub fn staging_key(c: &Uuid, a: &B32, device: &Uuid) -> String {
    format!(
        "staging/c/{}/{}/{}",
        c.to_uuid_string(),
        a.to_hex(),
        device.to_hex()
    )
}

#[allow(clippy::too_many_arguments)]
fn direct_mac(
    secret: &[u8],
    op: &str,
    c: &Uuid,
    a: &B32,
    dev: &str,
    size: u64,
    ck: &B32,
    exp: i64,
    region: Option<Region>,
) -> [u8; 32] {
    let mut m = format!(
        "ls-direct|{op}|{}|{}|{dev}|{size}|{}|{exp}",
        c.to_hex(),
        a.to_hex(),
        ck.to_hex()
    );
    // Regionless URLs keep the original message, so they stay valid unchanged.
    if let Some(r) = region {
        m.push_str("|r=");
        m.push_str(r.as_str());
    }
    hmac(secret, m.as_bytes())
}

/// Parse `bytes=a-b` into `(offset, len)`, rejecting reversed, overflowing or
/// over-long ranges (≤ 9 MiB, the largest object).
pub fn parse_range(h: &str) -> Option<(u64, u64)> {
    let (a, b) = h.strip_prefix("bytes=")?.split_once('-')?;
    let (a, b): (u64, u64) = (a.trim().parse().ok()?, b.trim().parse().ok()?);
    let len = b.checked_sub(a)?.checked_add(1)?;
    (len <= MAX_OBJECT_BYTES).then_some((a, len))
}

/// Constant-time equality.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Verify a direct-transfer URL: `/v1/o/<collection>/<address>?op=&size=&ck=&exp=&sig=`.
pub fn verify_direct(
    secret: &[u8],
    collection: &str,
    address: &str,
    query: &str,
    now: i64,
) -> Result<DirectOp> {
    let forbidden = || ServiceError::reason(Code::Forbidden, "url");
    let q: BTreeMap<&str, &str> = query
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .collect();
    let c = parse_uuid(collection).ok_or_else(forbidden)?;
    let a = B32(unhex(address)
        .and_then(|v| v.try_into().ok())
        .ok_or_else(forbidden)?);
    let op = *q.get("op").ok_or_else(forbidden)?;
    let size: u64 = q
        .get("size")
        .and_then(|s| s.parse().ok())
        .ok_or_else(forbidden)?;
    let ck = B32(q
        .get("ck")
        .and_then(|s| unhex(s))
        .and_then(|v| v.try_into().ok())
        .ok_or_else(forbidden)?);
    let exp: i64 = q
        .get("exp")
        .and_then(|s| s.parse().ok())
        .ok_or_else(forbidden)?;
    let dev = q.get("dev").copied().unwrap_or("");
    let region = match q.get("r") {
        Some(r) => Some(Region::parse(r).ok_or_else(forbidden)?),
        None => None,
    };
    let sig = q.get("sig").and_then(|s| unhex(s)).ok_or_else(forbidden)?;
    let want = direct_mac(secret, op, &c, &a, dev, size, &ck, exp, region);
    if exp < now || !ct_eq(&want, &sig) {
        return Err(forbidden());
    }
    let device = match op {
        "put" => Some(B16(unhex(dev)
            .and_then(|v| v.try_into().ok())
            .ok_or_else(forbidden)?)),
        "get" => None,
        _ => return Err(forbidden()),
    };
    Ok(DirectOp {
        put: op == "put",
        collection: c,
        address: a,
        sealed_size: size,
        sealed_checksum: ck,
        expires_ms: exp,
        expect: (op == "put").then_some((size, ck)),
        device,
        region,
    })
}

impl<B: Backend, O: ObjectStore> Service<B, O> {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn direct(
        &self,
        region: Option<Region>,
        uploader: Option<&Uuid>,
        c: &Uuid,
        a: &B32,
        size: u64,
        ck: &B32,
        now: i64,
    ) -> DirectTransfer {
        let exp = now + DIRECT_TTL_MS;
        let put = uploader.is_some();
        let op = if put { "put" } else { "get" };
        let dev = uploader.map(|d| d.to_hex()).unwrap_or_default();
        let sig = direct_mac(
            &self.config.url_secret,
            op,
            c,
            a,
            &dev,
            size,
            ck,
            exp,
            region,
        );
        let r = region.map_or(String::new(), |r| format!("&r={}", r.as_str()));
        let url = format!(
            "{}/v1/o/{}/{}?op={op}&dev={dev}&size={size}&ck={}&exp={exp}{r}&sig={}",
            self.config.public_base.trim_end_matches('/'),
            c.to_uuid_string(),
            a.to_hex(),
            ck.to_hex(),
            mdbn_wire::render::hex(&sig)
        );
        let headers = if put {
            vec![("x-amz-checksum-sha256".to_string(), base64(&ck.0))]
        } else {
            vec![]
        };
        DirectTransfer {
            url,
            headers: DataMap(headers),
            expires_at: exp,
        }
    }
}

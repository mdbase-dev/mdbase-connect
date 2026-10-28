//! Browser transport visibility, never RPC/grant authority. Every origin may read
//! responses (`Access-Control-Allow-Origin: *`, never credentials or cookies): the
//! log carries no ambient authority. Every RPC needs a bearer log token plus a
//! nonce signature, and `GET /v1/nonce` is public by design, so an origin list
//! only blocked legitimate browser apps (staging, production, registered SDK apps).
use worker::{Headers, Response, Result};

const METHODS: &str = "GET, POST, PUT";
const HEADERS: &str =
    "authorization, content-type, x-mdbase-nonce, x-mdbase-sig, range, x-amz-checksum-sha256";
const EXPOSE: &str =
    "content-length, content-range, etag, x-amz-checksum-sha256, x-mdbase-next-nonce";
/// Response header carrying a fresh stateless nonce for the caller's NEXT signed
/// RPC, minted exactly like `GET /v1/nonce`. It saves that extra request; it is
/// not authority (anyone may mint one) and single use stays enforced by the actor.
pub const NEXT_NONCE: &str = "x-mdbase-next-nonce";
/// Browsers cache an allowed preflight this long (Chrome caps at 7200 s). The
/// permitted method/header set is fixed.
const MAX_AGE: &str = "7200";

fn permits_preflight(method: Option<&str>, headers: Option<&str>) -> bool {
    if !matches!(method, Some("GET" | "POST" | "PUT")) {
        return false;
    }
    let Some(headers) = headers else {
        return true;
    };
    if headers.len() > 2048 {
        return false;
    }
    // A fixed header list, not arbitrary echoed request headers.
    let mut count = 0;
    headers.split(',').all(|h| {
        count += 1;
        count <= 16
            && HEADERS
                .split(',')
                .any(|allowed| allowed.trim().eq_ignore_ascii_case(h.trim()))
    })
}

pub fn preflight(method: Option<&str>, requested_headers: Option<&str>) -> Result<Response> {
    let allowed = permits_preflight(method, requested_headers);
    let headers = Headers::new();
    headers.set(
        "vary",
        "Access-Control-Request-Method, Access-Control-Request-Headers",
    )?;
    headers.set("cache-control", "no-store")?;
    if allowed {
        headers.set("access-control-allow-origin", "*")?;
        headers.set("access-control-allow-methods", METHODS)?;
        headers.set("access-control-allow-headers", HEADERS)?;
        headers.set("access-control-max-age", MAX_AGE)?;
    }
    // No body read, config secrets, auth/nonce handling, DO lookup or R2 call.
    Ok(Response::empty()?
        .with_status(if allowed { 204 } else { 403 })
        .with_headers(headers))
}

/// `next_nonce` is set only on signed-RPC routes; any upstream value is dropped.
pub fn decorate(response: Response, next_nonce: Option<&str>) -> Result<Response> {
    // Fetch/DO response headers can be immutable. Copy only headers, preserving
    // the original status/body stream/WebSocket and without buffering content.
    let headers = response.headers().clone();
    for name in [
        "access-control-allow-origin",
        "access-control-allow-credentials",
        "access-control-allow-methods",
        "access-control-allow-headers",
        "access-control-expose-headers",
        "access-control-max-age",
        NEXT_NONCE,
    ] {
        headers.delete(name)?;
    }
    if let Some(nonce) = next_nonce {
        headers.set(NEXT_NONCE, nonce)?;
    }
    headers.set("access-control-allow-origin", "*")?;
    headers.set("access-control-expose-headers", EXPOSE)?;
    Ok(response.with_headers(headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preflight_has_fixed_method_and_header_permissions() {
        assert!(permits_preflight(
            Some("POST"),
            Some("Authorization, Content-Type, X-Mdbase-Nonce, X-Mdbase-Sig")
        ));
        assert!(permits_preflight(
            Some("PUT"),
            Some("x-amz-checksum-sha256")
        ));
        assert!(permits_preflight(Some("GET"), None));
        for method in [None, Some("DELETE"), Some("post")] {
            assert!(!permits_preflight(method, None));
        }
        for headers in [
            "x-arbitrary",
            "authorization,",
            "",
            "x-mdbase-sig, cookie",
            "x-logsvc-decode-nodes",
        ] {
            assert!(!permits_preflight(Some("POST"), Some(headers)));
        }
        assert!(!permits_preflight(Some("POST"), Some(&"x".repeat(2049))));
    }
}

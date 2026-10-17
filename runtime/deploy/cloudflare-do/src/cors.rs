//! Browser transport visibility, never RPC/grant authority. No wildcard or cookies.
use worker::{Headers, Response, Result, Url};

pub const ENV: &str = "LOGSVC_CORS_ORIGINS";
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
/// permitted origin/method/header set is fixed per deployment.
const MAX_AGE: &str = "7200";

/// An exact `capacitor://<lowercase host>` (iOS app) or
/// `chrome-extension://<32-letter id>` origin. Their WHATWG origin is opaque, so
/// the configured string itself is the canonical form; no port, path or wildcard.
fn app_origin(origin: &str) -> bool {
    if let Some(host) = origin.strip_prefix("capacitor://") {
        return !host.is_empty()
            && host.len() <= 253
            && !host.starts_with(['.', '-'])
            && host
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-');
    }
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

pub struct Cors {
    origins: Vec<String>,
}

impl Cors {
    /// Comma-separated canonical HTTP(S), Capacitor iOS or Chrome extension origins. Absent/empty means disabled;
    /// malformed/oversized configuration refuses, never falls back to reflection.
    pub fn parse(raw: Option<&str>) -> std::result::Result<Self, ()> {
        let raw = raw.unwrap_or("");
        if raw.len() > 8192 {
            return Err(());
        }
        let mut origins = Vec::new();
        if !raw.trim().is_empty() {
            for origin in raw.split(',').map(str::trim) {
                if origins.len() == 32
                    || origin.len() > 256
                    || origin.contains('*')
                    || origins.iter().any(|x| x == origin)
                {
                    return Err(());
                }
                if !app_origin(origin) {
                    let url = Url::parse(origin).map_err(|_| ())?;
                    if !matches!(url.scheme(), "http" | "https")
                        || url.origin().ascii_serialization() != origin
                    {
                        return Err(());
                    }
                }
                origins.push(origin.to_owned());
            }
        }
        Ok(Self { origins })
    }

    /// A browser WebSocket upgrade is not subject to CORS: refuse a page origin
    /// outside the list. Native clients send no `Origin` and are unaffected.
    pub fn permits_upgrade(&self, origin: Option<&str>) -> bool {
        origin.is_none() || self.allowed(origin).is_some()
    }

    fn allowed(&self, origin: Option<&str>) -> Option<&str> {
        let origin = origin?;
        self.origins
            .iter()
            .find(|x| x.as_str() == origin)
            .map(String::as_str)
    }

    fn permits_preflight(
        &self,
        origin: Option<&str>,
        method: Option<&str>,
        headers: Option<&str>,
    ) -> bool {
        if self.allowed(origin).is_none() || !matches!(method, Some("GET" | "POST" | "PUT")) {
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

    pub fn preflight(
        &self,
        origin: Option<&str>,
        method: Option<&str>,
        requested_headers: Option<&str>,
    ) -> Result<Response> {
        let allowed = self.permits_preflight(origin, method, requested_headers);
        let headers = Headers::new();
        headers.set(
            "vary",
            "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        )?;
        headers.set("cache-control", "no-store")?;
        if allowed {
            headers.set(
                "access-control-allow-origin",
                self.allowed(origin).expect("preflight checked"),
            )?;
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
    pub fn decorate(
        &self,
        response: Response,
        origin: Option<&str>,
        next_nonce: Option<&str>,
    ) -> Result<Response> {
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
        let vary = headers.get("vary")?.unwrap_or_default();
        if !vary
            .split(',')
            .any(|v| v.trim().eq_ignore_ascii_case("origin") || v.trim() == "*")
        {
            headers.set(
                "vary",
                &if vary.is_empty() {
                    "Origin".into()
                } else {
                    format!("{vary}, Origin")
                },
            )?;
        }
        if let Some(allowed) = self.allowed(origin) {
            headers.set("access-control-allow-origin", allowed)?;
            headers.set("access-control-expose-headers", EXPOSE)?;
        }
        Ok(response.with_headers(headers))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const LAB: &str = "http://127.0.0.1:48218,https://lab.tasknotes-app.pages.dev";
    #[test]
    fn exact_origins_only() {
        let c = Cors::parse(Some(LAB)).unwrap();
        for origin in LAB.split(',') {
            assert_eq!(c.allowed(Some(origin)), Some(origin));
        }
        for origin in [
            "*",
            "null",
            "https://lab.tasknotes-app.pages.dev.evil.test",
            "https://lab.tasknotes-app.pages.dev/",
            "http://127.0.0.1:48219",
            "https://app.tasknotes.dev",
            "https://LAB.tasknotes-app.pages.dev",
            "https://lab.tasknotes-app.pages.dev https://evil.test",
        ] {
            assert_eq!(c.allowed(Some(origin)), None);
        }
        assert_eq!(c.allowed(None), None);
        assert_eq!(
            Cors::parse(None)
                .unwrap()
                .allowed(Some("https://app.tasknotes.dev")),
            None
        );
        assert_eq!(
            Cors::parse(Some("https://app.tasknotes.dev"))
                .unwrap()
                .allowed(Some("https://app.tasknotes.dev")),
            Some("https://app.tasknotes.dev")
        );
    }
    #[test]
    fn exact_native_app_and_extension_origins() {
        let ext = format!("chrome-extension://{}", "a".repeat(32));
        let raw = format!("https://app.tasknotes.dev,capacitor://app.tasknotes.dev,{ext}");
        let c = Cors::parse(Some(&raw)).unwrap();
        for origin in ["capacitor://app.tasknotes.dev", ext.as_str()] {
            assert_eq!(c.allowed(Some(origin)), Some(origin));
        }
        for origin in [
            "capacitor://evil.test",
            "capacitor://app.tasknotes.dev/",
            "capacitor://APP.tasknotes.dev",
            "ionic://app.tasknotes.dev",
            "https://app.tasknotes.dev.evil.test",
            &format!("chrome-extension://{}", "b".repeat(32)),
            &format!("{ext}/"),
        ] {
            assert_eq!(c.allowed(Some(origin)), None, "{origin}");
        }
        for raw in [
            "capacitor://",
            "capacitor://app.tasknotes.dev:8080",
            "capacitor://app.tasknotes.dev/x",
            "capacitor://u@app.tasknotes.dev",
            "capacitor://APP.tasknotes.dev",
            "capacitor://*.tasknotes.dev",
            "chrome-extension://not-an-extension-id",
            &format!("chrome-extension://{}", "q".repeat(32)),
            &format!("chrome-extension://{}", "A".repeat(32)),
            &format!("{ext}/"),
            "moz-extension://6f1c3d0e-8a8b-4c3e-9e0f-2a1b3c4d5e6f",
        ] {
            assert!(Cors::parse(Some(raw)).is_err(), "{raw}");
        }
    }
    #[test]
    fn invalid_configuration_closes() {
        for raw in [
            "*",
            "https://*.example.test",
            "http://*",
            "null",
            "https://a.test/",
            "https://u:p@a.test",
            "https://a.test?x=1",
            "https://a.test#x",
            "https://a.test,",
            "https://a.test,https://a.test",
            "file:///tmp",
            "https://a.test:443",
            "HTTPS://a.test",
        ] {
            assert!(Cors::parse(Some(raw)).is_err(), "{raw}");
        }
        assert!(Cors::parse(Some(&"x".repeat(8193))).is_err());
        assert!(
            Cors::parse(Some(
                &(0..33)
                    .map(|i| format!("https://{i}.test"))
                    .collect::<Vec<_>>()
                    .join(",")
            ))
            .is_err()
        );
    }
    #[test]
    fn preflight_has_fixed_method_and_header_permissions() {
        let c = Cors::parse(Some(LAB)).unwrap();
        let o = Some("http://127.0.0.1:48218");
        assert!(c.permits_preflight(
            o,
            Some("POST"),
            Some("Authorization, Content-Type, X-Mdbase-Nonce, X-Mdbase-Sig")
        ));
        assert!(c.permits_preflight(o, Some("PUT"), Some("x-amz-checksum-sha256")));
        assert!(c.permits_preflight(o, Some("GET"), None));
        for method in [None, Some("DELETE"), Some("post")] {
            assert!(!c.permits_preflight(o, method, None));
        }
        for headers in [
            "x-arbitrary",
            "authorization,",
            "",
            "x-mdbase-sig, cookie",
            "x-logsvc-decode-nodes",
        ] {
            assert!(!c.permits_preflight(o, Some("POST"), Some(headers)));
        }
        assert!(!c.permits_preflight(Some("https://evil.test"), Some("POST"), Some(HEADERS)));
        assert!(!c.permits_preflight(None, Some("POST"), Some(HEADERS)));
        assert!(!c.permits_preflight(o, Some("POST"), Some(&"x".repeat(2049))));
    }
}

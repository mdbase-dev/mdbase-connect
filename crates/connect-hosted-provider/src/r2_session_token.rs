//! Reading the expiry out of an R2 temporary credential.
//!
//! Extracted from `blob_store` so the decoding sits beside the tests that
//! establish the token's shape. The shape is the whole problem: the first
//! implementation guessed it, decoded nothing, and reported every expiring
//! credential as permanent.

/// Unix expiry carried by an R2 session token, if it has one.
///
/// The claim is read, not verified: this is a diagnostic and the authority on
/// validity is Cloudflare. An unreadable token yields `None` rather than an
/// error, because a diagnostic must not fail its caller.
///
/// `None` is therefore ambiguous — it means "permanent credential" as well as
/// "could not read this one". That ambiguity is why the decoding must be
/// right: a silent failure here is indistinguishable from the healthy case.
pub(crate) fn session_token_expiry(token: &str) -> Option<i64> {
    // The session token is not a bare JWT. A temporary credential wraps the
    // signed token as standard base64 of `jwt/<header>.<claims>.<signature>`
    // (`.github/scripts/r2_temporary_credential.mjs`). Splitting the outer
    // encoding on `.` finds no claims, which is why reading them directly
    // reported no expiry for every real credential.
    let unwrapped = base64_standard_decode(token)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|value| value.strip_prefix("jwt/").map(str::to_owned));
    // A bare JWT still decodes, so this reads whichever shape is configured
    // rather than assuming the wrapper is always present.
    let jwt = unwrapped.as_deref().unwrap_or(token);
    let claims = jwt.split('.').nth(1)?;
    let decoded = base64_url_decode(claims)?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    value.get("exp")?.as_i64()
}

fn base64_url_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .ok()
}

fn base64_standard_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.decode(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a token in the shape the minter actually emits. The previous test
    /// double was the literal `"temporary-session"`, which exercised no
    /// decoding at all, and is why a credential expiry that never decoded
    /// reached production.
    fn wrapped_session_token(expires_at: i64) -> String {
        use base64::Engine as _;
        let url = base64::engine::general_purpose::URL_SAFE_NO_PAD;
        let header = url.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let claims = url.encode(
            serde_json::json!({
                "bucket": "mdbase-connect-staging-files",
                "scope": "object-read-write",
                "exp": expires_at,
            })
            .to_string(),
        );
        let jwt = format!("{header}.{claims}.c2lnbmF0dXJl");
        base64::engine::general_purpose::STANDARD.encode(format!("jwt/{jwt}"))
    }

    #[test]
    fn reads_the_expiry_of_a_wrapped_temporary_credential() {
        assert_eq!(
            session_token_expiry(&wrapped_session_token(1_756_000_000)),
            Some(1_756_000_000)
        );
    }

    #[test]
    fn reads_the_expiry_of_a_bare_jwt() {
        use base64::Engine as _;
        let claims =
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(r#"{"exp":1756000001}"#);
        assert_eq!(
            session_token_expiry(&format!("aGVhZGVy.{claims}.c2ln")),
            Some(1_756_000_001)
        );
    }

    #[test]
    fn yields_no_expiry_rather_than_a_wrong_one_when_it_cannot_be_read() {
        use base64::Engine as _;
        // Correctly wrapped, but the claims carry no expiry.
        let wrapped_without_expiry =
            base64::engine::general_purpose::STANDARD.encode("jwt/aGVhZGVy.e30.c2ln");
        for unreadable in [
            "temporary-session",
            "not base64 at all !!",
            "",
            wrapped_without_expiry.as_str(),
        ] {
            assert_eq!(
                session_token_expiry(unreadable),
                None,
                "expected no expiry for {unreadable:?}"
            );
        }
    }
}

//! Error codes (`log-service-api.md` §10).
//!
//! `head-moved` and `duplicate` are results, not errors (§4); they never appear here.

use mdbn_wire::cbor::Cbor;
use mdbn_wire::log_service::LsError;

/// The error codes replicas see.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Code {
    /// Missing, expired or unbound token.
    Unauthenticated,
    /// The principal is not allowed.
    Forbidden,
    /// No such collection or object.
    NotFound,
    /// The collection was deleted or moved.
    Gone,
    /// Malformed request or items.
    Invalid,
    /// Item, batch or object over its limit.
    TooLarge,
    /// Referenced objects are absent.
    RefsMissing,
    /// Frozen or rekey-required.
    Frozen,
    /// Over a rate limit.
    RateLimited,
    /// Over the storage quota.
    QuotaExceeded,
    /// Restarting, moving or overloaded.
    Unavailable,
    /// API version no longer supported.
    UpgradeRequired,
}

impl Code {
    /// The wire string.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::Unauthenticated => "unauthenticated",
            Code::Forbidden => "forbidden",
            Code::NotFound => "not_found",
            Code::Gone => "gone",
            Code::Invalid => "invalid",
            Code::TooLarge => "too_large",
            Code::RefsMissing => "refs_missing",
            Code::Frozen => "frozen",
            Code::RateLimited => "rate_limited",
            Code::QuotaExceeded => "quota_exceeded",
            Code::Unavailable => "unavailable",
            Code::UpgradeRequired => "upgrade_required",
        }
    }

    /// Parse a wire string.
    pub fn parse(s: &str) -> Option<Code> {
        Some(match s {
            "unauthenticated" => Code::Unauthenticated,
            "forbidden" => Code::Forbidden,
            "not_found" => Code::NotFound,
            "gone" => Code::Gone,
            "invalid" => Code::Invalid,
            "too_large" => Code::TooLarge,
            "refs_missing" => Code::RefsMissing,
            "frozen" => Code::Frozen,
            "rate_limited" => Code::RateLimited,
            "quota_exceeded" => Code::QuotaExceeded,
            "unavailable" => Code::Unavailable,
            "upgrade_required" => Code::UpgradeRequired,
            _ => return None,
        })
    }
}

/// A service error: a code plus optional reason, message, retry hint and details.
#[derive(Debug, Clone, PartialEq)]
pub struct ServiceError {
    /// Code.
    pub code: Code,
    /// Finer machine-readable reason (`shape`, `chain`, `signature`, ...).
    pub reason: Option<String>,
    /// For logs.
    pub message: Option<String>,
    /// Retry hint.
    pub retry_after_ms: Option<u64>,
    /// Details (e.g. the missing addresses of `refs_missing`).
    pub details: Option<Cbor>,
}

impl ServiceError {
    /// An error with a code only.
    pub fn new(code: Code) -> Self {
        ServiceError {
            code,
            reason: None,
            message: None,
            retry_after_ms: None,
            details: None,
        }
    }
    /// An error with a reason.
    pub fn reason(code: Code, reason: &str) -> Self {
        ServiceError {
            reason: Some(reason.to_string()),
            ..Self::new(code)
        }
    }
    /// Attach a log message.
    pub fn msg(mut self, m: impl Into<String>) -> Self {
        self.message = Some(m.into());
        self
    }
    /// Attach a retry hint.
    pub fn retry(mut self, ms: u64) -> Self {
        self.retry_after_ms = Some(ms);
        self
    }
    /// `invalid` with a reason.
    pub fn invalid(reason: &str) -> Self {
        Self::reason(Code::Invalid, reason)
    }
    /// `unavailable` for a backend failure (the replica retries with jitter).
    pub fn backend(m: impl Into<String>) -> Self {
        Self::new(Code::Unavailable).msg(m).retry(250)
    }

    /// The wire form.
    pub fn to_wire(&self) -> LsError {
        LsError {
            code: self.code.as_str().to_string(),
            reason: self.reason.clone(),
            message: self.message.clone(),
            retry_after_ms: self.retry_after_ms,
            details: self.details.clone(),
        }
    }

    /// From the wire form (unknown codes map to `unavailable`).
    pub fn from_wire(e: &LsError) -> Self {
        ServiceError {
            code: Code::parse(&e.code).unwrap_or(Code::Unavailable),
            reason: e.reason.clone(),
            message: e.message.clone(),
            retry_after_ms: e.retry_after_ms,
            details: e.details.clone(),
        }
    }
}

impl std::fmt::Display for ServiceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code.as_str())?;
        if let Some(r) = &self.reason {
            write!(f, " ({r})")?;
        }
        if let Some(m) = &self.message {
            write!(f, ": {m}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ServiceError {}

/// Result alias.
pub type Result<T> = std::result::Result<T, ServiceError>;

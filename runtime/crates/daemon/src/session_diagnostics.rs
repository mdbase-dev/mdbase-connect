//! Privacy-bounded session-end diagnostics. No identities, frames, keys, paths,
//! free-form errors, problem messages or server-supplied reasons are retained.
use crate::session::{Origin, SessionError};

/// A separate target permits collection without the relay's identifier events.
pub(crate) const TARGET: &str = "mdbase_native_session";

/// Owned, static-only progress, including cancellation of the session future.
pub(crate) struct SessionTrace {
    origin: &'static str,
    pub(crate) phase: &'static str,
    pub(crate) class: &'static str,
    pub(crate) code: &'static str,
    pub(crate) m1_received: bool,
    /// Accepted by the carrier, not browser delivery or a READ/receipt ACK.
    pub(crate) m2_queued: bool,
    pub(crate) admitted: bool,
    emitted: bool,
}

impl SessionTrace {
    pub(crate) fn new(origin: Origin) -> Self {
        Self {
            origin: match origin {
                Origin::RelayPipe => "relay_pipe",
                Origin::LocalIpc => "local_ipc",
                Origin::LocalLink { .. } => "local_link",
            },
            phase: "handshake",
            class: "abandoned",
            code: "none",
            m1_received: false,
            m2_queued: false,
            admitted: false,
            emitted: false,
        }
    }

    pub(crate) fn finish(&mut self, error: Option<&SessionError>) {
        if let Some(error) = error {
            self.class = match error {
                SessionError::Io(_) => "io_error",
                SessionError::Protocol("handshake timed out") => "handshake_timeout",
                SessionError::Protocol("closed during handshake") => "handshake_eof",
                SessionError::Protocol(_) => "protocol_error",
                SessionError::Noise(crate::noise::NoiseError::Decrypt) => "noise_decrypt",
                SessionError::Noise(crate::noise::NoiseError::WeakKey) => "noise_weak_key",
                SessionError::Noise(crate::noise::NoiseError::Limit) => "noise_limit",
            };
        }
        self.emit();
        self.emitted = true;
    }

    fn emit(&self) {
        tracing::info!(target: TARGET,
            origin = self.origin,
            phase = self.phase,
            class = self.class,
            code = self.code,
            m1_received = self.m1_received,
            m2_queued = self.m2_queued,
            admitted = self.admitted,
            "native session ended"
        );
    }
}

impl Drop for SessionTrace {
    fn drop(&mut self) {
        if !self.emitted {
            self.class = "abandoned";
            self.code = "none";
            self.emit();
        }
    }
}

/// Collapse arbitrary problem strings to fixed classes; never log raw text.
pub(crate) fn problem_code(code: &str) -> &'static str {
    match code {
        "invalid_request" => "invalid_request",
        "invalid_record" => "invalid_record",
        "not_found" => "not_found",
        "unauthenticated" => "unauthenticated",
        "forbidden" => "forbidden",
        "unavailable" => "unavailable",
        "upgrade_required" => "upgrade_required",
        "integrity" => "integrity",
        "conflict" => "conflict",
        "too_large" => "too_large",
        "rate_limited" => "rate_limited",
        "internal" => "internal",
        _ => "other",
    }
}

pub(crate) fn pre_live(class: &'static str) {
    let mut trace = SessionTrace::new(Origin::RelayPipe);
    trace.phase = "pre_live";
    trace.class = class;
    trace.code = match class {
        "grant_not_live" => "grant_inactive",
        "nil_grant" => "unauthenticated",
        "invalid_open_ids" => "invalid_request",
        _ => "other",
    };
    trace.finish(None);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("capture").extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Capture {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }
    fn captured(f: impl FnOnce()) -> String {
        let capture = Capture::default();
        let subscriber = tracing_subscriber::fmt()
            .with_ansi(false)
            .without_time()
            .with_env_filter("off,mdbase_native_session=info")
            .with_writer(capture.clone())
            .finish();
        tracing::subscriber::with_default(subscriber, f);
        String::from_utf8(capture.0.lock().expect("capture").clone()).expect("utf8")
    }
    #[test]
    fn pre_live_has_no_noise_or_admission_claim() {
        let text = captured(|| pre_live("grant_not_live"));
        assert!(text.contains("phase=\"pre_live\""));
        assert!(text.contains("class=\"grant_not_live\""));
        assert!(text.contains("m1_received=false"));
        assert!(text.contains("m2_queued=false"));
        assert!(text.contains("admitted=false"));
        assert_eq!(text.matches("native session ended").count(), 1);
    }
    #[test]
    fn refusal_and_io_keep_only_static_classes() {
        let secret = "[test] forbidden payload identifier /private/path";
        let text = captured(|| {
            let mut trace = SessionTrace::new(Origin::RelayPipe);
            trace.phase = "admission";
            trace.class = "admission_refused";
            trace.code = problem_code(secret);
            trace.m1_received = true;
            trace.m2_queued = true;
            trace.finish(None);
            let error = SessionError::Io(std::io::Error::other(secret));
            let mut trace = SessionTrace::new(Origin::RelayPipe);
            trace.finish(Some(&error));
        });
        assert!(!text.contains(secret));
        assert!(text.contains("class=\"admission_refused\""));
        assert!(text.contains("code=\"other\""));
        assert!(text.contains("class=\"io_error\""));
        assert_eq!(text.matches("native session ended").count(), 2);
    }
    #[test]
    fn cancelled_future_and_noise_failure_emit_once() {
        let text = captured(|| {
            drop(SessionTrace::new(Origin::RelayPipe));
            let mut trace = SessionTrace::new(Origin::RelayPipe);
            trace.finish(Some(&SessionError::Noise(
                crate::noise::NoiseError::Decrypt,
            )));
        });
        assert!(text.contains("class=\"abandoned\""));
        assert!(text.contains("class=\"noise_decrypt\""));
        assert_eq!(text.matches("native session ended").count(), 2);
    }
}

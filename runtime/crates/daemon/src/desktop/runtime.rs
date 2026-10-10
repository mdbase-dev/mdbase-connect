//! Companion task ownership. UI requests are bounded and serialized; notifications
//! contain only static copy. Closing the UI stops these tasks, never the daemon.

use crate::paths::Profile;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
use {
    super::{Notice, ReviewRequest, Snapshot, request_review, subscribe},
    crate::paths::Target,
    std::{
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
        time::Duration,
    },
    tokio::sync::{mpsc, watch},
};

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
struct Tasks(Vec<tokio::task::JoinHandle<()>>);
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
impl Drop for Tasks {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub(super) struct Views {
    pub snapshot: watch::Receiver<Snapshot>,
    pub reviews: mpsc::Sender<ReviewRequest>,
    pub stop: watch::Receiver<bool>,
    pub busy: Arc<AtomicBool>,
    pub feedback: watch::Receiver<Option<&'static str>>,
}

/// Companion startup/runtime failure, with no platform error payload or secrets.
#[derive(Debug)]
pub enum CompanionError {
    /// No native adapter for this operating system.
    Unsupported,
    /// Could not construct the companion's independent async worker runtime.
    RuntimeUnavailable,
    /// No session bus/tray host, or the UI's event loop failed.
    TrayUnavailable,
}
impl std::fmt::Display for CompanionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unsupported => "companion is not supported on this operating system",
            Self::RuntimeUnavailable => "companion worker runtime unavailable",
            Self::TrayUnavailable => {
                "companion tray unavailable; check the desktop session and tray host"
            }
        })
    }
}
impl std::error::Error for CompanionError {}

/// Run exactly once on the process main thread, **before** entering an async CLI
/// runtime (macOS AppKit requires it). Async IPC has its own two-worker runtime.
/// No service install/start or profile fallback occurs here. Native adapters still
/// require independent desktop-session/platform and LAB qualification.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
pub fn run(profile: Profile) -> Result<(), CompanionError> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .map_err(|_| CompanionError::RuntimeUnavailable)?;
    let entered = runtime.enter();
    let isolated = profile.target == Target::IsolatedProfile;
    let (sender, snapshot) = watch::channel(Snapshot::default());
    let (reviews, mut requests) = mpsc::channel::<ReviewRequest>(1);
    let (stop, stopped) = watch::channel(false);
    let (feedback, messages) = watch::channel(None);
    let busy = Arc::new(AtomicBool::new(false));
    let subscription = tokio::spawn(subscribe(profile.clone(), sender));
    let request_busy = busy.clone();
    let reviewer = tokio::spawn(async move {
        while let Some(request) = requests.recv().await {
            // Exactly one request, never an approval answer or automatic retry.
            if let Some(link) = request.compare_link() {
                let message = if open_link(&link).await {
                    "Compare opened in your app — or use keep mine / take theirs"
                } else {
                    "No app opened compare — use keep mine / take theirs"
                };
                feedback.send_replace(Some(message));
                request_busy.store(false, Ordering::Release);
                continue;
            }
            if request.resolves_hold() {
                feedback.send_replace(Some("Resolving — the other version stays in the log"));
                let message = match request_review(&profile, &request).await {
                    Ok(()) => "Resolved — you can change it later from mdbase holds",
                    Err(_) => "Could not resolve — see mdbase holds",
                };
                feedback.send_replace(Some(message));
                request_busy.store(false, Ordering::Release);
                continue;
            }
            feedback.send_replace(Some("Review pending — check daemon dialog"));
            let result = request_review(&profile, &request).await;
            let message = match &result {
                Ok(()) => "Review completed — inspect current app access",
                Err(crate::client::ClientError::Remote(error))
                    if error.reason.as_deref() == Some("not_confirmed") =>
                {
                    "Review declined by daemon dialog"
                }
                Err(crate::client::ClientError::Remote(error))
                    if error.reason.as_deref() == Some("confirmation_unavailable") =>
                {
                    "Review unavailable — daemon could not show its dialog"
                }
                Err(_) => "Review failed — check daemon dialog and access before retry",
            };
            feedback.send_replace(Some(message));
            request_busy.store(false, Ordering::Release);
        }
    });
    let notifier = tokio::spawn(notify(snapshot.clone()));
    let interrupt = tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            stop.send_replace(true);
        }
        // Keep the sender alive even if signal registration failed.
        std::future::pending::<()>().await;
    });
    let tasks = Tasks(vec![subscription, reviewer, notifier, interrupt]);
    let views = Views {
        snapshot,
        reviews,
        stop: stopped,
        busy,
        feedback: messages,
    };
    #[cfg(target_os = "linux")]
    let result = super::linux::run(
        views.snapshot,
        views.reviews,
        views.stop,
        views.busy,
        isolated,
        views.feedback,
    )
    .map_err(|_| CompanionError::TrayUnavailable);
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    let result = super::native::run(views, isolated);
    drop(tasks);
    drop(entered);
    // A stuck OS notification worker must not prevent Quit. No daemon shutdown.
    runtime.shutdown_timeout(Duration::from_secs(2));
    result
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub fn run(_profile: Profile) -> Result<(), CompanionError> {
    Err(CompanionError::Unsupported)
}

/// Last-value delivery coalesces bursts and durable reminders. One notification
/// per30s at most, with later events retained for the next tick, not dropped.
/// Access changes and newly protected files are two fixed notices.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
async fn notify(mut snapshots: watch::Receiver<Snapshot>) {
    let mut last_sequence = 0;
    let mut last_hold_sequence = 0;
    let mut next_notice = tokio::time::Instant::now();
    loop {
        let state = snapshots.borrow_and_update().clone();
        let access = state.model.connected() && state.notice_sequence != last_sequence;
        let protected = state.model.connected() && state.hold_sequence != last_hold_sequence;
        let pending = access || protected;
        if pending && tokio::time::Instant::now() >= next_notice {
            // Access first; a protected file follows on the next tick.
            let notice = if access {
                Notice::NewAccess
            } else {
                Notice::Protected
            };
            let shown = tokio::time::timeout(Duration::from_secs(5), show_notice(notice)).await;
            next_notice = tokio::time::Instant::now() + Duration::from_secs(30);
            if matches!(shown, Ok(true)) {
                if access {
                    last_sequence = state.notice_sequence;
                } else {
                    last_hold_sequence = state.hold_sequence;
                }
            }
        }
        tokio::select! {
            _ = tokio::time::sleep_until(next_notice), if pending => {},
            changed = snapshots.changed() => { if changed.is_err() { break; } }
        }
    }
}

/// The fixed copy for a notice: the generic access-changed text for any access
/// event, the protected-edit text for holds.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn notice_copy(notice: Notice) -> (&'static str, &'static str) {
    match notice {
        Notice::Protected => (notice.title(), notice.body()),
        _ => (Notice::NewAccess.title(), super::ACCESS_CHANGED),
    }
}

#[cfg(target_os = "linux")]
async fn show_notice(notice: Notice) -> bool {
    let (title, body) = notice_copy(notice);
    notify_rust::Notification::new()
        .summary(title)
        .body(body)
        .appname("mdbase")
        .show_async()
        .await
        .is_ok()
}

#[cfg(target_os = "windows")]
async fn show_notice(notice: Notice) -> bool {
    // Never borrow PowerShell's default identity. The installer must register this
    // AUMID; unregistered/failed toasts leave the pending menu available instead.
    static NOTIFY_BUSY: AtomicBool = AtomicBool::new(false);
    if NOTIFY_BUSY
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return false;
    }
    let (title, body) = notice_copy(notice);
    tokio::task::spawn_blocking(move || {
        let shown = notify_rust::Notification::new()
            .summary(title)
            .body(body)
            .app_id("dev.mdbase.companion")
            .show()
            .is_ok();
        // Timeout cancels the waiter, not this OS call. Hold the single-flight
        // gate until completion so an unavailable OS cannot accumulate workers.
        NOTIFY_BUSY.store(false, Ordering::Release);
        shown
    })
    .await
    .unwrap_or(false)
}

#[cfg(target_os = "macos")]
async fn show_notice(notice: Notice) -> bool {
    // Fixed script, absolute OS executable, no remote names/interpolation/shell.
    let (title, body) = notice_copy(notice);
    tokio::process::Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(format!(
            "display notification {body:?} with title {title:?}"
        ))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status()
        .await
        .is_ok_and(|status| status.success())
}

/// Hand a `mdbase://hold/compare?…` link to the app that registered the scheme.
/// The link is built from validated opaque IDs only; no shell is involved.
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
async fn open_link(link: &str) -> bool {
    if !link.starts_with("mdbase://hold/compare?") || link.len() > 256 {
        return false;
    }
    let mut command = if cfg!(target_os = "macos") {
        let mut c = tokio::process::Command::new("/usr/bin/open");
        c.arg(link);
        c
    } else if cfg!(windows) {
        let mut c = tokio::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler").arg(link);
        c
    } else {
        let mut c = tokio::process::Command::new("xdg-open");
        c.arg(link);
        c
    };
    let status = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .status();
    tokio::time::timeout(Duration::from_secs(10), status)
        .await
        .is_ok_and(|r| r.is_ok_and(|s| s.success()))
}

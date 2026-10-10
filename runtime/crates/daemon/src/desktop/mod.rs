//! Notification/request-only companion presentation model.
//!
//! This is not a trusted approval channel or an independent state owner. A
//! request to review pending access must still pass the daemon's native dialog.
//! There is deliberately no generic RPC or confirmation-answer operation here.

#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod icon;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows", test))]
mod menu;
mod model;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod native;
#[cfg(any(target_os = "macos", target_os = "windows", test))]
mod native_limits;
mod runtime;
mod session;

pub use model::{
    AccessPreview, CompanionModel, HoldCause, HoldChoice, HoldPreview, MAX_HOLDS, MAX_PREVIEWS,
    Notice, ReviewRequest,
};
pub use runtime::{CompanionError, run};
pub use session::{ACCESS_CHANGED, Snapshot, request_review, subscribe};

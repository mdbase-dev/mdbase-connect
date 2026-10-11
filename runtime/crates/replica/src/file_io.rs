//! Bounded attachment stream boundary shared by replica hosts.
//!
//! This is the existing hosted read/ACK/cancel driver and its single zeroizing
//! region, not another attachment reader or an authority provider. Native pins
//! recheck READ/folder/wake authority; a transport host must additionally enforce
//! its own live admission before every I/O and plaintext output.

mod attachment_region;
mod file_reads;

pub use attachment_region::{AttachmentRegion, RegionLease, RegionOwner};
pub use file_reads::{FileReads, MAX_OUT_FRAME, ObjectRead, busy};

//! Limits and defaults from the contract (`log-service-api.md` §4, §6, §8, §11;
//! `log-entry.md` §10; `snapshot.md` §5).

/// 1 MiB.
pub const MIB: u64 = 1024 * 1024;

/// Items per append.
pub const MAX_BATCH_ITEMS: usize = 64;
/// Bytes per append.
pub const MAX_BATCH_BYTES: u64 = 4 * MIB;
/// Bytes per sealed item.
pub const MAX_ITEM_BYTES: u64 = MIB;
/// `refs` per item.
pub const MAX_REFS_PER_ITEM: usize = 1024;

/// Items per read page.
pub const MAX_READ_ITEMS: u64 = 1000;
/// Bytes per read page.
pub const MAX_READ_BYTES: u64 = 8 * MIB;

/// Largest object (an 8 MiB plaintext part plus framing and padding, I13).
pub const MAX_OBJECT_BYTES: u64 = 9 * MIB;
/// Objects up to this size travel inline.
pub const MAX_INLINE_OBJECT_BYTES: u64 = MIB;
/// Addresses per `has_objects`.
pub const MAX_HAS_OBJECTS: usize = 1024;
/// Pre-signed transfer lifetime.
pub const DIRECT_TTL_MS: i64 = 15 * 60 * 1000;
/// Uncommitted uploads, and unreferenced objects, are kept at least this long (I10).
pub const OBJECT_GRACE_MS: i64 = 24 * 60 * 60 * 1000;

/// Idempotency token retention (I5: at least 180 days).
pub const TOKEN_RETENTION_MS: i64 = 180 * 24 * 60 * 60 * 1000;

/// Compaction grace region (`snapshot.md` §5.1).
pub const COMPACTION_GRACE_ENTRIES: u64 = 10_000;
/// Entries younger than this are never compacted.
pub const COMPACTION_MIN_AGE_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// A single-device collection's snapshot older than this counts as endorsed.
pub const SELF_ENDORSE_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;
/// Retained snapshots.
pub const RETAINED_SNAPSHOTS: usize = 2;
/// Item bytes per archived compaction segment (one segment is one object).
pub const ARCHIVE_SEGMENT_BYTES: u64 = 8 * MIB;

/// Default `inline_bytes` for subscriptions.
pub const DEFAULT_INLINE_BYTES: u64 = 65_536;
/// Per-connection push queue for log pushes (§9).
pub const PUSH_QUEUE_BYTES: usize = MIB as usize;

/// Ephemeral message size (§8).
pub const EPH_MAX_MESSAGE: usize = 16 * 1024;
/// Messages per second per session per stream.
pub const EPH_RATE_MSGS: u64 = 30;
/// Bytes per second per session per stream.
pub const EPH_RATE_BYTES: u64 = 256 * 1024;
/// Sessions per stream.
pub const EPH_MAX_SESSIONS: usize = 64;
/// Streams joined per connection.
pub const EPH_MAX_STREAMS_PER_CONN: usize = 512;
/// Active streams per collection.
pub const EPH_MAX_STREAMS: usize = 4096;
/// Idle timeout.
pub const EPH_IDLE_MS: i64 = 60_000;
/// Server buffer per receiving session.
pub const EPH_BUFFER_BYTES: usize = 256 * 1024;

/// Default quotas (§11).
pub const DEFAULT_STORAGE_BYTES: u64 = 1024 * MIB;
/// Sustained append rate, items per second.
pub const DEFAULT_ITEMS_PER_S: u64 = 50;
/// Sustained append rate, bytes per second.
pub const DEFAULT_BYTES_PER_S: u64 = 4 * MIB;
/// Burst, items.
pub const DEFAULT_BURST_ITEMS: u64 = 500;

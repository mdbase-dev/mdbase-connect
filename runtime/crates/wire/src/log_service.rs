//! Log service messages (`docs/contracts/log-service-api.md`).

use crate::cbor::Cbor;
use crate::common::{B16, B32, B64, Bytes, DataMap, Hash, Uuid, Version};
use crate::envelope::ItemKind;
use crate::schema::{Ann, SchemaError, Wire, array};
use crate::{wire_enum, wire_struct, wire_tuple, wire_union};

wire_struct! {
    /// A request.
    pub struct LsRequest {
        /// Request ID, unique per connection.
        1 req id: u64,
        /// Method.
        2 req method: String,
        /// Params.
        3 req params: Cbor,
    }
}

wire_struct! {
    /// A response: exactly one of `result` and `error`.
    pub struct LsResponse {
        /// Request ID.
        1 req id: u64,
        /// Result.
        2 opt result: Cbor,
        /// Error.
        3 opt error: LsError,
    }
}

wire_struct! {
    /// A server push.
    pub struct LsPush {
        /// Push type.
        1 req kind: String,
        /// Payload.
        2 req payload: Cbor,
    }
}

wire_union! {
    /// A log service frame (log-service-api.md §2).
    pub enum LsFrame {
        /// Request.
        0 => Request(LsRequest),
        /// Response.
        1 => Response(LsResponse),
        /// Push.
        2 => Push(LsPush),
    }
}

wire_struct! {
    /// A log service error (log-service-api.md §10).
    pub struct LsError {
        /// Code.
        0 req code: String,
        /// Finer machine-readable reason.
        1 opt reason: String,
        /// For logs.
        2 opt message: String,
        /// Retry hint.
        3 opt retry_after_ms: u64,
        /// Details.
        4 opt details: Cbor,
    }
}

wire_struct! {
    /// `hello` params.
    pub struct LsHelloParams {
        /// API version.
        0 req version: Version,
        /// Access token.
        1 req token: String,
        /// Device ID (absent for the control plane).
        2 opt device: Uuid,
        /// Proof-of-possession signature.
        3 req sig: B64,
    }
}

wire_struct! {
    /// `hello` result.
    pub struct LsHelloResult {
        /// Negotiated version.
        0 req version: Version,
        /// Nonce for the next hello.
        1 req server_nonce: B32,
    }
}

/// `[seq, bstr]`: a positioned item.
#[derive(Debug, Clone, PartialEq)]
pub struct SeqItem {
    /// Position.
    pub seq: u64,
    /// Canonical item envelope bytes.
    pub item: Bytes,
}

impl Wire for SeqItem {
    fn to_cbor(&self) -> Cbor {
        Cbor::Array(vec![Cbor::Uint(self.seq), self.item.to_cbor()])
    }
    fn from_cbor(c: &Cbor) -> Result<Self, SchemaError> {
        match array(c, "seq-item")? {
            [s, b] => Ok(SeqItem {
                seq: u64::from_cbor(s)?,
                item: Bytes::from_cbor(b)?,
            }),
            _ => Err(SchemaError::Invalid {
                ty: "seq-item",
                reason: "must be [seq, item]",
            }),
        }
    }
    fn annotate(&self) -> Ann {
        Ann::Tuple(
            "SeqItem",
            vec![
                ("seq", Ann::Leaf(Cbor::Uint(self.seq))),
                ("item", self.item.annotate()),
            ],
        )
    }
}

wire_struct! {
    /// `append` params (log-service-api.md §4).
    pub struct AppendParams {
        /// Collection.
        0 req collection: Uuid,
        /// Must be head + 1.
        1 req expect_seq: u64,
        /// Must be chain(head).
        2 req expect_prev: Hash,
        /// Canonical item envelopes.
        3 req1 items: Vec<Bytes>,
    }
}

wire_struct! {
    /// The items were appended.
    pub struct Appended {
        /// First position.
        1 req first: u64,
        /// Last position.
        2 req last: u64,
        /// chain(last).
        3 req head_chain: Hash,
        /// Service time.
        4 req appended_at: i64,
    }
}

wire_struct! {
    /// Another writer appended first.
    pub struct HeadMoved {
        /// Head.
        1 req head: u64,
        /// chain(head).
        2 req head_chain: Hash,
    }
}

wire_struct! {
    /// An item repeats an indexed idempotency token.
    pub struct Duplicate {
        /// Index in the batch.
        1 req index: u64,
        /// Position of the existing item.
        2 req seq: u64,
    }
}

wire_union! {
    /// `append` result.
    pub enum AppendResult {
        /// Appended.
        0 => Appended(Appended),
        /// Head moved.
        1 => HeadMoved(HeadMoved),
        /// Duplicate.
        2 => Duplicate(Duplicate),
    }
}

wire_enum! {
    /// Which items a read returns.
    pub enum ReadKinds {
        /// All items.
        All = 0,
        /// Control items only.
        Control = 1,
    }
}

wire_struct! {
    /// A snapshot pointer.
    pub struct SnapshotPointer {
        /// Position.
        0 req seq: u64,
        /// Manifest address.
        1 req manifest: B32,
        /// Author device.
        2 req author: Uuid,
        /// Service time.
        3 req created_at: i64,
        /// Endorsed by another device.
        4 req endorsed: bool,
    }
}

wire_struct! {
    /// `read` params (log-service-api.md §5).
    pub struct ReadParams {
        /// Collection.
        0 req collection: Uuid,
        /// Return items with seq > after.
        1 req after: u64,
        /// At most this many items.
        2 req limit: u64,
        /// Default all.
        3 opt kinds: ReadKinds,
        /// Soft canonical item-byte budget: positive, default/clamped to 8 MiB.
        /// The first eligible item may exceed it to permit progress. Excludes framing.
        4 opt max_bytes: u64,
    }
}

wire_struct! {
    /// `read` result.
    pub struct ReadResult {
        /// Items, in order.
        0 req items: Vec<SeqItem>,
        /// Head.
        1 req head: u64,
        /// chain(head).
        2 req head_chain: Hash,
        /// Lowest retained entry position.
        3 req retained_from: u64,
        /// The requested range is compacted.
        4 req behind: bool,
        /// Latest snapshot.
        5 opt snapshot: SnapshotPointer,
        /// More items exist.
        6 req more: bool,
    }
}

wire_struct! {
    /// `head` params.
    pub struct HeadParams {
        /// Collection.
        0 req collection: Uuid,
    }
}

wire_struct! {
    /// `head` result.
    pub struct HeadResult {
        /// Head.
        0 req head: u64,
        /// chain(head).
        1 req head_chain: Hash,
        /// Lowest retained entry position.
        2 req retained_from: u64,
        /// Latest snapshot.
        3 opt snapshot: SnapshotPointer,
    }
}

wire_struct! {
    /// A pre-signed object-store transfer.
    pub struct DirectTransfer {
        /// URL.
        0 req url: String,
        /// Headers the client must send.
        1 req headers: DataMap<String>,
        /// Expiry.
        2 req expires_at: i64,
    }
}

wire_enum! {
    /// `put_object` outcome.
    pub enum PutStatus {
        /// Stored inline.
        Stored = 0,
        /// Upload through `direct`, then `commit_object`.
        Upload = 1,
        /// Already present.
        Exists = 2,
    }
}

wire_struct! {
    /// `put_object` params (log-service-api.md §6).
    pub struct PutObjectParams {
        /// Collection.
        0 req collection: Uuid,
        /// Address.
        1 req address: B32,
        /// Object kind (manifest, chunk, blob-part).
        2 req kind: ItemKind,
        /// Exact byte length.
        3 req size: u64,
        /// SHA-256 of the object bytes.
        4 req checksum: Hash,
        /// Inline bytes (≤ 1 MiB).
        5 opt bytes: Bytes,
    }
}

wire_struct! {
    /// `put_object` result.
    pub struct PutObjectResult {
        /// Outcome.
        0 req status: PutStatus,
        /// Where to upload.
        1 opt direct: DirectTransfer,
    }
}

wire_struct! {
    /// `commit_object` params.
    pub struct CommitObjectParams {
        /// Collection.
        0 req collection: Uuid,
        /// Address.
        1 req address: B32,
    }
}

wire_tuple! {
    /// A byte range, `[offset, length]`.
    pub struct ByteRange {
        /// Offset.
        offset: u64,
        /// Length.
        len: u64,
    }
}

wire_struct! {
    /// `get_object` params.
    pub struct GetObjectParams {
        /// Collection.
        0 req collection: Uuid,
        /// Address.
        1 req address: B32,
        /// Optional range.
        2 opt range: ByteRange,
    }
}

wire_struct! {
    /// `get_object` result.
    pub struct GetObjectResult {
        /// Inline bytes.
        0 opt bytes: Bytes,
        /// Where to download.
        1 opt direct: DirectTransfer,
        /// Size.
        2 req size: u64,
        /// Checksum.
        3 req checksum: Hash,
    }
}

wire_struct! {
    /// `has_objects` params.
    pub struct HasObjectsParams {
        /// Collection.
        0 req collection: Uuid,
        /// Up to 1,024 addresses.
        1 req1 addresses: Vec<B32>,
    }
}

wire_struct! {
    /// `has_objects` result.
    pub struct HasObjectsResult {
        /// One flag per address.
        0 req1 present: Vec<bool>,
    }
}

wire_struct! {
    /// `put_snapshot` params (log-service-api.md §7).
    pub struct PutSnapshotParams {
        /// Collection.
        0 req collection: Uuid,
        /// Position the manifest describes.
        1 req seq: u64,
        /// Manifest address.
        2 req manifest: B32,
        /// Every chunk and blob part address referenced.
        3 req1 refs: Vec<B32>,
    }
}

wire_struct! {
    /// `get_snapshot` result.
    pub struct GetSnapshotResult {
        /// Retained snapshots, newest first.
        0 req snapshots: Vec<SnapshotPointer>,
    }
}

wire_struct! {
    /// `endorse_snapshot` params.
    pub struct EndorseSnapshotParams {
        /// Collection.
        0 req collection: Uuid,
        /// Position.
        1 req seq: u64,
        /// Manifest address.
        2 req manifest: B32,
    }
}

wire_struct! {
    /// `subscribe` params (log-service-api.md §9).
    pub struct SubscribeParams {
        /// Collection.
        0 req collection: Uuid,
        /// The subscriber's applied head.
        1 req after: u64,
        /// Inline items up to this many bytes per push.
        2 opt inline_bytes: u64,
    }
}

wire_struct! {
    /// `head` push.
    pub struct HeadPush {
        /// Collection.
        0 req collection: Uuid,
        /// Head.
        1 req head: u64,
        /// chain(head).
        2 req head_chain: Hash,
    }
}

wire_struct! {
    /// `items` push.
    pub struct ItemsPush {
        /// Collection.
        0 req collection: Uuid,
        /// Items.
        1 req1 items: Vec<SeqItem>,
        /// Head.
        2 req head: u64,
        /// chain(head).
        3 req head_chain: Hash,
    }
}

wire_struct! {
    /// `closed` push.
    pub struct ClosedPush {
        /// Collection.
        0 req collection: Uuid,
        /// Reason (an error code).
        1 req reason: String,
    }
}

wire_struct! {
    /// `stream_join` / `stream_leave` params (log-service-api.md §8).
    pub struct StreamRef {
        /// Collection.
        0 req collection: Uuid,
        /// Stream ID.
        1 req stream: B16,
    }
}

wire_struct! {
    /// `stream_send` params.
    pub struct StreamSendParams {
        /// Collection.
        0 req collection: Uuid,
        /// Stream ID.
        1 req stream: B16,
        /// Ephemeral item envelope.
        2 req message: Bytes,
    }
}

wire_struct! {
    /// `stream_msg` push.
    pub struct StreamMsg {
        /// Collection.
        0 req collection: Uuid,
        /// Stream ID.
        1 req stream: B16,
        /// Sending device.
        2 req from: Uuid,
        /// Ephemeral item envelope.
        3 req message: Bytes,
    }
}

wire_enum! {
    /// Stream membership change.
    pub enum StreamEventKind {
        /// Joined.
        Joined = 0,
        /// Left.
        Left = 1,
    }
}

wire_struct! {
    /// `stream_event` push.
    pub struct StreamEvent {
        /// Collection.
        0 req collection: Uuid,
        /// Stream ID.
        1 req stream: B16,
        /// Device.
        2 req device: Uuid,
        /// Joined or left.
        3 req event: StreamEventKind,
    }
}

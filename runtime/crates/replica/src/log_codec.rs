//! Canonical log-service frames at every replica host boundary.
//!
//! Only sealed item/object bytes cross this boundary. The host owns the socket,
//! authentication exchange and direct object transfers; the replica owns all log
//! semantics. Direct transfers must be completed before delivering an inline
//! normalized result. Unknown variants and ambiguous responses fail closed.

use crate::log::{
    CallId, LogCall, LogError, LogErrorCode, LogPush, LogReply, LogRequest, LogResponse,
};
use mdbn_wire::cbor::Cbor;
use mdbn_wire::common::{B32, Bytes, Uuid};
use mdbn_wire::log_service::*;
use mdbn_wire::schema::{SchemaError, Wire, struct_map};

/// Maximum frame delivered through this boundary (service reads are capped at
/// 8 MiB, and a sealed object at 9 MiB).
pub const MAX_LOG_FRAME: usize = 16 * 1024 * 1024;
/// Log-service inline object transfer limit (log-service-api §6).
pub const INLINE_OBJECT_MAX: usize = 1024 * 1024;
/// Maximum sealed object, including envelope/padding (log-service-api §6).
pub const MAX_SEALED_OBJECT: usize = 9 * 1024 * 1024;

fn invalid(reason: &'static str) -> SchemaError {
    SchemaError::Invalid {
        ty: "replica-log",
        reason,
    }
}

fn map(fields: Vec<(u64, Cbor)>) -> Cbor {
    Cbor::Map(
        fields
            .into_iter()
            .map(|(key, value)| (Cbor::Uint(key), value))
            .collect(),
    )
}

fn field<T: Wire>(value: &Cbor, key: u64) -> Result<T, SchemaError> {
    let fields = struct_map(value, "replica-log-result")?;
    let value = fields
        .iter()
        .find(|(k, _)| *k == Cbor::Uint(key))
        .map(|(_, v)| v)
        .ok_or_else(|| invalid("missing result field"))?;
    T::from_cbor(value)
}

/// HTTP-only transport admission (no standing socket/push channel). Preserve the
/// engine's ORIGINAL call/scope separately: only the native wire request changes
/// Subscribe -> Head. Remember the returned flag by original ID for the reply.
/// Hosts reconnect on wake/foreground notification to learn new entries.
pub fn http_unary_call(mut call: LogCall) -> (LogCall, bool) {
    let as_subscribe = if let LogRequest::Subscribe { collection, .. } = call.request {
        call.request = LogRequest::Head { collection };
        true
    } else {
        false
    };
    (call, as_subscribe)
}

/// Invoke ONLY inside the engine's original-scope validated reply callback.
/// Uses the original immutable method, never a JS/network supplied label. Head
/// admission is delivered as Subscribed; malformed/unexpected replies are unknown
/// outcomes, and service errors retain the existing transport error semantics.
pub fn http_unary_reply(
    id: CallId,
    original_method: &str,
    as_subscribe: bool,
    bytes: &[u8],
) -> Result<LogReply, SchemaError> {
    if !as_subscribe {
        return reply(id, original_method, bytes);
    }
    if original_method != "subscribe" {
        return Err(invalid("HTTP subscribe original method"));
    }
    Ok(match reply(id, "head", bytes)? {
        Ok(LogResponse::Head(head)) => Ok(LogResponse::Subscribed {
            head: head.head,
            head_chain: head.head_chain,
        }),
        Ok(_) => Err(LogError::NoResponse),
        Err(error) => Err(error),
    })
}

/// One service-valid network request. Objects above the 1 MiB inline limit
/// omit their bytes; `host_call` carries those bytes as a separate sealed sidecar.
/// JS completes the direct PUT and commit before returning stored/exists.
pub fn request(call: &LogCall) -> Result<Vec<u8>, SchemaError> {
    let params = match &call.request {
        LogRequest::Append(p) => p.to_cbor(),
        LogRequest::Read(p) => p.to_cbor(),
        LogRequest::Head { collection }
        | LogRequest::Unsubscribe { collection }
        | LogRequest::GetSnapshot { collection } => HeadParams {
            collection: *collection,
        }
        .to_cbor(),
        LogRequest::Subscribe {
            collection,
            after,
            inline_bytes,
        } => SubscribeParams {
            collection: *collection,
            after: *after,
            inline_bytes: *inline_bytes,
        }
        .to_cbor(),
        LogRequest::PutObject {
            collection,
            address,
            kind,
            bytes,
        } => {
            if bytes.len() > MAX_SEALED_OBJECT {
                return Err(invalid("sealed object exceeds service limit"));
            }
            PutObjectParams {
                collection: *collection,
                address: *address,
                kind: *kind,
                size: bytes.len() as u64,
                checksum: mdbn_wire::hash::sha256(bytes),
                bytes: (bytes.len() <= INLINE_OBJECT_MAX).then(|| Bytes(bytes.clone())),
            }
            .to_cbor()
        }
        LogRequest::GetObject {
            collection,
            address,
            range,
        } => GetObjectParams {
            collection: *collection,
            address: *address,
            range: range.map(|(offset, len)| ByteRange { offset, len }),
        }
        .to_cbor(),
        LogRequest::HasObjects {
            collection,
            addresses,
        } => HasObjectsParams {
            collection: *collection,
            addresses: addresses.clone(),
        }
        .to_cbor(),
        LogRequest::PutSnapshot(p) => p.to_cbor(),
        LogRequest::EndorseSnapshot(p) => p.to_cbor(),
        LogRequest::StreamJoin { collection, stream }
        | LogRequest::StreamLeave { collection, stream } => StreamRef {
            collection: *collection,
            stream: *stream,
        }
        .to_cbor(),
        LogRequest::StreamSend {
            collection,
            stream,
            message,
        } => StreamSendParams {
            collection: *collection,
            stream: *stream,
            message: Bytes(message.clone()),
        }
        .to_cbor(),
    };
    let frame = LsFrame::Request(LsRequest {
        id: call.id.0,
        method: call.request.method().into(),
        params,
    });
    let bytes = frame.to_bytes()?;
    if bytes.len() > MAX_LOG_FRAME {
        return Err(invalid("log request exceeds frame limit"));
    }
    Ok(bytes)
}

/// Host call record: `{0: endpoint, 1: request_frame_bytes, ?2: sealed_object}`.
/// The optional sidecar is never sent inside a service request. Call ID and
/// method remain in the canonical frame, preventing two competing identities.
pub fn host_call(call: LogCall) -> Result<Cbor, SchemaError> {
    let frame = request(&call)?;
    let mut fields = vec![(0, Cbor::Uint(call.endpoint.0)), (1, Cbor::Bytes(frame))];
    if let LogRequest::PutObject { bytes, .. } = call.request
        && bytes.len() > INLINE_OBJECT_MAX
    {
        fields.push((2, Cbor::Bytes(bytes)));
    }
    Ok(map(fields))
}

fn decode_frame(bytes: &[u8]) -> Result<LsFrame, SchemaError> {
    if bytes.len() > MAX_LOG_FRAME {
        return Err(invalid("log frame exceeds limit"));
    }
    LsFrame::from_bytes(bytes)
}

/// Decode a reply against its original call. The caller removes correlation
/// state only after success, so malformed replies cannot consume another call.
pub fn reply(id: CallId, method: &str, bytes: &[u8]) -> Result<LogReply, SchemaError> {
    let LsFrame::Response(response) = decode_frame(bytes)? else {
        return Err(invalid("expected log response"));
    };
    if response.id != id.0 {
        return Err(invalid("log response ID mismatch"));
    }
    match (response.result, response.error) {
        (Some(result), None) => Ok(Ok(result_for(method, &result)?)),
        (None, Some(error)) => {
            let code = LogErrorCode::parse(&error.code)
                .ok_or_else(|| invalid("unknown log error code"))?;
            let missing = if code == LogErrorCode::RefsMissing {
                error
                    .details
                    .as_ref()
                    .map(Vec::<B32>::from_cbor)
                    .transpose()?
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            Ok(Err(LogError::Service {
                code,
                reason: error.reason,
                retry_after_ms: error.retry_after_ms,
                missing,
            }))
        }
        _ => Err(invalid("log response requires exactly one result or error")),
    }
}

fn result_for(method: &str, value: &Cbor) -> Result<LogResponse, SchemaError> {
    Ok(match method {
        "append" => LogResponse::Append(AppendResult::from_cbor(value)?),
        "read" => LogResponse::Read(ReadResult::from_cbor(value)?),
        "head" => LogResponse::Head(HeadResult::from_cbor(value)?),
        "subscribe" => LogResponse::Subscribed {
            head: field(value, 0)?,
            head_chain: field(value, 1)?,
        },
        "put_object" => {
            let p = PutObjectResult::from_cbor(value)?;
            if p.direct.is_some() || p.status == PutStatus::Upload {
                return Err(invalid("direct upload must be completed by host"));
            }
            LogResponse::PutObject {
                existed: p.status == PutStatus::Exists,
            }
        }
        "get_object" => {
            let p = GetObjectResult::from_cbor(value)?;
            if p.size > MAX_SEALED_OBJECT as u64 {
                return Err(invalid("sealed object exceeds service limit"));
            }
            if p.direct.is_some() {
                return Err(invalid("direct download must be completed by host"));
            }
            let bytes = p
                .bytes
                .ok_or_else(|| invalid("object response requires bytes"))?;
            if bytes.0.len() as u64 > p.size {
                return Err(invalid("object bytes exceed whole size"));
            }
            if bytes.0.len() as u64 == p.size && mdbn_wire::hash::sha256(&bytes.0) != p.checksum {
                return Err(invalid("whole object checksum mismatch"));
            }
            LogResponse::GetObject {
                bytes: bytes.0,
                size: p.size,
                checksum: p.checksum,
            }
        }
        "has_objects" => LogResponse::HasObjects(HasObjectsResult::from_cbor(value)?.present),
        "put_snapshot" => LogResponse::PutSnapshot(field(value, 0)?),
        "get_snapshot" => LogResponse::GetSnapshot(GetSnapshotResult::from_cbor(value)?.snapshots),
        "endorse_snapshot" => LogResponse::EndorseSnapshot(field(value, 0)?),
        "stream_join" => LogResponse::StreamJoined(field(value, 0)?),
        "stream_send" => LogResponse::StreamSent(field(value, 0)?),
        "unsubscribe" | "stream_leave" => {
            if !struct_map(value, "log-unit")?.is_empty() {
                return Err(invalid("unit result must be empty"));
            }
            LogResponse::Ok
        }
        _ => return Err(invalid("unknown pending log method")),
    })
}

/// A service push, constrained to this runtime's collection. Connection events
/// are separate trusted-host calls, not remote push names.
pub fn push(collection: Uuid, bytes: &[u8]) -> Result<LogPush, SchemaError> {
    let LsFrame::Push(push) = decode_frame(bytes)? else {
        return Err(invalid("expected log push"));
    };
    let (scope, output) = match push.kind.as_str() {
        "head" => {
            let p = HeadPush::from_cbor(&push.payload)?;
            (
                p.collection,
                LogPush::Head {
                    collection: p.collection,
                    head: p.head,
                    head_chain: p.head_chain,
                },
            )
        }
        "items" => {
            let p = ItemsPush::from_cbor(&push.payload)?;
            (
                p.collection,
                LogPush::Items {
                    collection: p.collection,
                    items: p.items,
                    head: p.head,
                    head_chain: p.head_chain,
                },
            )
        }
        "closed" => {
            let p = ClosedPush::from_cbor(&push.payload)?;
            (
                p.collection,
                LogPush::Closed {
                    collection: p.collection,
                    reason: p.reason,
                },
            )
        }
        "stream_msg" => {
            let p = StreamMsg::from_cbor(&push.payload)?;
            (
                p.collection,
                LogPush::StreamMsg {
                    collection: p.collection,
                    stream: p.stream,
                    from: p.from,
                    message: p.message.0,
                },
            )
        }
        "stream_event" => {
            let p = StreamEvent::from_cbor(&push.payload)?;
            (
                p.collection,
                LogPush::StreamEvent {
                    collection: p.collection,
                    stream: p.stream,
                    device: p.device,
                    event: p.event,
                },
            )
        }
        _ => return Err(invalid("unknown log push kind")),
    };
    if scope != collection {
        return Err(invalid("log push belongs to another collection"));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log::EndpointId;
    use mdbn_wire::common::B16;

    const COLLECTION: Uuid = B16([1; 16]);

    fn response(id: u64, result: Option<Cbor>, error: Option<LsError>) -> Vec<u8> {
        LsFrame::Response(LsResponse { id, result, error })
            .to_bytes()
            .unwrap()
    }

    #[test]
    fn http_unary_subscribe_preserves_route_and_requires_original_scope_head_reply() {
        let original = LogCall {
            id: CallId(11),
            endpoint: EndpointId(37),
            request: LogRequest::Subscribe {
                collection: COLLECTION,
                after: 7,
                inline_bytes: Some(4096),
            },
        };
        let (wire, mapped) = http_unary_call(original);
        assert!(mapped);
        assert_eq!(wire.id, CallId(11));
        assert_eq!(wire.endpoint, EndpointId(37));
        assert!(matches!(wire.request,LogRequest::Head{collection} if collection==COLLECTION));
        let head = HeadResult {
            head: 7,
            head_chain: B32([2; 32]),
            retained_from: 1,
            snapshot: None,
        };
        let bytes = response(11, Some(head.to_cbor()), None);
        assert!(
            matches!(http_unary_reply(CallId(11),"subscribe",true,&bytes).unwrap(),Ok(LogResponse::Subscribed{head:7,head_chain}) if head_chain==B32([2;32]))
        );
        assert!(http_unary_reply(CallId(12), "subscribe", true, &bytes).is_err());
        assert!(http_unary_reply(CallId(11), "head", true, &bytes).is_err());
        assert!(http_unary_reply(CallId(11), "subscribe", true, &[0]).is_err());
        assert!(matches!(
            http_unary_reply(CallId(11), "head", false, &bytes).unwrap(),
            Ok(LogResponse::Head(_))
        ));
        let (wire, mapped) = http_unary_call(LogCall {
            id: CallId(12),
            endpoint: EndpointId(37),
            request: LogRequest::Head {
                collection: COLLECTION,
            },
        });
        assert!(!mapped);
        assert_eq!(wire.request.method(), "head");
    }
    #[test]
    fn requests_preserve_ids_collection_and_exact_sealed_bytes() {
        let item = vec![0xa1, 0x00, 0x01];
        let call = LogCall {
            id: CallId(11),
            endpoint: EndpointId(0),
            request: LogRequest::Append(AppendParams {
                collection: COLLECTION,
                expect_seq: 7,
                expect_prev: B32([0; 32]),
                items: vec![Bytes(item.clone())],
            }),
        };
        let LsFrame::Request(frame) = LsFrame::from_bytes(&request(&call).unwrap()).unwrap() else {
            panic!("request");
        };
        assert_eq!(frame.id, 11);
        assert_eq!(frame.method, "append");
        let params = AppendParams::from_cbor(&frame.params).unwrap();
        assert_eq!(params.collection, COLLECTION);
        assert_eq!(params.items[0].0, item);
    }

    #[test]
    fn object_request_carries_only_sealed_bytes_and_computed_checksum() {
        let bytes = vec![42; 1024];
        let call = LogCall {
            id: CallId(1),
            endpoint: EndpointId(0),
            request: LogRequest::PutObject {
                collection: COLLECTION,
                address: B32([2; 32]),
                kind: mdbn_wire::envelope::ItemKind::BlobPart,
                bytes: bytes.clone(),
            },
        };
        let LsFrame::Request(frame) = LsFrame::from_bytes(&request(&call).unwrap()).unwrap() else {
            panic!("request");
        };
        let params = PutObjectParams::from_cbor(&frame.params).unwrap();
        assert_eq!(params.bytes, Some(Bytes(bytes.clone())));
        assert_eq!(params.checksum, mdbn_wire::hash::sha256(&bytes));
        assert_eq!(params.size, 1024);
    }

    #[test]
    fn large_object_bytes_are_a_host_sidecar_not_an_invalid_inline_request() {
        let bytes = vec![42; INLINE_OBJECT_MAX + 1];
        let call = LogCall {
            id: CallId(7),
            endpoint: EndpointId(2),
            request: LogRequest::PutObject {
                collection: COLLECTION,
                address: B32([3; 32]),
                kind: mdbn_wire::envelope::ItemKind::BlobPart,
                bytes: bytes.clone(),
            },
        };
        let record = host_call(call).unwrap();
        let endpoint: u64 = field(&record, 0).unwrap();
        assert_eq!(endpoint, 2);
        let request_bytes: Bytes = field(&record, 1).unwrap();
        let sidecar: Bytes = field(&record, 2).unwrap();
        assert_eq!(sidecar.0, bytes);
        let LsFrame::Request(frame) = LsFrame::from_bytes(&request_bytes.0).unwrap() else {
            panic!("request");
        };
        assert_eq!(frame.id, 7);
        let params = PutObjectParams::from_cbor(&frame.params).unwrap();
        assert_eq!(params.bytes, None);
        assert_eq!(params.size, bytes.len() as u64);
        assert_eq!(params.checksum, mdbn_wire::hash::sha256(&bytes));
    }

    #[test]
    fn rejects_wrong_id_ambiguous_and_unknown_method_replies() {
        let ok = map(vec![(0, Cbor::Uint(1)), (1, B32([2; 32]).to_cbor())]);
        assert!(reply(CallId(1), "subscribe", &response(2, Some(ok.clone()), None)).is_err());
        let error = LsError {
            code: "unavailable".into(),
            reason: None,
            message: None,
            retry_after_ms: None,
            details: None,
        };
        assert!(
            reply(
                CallId(1),
                "subscribe",
                &response(1, Some(ok.clone()), Some(error))
            )
            .is_err()
        );
        assert!(reply(CallId(1), "future", &response(1, Some(ok), None)).is_err());
        assert!(reply(CallId(1), "subscribe", &response(1, None, None)).is_err());
    }

    #[test]
    fn decodes_subscribe_and_missing_object_addresses() {
        let result = map(vec![(0, Cbor::Uint(8)), (1, B32([2; 32]).to_cbor())]);
        assert_eq!(
            reply(CallId(1), "subscribe", &response(1, Some(result), None)).unwrap(),
            Ok(LogResponse::Subscribed {
                head: 8,
                head_chain: B32([2; 32]),
            })
        );
        let error = LsError {
            code: "refs_missing".into(),
            reason: Some("objects".into()),
            message: None,
            retry_after_ms: Some(50),
            details: Some(vec![B32([3; 32])].to_cbor()),
        };
        assert_eq!(
            reply(CallId(1), "append", &response(1, None, Some(error))).unwrap(),
            Err(LogError::Service {
                code: LogErrorCode::RefsMissing,
                reason: Some("objects".into()),
                retry_after_ms: Some(50),
                missing: vec![B32([3; 32])],
            })
        );
    }

    #[test]
    fn direct_transfer_and_unknown_error_cannot_be_used_as_final_result() {
        let upload = PutObjectResult {
            status: PutStatus::Upload,
            direct: None,
        }
        .to_cbor();
        assert!(reply(CallId(1), "put_object", &response(1, Some(upload), None)).is_err());
        let error = LsError {
            code: "future".into(),
            reason: None,
            message: None,
            retry_after_ms: None,
            details: None,
        };
        assert!(reply(CallId(1), "head", &response(1, None, Some(error))).is_err());
    }

    #[test]
    fn object_and_frame_limits_are_checked_before_use() {
        let call = LogCall {
            id: CallId(1),
            endpoint: EndpointId(0),
            request: LogRequest::PutObject {
                collection: COLLECTION,
                address: B32([2; 32]),
                kind: mdbn_wire::envelope::ItemKind::BlobPart,
                bytes: vec![42; MAX_SEALED_OBJECT + 1],
            },
        };
        assert!(request(&call).is_err());
        assert!(
            host_call(call).is_err(),
            "oversized sidecar is never returned"
        );
        let oversized = GetObjectResult {
            bytes: None,
            direct: None,
            size: MAX_SEALED_OBJECT as u64 + 1,
            checksum: B32([0; 32]),
        };
        assert!(
            reply(
                CallId(1),
                "get_object",
                &response(1, Some(oversized.to_cbor()), None)
            )
            .is_err()
        );
        let frame = vec![0; MAX_LOG_FRAME + 1];
        assert!(reply(CallId(1), "head", &frame).is_err());
        assert!(push(COLLECTION, &frame).is_err());
    }

    #[test]
    fn normalized_objects_are_bounded_and_whole_checksums_verify() {
        let bytes = vec![1, 2, 3, 4];
        let good = GetObjectResult {
            bytes: Some(Bytes(bytes.clone())),
            direct: None,
            size: 4,
            checksum: mdbn_wire::hash::sha256(&bytes),
        };
        assert!(
            reply(
                CallId(1),
                "get_object",
                &response(1, Some(good.to_cbor()), None)
            )
            .unwrap()
            .is_ok()
        );
        let mut bad = good.clone();
        bad.checksum = B32([0; 32]);
        assert!(
            reply(
                CallId(1),
                "get_object",
                &response(1, Some(bad.to_cbor()), None)
            )
            .is_err()
        );
        bad = good.clone();
        bad.size = 3;
        assert!(
            reply(
                CallId(1),
                "get_object",
                &response(1, Some(bad.to_cbor()), None)
            )
            .is_err()
        );
        // Partial range replies carry the checksum of the whole object; their
        // original range is validated by the host against its correlated call.
        let mut partial = good;
        partial.bytes = Some(Bytes(bytes[..2].to_vec()));
        assert!(
            reply(
                CallId(1),
                "get_object",
                &response(1, Some(partial.to_cbor()), None)
            )
            .unwrap()
            .is_ok()
        );
    }

    #[test]
    fn constrains_pushes_to_collection_and_known_kinds() {
        let frame = |kind: &str, payload: Cbor| {
            LsFrame::Push(LsPush {
                kind: kind.into(),
                payload,
            })
            .to_bytes()
            .unwrap()
        };
        let p = HeadPush {
            collection: COLLECTION,
            head: 8,
            head_chain: B32([2; 32]),
        };
        assert!(push(COLLECTION, &frame("head", p.to_cbor())).is_ok());
        assert!(push(B16([9; 16]), &frame("head", p.to_cbor())).is_err());
        assert!(push(COLLECTION, &frame("future", Cbor::Null)).is_err());
        assert!(push(COLLECTION, &frame("reconnected", Cbor::Null)).is_err());
    }
}

use super::*;
use crate::replica::{BasesExecutionWindow, BasesReadRequest};
fn request<'a>(source: &str, hints: &'a BTreeMap<String, String>) -> BasesReadRequest<'a> {
    BasesReadRequest {
        selection: selection(source, 0),
        property_types: hints,
        timezone: "UTC",
        window: Some(BasesExecutionWindow {
            offset: 0,
            limit: 2,
        }),
    }
}
#[test]
fn window_display_and_codec_keep_original_two_selected_source_reads() {
    let (mut r, session, source, hints) = actor();
    let bytes = r
        .encode_indexed_bases_read_request(
            session,
            request(&source, &hints),
            |result| {
                assert_eq!(result.rows.len(), 2);
                let info = result.window.as_ref().unwrap();
                assert_eq!(info.request.limit, 2);
                assert!(info.total_rows > 2);
                Ok(1)
            },
            |_, size| {
                assert_eq!(size, 1);
                Ok(vec![0])
            },
        )
        .unwrap();
    assert_eq!(bytes, vec![0]);
    assert_eq!(r.store().reads.get(), 2);
    assert_eq!(r.store().pages.get(), 2);
}
#[test]
fn failed_selected_display_page_suppresses_measure_encode_and_publication() {
    let (mut r, session, source, hints) = actor();
    r.store().fail_page.set(2);
    assert!(
        r.encode_indexed_bases_read_request(
            session,
            request(&source, &hints),
            |_| panic!("no measure after display fault"),
            |_, _| panic!("no encode after display fault")
        )
        .is_err()
    );
    assert_eq!(r.store().pages.get(), 2);
    assert_eq!(r.store().reads.get(), 1);
}
#[test]
fn window_private_encoding_is_still_before_final_readiness_fence() {
    let (mut r, session, source, hints) = actor();
    let ready = r.store().ready.clone();
    let encoded = Cell::new(false);
    let result = r.encode_indexed_bases_read_request(
        session,
        request(&source, &hints),
        |_| Ok(1),
        |_, _| {
            encoded.set(true);
            ready.set(false);
            Ok(vec![0])
        },
    );
    assert!(encoded.get());
    assert!(result.is_err());
    assert_eq!(r.store().pages.get(), 2);
}
#[test]
fn window_output_preflight_uses_same_retained_budget_before_allocation() {
    let (mut r, session, source, hints) = actor();
    let encoded = Cell::new(false);
    let result = r.encode_indexed_bases_read_request(
        session,
        request(&source, &hints),
        |_| Ok(128 * 1024 * 1024),
        |_, _| {
            encoded.set(true);
            Ok(vec![])
        },
    );
    assert!(!encoded.get());
    let error = result.unwrap_err();
    assert_eq!(error.code(), Some(ErrorCode::InvalidRequest));
    assert_eq!(
        error.problem().reason.as_deref(),
        Some("query_budget_exceeded")
    );
    assert_eq!(r.store().pages.get(), 2);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_cursor_tokens_are_canonical_and_round_trip() {
        let id = Uuid::new_v4();
        let token = encode_query_cursor(id);
        assert_eq!(decode_query_cursor(&token).unwrap(), id);
        assert_eq!(
            decode_query_cursor(&(token + "=")).unwrap_err().code,
            "invalid_query_cursor"
        );
    }

    #[test]
    fn only_closed_type_candidates_are_translated() {
        use mdbase::runtime::CandidatePredicate;
        let candidate = CandidatePredicate::Or {
            terms: vec![
                CandidatePredicate::HasType {
                    type_name: "task".to_string(),
                },
                CandidatePredicate::HasType {
                    type_name: "note".to_string(),
                },
            ],
        };
        assert_eq!(candidate_type_union(&candidate).unwrap(), ["note", "task"]);
        assert!(candidate_type_union(&CandidatePredicate::Not {
            term: Box::new(candidate)
        })
        .unwrap()
        .is_empty());
    }

    #[test]
    fn base_scope_and_candidate_are_separate_sql_predicates() {
        let mut query = QueryBuilder::<Postgres>::new("WHERE (cardinality(");
        query
            .push_bind(Vec::<String>::new())
            .push("::text[]) = 0 OR matched_types && ")
            .push_bind(Vec::<String>::new())
            .push("::text[]) AND (");
        push_candidate_predicate(&mut query, &mdbase::runtime::CandidatePredicate::All);
        query.push(")");
        assert_eq!(
            query.sql(),
            "WHERE (cardinality($1::text[]) = 0 OR matched_types && $2::text[]) AND (TRUE)"
        );
    }

    #[test]
    fn scoped_budget_details_reveal_only_the_threshold_breach() {
        assert_eq!(scoped_budget_observed(&[], 100, 173), 173);
        assert_eq!(scoped_budget_observed(&["task".to_string()], 100, 173), 101);
    }

    #[test]
    fn aggregation_state_overflow_is_a_typed_budget_outcome() {
        let budgets = mdbase::runtime::HostedQueryBudgets::default();
        let error = reduction_error(
            mdbase::runtime::CatalogError {
                code: "hosted_aggregation_state_budget_exceeded".to_string(),
                message: "retained state is too large".to_string(),
            },
            &budgets,
        );
        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(error.code, "hosted_aggregation_state_budget_exceeded");
        assert_eq!(
            error.details.as_ref().unwrap()["budget"],
            "aggregation_state_bytes"
        );
        assert_eq!(
            error.details.as_ref().unwrap()["limit"],
            budgets.max_aggregation_bytes
        );
    }

    #[test]
    fn query_receipt_compression_round_trips_with_a_decode_ceiling() {
        let result = OperationResult {
            valid: true,
            result: json!({
                "results": (0..1000)
                    .map(|index| json!({"path": format!("tasks/{index}.md"), "status": "open"}))
                    .collect::<Vec<_>>(),
                "meta": {"total_count": 1000}
            }),
            diagnostics: Vec::new(),
        };
        let maximum = 16 * 1024 * 1024;
        let (encoding, payload) = encode_query_page_receipt_payload(&result, maximum).unwrap();
        assert_eq!(encoding, QUERY_RECEIPT_ZSTD_JSON_V1);
        assert_eq!(
            decode_query_page_receipt_payload(encoding, &payload, maximum).unwrap(),
            result
        );
        assert!(decode_query_page_receipt_payload(encoding, &payload, 16).is_err());
    }

    #[test]
    fn projected_fast_path_requires_an_exact_sql_candidate() {
        use mdbase::runtime::{
            CandidateComparison, CandidateComparisonOperator, CandidateComparisonPruning,
            CandidateField, CandidatePredicate,
        };
        assert!(candidate_predicate_is_total(&CandidatePredicate::HasType {
            type_name: "task".to_string(),
        }));
        let comparison = CandidatePredicate::Compare {
            comparison: CandidateComparison {
                field: CandidateField::EffectiveFrontmatter(vec!["status".to_string()]),
                operator: CandidateComparisonOperator::Equal,
                value: Value::String("open".to_string()),
                pruning: CandidateComparisonPruning::ExactJson,
                value_kind: Some(mdbase::runtime::HostedScalarKind::String),
            },
        };
        assert!(!candidate_predicate_is_total(&comparison));
        assert!(candidate_predicate_is_projection_exact(&comparison));
    }

    #[test]
    fn scalar_keyset_sql_preserves_canonical_null_direction() {
        use mdbase::runtime::{
            CandidateField, HostedOrder, HostedOrderDirection, HostedScalarKind,
            HostedSortSemantics,
        };
        let ascending = HostedOrder {
            field: CandidateField::EffectiveFrontmatter(vec!["created_at".to_string()]),
            direction: HostedOrderDirection::Ascending,
            canonical_path_tiebreak: true,
            semantics: HostedSortSemantics::CanonicalV03,
            value_kind: Some(HostedScalarKind::String),
        };
        let mut after_value = QueryBuilder::<Postgres>::new("");
        push_scalar_order_after(&mut after_value, &ascending, &json!("2026-01-01"));
        assert_eq!(
            after_value.sql(),
            "(p.semantic_projection #>> $1 IS NULL OR p.semantic_projection #>> $2 COLLATE \"C\" > $3)"
        );
        let mut equal_value = QueryBuilder::<Postgres>::new("");
        push_scalar_order_prefix_equal(
            &mut equal_value,
            std::slice::from_ref(&ascending),
            &[json!("ä")],
        );
        assert_eq!(
            equal_value.sql(),
            "p.semantic_projection #>> $1 COLLATE \"C\" = $2"
        );
        let mut after_null = QueryBuilder::<Postgres>::new("");
        push_scalar_order_after(&mut after_null, &ascending, &Value::Null);
        assert_eq!(after_null.sql(), "FALSE");

        let descending = HostedOrder {
            direction: HostedOrderDirection::Descending,
            ..ascending
        };
        let mut descending_after_null = QueryBuilder::<Postgres>::new("");
        push_scalar_order_after(&mut descending_after_null, &descending, &Value::Null);
        assert_eq!(
            descending_after_null.sql(),
            "p.semantic_projection #>> $1 IS NOT NULL"
        );

        let descending_mtime = HostedOrder {
            field: CandidateField::File("mtime".to_string()),
            direction: HostedOrderDirection::Descending,
            canonical_path_tiebreak: true,
            semantics: HostedSortSemantics::CanonicalV03,
            value_kind: Some(HostedScalarKind::String),
        };
        let mut after_mtime = QueryBuilder::<Postgres>::new("");
        push_scalar_order_after(
            &mut after_mtime,
            &descending_mtime,
            &json!("2026-01-01T00:00:00.000000Z"),
        );
        assert_eq!(after_mtime.sql(), "p.file_modified_at < $1::timestamptz");
    }

    #[tokio::test]
    async fn scan_permit_gate_is_bounded_and_releases_independently() {
        let semaphore = Arc::new(Semaphore::new(2));
        let counters = Arc::new(HostedQueryActivityCounters::default());
        let first = HostedScanPermitGuard::new(
            semaphore.clone().acquire_owned().await.unwrap(),
            counters.clone(),
        );
        let second = HostedScanPermitGuard::new(
            semaphore.clone().acquire_owned().await.unwrap(),
            counters.clone(),
        );
        assert_eq!(
            counters.active_scan_permits.load(AtomicOrdering::Relaxed),
            2
        );
        assert!(
            tokio::time::timeout(Duration::from_millis(10), semaphore.clone().acquire_owned())
                .await
                .is_err()
        );
        drop(first);
        let replacement = HostedScanPermitGuard::new(
            semaphore.clone().acquire_owned().await.unwrap(),
            counters.clone(),
        );
        drop(second);
        drop(replacement);
        assert_eq!(
            counters.active_scan_permits.load(AtomicOrdering::Relaxed),
            0
        );
        assert_eq!(semaphore.available_permits(), 2);
    }

    #[tokio::test]
    async fn execution_memory_permit_gate_accounts_and_releases_bytes() {
        let semaphore = Arc::new(Semaphore::new(8));
        let counters = Arc::new(HostedQueryActivityCounters::default());
        let guard = HostedExecutionMemoryGuard::new(
            semaphore.clone().acquire_many_owned(5).await.unwrap(),
            counters.clone(),
            5,
        );
        assert_eq!(
            counters
                .accounted_execution_bytes
                .load(AtomicOrdering::Relaxed),
            5
        );
        assert_eq!(semaphore.available_permits(), 3);
        drop(guard);
        assert_eq!(
            counters
                .accounted_execution_bytes
                .load(AtomicOrdering::Relaxed),
            0
        );
        assert_eq!(semaphore.available_permits(), 8);
    }
}

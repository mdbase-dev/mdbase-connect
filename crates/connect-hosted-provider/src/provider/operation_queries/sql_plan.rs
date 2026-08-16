fn push_candidate_predicate(
    query: &mut QueryBuilder<Postgres>,
    predicate: &mdbase::runtime::CandidatePredicate,
) {
    use mdbase::runtime::CandidatePredicate;
    match predicate {
        CandidatePredicate::All => {
            query.push("TRUE");
        }
        CandidatePredicate::None => {
            query.push("FALSE");
        }
        CandidatePredicate::HasType { type_name } => {
            query
                .push("matched_types @> ARRAY[")
                .push_bind(type_name.clone())
                .push("]::text[]");
        }
        CandidatePredicate::And { terms } | CandidatePredicate::Or { terms } => {
            let separator = if matches!(predicate, CandidatePredicate::And { .. }) {
                " AND "
            } else {
                " OR "
            };
            query.push("(");
            for (index, term) in terms.iter().enumerate() {
                if index > 0 {
                    query.push(separator);
                }
                push_candidate_predicate(query, term);
            }
            query.push(")");
        }
        CandidatePredicate::Not { term } if candidate_predicate_is_total(term) => {
            query.push("NOT (");
            push_candidate_predicate(query, term);
            query.push(")");
        }
        CandidatePredicate::Not { .. } => {
            query.push("TRUE");
        }
        CandidatePredicate::Compare { comparison }
            if comparison.pruning
                == mdbase::runtime::CandidateComparisonPruning::NormalizedTagHierarchy
                && comparison.field == mdbase::runtime::CandidateField::BodyTags
                && comparison.operator
                    == mdbase::runtime::CandidateComparisonOperator::Contains
                && comparison.value.is_string() =>
        {
            push_tag_hierarchy_candidate_comparison(query, comparison);
        }
        CandidatePredicate::Compare { comparison }
            if comparison.pruning == mdbase::runtime::CandidateComparisonPruning::ExactJson
                && candidate_field_supported(&comparison.field) =>
        {
            push_candidate_comparison(query, comparison);
        }
        CandidatePredicate::Compare { comparison }
            if comparison.pruning
                == mdbase::runtime::CandidateComparisonPruning::IsoDateOnlyString
                && candidate_field_supported(&comparison.field) =>
        {
            push_iso_date_candidate_comparison(query, comparison);
        }
        CandidatePredicate::Compare { .. } => {
            query.push("TRUE");
        }
    }
}

fn push_tag_hierarchy_candidate_comparison(
    query: &mut QueryBuilder<Postgres>,
    comparison: &mdbase::runtime::CandidateComparison,
) {
    let needle = comparison
        .value
        .as_str()
        .expect("tag hierarchy pruning always has a normalized string literal");
    query.push("EXISTS (SELECT 1 FROM jsonb_array_elements_text(");
    push_candidate_field(query, &comparison.field);
    query.push(") AS candidate_tag(value) WHERE ltrim(candidate_tag.value, '#') = ");
    query.push_bind(needle.to_string());
    query.push(" OR left(ltrim(candidate_tag.value, '#'), char_length(");
    query.push_bind(needle.to_string());
    query.push(") + 1) = ");
    query.push_bind(format!("{needle}/")).push(")");
}

fn candidate_predicate_is_total(predicate: &mdbase::runtime::CandidatePredicate) -> bool {
    use mdbase::runtime::CandidatePredicate;
    match predicate {
        CandidatePredicate::All | CandidatePredicate::None | CandidatePredicate::HasType { .. } => {
            true
        }
        CandidatePredicate::And { terms } | CandidatePredicate::Or { terms } => {
            terms.iter().all(candidate_predicate_is_total)
        }
        CandidatePredicate::Not { term } => candidate_predicate_is_total(term),
        CandidatePredicate::Compare { .. } => false,
    }
}

fn candidate_predicate_is_projection_exact(
    predicate: &mdbase::runtime::CandidatePredicate,
) -> bool {
    use mdbase::runtime::{
        CandidateComparisonOperator as Operator, CandidateComparisonPruning as Pruning,
        CandidatePredicate, HostedScalarKind,
    };
    match predicate {
        CandidatePredicate::All | CandidatePredicate::None | CandidatePredicate::HasType { .. } => {
            true
        }
        CandidatePredicate::And { terms } | CandidatePredicate::Or { terms } => {
            terms.iter().all(candidate_predicate_is_projection_exact)
        }
        CandidatePredicate::Not { term } => candidate_predicate_is_projection_exact(term),
        CandidatePredicate::Compare { comparison } => {
            comparison.pruning == Pruning::ExactJson
                && matches!(
                    comparison.operator,
                    Operator::Equal | Operator::NotEqual | Operator::In
                )
                && match comparison.value_kind {
                    Some(HostedScalarKind::String) => match comparison.operator {
                        Operator::In => comparison
                            .value
                            .as_array()
                            .is_some_and(|values| values.iter().all(Value::is_string)),
                        _ => comparison.value.is_string(),
                    },
                    Some(HostedScalarKind::Boolean) => match comparison.operator {
                        Operator::In => comparison
                            .value
                            .as_array()
                            .is_some_and(|values| values.iter().all(Value::is_boolean)),
                        _ => comparison.value.is_boolean(),
                    },
                    Some(HostedScalarKind::Number) | None => false,
                }
        }
    }
}

fn push_exact_candidate_predicate(
    query: &mut QueryBuilder<Postgres>,
    predicate: &mdbase::runtime::CandidatePredicate,
) {
    use mdbase::runtime::{CandidateComparisonOperator as Operator, CandidatePredicate};
    match predicate {
        CandidatePredicate::All => {
            query.push("TRUE");
        }
        CandidatePredicate::None => {
            query.push("FALSE");
        }
        CandidatePredicate::HasType { type_name } => {
            query
                .push("matched_types @> ARRAY[")
                .push_bind(type_name.clone())
                .push("]::text[]");
        }
        CandidatePredicate::And { terms } | CandidatePredicate::Or { terms } => {
            let separator = if matches!(predicate, CandidatePredicate::And { .. }) {
                " AND "
            } else {
                " OR "
            };
            query.push("(");
            for (index, term) in terms.iter().enumerate() {
                if index > 0 {
                    query.push(separator);
                }
                push_exact_candidate_predicate(query, term);
            }
            query.push(")");
        }
        CandidatePredicate::Not { term } => {
            query.push("NOT (");
            push_exact_candidate_predicate(query, term);
            query.push(")");
        }
        CandidatePredicate::Compare { comparison } => match comparison.operator {
            Operator::Equal | Operator::NotEqual => {
                push_candidate_field(query, &comparison.field);
                query.push(if comparison.operator == Operator::Equal {
                    " = "
                } else {
                    " <> "
                });
                query.push_bind(sqlx::types::Json(comparison.value.clone()));
            }
            Operator::In => {
                query.push("(");
                for (index, value) in comparison
                    .value
                    .as_array()
                    .expect("exact scalar membership was validated above")
                    .iter()
                    .enumerate()
                {
                    if index > 0 {
                        query.push(" OR ");
                    }
                    push_candidate_field(query, &comparison.field);
                    query
                        .push(" = ")
                        .push_bind(sqlx::types::Json(value.clone()));
                }
                if comparison
                    .value
                    .as_array()
                    .is_some_and(Vec::is_empty)
                {
                    query.push("FALSE");
                }
                query.push(")");
            }
            Operator::LessThan
            | Operator::LessThanOrEqual
            | Operator::GreaterThan
            | Operator::GreaterThanOrEqual
            | Operator::Contains => {
                unreachable!("exact candidate support was checked before SQL translation")
            }
        },
    }
}

fn candidate_field_supported(field: &mdbase::runtime::CandidateField) -> bool {
    use mdbase::runtime::CandidateField;
    match field {
        CandidateField::Path
        | CandidateField::Types
        | CandidateField::PersistedFrontmatter(_)
        | CandidateField::EffectiveFrontmatter(_)
        | CandidateField::BodyTags => true,
        CandidateField::File(name) => {
            matches!(
                name.as_str(),
                "path" | "name" | "basename" | "ext" | "size" | "mtime"
            )
        }
    }
}

fn push_iso_date_candidate_comparison(
    query: &mut QueryBuilder<Postgres>,
    comparison: &mdbase::runtime::CandidateComparison,
) {
    use mdbase::runtime::CandidateComparisonOperator as Op;
    let operator = match comparison.operator {
        Op::Equal => " = ",
        Op::NotEqual => " <> ",
        Op::LessThan => " < ",
        Op::LessThanOrEqual => " <= ",
        Op::GreaterThan => " > ",
        Op::GreaterThanOrEqual => " >= ",
        Op::In | Op::Contains => unreachable!("date-only proof is a scalar comparison"),
    };
    let literal = comparison
        .value
        .as_str()
        .expect("date-only pruning proof has a string literal");
    query.push("(");
    push_candidate_field(query, &comparison.field);
    query.push(" IS NULL OR jsonb_typeof(");
    push_candidate_field(query, &comparison.field);
    query.push(") <> 'string' OR (");
    push_candidate_field(query, &comparison.field);
    query.push(" #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR (");
    push_candidate_field(query, &comparison.field);
    query
        .push(" #>> '{}') COLLATE \"C\"")
        .push(operator)
        .push_bind(literal.to_string())
        .push(")");
}

fn push_candidate_comparison(
    query: &mut QueryBuilder<Postgres>,
    comparison: &mdbase::runtime::CandidateComparison,
) {
    use mdbase::runtime::CandidateComparisonOperator as Op;
    match comparison.operator {
        Op::Equal | Op::NotEqual => {
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR ");
            push_candidate_field(query, &comparison.field);
            query.push(if comparison.operator == Op::Equal {
                " = "
            } else {
                " <> "
            });
            query
                .push_bind(sqlx::types::Json(comparison.value.clone()))
                .push(")");
        }
        Op::LessThan | Op::LessThanOrEqual | Op::GreaterThan | Op::GreaterThanOrEqual => {
            let operator = match comparison.operator {
                Op::LessThan => " < ",
                Op::LessThanOrEqual => " <= ",
                Op::GreaterThan => " > ",
                Op::GreaterThanOrEqual => " >= ",
                _ => unreachable!(),
            };
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR (");
            if let Some(value) = comparison.value.as_str() {
                query.push("jsonb_typeof(");
                push_candidate_field(query, &comparison.field);
                query.push(") = 'string' AND (");
                push_candidate_field(query, &comparison.field);
                query
                    .push(" #>> '{}') COLLATE \"C\"")
                    .push(operator)
                    .push_bind(value.to_string());
            } else {
                query.push("jsonb_typeof(");
                push_candidate_field(query, &comparison.field);
                query.push(") = 'number' AND ");
                push_candidate_field(query, &comparison.field);
                query
                    .push(operator)
                    .push_bind(sqlx::types::Json(comparison.value.clone()));
            }
            query.push("))");
        }
        Op::In => {
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR ");
            let values = comparison
                .value
                .as_array()
                .expect("exact membership pruning always has an array literal");
            query.push("(");
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    query.push(" OR ");
                }
                push_candidate_field(query, &comparison.field);
                query
                    .push(" = ")
                    .push_bind(sqlx::types::Json(value.clone()));
            }
            if values.is_empty() {
                query.push("FALSE");
            }
            query.push("))");
        }
        Op::Contains => {
            query.push("(");
            push_candidate_field(query, &comparison.field);
            query.push(" IS NULL OR (jsonb_typeof(");
            push_candidate_field(query, &comparison.field);
            query.push(") = 'array' AND ");
            push_candidate_field(query, &comparison.field);
            query
                .push(" @> ")
                .push_bind(sqlx::types::Json(Value::Array(vec![comparison
                    .value
                    .clone()])));
            if let Some(value) = comparison.value.as_str() {
                query.push(" OR (jsonb_typeof(");
                push_candidate_field(query, &comparison.field);
                query.push(") = 'string' AND strpos(");
                push_candidate_field(query, &comparison.field);
                query
                    .push(" #>> '{}', ")
                    .push_bind(value.to_string())
                    .push(") > 0)");
            }
            query.push("))");
        }
    }
}

fn push_candidate_field(
    query: &mut QueryBuilder<Postgres>,
    field: &mdbase::runtime::CandidateField,
) {
    use mdbase::runtime::CandidateField;
    match field {
        CandidateField::Path => {
            query.push("to_jsonb(canonical_path)");
        }
        CandidateField::Types => {
            query.push("to_jsonb(matched_types)");
        }
        CandidateField::PersistedFrontmatter(path) => {
            let mut full = vec!["persisted_frontmatter".to_string()];
            full.extend(path.iter().cloned());
            query.push("semantic_projection #> ").push_bind(full);
        }
        CandidateField::EffectiveFrontmatter(path) => {
            let mut full = vec!["effective_frontmatter".to_string()];
            full.extend(path.iter().cloned());
            query.push("semantic_projection #> ").push_bind(full);
        }
        CandidateField::BodyTags => {
            query.push(
                r#"(CASE jsonb_typeof(semantic_projection #> '{effective_frontmatter,tags}')
                     WHEN 'array' THEN (
                       SELECT COALESCE(jsonb_agg(to_jsonb(ltrim(value, '#'))), '[]'::jsonb)
                       FROM jsonb_array_elements_text(
                         semantic_projection #> '{effective_frontmatter,tags}'
                       ) AS tag(value)
                     )
                     WHEN 'string' THEN jsonb_build_array(to_jsonb(ltrim(
                       semantic_projection #>> '{effective_frontmatter,tags}', '#'
                     )))
                     ELSE '[]'::jsonb
                   END || COALESCE(
                     semantic_projection #> '{structure,body_tags}', '[]'::jsonb
                   ))"#,
            );
        }
        CandidateField::File(name) => {
            let projected_name = if name == "ext" { "extension" } else { name };
            query
                .push("semantic_projection #> ")
                .push_bind(vec!["file".to_string(), projected_name.to_string()]);
        }
    }
}

fn candidate_type_union(predicate: &mdbase::runtime::CandidatePredicate) -> Option<Vec<String>> {
    use mdbase::runtime::CandidatePredicate;
    match predicate {
        CandidatePredicate::All => Some(Vec::new()),
        CandidatePredicate::None => Some(vec!["__mdbase_no_such_type__".to_string()]),
        CandidatePredicate::HasType { type_name } => Some(vec![type_name.clone()]),
        CandidatePredicate::Or { terms } => {
            let mut types = Vec::new();
            for term in terms {
                let term_types = candidate_type_union(term)?;
                if term_types.is_empty() {
                    return Some(Vec::new());
                }
                types.extend(term_types);
            }
            types.sort();
            types.dedup();
            Some(types)
        }
        CandidatePredicate::And { terms } => {
            let mut narrowest = Vec::new();
            for term in terms {
                let term_types = candidate_type_union(term)?;
                if !term_types.is_empty()
                    && (narrowest.is_empty() || term_types.len() < narrowest.len())
                {
                    narrowest = term_types;
                }
            }
            Some(narrowest)
        }
        CandidatePredicate::Not { .. } | CandidatePredicate::Compare { .. } => Some(Vec::new()),
    }
}

fn projected_scalar_order_supported(plan: &mdbase::runtime::HostedQueryPlan) -> bool {
    plan.order.iter().all(|order| {
        order.value_kind == Some(mdbase::runtime::HostedScalarKind::String)
            && match &order.field {
                mdbase::runtime::CandidateField::Path => true,
                mdbase::runtime::CandidateField::File(name) => {
                    matches!(name.as_str(), "path" | "mtime")
                }
                mdbase::runtime::CandidateField::PersistedFrontmatter(path)
                | mdbase::runtime::CandidateField::EffectiveFrontmatter(path) => !path.is_empty(),
                mdbase::runtime::CandidateField::Types
                | mdbase::runtime::CandidateField::BodyTags => false,
            }
    })
}

fn projected_direct_order_supported(plan: &mdbase::runtime::HostedQueryPlan) -> bool {
    plan.order.iter().all(|order| match &order.field {
        mdbase::runtime::CandidateField::Path => true,
        mdbase::runtime::CandidateField::File(name) if name == "path" => true,
        mdbase::runtime::CandidateField::File(name) if name == "mtime" => matches!(
            order.direction,
            mdbase::runtime::HostedOrderDirection::Descending
        ),
        _ => false,
    })
}

fn projected_grouping_supported(plan: &mdbase::runtime::HostedQueryPlan) -> bool {
    !plan.groups.is_empty()
        && plan.groups.iter().all(|group| {
            group.value_kind == Some(mdbase::runtime::HostedScalarKind::String)
                && match &group.field {
                    mdbase::runtime::CandidateField::Path => true,
                    mdbase::runtime::CandidateField::File(name) => {
                        matches!(name.as_str(), "path" | "mtime")
                    }
                    mdbase::runtime::CandidateField::PersistedFrontmatter(path)
                    | mdbase::runtime::CandidateField::EffectiveFrontmatter(path) => {
                        !path.is_empty()
                    }
                    mdbase::runtime::CandidateField::Types
                    | mdbase::runtime::CandidateField::BodyTags => false,
                }
        })
        && plan
            .aggregates
            .iter()
            .all(|aggregate| aggregate.provider_safe && aggregate.function == "count")
}

fn query_page_size(input: &Value) -> ApiResult<u64> {
    match input.get("limit") {
        None => Ok(100),
        Some(value) => value.as_u64().filter(|value| *value > 0).ok_or_else(|| {
            ApiError::bad_request(
                "invalid_query",
                "Hosted query limit must be a positive integer.",
            )
        }),
    }
}

fn decode_sha256_digest(value: &str) -> ApiResult<Vec<u8>> {
    let hex = value
        .strip_prefix("sha256:")
        .ok_or_else(|| ApiError::internal("A hosted query digest has an unsupported format."))?;
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ApiError::internal("A hosted query digest is malformed."));
    }
    (0..32)
        .map(|index| {
            u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16)
                .map_err(|_| ApiError::internal("A hosted query digest is malformed."))
        })
        .collect()
}

fn encode_query_cursor(cursor_id: Uuid) -> String {
    format!("hq1.{}", URL_SAFE_NO_PAD.encode(cursor_id.as_bytes()))
}

fn decode_query_cursor(value: &str) -> ApiResult<Uuid> {
    let encoded = value.strip_prefix("hq1.").ok_or_else(|| {
        ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor has an unsupported format.",
        )
    })?;
    let bytes = URL_SAFE_NO_PAD.decode(encoded).map_err(|_| {
        ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor is malformed.",
        )
    })?;
    let cursor_id = Uuid::from_slice(&bytes).map_err(|_| {
        ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor is malformed.",
        )
    })?;
    if encode_query_cursor(cursor_id) != value {
        return Err(ApiError::bad_request(
            "invalid_query_cursor",
            "The hosted query cursor is not canonical.",
        ));
    }
    Ok(cursor_id)
}

fn query_cursor_conflict(code: &str, message: &str) -> ApiError {
    ApiError::conflict(code, message)
}

fn empty_query_result() -> OperationResult {
    OperationResult {
        valid: true,
        result: json!({
            "results": [],
            "meta": { "total_count": 0, "has_more": false },
            "diagnostics": [],
        }),
        diagnostics: Vec::new(),
    }
}

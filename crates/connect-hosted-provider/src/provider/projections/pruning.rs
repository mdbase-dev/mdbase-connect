pub(super) async fn prune_unpinned_projection_generations_in(
    transaction: &mut Transaction<'_, Postgres>,
    collection_id: Uuid,
) -> ApiResult<()> {
    super::operation_queries::cleanup_expired_query_cursors(
        &mut **transaction,
        Some(collection_id),
    )
    .await?;
    super::operation_queries::cleanup_base_query_invocations(
        &mut **transaction,
        collection_id,
        None,
    )
    .await?;
    let removable = sqlx::query_scalar::<_, Uuid>(
        r#"SELECT generation_id
           FROM hosted_provider_projection_generations generation
           WHERE generation.collection_id = $1
             AND generation.status IN ('complete', 'abandoned')
             AND NOT EXISTS (
               SELECT 1 FROM hosted_provider_collections collection
               WHERE collection.id = generation.collection_id
                 AND collection.active_projection_generation_id = generation.generation_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM hosted_provider_query_cursors cursor
               WHERE cursor.collection_id = generation.collection_id
                 AND cursor.generation_id = generation.generation_id
                 AND cursor.hard_expires_at > now()
             )
           ORDER BY generation.updated_at, generation.generation_id"#,
    )
    .bind(collection_id)
    .fetch_all(&mut **transaction)
    .await?;
    if removable.is_empty() {
        return Ok(());
    }
    sqlx::query(
        "DELETE FROM hosted_provider_record_relationships
         WHERE collection_id = $1 AND generation_id = ANY($2::uuid[])",
    )
    .bind(collection_id)
    .bind(&removable)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "DELETE FROM hosted_provider_record_resolution_keys
         WHERE collection_id = $1 AND generation_id = ANY($2::uuid[])",
    )
    .bind(collection_id)
    .bind(&removable)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "DELETE FROM hosted_provider_record_projections
         WHERE collection_id = $1 AND generation_id = ANY($2::uuid[])",
    )
    .bind(collection_id)
    .bind(&removable)
    .execute(&mut **transaction)
    .await?;
    sqlx::query(
        "DELETE FROM hosted_provider_projection_generations
         WHERE collection_id = $1 AND generation_id = ANY($2::uuid[])",
    )
    .bind(collection_id)
    .bind(&removable)
    .execute(&mut **transaction)
    .await?;
    Ok(())
}

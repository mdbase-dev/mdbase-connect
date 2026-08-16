EXPLAIN (ANALYZE, BUFFERS, WAL, SETTINGS, FORMAT TEXT)
WITH live AS (
  SELECT DISTINCT ON (record_id)
         record_id, sequence, revision, deleted
  FROM hosted_provider_record_versions
  WHERE collection_id = '01a00970-bddd-7d23-9d03-f8f626c0ff06'
    AND sequence <= 4
  ORDER BY record_id, sequence DESC
), joined AS (
  SELECT l.record_id,
         l.deleted,
         p.matched_types,
         p.canonical_path,
         p.semantic_projection,
         p.record_id IS NOT NULL
           AND p.record_sequence = l.sequence
           AND p.record_revision = l.revision
           AND p.catalog_revision =
             'sha256:e85a4745d8ec2fd63de2f6b8a1f45401413528841cf1375dca04149cfcd5b399'
           AND p.projection_format_version = 3
           AND p.semantic_engine_version = '0.4.0-rc.4'
           AND p.semantic_complete
           AND p.resolution_complete AS projection_current
  FROM live l
  LEFT JOIN hosted_provider_record_projections p
    ON p.collection_id = '01a00970-bddd-7d23-9d03-f8f626c0ff06'
   AND p.generation_id = '2ea39602-5767-4f10-83fb-659a6bdc91e8'
   AND p.record_id = l.record_id
   AND p.valid_from_sequence <= 4
   AND (p.valid_to_sequence IS NULL OR p.valid_to_sequence > 4)
)
SELECT record_id,
       CASE WHEN projection_current THEN canonical_path END AS canonical_path,
       CASE WHEN projection_current THEN semantic_projection END AS semantic_projection
FROM joined
WHERE NOT deleted
  AND (
    NOT projection_current
    OR (
      (cardinality(ARRAY[]::text[]) = 0 OR matched_types && ARRAY[]::text[])
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          CASE jsonb_typeof(semantic_projection #> '{effective_frontmatter,tags}')
            WHEN 'array' THEN (
              SELECT COALESCE(
                jsonb_agg(to_jsonb(ltrim(value, '#'))),
                '[]'::jsonb
              )
              FROM jsonb_array_elements_text(
                semantic_projection #> '{effective_frontmatter,tags}'
              ) AS tag(value)
            )
            WHEN 'string' THEN jsonb_build_array(to_jsonb(ltrim(
              semantic_projection #>> '{effective_frontmatter,tags}', '#'
            )))
            ELSE '[]'::jsonb
          END || COALESCE(
            semantic_projection #> '{structure,body_tags}',
            '[]'::jsonb
          )
        ) AS candidate_tag(value)
        WHERE ltrim(candidate_tag.value, '#') = 'task'
           OR left(ltrim(candidate_tag.value, '#'), char_length('task') + 1) = 'task/'
      )
    )
  )
ORDER BY record_id
LIMIT 10001;

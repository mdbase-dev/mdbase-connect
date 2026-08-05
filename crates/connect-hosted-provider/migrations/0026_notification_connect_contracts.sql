-- Beta.32 makes the independent Connect compatibility ceilings explicit on
-- every grant summary. Provider notification grants are a durable projection
-- of already-approved control-plane grants, so derive the new ceiling from the
-- permissions that were actually stored instead of accepting an implicit
-- runtime default.
UPDATE hosted_provider_notification_grants AS stored_grant
SET grant_json = jsonb_set(
      stored_grant.grant_json,
      '{contracts}',
      jsonb_build_object(
        'operation_transport', 2,
        'authorization_binding', 3,
        'semantic_capabilities', 1
      ) || CASE
        WHEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(stored_grant.grant_json -> 'operations', '[]'::jsonb)
          ) AS operation(name)
          WHERE operation.name IN (
            'create_view_source',
            'update_view_source',
            'delete_view_source',
            'create',
            'update',
            'delete',
            'rename',
            'create_type',
            'update_type',
            'apply_type_pack',
            'put_timer',
            'cancel_timer',
            'reconcile_timers',
            'sync'
          )
        ) OR EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(
            COALESCE(
              stored_grant.grant_json #> '{file_capability,actions}',
              '[]'::jsonb
            )
          ) AS file_action(name)
          WHERE file_action.name IN ('add', 'replace', 'move', 'delete')
        ) THEN jsonb_build_object('durable_mutation', 1)
        ELSE '{}'::jsonb
      END,
      true
    ),
    updated_at = now()
WHERE NOT stored_grant.grant_json ? 'contracts';

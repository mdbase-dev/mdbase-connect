-- mdbase:skip-if-missing-table applications
-- Installation-device authorization belongs to registered applications. It is
-- operator-owned: ordinary manifest upserts never change this allowlist.
ALTER TABLE applications ADD COLUMN installation_origins jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(installation_origins) = 'object');

-- Minimal normalized TaskNotes installation declaration. Its ordinary family
-- also covers the app's separately registered, versioned OAuth declarations.
-- The ID is public configuration, not a credential. Preserve historical pairing
-- app_id values: they are part of the immutable credential derivation.
INSERT INTO applications (
  id, canonical_identity, family_identity, manifest_version, manifest_digest,
  distribution, name, homepage, redirect_uris, requirements, provisions,
  notifications, application_declaration, installation_origins
) VALUES (
  '5cdfa020-c201-4da8-845a-f2cc9969eade',
  'bundle:dev.tasknotes.app:sha256:5435d252a86e3eecf600f48322a06607d1500c8d9dedd23e538c681275256d91',
  'bundle:dev.tasknotes.app', 1,
  '5435d252a86e3eecf600f48322a06607d1500c8d9dedd23e538c681275256d91',
  'web', 'TaskNotes', 'https://app.tasknotes.dev/',
  '["https://app.tasknotes.dev/auth/mdbase/callback","dev.tasknotes.app://auth/mdbase/callback"]',
  '{"configuration":[],"access":"full_collection","contracts":[]}',
  '{"type_packs":[],"configuration":[]}', '{"criteria":[]}',
  '{"manifest_version":1,"distribution":"web","id":"dev.tasknotes.app","name":"TaskNotes","homepage":"https://app.tasknotes.dev/","redirect_uris":["https://app.tasknotes.dev/auth/mdbase/callback","dev.tasknotes.app://auth/mdbase/callback"],"requirements":{"configuration":[],"access":"full_collection","contracts":[]},"provisions":{"type_packs":[],"configuration":[]},"notifications":{"criteria":[]}}',
  '{
    "production":{"app-runtime":["https://app.tasknotes.dev"],"mobile":["https://app.tasknotes.dev","capacitor://app.tasknotes.dev"]},
    "staging":{"app-runtime":["https://staging.tasknotes-app.pages.dev"],"mobile":["https://app.tasknotes.dev","capacitor://app.tasknotes.dev"]},
    "lab":{"app-runtime":["https://lab.tasknotes-app.pages.dev","http://127.0.0.1:48218"],"mobile":["https://app.tasknotes.dev","capacitor://app.tasknotes.dev"]}
  }'
) ON CONFLICT (canonical_identity) DO UPDATE SET installation_origins=EXCLUDED.installation_origins;

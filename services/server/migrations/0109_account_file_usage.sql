-- Uploaded-file bytes the file quota pass last measured for each account that
-- holds a native collection: the figure it allocates against the plan. The usage
-- report counts accounts by size from it; nothing enforces from it. The pass
-- replaces a row each time it measures the account and deletes it once the
-- account holds no collection.
CREATE TABLE account_file_usage (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  file_bytes bigint NOT NULL CHECK (file_bytes >= 0)
);

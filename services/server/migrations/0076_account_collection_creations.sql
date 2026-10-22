-- Account creation intent survives an unknown bootstrap outcome. Runtime is a
-- server composition decision, never a caller field. These rows contain no keys
-- or content authority. Publication does not assert collection readiness.
CREATE TABLE account_collection_creations (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  collection_id uuid NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  timezone text NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('legacy', 'next')),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (user_id, request_id)
);

-- mdbase:account-collection-intent-immutable:v1
-- A later retry cannot silently become a different creation, even if a future
-- writer accidentally tries to update the row. Publication is one-way too.
CREATE FUNCTION guard_account_collection_creation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.user_id, NEW.request_id, NEW.collection_id, NEW.display_name, NEW.timezone, NEW.runtime, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.user_id, OLD.request_id, OLD.collection_id, OLD.display_name, OLD.timezone, OLD.runtime, OLD.created_at)
     OR (OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at) THEN
    RAISE EXCEPTION 'Account collection creation intent is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_account_collection_creation BEFORE UPDATE ON account_collection_creations
FOR EACH ROW EXECUTE FUNCTION guard_account_collection_creation();

-- Occasional announcements (email_jobs category 'onboarding': the welcome
-- message and later announcements) are on by default and can be turned off;
-- product updates stay opt-in. Every non-essential message carries an
-- unsubscribe token, stored only as a hash, that turns off the preference it
-- was sent under.
ALTER TABLE account_email_preferences
  ADD COLUMN announcements_enabled boolean NOT NULL DEFAULT true;

CREATE TABLE email_unsubscribe_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preference text NOT NULL
    CHECK (preference IN ('announcements', 'product_updates')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The copy of one-off announcement emails, stored by operators so that changing
-- it needs no deployment. Rows are never updated: a change is a new version, and
-- each queued email_jobs row (message_kind 'announcement.<slug>') names the
-- version it renders in template_version.
CREATE TABLE email_announcements (
  slug text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  subject text NOT NULL,
  -- Paragraphs separated by blank lines; {name} is the recipient's name.
  body text NOT NULL,
  -- What accounts with a beta grant receive instead, when set.
  beta_body text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, version)
);

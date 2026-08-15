-- Browser extensions use the portable, key-bound device flow, but unlike
-- native applications they have a stable browser origin. Preserve that origin
-- so the resulting capability can be restricted to the initiating extension.

ALTER TABLE authorization_requests
  ADD COLUMN device_origin text;

-- Real, normalized listing images; metadata-only legacy records remain untouched.
CREATE TABLE agency_photo_files (
  media_id text PRIMARY KEY REFERENCES agency_listing_media(id) ON DELETE CASCADE,
  content bytea NOT NULL CHECK (octet_length(content) BETWEEN 1 AND 524288),
  created_at timestamptz NOT NULL DEFAULT now()
);

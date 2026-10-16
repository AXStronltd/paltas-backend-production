-- Persist property document bytes in PostgreSQL, scoped to the same organisation as their metadata.
CREATE UNIQUE INDEX pm_documents_org_identity ON pm_documents (org_id,id);
CREATE TABLE pm_document_files (
 document_id text PRIMARY KEY,
 org_id text NOT NULL REFERENCES organisations(id),
 filename text NOT NULL,
 media_type text NOT NULL CHECK(media_type IN ('application/pdf','image/png','image/jpeg','text/plain','text/csv')),
 content bytea NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 2097152),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 uploaded_by text REFERENCES users(id),
 uploaded_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(org_id,document_id) REFERENCES pm_documents(org_id,id)
);
CREATE INDEX pm_document_files_org ON pm_document_files(org_id);

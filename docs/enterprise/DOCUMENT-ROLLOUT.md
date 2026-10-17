# Private operational document rollout

No migration is required; production already has migration 0014_property_document_files.

1. Backend first: scoped tenant/owner downloads use exactly the same visibility filter as portal document lists. Owner portal includes its document records.
2. Frontend second: metadata records gain upload/download controls; contact and client portals share the same file controls.
3. PM_DOCUMENT_FILE_UPLOADS_ENABLED=false stops new uploads while retaining metadata and existing downloads. Its default true preserves the existing API behaviour.
4. Classified identity, screening and employment files are rejected. No claim is made to identify mislabelled sensitive files, validate legal identity or scan malware.
5. Files are bounded to 2 MiB and 256 MiB per company, stored privately, hash checked and audited. Download as an attachment; never render file content inline.
6. Retention, deletion approval, residency, encryption-key policies and malware scanning require the next privacy/storage workstream. This module is not the complete global document compliance programme.
7. Verify using synthetic files on dedicated Supabase staging, then deploy only after CI and hosted checks pass. Do not copy production customer files into staging.

Security checks: staff-only visibility, linked tenant/contact/lease visibility, owner/property agreements, cross-company refusal, read-only write refusal, type/size/path validation, immutable versions and audit entries without file contents.

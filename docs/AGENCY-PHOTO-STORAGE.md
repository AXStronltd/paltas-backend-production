# Persistent listing photos

The photo upload endpoint stores real image bytes in PostgreSQL, alongside the listing metadata. No external storage credentials or paid infrastructure are required for this bounded initial implementation.

- POST `/api/v1/orgs/:orgId/agency/listings/:listingId/photos` accepts `fileName`, optional `caption`, and canonical `contentBase64` (up to 2 MiB input).
- The server accepts JPEG, PNG and WebP only, fully decodes and re-encodes to JPEG, strips original metadata, caps input at 16 million pixels, resizes within 1600 × 1600 and caps stored output at 512 KiB.
- Up to 20 stored photos per listing and 100 MiB per company. Uploads serialize per company to enforce concurrent quota checks.
- Role, company, subscription and editable-listing gates apply. Metadata and bytes commit atomically. Removing a media record cascades to its bytes.
- Public JPEG URLs return 404 unless the listing is published and the company subscription is usable. Responses use `no-store` so withdrawing a listing does not leave an intentional CDN cache. A downloaded image cannot be remotely revoked.
- Submission and staff approval require a stored photo; legacy metadata alone cannot satisfy publication requirements.
- Videos, tours and documents are not handled by this image endpoint. Do not label metadata registration as an uploaded file.

Migration `0021_agency_photo_files` is additive; it does not rewrite or delete legacy media. Database backups now also contain listing photos. Storage growth must be monitored; move bytes to a private object-storage provider before raising these limits for large customers.

The generated OpenAPI describes the public content response as binary JPEG. The typed API client's content method returns a JPEG data URL; browsers may use the public image URL directly.

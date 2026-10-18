# Multi-block and custom naming

Development change; do not apply migrations to production without release approval.

## Model

- `pm_buildings` is the existing block model; its name remains editable. `is_archived` defaults to false.
- `pm_units` retains its building foreign key, door (`unit_no`), floor, type, bedrooms, size (`area_sqm`) and market rent. `toilets` is nullable for existing records and constrained to 0–50.
- Door numbers remain unique within a property, preserving existing integrations.
- Archiving never deletes units, leases, rent steps, invoices, payments or audit entries. Empty-block deletion is protected by the existing foreign key.

## APIs

All routes require a signed-in organisation member and server-enforced Property Management permissions.

- `PUT /api/v1/orgs/:orgId/property/buildings/:buildingId` with `{ "name": "Block A" }` renames a block. Empty names are rejected.
- `DELETE /api/v1/orgs/:orgId/property/buildings/:buildingId` checks all leases whose status is active, including future-dated ones. It returns HTTP 400 with the active lease count if any exist. With no active leases, empty blocks are deleted and blocks containing units are archived. Both actions are audited.
- Unit creation/update accepts `buildingId`, `floor`, `unitNo`, `unitType`, `bedrooms`, `toilets`, `areaSqm`, and `marketRentMinor`.
- Tenant identity remains in the shared contacts API. Placement and agreed rent remain in the existing lease API (`POST /api/v1/orgs/:orgId/property/leases`): `tenantId`, `unitId`, optional matching `buildingId`/`floor`, and `rentMinor`. The server derives the authoritative location from the selected unit and rejects mismatches. There is no duplicate tenant/lease store or global unscoped `/api/tenants` endpoint.
- KES 12,000 agreed rent is `rentMinor:1200000`; it does not overwrite a unit's KES 140,000 market rent (`marketRentMinor:14000000`).

## Safety

Block row locks serialize archive, new unit placement and lease activation. Database triggers reject new placements and active leases in archived blocks even if an API-side check is bypassed. Other organisations receive 404. Legacy units without a block remain supported. Ended leases remain readable and payable after archive.

## Verification

`server/test/property.blocks.test.ts`: custom rename/name validation, empty deletion, cross-company denial, active lease refusal, rent override, payment-history preservation, archive with units, new placement refusal and concurrent archive/activation. Generated OpenAPI and browser contracts must be refreshed with the code.

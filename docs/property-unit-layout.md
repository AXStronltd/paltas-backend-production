# Universal floor and door layouts

The existing authenticated bulk API stores the supplied unit names, block IDs and floor fields in one transaction. The old browser form generated a sequential run on a single floor. It did not spread that run across floors.

The new layout generator explicitly iterates every configured floor and every door. Each name is `[floor padded to two digits][door padded to two digits] [block code]`: `0603 W`, `1102 E`. Floor 0 and up to floor 300 are supported. Different floors can have different door counts. Up to 500 units are submitted atomically through the existing organisation-scoped API.

## Operator script

`node scripts/generate-property-layout.mjs --plan=/secure/path/layout.json`

Set `PALTAS_API_ORIGIN` explicitly to the staging or production PALTAS API and provide an authorised company session in `PALTAS_OPERATOR_TOKEN`. Keep credentials out of plan files, logs and Git.

Example plan (replace the organisation, property and block IDs):

```json
{"orgId":"ORG-ID","propertyId":"PROPERTY-ID","blocks":[{"buildingId":"WEST-ID","initial":"W","floors":[{"floor":1,"doors":4},{"floor":2,"doors":3}]},{"buildingId":"EAST-ID","initial":"E","floors":[{"floor":1,"doors":2}]}]}
```

Dry-run checks property access, block membership and duplicate names. It prints only counts and a plan fingerprint. To add the reviewed units, pass `--apply --confirm=<fingerprint>`. A repeated run stops on duplicates. The server continues to enforce permissions, org isolation, entitlements and field validation.

## Existing incorrect records

This script never deletes units, moves leases or guesses a floor from a malformed label. Use the frontend's Edit unit details to correct each existing record in place through the existing unit update endpoint. This preserves unit IDs and linked tenancy/financial history. Do not delete and recreate occupied or historically used units. Any large existing-data correction needs an explicit reviewed mapping of old unit IDs to their intended floor, name and block.

Verification: `node scripts/test-property-layout.mjs`.

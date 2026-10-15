# Products

Each product is a folder here that exports one `ProductModule` (see `registry.ts`), added to `index.ts`:

| Folder         | Product                 | Server domain status | Client readiness                                      |
| -------------- | ----------------------- | -------------------- | ----------------------------------------------------- |
| `property/`    | Property Management     | Implemented          | Frontend API integration and production checks needed |
| `development/` | Real Estate Development | Implemented          | Frontend API integration and production checks needed |
| `security/`    | Security Services       | Implemented          | Frontend API integration and production checks needed |
| `agency/`      | Agent & Host            | Implemented          | Frontend API integration and production checks needed |
| `hotel/`       | Hotel Management        | Implemented          | Frontend API integration and provider checks needed   |

Inside a product folder, use the same layout as the core modules:

```
property/
  index.ts                  the ProductModule: routes, usage counter, payment handlers, ledger accounts
  leases/leases.service.ts  business rules (no HTTP, no SQL strings outside the repo)
  leases/leases.repo.ts     SQL only
  leases/leases.routes.ts   HTTP only: one route() per endpoint in @paltas/contracts
```

Rules every product follows:

- **Contracts first.** Add the product's endpoints and record shapes to `backend/contracts/src/api/<product>.ts`. The front end and the server both use them.
- **Access.** Every route starts with `core.access.scope(...)`. That checks membership, the role's capability, the product subscription, an active subscription for writes, and the module.
- **Money.** Post through `core.ledger.postSystemJournal(...)`. Never write your own ledger tables.
- **Audit.** Record changes with `recordAudit(...)`.
- **Migrations.** Add new numbered files in `server/migrations/`, prefixed with the product's tables (`pm_…`, `dev_…`).

The list above describes server product domains, not frontend workspace readiness. Every workspace still needs frontend API integration, cross-organisation isolation checks, and production provider configuration before client launch.

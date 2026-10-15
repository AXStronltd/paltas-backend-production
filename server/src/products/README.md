# Products

Each product is a folder here that exports one `ProductModule` (see `registry.ts`), added to `index.ts`:

| Folder                 | Product                                 | Status        |
| ---------------------- | --------------------------------------- | ------------- |
| `property-management/` | Property Management (Almas Tower pilot) | Next round    |
| `development/`         | Real Estate Development                 | Later round   |
| `security/`            | Security Services                       | Later round   |
| `agency/`, `hotel/`    | Agent & Host, Hotel                     | Not scheduled |

Inside a product folder, use the same layout as the core modules:

```
property-management/
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

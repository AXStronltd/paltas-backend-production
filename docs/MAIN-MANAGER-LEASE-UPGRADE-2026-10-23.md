# PALTAS operational access and lease workspace — 23 October 2026

## Release scope

This release extends the existing Property Management and shared organisation access architecture. It preserves existing roles, customer records, posted journals, Marketplace design, subscriptions, staff authentication and external payment integrations.

### Company administrator controls

Open the existing Team page (`account.html?org=YOUR_ORGANISATION#members`). Invite a colleague, then choose **Main Manager permissions** on their team entry. Appointment is restricted to an existing active organisation administrator (`org_admin`); this role is an access designation, not legal proof of property ownership.

Select products, actions and either all organisation properties or an explicit list of Property Management properties. Nothing is granted merely by naming someone a Main Manager. Unchecking every product revokes delegation. Requests load current database grants, so previously issued sessions do not retain revoked permissions. Every permission change records actor, organisation, before/after values and reason.

Staff Management requires organisation-wide delegation. A delegated manager must choose explicit product roles and cannot grant capabilities outside their own current grants. They cannot appoint administrators/Main Managers, change their own access, or suspend an administrator. A property-scoped manager cannot create unscoped staff access. Existing non-property product site-assignment controls are retained; PM property IDs are not reused for hotels or other products.

### Tenant controls

Open a tenant profile and expand **Manage tenant**. Tenant permissions are separate: view, register, edit, assignment, documents, lease creation/editing/activation/renewal/end, suspend/restore, archive, financial history and notices.

- **Suspend portal access** requires a reason, review date within 30 days, and confirmation that this is not eviction or debt enforcement. Core authorisation blocks the relevant tenant portal and private document routes even with an existing session. Other organisations remain separate.
- **Restore portal access** preserves the tenant's lease, documents and accounting records.
- **Archive tenant** removes the contact from default operational contact lists. Draft/active leases must first be cancelled/ended through the existing workflow. Financial and contractual history is retained. Restore the archived record before creating another lease.
- **Include archived records** makes retained contacts accessible in the contact list. No permanent tenant deletion was added.
- Review/appeal is through the property management office/company administrator or PALTAS support. A review date does not silently terminate a lease or automatically lift an unresolved suspension.

### Lease workspace

Opening a lease now uses the existing portal router and a dedicated full-page workspace, with Overview, Financials, Documents and Activity sections. It shows tenant, property/unit, legal ownership, current management authority, dates, rent, deposit, unpaid invoices and recorded signing date. Financial values use the existing invoice and ledger services.

Draft editing persists dates, rent, deposit handling and due day without posting invoices. Signed/active terms remain protected by existing renewal and audited rent-review workflows. **Review & Activate** reuses the transactionally rolled-back preview and explicit confirmation, expected-amount checks, authority/conflict checks and duplicate protection. Historical activation does not automatically generate historic rent or deposits.

Approved templates, reviewed drafts, signed copies and supporting documents can be uploaded through the existing private storage service (PDF/PNG/JPEG/plain text, 2 MiB/file). Upload and signing are distinct: storing a file never marks a lease signed. Failed uploads can retry against the pending document record. Downloads pass organisation, permission and property-context checks.

### Mixed ownership

The system supports a building's company-owned units alongside individually owned units, all managed by one authorised department. Unit-specific ownership and authority override incompatible building-wide mandates. Rent receivables, owner funds, management fees and deposit liabilities remain separate. No Almas unit was assigned to an owner from a numerical 67/33 split; actual ownership evidence and unit mapping remain customer/administrator inputs.

## Integrity and isolation

Additive migration `0035_operational_controls` adds delegation and tenant-control tables. Existing memberships, properties, units, leases, invoices and journal entries are not rewritten by the migration.

Restricted managers fail closed on unaudited/global operations. Organisation-wide ledger reconciliation, banking, exports and financial dashboard checks require organisation-wide authority. Contact reuse cannot reveal/reuse an out-of-scope contact. Contacts and receipt counts are scoped before their query limits/pagination; request-level checks also validate linked records, nested allocations and private documents.

## Explicit limitations

- A recorded signing date is not electronic signature verification. No e-signature provider was connected and no contract was automatically signed.
- AI legal drafting, a separate Pending Signature/Signed lifecycle and a new formal amendment approval service are not represented as completed features. Existing statuses and signed/active lease protection remain in place.
- External bank/M-Pesa transfers and refunds remain external actions. No real funds moved or customer emails were sent by release tests.
- Organisation-wide reports are intentionally unavailable to a property-scoped manager. This avoids exposing another building's balances.
- Property-scoped contact access is conservative when a person has relationships across multiple properties: all related properties must be assigned.

## Verification

See the accompanying release report for final test counts, exact deployed commits, hosting deployment IDs, migration readiness and production artifact checks. All automated financial test records and files are synthetic and isolated in local test databases.

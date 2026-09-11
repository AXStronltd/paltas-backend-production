/* ====================================================================== *
 * THE TWENTY-EIGHT RESOURCES, DECLARED ONCE.
 *
 * backend.md names 27 create forms and 45 further endpoints across six
 * products. Written by hand that is roughly 170 handlers, and they would be
 * 170 chances to forget `where: { orgId }` — which is the one mistake in this
 * system that shows one company another company's business.
 *
 * So they are not written by hand. Each resource declares WHAT IT IS, and
 * http/resource.js builds the five endpoints from that declaration with the
 * organization filter, the permission check, the pagination and the audit
 * entry already in place. A new resource is a dozen lines here, and it is
 * scoped because there is no code path in which it is not.
 *
 * WHAT A DECLARATION MEANS
 *
 *   model     the Prisma accessor — `db[model]`
 *   area      which block of access.js decides who may touch it
 *   product   the entitlement required to reach it at all. A company that
 *             has not bought Hotel Management cannot read a room, whatever
 *             role the person holds.
 *   fields    every field a request may write, and how to read it. A field
 *             that is not here CANNOT be set by any request — which is how
 *             `orgId`, `createdAt` and every computed total stay out of
 *             reach of a hand-written body.
 *   required  what a create must carry.
 *   numbered  the column holding a per-company number (INV-2026-0041, or a
 *             pass code). The framework allocates it, a caller may not
 *             choose one, and @@unique([orgId, <column>]) stops two racing
 *             requests being handed the same one.
 *   search    fields `?q=` looks in.
 *   order     the default ordering.
 *   include   related rows to return, and the columns of them. Always a
 *             `select`, never the whole row: an include without one is how
 *             a tenant's phone number ends up in a list nobody meant to
 *             expose it in.
 * ====================================================================== */

import { aliasesFor } from "./console-map.js";

/* Field kinds:
     string · text · int · money · float · bool · date · json
     enum:<EnumName>   one of that enum's values
     id:<resourceName> the id of another row IN THE SAME COMPANY — the
                       framework checks that before writing it, so a caller
                       cannot attach their invoice to somebody else's lease
                       by guessing an id. */

const AT = { createdAt: "date", updatedAt: "date" };   // never writable; listed for clarity only

export const RESOURCES = {

  /* ================================================== SHARED SPINE */

  sites: {
    model: "site", area: "property", product: null,
    label: "sites",
    fields: {
      name: "string", kind: "enum:SiteKind",
      address: "string", city: "string", country: "string",
      lat: "float", lng: "float", note: "text", status: "string",
      unitCount: "int", value: "money",
    },
    required: ["name"],
    search: ["name", "city", "address"],
    order: [{ name: "asc" }],
  },

  buildings: {
    model: "building", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "buildings",
    fields: {
      siteId: "id:site", name: "string", city: "string", floors: "int",
      unitCount: "int", builtYear: "int",
      condition: "enum:BuildingCondition", note: "text",
    },
    required: ["name"],
    search: ["name"],
    order: [{ name: "asc" }],
    include: { site: { select: { id: true, name: true } } },
  },

  units: {
    model: "unit", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "units",
    fields: {
      siteId: "id:site", buildingId: "id:building", ref: "string",
      buildingName: "string",
      kind: "enum:UnitKind", floor: "int", sqm: "int",
      status: "enum:UnitStatus", rent: "money", currency: "string",
    },
    required: ["ref"],
    search: ["ref"],
    order: [{ ref: "asc" }],
    include: { building: { select: { id: true, name: true } } },
  },

  parties: {
    model: "party", area: "people", product: null,
    label: "contacts",
    fields: {
      name: "string", kind: "enum:PartyKind", email: "string",
      phone: "string", note: "text", since: "date",
      unit: "string", cars: "int",
    },
    required: ["name"],
    search: ["name", "email", "phone"],
    order: [{ name: "asc" }],
  },

  documents: {
    model: "document", area: "documents", product: null,
    label: "documents",
    fields: {
      name: "string", kind: "enum:DocumentKind", about: "string",
      expiresAt: "date", storageKey: "string", checksum: "string",
      bytes: "int", mimeType: "string",
    },
    required: ["name"],
    search: ["name", "about"],
    order: [{ createdAt: "desc" }],
  },

  /* ================================================== PROPERTY */

  leases: {
    model: "lease", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "leases",
    fields: {
      unitId: "id:unit", tenantId: "id:party",
      tenantName: "string", unitRef: "string",
      rent: "money", currency: "string",
      deposit: "money", startsOn: "date", endsOn: "date",
      status: "enum:LeaseStatus", note: "text",
    },
    required: [], numbered: "ref",
    search: ["ref"],
    order: [{ createdAt: "desc" }],
    include: {
      unit: { select: { id: true, ref: true } },
      tenant: { select: { id: true, name: true, phone: true } },
    },
  },

  projects: {
    model: "project", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "development projects",
    fields: {
      siteId: "id:site", name: "string", city: "string", units: "int",
      dueOn: "date", stage: "enum:ProjectStage", budget: "money",
      spent: "money", currency: "string",
    },
    required: ["name"],
    search: ["name", "city"],
    order: [{ dueOn: "asc" }],
  },

  "work-orders": {
    model: "workOrder", area: "maintenance", product: null,
    label: "work orders",
    fields: {
      siteId: "id:site", title: "string", detail: "text",
      kind: "enum:WorkKind", priority: "enum:WorkPriority",
      status: "enum:WorkStatus", place: "string", assignee: "string",
      department: "string", raisedBy: "string",
    },
    required: ["title"], numbered: "ref",
    search: ["ref", "title", "place", "assignee"],
    order: [{ createdAt: "desc" }],
    history: { model: "workOrderEvent", key: "workOrderId", status: "status" },
  },

  assets: {
    model: "asset", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "assets",
    fields: {
      siteId: "id:site", name: "string", kind: "string", serial: "string",
      place: "string", installedOn: "date", servicedOn: "date",
      nextServiceOn: "date", status: "string",
    },
    required: ["name"],
    search: ["name", "serial", "kind"],
    order: [{ name: "asc" }],
  },

  /* ================================================== HOTEL */

  rooms: {
    model: "room", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "rooms",
    fields: {
      siteId: "id:site", number: "string", roomType: "string", floor: "int",
      housekeeping: "enum:RoomHousekeeping", condition: "enum:RoomCondition",
      occupied: "bool", outOfOrder: "bool",
    },
    required: ["number"],
    search: ["number", "roomType"],
    order: [{ number: "asc" }],
  },

  reservations: {
    model: "reservation", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "reservations",
    fields: {
      roomId: "id:room", guestId: "id:party", guestName: "string",
      property: "string", roomNumber: "string",
      roomType: "string", arriveOn: "date", departOn: "date",
      nights: "int", adults: "int", children: "int", eta: "string",
      source: "string", status: "enum:ReservationStatus",
      rate: "money", currency: "string",
    },
    required: ["guestName"], numbered: "ref",
    search: ["ref", "guestName"],
    order: [{ arriveOn: "asc" }],
    include: {
      room: { select: { id: true, number: true, roomType: true } },
      guest: { select: { id: true, name: true, phone: true } },
    },
  },

  services: {
    model: "hotelService", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "guest services",
    fields: {
      siteId: "id:site", name: "string", kind: "string", opensAt: "string",
      capacity: "int", active: "bool", chargeable: "bool", note: "text",
    },
    required: ["name"],
    search: ["name", "kind"],
    order: [{ name: "asc" }],
  },

  /* ================================================== AGENT & HOST */

  listings: {
    model: "listing", area: "agent", product: "AGENT_HOST",
    label: "listings",
    fields: {
      unitId: "id:unit", title: "string", channel: "string",
      kind: "enum:ListingKind", price: "money", currency: "string",
      status: "enum:ListingStatus", ownerName: "string",
      mandate: "string", note: "text",
    },
    required: ["title"],
    search: ["title", "ownerName"],
    order: [{ createdAt: "desc" }],
  },

  leads: {
    model: "lead", area: "agent", product: "AGENT_HOST",
    label: "leads",
    fields: {
      name: "string", wants: "string", property: "string",
      budget: "money", currency: "string",
      stage: "enum:LeadStage", source: "string", note: "text",
    },
    required: ["name"],
    search: ["name", "wants"],
    order: [{ createdAt: "desc" }],
  },

  viewings: {
    model: "viewing", area: "agent", product: "AGENT_HOST",
    label: "viewings",
    fields: {
      leadId: "id:lead", partyId: "id:party", who: "string",
      property: "string", at: "date", status: "string", note: "text",
    },
    required: [],
    search: ["who", "property"],
    order: [{ at: "desc" }],
    include: { lead: { select: { id: true, name: true } } },
  },

  deals: {
    model: "deal", area: "agent", product: "AGENT_HOST",
    label: "deals",
    fields: {
      partyId: "id:party", name: "string", value: "money", fee: "money",
      currency: "string", stage: "enum:DealStage", closesOn: "date",
    },
    required: ["name"],
    search: ["name"],
    order: [{ createdAt: "desc" }],
    include: { party: { select: { id: true, name: true } } },
  },

  /* ================================================== SECURITY */

  zones: {
    model: "zone", area: "security", product: "SECURITY_MANAGEMENT",
    label: "zones",
    fields: {
      siteId: "id:site", name: "string", kind: "enum:ZoneKind",
      note: "text", active: "bool",
    },
    /* siteId is NOT NULL in the schema — a gate or a lobby is somewhere.
       Without it here the database refused the row and the caller got a
       500 for a request that was only missing a field. */
    required: ["name", "siteId"],
    search: ["name"],
    order: [{ name: "asc" }],
  },

  visits: {
    model: "visit", area: "security", product: "SECURITY_MANAGEMENT",
    label: "visits",
    fields: {
      siteId: "id:site", hostId: "id:party", visitor: "string",
      category: "enum:VisitCategory", hostName: "string", phone: "string",
      vehicle: "string", purpose: "string", status: "enum:VisitStatus",
      idKind: "string", idRef: "string",
      arrivedAt: "date", admittedAt: "date", leftAt: "date",
      decidedBy: "string", decidedWhy: "string",
    },
    required: ["visitor"],
    search: ["visitor", "hostName", "phone", "vehicle"],
    order: [{ arrivedAt: "desc" }],
  },

  passes: {
    model: "pass", area: "security", product: "SECURITY_MANAGEMENT",
    label: "passes",
    fields: {
      siteId: "id:site", zoneId: "id:zone", holder: "string",
      kind: "enum:PassKind", forWhom: "string",
      validFrom: "date", validTo: "date", valid: "string",
      status: "enum:PassStatus",
      issuedBy: "string", uses: "int",
    },
    required: ["holder"], numbered: "code",
    search: ["code", "holder", "forWhom"],
    order: [{ createdAt: "desc" }],
  },

  vehicles: {
    model: "vehicle", area: "security", product: "SECURITY_MANAGEMENT",
    label: "vehicles",
    fields: {
      siteId: "id:site", plate: "string", make: "string", colour: "string",
      ownerName: "string", kind: "enum:VehicleKind", bay: "string",
      blocked: "bool", blockedWhy: "string",
    },
    required: ["plate"],
    search: ["plate", "ownerName", "make"],
    order: [{ plate: "asc" }],
  },

  incidents: {
    model: "incident", area: "security", product: "SECURITY_MANAGEMENT",
    label: "incidents",
    fields: {
      siteId: "id:site", title: "string", detail: "text",
      severity: "enum:IncidentSeverity", status: "enum:IncidentStatus",
      place: "string", raisedBy: "string",
    },
    required: ["title"], numbered: "ref",
    search: ["ref", "title", "place"],
    order: [{ createdAt: "desc" }],
    history: { model: "incidentEvent", key: "incidentId", status: "status" },
  },

  shifts: {
    model: "guardShift", area: "security", product: "SECURITY_MANAGEMENT",
    label: "guard shifts",
    fields: {
      siteId: "id:site", guard: "string", post: "string", shift: "string",
      startsAt: "date", endsAt: "date", status: "string",
      signedInAt: "date", signedOutAt: "date",
    },
    required: ["guard"],
    search: ["guard", "post"],
    order: [{ startsAt: "desc" }],
  },

  patrols: {
    model: "patrol", area: "security", product: "SECURITY_MANAGEMENT",
    label: "patrols",
    fields: {
      siteId: "id:site", route: "string", guard: "string", dueAt: "date",
      points: "int", pointsHit: "int", status: "string",
    },
    required: ["route"],
    search: ["route", "guard"],
    order: [{ dueAt: "desc" }],
  },

  deliveries: {
    model: "delivery", area: "security", product: "SECURITY_MANAGEMENT",
    label: "deliveries",
    fields: {
      siteId: "id:site", courier: "string", what: "string", forWhom: "string",
      outbound: "bool", status: "string", receivedBy: "string",
      releasedTo: "string", releasedAt: "date",
    },
    required: ["courier"],
    search: ["courier", "forWhom", "what"],
    order: [{ createdAt: "desc" }],
  },

  /* ================================================== MONEY */

  invoices: {
    model: "invoice", area: "finance", product: null,
    label: "invoices",
    /*
     * `total` and `paid` ARE NOT HERE, AND THAT IS THE POINT.
     *
     * They are computed by the server from the lines and the payments on
     * every write. A client that can name its own total can name zero.
     */
    fields: {
      partyId: "id:party", leaseId: "id:lease", source: "string",
      sourceId: "string", currency: "string",
      issuedOn: "date", dueOn: "date", status: "enum:InvoiceStatus", note: "text",
    },
    required: [], numbered: "ref",
    search: ["ref", "note"],
    order: [{ createdAt: "desc" }],
    include: {
      party: { select: { id: true, name: true, email: true } },
      lines: true,
    },
  },

  payments: {
    model: "payment", area: "finance", product: null,
    label: "payments",
    fields: {
      invoiceId: "id:invoice", amount: "money", currency: "string",
      method: "enum:PaymentMethod", reference: "string",
      receivedAt: "date", receivedBy: "string",
    },
    required: ["amount"],
    search: ["reference", "receivedBy"],
    order: [{ receivedAt: "desc" }],
    /*
     * A PAYMENT IS NEVER DELETED, whatever the role. Money that moved and
     * then vanished from the record is the one failure a customer does not
     * forgive. POST /payments/:id/void keeps the row and says why.
     */
    noDelete: "A payment is voided, never deleted — POST /payments/:id/void, with a reason.",
    /*
     * THE GENERIC CREATE IS SWITCHED OFF HERE, and this is not a style
     * choice. `POST /payments` is written by hand in routes/products.js
     * because three things have to happen that no generic create can do:
     * the currency is taken FROM THE INVOICE, the invoice's total and paid
     * figures are recomputed, and a duplicate provider reference is
     * explained as a double-submit rather than as a constraint.
     *
     * Without this line the framework also registered POST /payments, was
     * mounted first, and won. The hand-written endpoint never ran: money
     * arrived, and the invoice it paid stayed unpaid.
     */
    ownCreate: "POST /payments is hand-written in routes/products.js — it takes the " +
               "currency from the invoice and recomputes what is owed.",
    include: { invoice: { select: { id: true, ref: true, total: true, currency: true } } },
  },

  expenses: {
    model: "expense", area: "finance", product: null,
    label: "expenses",
    fields: {
      siteId: "id:site", partyId: "id:party", detail: "string",
      category: "string", amount: "money", currency: "string",
      spentOn: "date", recoverable: "bool",
      status: "enum:ExpenseStatus", note: "text",
    },
    required: ["detail"],
    search: ["detail", "category"],
    order: [{ spentOn: "desc" }],
  },

  payouts: {
    model: "payout", area: "finance", product: null,
    label: "payouts",
    /*
     * `net` is not writable: it is gross minus fees, and a caller who can
     * send all three can send a net that does not follow from the other two.
     * Creating a row here REQUESTS a payout. It does not move money — this
     * service moves no money at all.
     */
    fields: {
      partyId: "id:party", gross: "money", fees: "money", currency: "string",
      periodFrom: "date", periodTo: "date",
      status: "enum:PayoutStatus", reference: "string", sentAt: "date",
    },
    required: [],
    search: ["reference"],
    order: [{ createdAt: "desc" }],
    include: { party: { select: { id: true, name: true } } },
  },
};

/** `/hotel/rooms` → the declaration, or undefined. */
/*
 * THE CONSOLE'S OWN FIELD NAMES, ATTACHED TO EACH RESOURCE.
 *
 * The built product posts `{n, cat, host, veh}`, not `{visitor, category,
 * hostName, vehicle}` — see domain/console-map.js for why both namings are
 * right where they live. Every resource gets the aliases of every screen
 * that writes to it, so clean() accepts either spelling and the 27 forms
 * work without one line changing in the frontend.
 */
for (const [slug, r] of Object.entries(RESOURCES)) {
  r.aliases = aliasesFor(slug);
}

export const resource = (slug) => RESOURCES[slug];

export const slugs = () => Object.keys(RESOURCES);

/* Referenced above so a reader can see what is deliberately not writable. */
void AT;

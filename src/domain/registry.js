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
      /* Which channel sold it. `source` stays as the human label; this is the
         join the commission roll-up reads. `id:channel` makes the framework
         check the channel belongs to the same company before writing it. */
      channelId: "id:channel",
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

  /*
   * WHAT GUESTS HAVE ASKED FOR — the staff side of the guest portal.
   *
   * The guest writes these through routes/guest.js, scoped to themselves. This
   * is the other half: the hotel reading its own queue, scoped to the
   * organization like everything else, so a front desk can acknowledge, answer
   * and close them.
   *
   * `kind`, `detail` and `note` are the GUEST'S words and are not writable
   * here — staff answering a request must not be able to rewrite what was
   * asked. What staff may set is the state and the reply.
   */
  "guest-requests": {
    model: "guestRequest", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "guest requests",
    fields: {
      status: "enum:GuestRequestStatus",
      response: "text",
      resolvedAt: "date",
    },
    required: [],
    search: ["detail", "note", "response"],
    order: [{ createdAt: "desc" }],
    include: {
      reservation: { select: { id: true, ref: true, guestName: true, roomNumber: true } },
    },
    /*
     * A GUEST'S REQUEST IS NOT DELETED.
     *
     * "I asked for this and nobody came" is a complaint a property has to be
     * able to answer months later. Declining one is a state with a reason
     * attached; removing the row removes the evidence.
     */
    /*
     * NOTHING CREATES ONE THROUGH THE STAFF API.
     *
     * A guest request is made BY THE GUEST, at POST /guest/requests, scoped to
     * them. A front desk raising one on a guest's behalf would be a record
     * saying a guest asked for something they did not ask for — so the staff
     * create endpoint is not registered at all, rather than registered and
     * guarded.
     */
    noCreate: "A guest request is made by the guest at POST /guest/requests. " +
              "Staff acknowledge, answer and close it; they do not raise it.",
    noDelete: "A guest request is declined with a reason, never deleted — " +
              "PATCH it to DECLINED and say why in `response`.",
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
      siteId: "id:site", zoneId: "id:zone", hostId: "id:party", visitor: "string",
      category: "enum:VisitCategory", hostName: "string", phone: "string",
      vehicle: "string", purpose: "string", status: "enum:VisitStatus",
      idKind: "string", idRef: "string",
      arrivedAt: "date", admittedAt: "date", leftAt: "date",
      decidedBy: "string", decidedWhy: "string",
    },
    required: ["visitor"],
    search: ["visitor", "hostName", "phone", "vehicle"],
    order: [{ arrivedAt: "desc" }],
    /* The gate console reads both: which property, and which gate of it. */
    include: {
      site: { select: { id: true, name: true } },
      zone: { select: { id: true, name: true } },
    },
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
    /* The site's NAME, so a rota can say where a shift is. A column of ids
       tells a supervisor nothing. */
    include: { site: { select: { id: true, name: true } } },
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
    include: { invoice: {
        select: {
          id: true, ref: true, total: true, currency: true,
          /* WHO the money came from. Without this the finance screens read
             `payment.invoice.party.name` and get nothing, so every row in the
             ledger showed its payer as "—" — a real payment with an unnamed
             payer, which is not much use on a reconciliation screen. */
          party: { select: { id: true, name: true } },
        },
      } },
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
    /*
     * WHO WAS PAID, WITHOUT A SECOND REQUEST.
     *
     * An expense carries a `partyId` and nothing read it back, so a finance
     * screen listing fifty expenses could show fifty amounts and not one
     * vendor name — or make fifty more requests to find them. `payouts` has
     * always included its party for exactly this reason; this is the same two
     * columns, and no more than two: an include without a `select` is how a
     * contact's phone number ends up in a list nobody meant to expose it in.
     */
    include: { party: { select: { id: true, name: true } } },
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
  /* ================================================================ *
   * PROPERTY DEVELOPMENT.
   *
   * Area `property`, product PROPERTY_MANAGEMENT — the same pair `projects`
   * has always used. See the note above Investor in schema.prisma for why
   * this is not its own product value.
   * ================================================================ */

  investors: {
    model: "investor", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "investors",
    fields: {
      name: "string", kind: "enum:InvestorKind", units: "int",
      committed: "money", paid: "money", currency: "string",
      yieldBps: "int", since: "date", status: "enum:InvestorStatus",
      note: "text",
    },
    required: ["name"],
    search: ["name", "note"],
    order: [{ name: "asc" }],
  },

  distributions: {
    model: "distribution", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "distributions",
    fields: {
      investorId: "id:investor", period: "string", amount: "money",
      currency: "string", status: "enum:DistributionStatus",
      paidOn: "date", note: "text",
    },
    required: ["period"],
    search: ["period", "note"],
    order: [{ createdAt: "desc" }],
    include: { investor: { select: { id: true, name: true } } },
  },

  "capital-calls": {
    model: "capitalCall", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "capital calls",
    fields: {
      investorId: "id:investor", projectId: "id:project", ref: "string",
      amount: "money", currency: "string", dueOn: "date",
      status: "enum:CapitalCallStatus", note: "text",
    },
    required: ["ref"],
    search: ["ref", "note"],
    order: [{ createdAt: "desc" }],
    include: {
      investor: { select: { id: true, name: true } },
      project: { select: { id: true, name: true } },
    },
    prefix: "CC",
  },

  /* ================================================================ *
   * HOTEL MANAGEMENT.
   * ================================================================ */

  channels: {
    model: "channel", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "channels",
    fields: {
      name: "string", mark: "string", status: "enum:ChannelStatus",
      mapped: "int", total: "int", commissionBps: "int",
      lastSyncAt: "date", note: "text",
    },
    required: ["name"],
    search: ["name", "note"],
    order: [{ name: "asc" }],
  },

  "rate-rules": {
    model: "rateRule", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "rate rules",
    fields: {
      name: "string", whenText: "text", moveBps: "int",
      active: "bool", hits: "int",
    },
    required: ["name"],
    search: ["name", "whenText"],
    order: [{ name: "asc" }],
  },

  "group-bookings": {
    model: "groupBooking", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "group bookings",
    fields: {
      partyId: "id:party", ref: "string", orgName: "string", event: "string",
      rooms: "int", nights: "int", fromOn: "date", value: "money",
      currency: "string", paid: "money",
      status: "enum:GroupBookingStatus", note: "text",
    },
    required: ["ref"],
    search: ["ref", "orgName", "event"],
    order: [{ fromOn: "asc" }],
    include: { party: { select: { id: true, name: true } } },
    prefix: "GRP",
  },

  "audit-tasks": {
    model: "nightAuditTask", area: "hotel", product: "HOTEL_MANAGEMENT",
    label: "night audit tasks",
    fields: {
      title: "string", detail: "text", runOn: "date", done: "bool",
      doneAt: "date", doneBy: "string", seq: "int",
    },
    required: ["title", "runOn"],
    search: ["title", "detail"],
    order: [{ seq: "asc" }],
  },

  /* ================================================================ *
   * SECURITY MANAGEMENT.
   * ================================================================ */

  cameras: {
    model: "camera", area: "security", product: "SECURITY_MANAGEMENT",
    label: "cameras",
    fields: {
      siteId: "id:site", name: "string", place: "string",
      status: "enum:CameraStatus", lastSeenAt: "date",
    },
    required: ["name"],
    search: ["name", "place"],
    order: [{ name: "asc" }],
    include: { site: { select: { id: true, name: true } } },
  },

  "guard-tasks": {
    model: "guardTask", area: "security", product: "SECURITY_MANAGEMENT",
    label: "guard tasks",
    fields: {
      siteId: "id:site", shiftId: "id:guardShift", title: "string",
      dueAt: "string", status: "enum:GuardTaskStatus", note: "text",
      doneAt: "date",
    },
    required: ["title"],
    search: ["title", "note"],
    order: [{ dueAt: "asc" }],
  },

  "emergency-plans": {
    model: "emergencyPlan", area: "security", product: "SECURITY_MANAGEMENT",
    label: "emergency plans",
    fields: {
      siteId: "id:site", kind: "string", where: "string",
      procedure: "text", drillNote: "text", lastDrill: "date",
      status: "enum:EmergencyStatus",
    },
    required: ["kind"],
    search: ["kind", "where", "procedure"],
    order: [{ kind: "asc" }],
    include: { site: { select: { id: true, name: true } } },
  },

  /* ================================================================ *
   * AGENT & HOST.
   * ================================================================ */

  conversations: {
    model: "conversation", area: "agent", product: "AGENT_HOST",
    label: "conversations",
    fields: {
      partyId: "id:party", withName: "string", subject: "string",
      lastText: "text", lastAt: "date", unread: "int", closed: "bool",
    },
    required: ["withName"],
    search: ["withName", "subject", "lastText"],
    order: [{ lastAt: "desc" }],
    include: { party: { select: { id: true, name: true } } },
  },

  messages: {
    model: "message", area: "agent", product: "AGENT_HOST",
    label: "messages",
    fields: {
      conversationId: "id:conversation", direction: "enum:MessageDirection",
      authorName: "string", body: "text", readAt: "date",
    },
    required: ["conversationId", "body"],
    search: ["body", "authorName"],
    order: [{ createdAt: "desc" }],
  },

  "ops-tasks": {
    model: "opsTask", area: "agent", product: "AGENT_HOST",
    label: "turnover tasks",
    fields: {
      unitId: "id:unit", title: "string", assignee: "string",
      dueAt: "date", status: "enum:OpsTaskStatus", note: "text",
    },
    required: ["title"],
    search: ["title", "assignee", "note"],
    order: [{ dueAt: "asc" }],
    include: { unit: { select: { id: true, ref: true } } },
  },

  "pricing-rules": {
    model: "pricingRule", area: "agent", product: "AGENT_HOST",
    label: "pricing rules",
    fields: {
      unitId: "id:unit", label: "string", base: "money", currency: "string",
      weekendBps: "int", monthlyBps: "int", minNights: "int", auto: "bool",
    },
    required: ["label"],
    search: ["label"],
    order: [{ label: "asc" }],
    include: { unit: { select: { id: true, ref: true } } },
  },

  /* ================================================================ *
   * TOKENISED INVESTMENT.
   *
   * Area `investments`, which is new and is the ninth — see the note in
   * access.js. No `product:` value, because eligibility is not a subscription:
   * it is IssuerProfile.status === "APPROVED", checked by the routes in
   * src/routes/investments.js. A company that has not been approved as an
   * issuer can hold every product PALTAS sells and still not raise a penny.
   *
   * `offerings` is NOT here. Its lifecycle has twelve states and a review that
   * belongs to somebody else, so a generic PATCH that could set `status` to
   * LIVE is exactly the endpoint that must not exist. It lives in
   * src/routes/investments.js, where every move goes through
   * OFFERING_TRANSITIONS.
   * ================================================================ */

  /* `investors`, `distributions` and `capital-calls` are declared further up,
     under Property Development, and are REUSED here rather than duplicated. */

  "investor-profiles": {
    model: "investorProfile", area: "investments",
    label: "investor compliance profiles",
    fields: {
      investorId: "id:investor",
      kyc: "enum:KycStatus", aml: "enum:AmlStatus",
      kycProvider: "string", kycRef: "string",
      amlProvider: "string", amlRef: "string",
      screenedAt: "date", expiresAt: "date",
      jurisdiction: "string", classifiedAs: "enum:InvestorEligibility",
      blockedReason: "text",
    },
    required: ["investorId"],
    search: ["jurisdiction", "kycRef", "amlRef"],
    order: [{ createdAt: "desc" }],
    include: { investor: { select: { id: true, name: true, kind: true } } },
  },

  /*
   * `offering-parties` and `offering-documents` are NOT registry resources.
   *
   * Neither carries an orgId: both cascade from Offering, which does. The
   * framework's first act is `where: { orgId }`, so a model without that column
   * 500s — and the fix is NOT to denormalise the company onto them. Storing it
   * twice is how the two copies come to disagree, which is the reason
   * tenancy.test.js has a whole test allowing parent-scoped models.
   *
   * They are served from src/routes/investments.js, scoped through the offering
   * the caller already had to be allowed to see.
   */
  "investment-orders": {
    model: "investmentOrder", area: "investments",
    label: "investment orders",
    /*
     * `status` is NOT writable here, and neither is `amount` or `units`.
     *
     * An order's state is the consequence of a compliance decision and a
     * settled payment, so a PATCH that could set it to SETTLED would be a way
     * to record money nobody received. The allocate and cancel actions are in
     * src/routes/investments.js; this exists for the list and the read.
     */
    fields: {
      refusedWhy: "text",
    },
    required: [],
    search: ["ref"],
    order: [{ placedAt: "desc" }],
    include: {
      offering: { select: { id: true, ref: true, title: true, currency: true } },
      investor: { select: { id: true, name: true } },
    },
    noCreate: "An order is placed against a LIVE offering at " +
              "POST /investments/offerings/:id/orders, which checks the " +
              "investor's KYC, screening and jurisdiction first. A generic " +
              "create would be a way to record a subscription that no " +
              "compliance check ever saw.",
    noDelete: "An order is cancelled or refused with a reason, never deleted. " +
              "Somebody committed money; the record of what happened to it is " +
              "not ours to remove.",
  },

  "token-holdings": {
    model: "tokenHolding", area: "investments",
    label: "token holdings",
    /*
     * NOTHING HERE IS WRITABLE.
     *
     * Every field is what a tokenisation provider reported. A writable `units`
     * column is a way for this platform to tell an investor they own something
     * the provider has never heard of. Reads only.
     */
    fields: {},
    required: [],
    search: ["providerRef", "custodianRef", "walletRef"],
    order: [{ asAt: "desc" }],
    include: {
      offering: { select: { id: true, ref: true, title: true } },
      investor: { select: { id: true, name: true } },
    },
    noCreate: "A holding is what a tokenisation provider reported. PALTAS " +
              "records it; it does not issue it. A create endpoint here would " +
              "let this platform tell an investor they own units that no " +
              "provider has ever heard of.",
    noDelete: "The same reason. A position that has gone is a provider event " +
              "(BURN or TRANSFER) recorded in TokenEvent, not a row deleted.",
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

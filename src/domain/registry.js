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

import { db } from "../db.js";
import { aliasesFor } from "./console-map.js";
import { postForExpense, postForInvoice } from "./posting.js";

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

    /*
     * HOW MANY OF THIS PROPERTY'S UNITS ARE LET, AND WHAT THEY BRING IN.
     *
     * Both live in other tables — units carry the status, leases carry the
     * rent — so a site row cannot answer either on its own. The console
     * showed 0 for both and said plainly why: nothing counted them, and it
     * would not invent a number for a portfolio screen.
     *
     * Two grouped queries for the whole page, not two per property: a
     * portfolio of forty buildings must not become eighty round trips.
     *
     * `rent` is the rent roll of ACTIVE leases only. A lease that ended is
     * not income, and counting it would overstate the one figure an owner
     * checks first.
     */
    async rollup(rows, orgId) {
      if (!rows.length) return rows;
      const ids = rows.map((r) => r.id);

      const let_ = await db.unit.groupBy({
        by: ["siteId"],
        where: { orgId, siteId: { in: ids }, status: "OCCUPIED" },
        _count: { _all: true },
      });
      const occupied = new Map(let_.map((g) => [g.siteId, g._count._all]));

      /* Rent hangs off the LEASE, which hangs off the unit, which carries the
         site — so the join has to go through units. */
      const leases = await db.lease.findMany({
        where: { orgId, status: "ACTIVE", unit: { siteId: { in: ids } } },
        select: { rent: true, unit: { select: { siteId: true } } },
      });
      const rent = new Map();
      for (const l of leases) {
        const sid = l.unit && l.unit.siteId;
        if (!sid) continue;
        rent.set(sid, (rent.get(sid) || 0n) + BigInt(l.rent || 0));
      }

      /*
       * AND THE UNIT COUNT, COUNTED.
       *
       * `unitCount` is a number the owner types when they register a
       * property. Once units exist it is a second opinion, and the portfolio
       * screen was showing it beside a units screen counting the real ones —
       * "10 units" on one tab and "3" on the next. A client notices that
       * before they notice anything else.
       *
       * The stored figure still stands where nothing has been entered yet:
       * somebody who told us their block has 48 units and has not itemised
       * them should not watch it drop to zero.
       */
      const counted = await db.unit.groupBy({
        by: ["siteId"],
        where: { orgId, siteId: { in: ids } },
        _count: { _all: true },
      });
      const units = new Map(counted.map((g) => [g.siteId, g._count._all]));

      return rows.map((r) => ({
        ...r,
        unitCount: units.get(r.id) ?? r.unitCount ?? 0,
        let: occupied.get(r.id) || 0,
        rent: rent.get(r.id) || 0n,
      }));
    },
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

    /*
     * HOW MANY UNITS IT ACTUALLY HAS.
     *
     * `unitCount` is a column somebody types in, and nobody does — so a
     * building with forty units read 0 on its own screen until a person
     * remembered to fill in a number that the units table already knows.
     *
     * Counted instead, with the let ones alongside, because "38 of 40" is
     * the sentence a building manager is actually after. The stored column
     * is left alone and used as the fallback: a building whose units have
     * not been entered yet still shows what its owner told us.
     */
    async rollup(rows, orgId) {
      if (!rows.length) return rows;
      const ids = rows.map((r) => r.id);
      const [all, let_] = await Promise.all([
        db.unit.groupBy({ by: ["buildingId"],
          where: { orgId, buildingId: { in: ids } }, _count: { _all: true } }),
        db.unit.groupBy({ by: ["buildingId"],
          where: { orgId, buildingId: { in: ids }, status: "OCCUPIED" }, _count: { _all: true } }),
      ]);
      const total = new Map(all.map((g) => [g.buildingId, g._count._all]));
      const occupied = new Map(let_.map((g) => [g.buildingId, g._count._all]));

      return rows.map((r) => ({
        ...r,
        unitCount: total.get(r.id) ?? r.unitCount ?? 0,
        let: occupied.get(r.id) || 0,
      }));
    },
  },

  units: {
    model: "unit", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "units",
    fields: {
      siteId: "id:site", buildingId: "id:building", projectId: "id:project",
      ref: "string", buildingName: "string",
      kind: "enum:UnitKind", floor: "int", sqm: "int",
      status: "enum:UnitStatus", rent: "money", currency: "string",
    },
    required: ["ref"],
    search: ["ref"],
    order: [{ ref: "asc" }],
    include: { building: { select: { id: true, name: true } } },

    /*
     * WHO IS IN IT, AND WHEN THEY LEAVE.
     *
     * Both belong to the LEASE, not the unit, so the row could not answer
     * either and the console showed "—" in both columns for every unit. For a
     * letting business those two columns ARE the screen: a unit list that
     * cannot say who lives there is a spreadsheet of door numbers.
     *
     * One query for the page. ACTIVE leases only — a lease that ended tells
     * you who USED to live there, which is a different and much worse answer
     * to put in a column headed "Tenant".
     */
    async rollup(rows, orgId) {
      if (!rows.length) return rows;
      const leases = await db.lease.findMany({
        where: { orgId, status: "ACTIVE", unitId: { in: rows.map((r) => r.id) } },
        select: {
          unitId: true, endsOn: true, tenantName: true,
          tenant: { select: { name: true } },
        },
        orderBy: { startsOn: "desc" },
      });
      /* The newest active lease wins if a unit somehow has two. */
      const by = new Map();
      for (const l of leases) if (!by.has(l.unitId)) by.set(l.unitId, l);

      return rows.map((r) => {
        const l = by.get(r.id);
        return {
          ...r,
          tenantName: l ? ((l.tenant && l.tenant.name) || l.tenantName || "") : "",
          leaseEndsOn: l ? l.endsOn : null,
        };
      });
    },
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
    /*
     * THE FOUR STORAGE COLUMNS ARE NOT HERE, AND THAT IS THE POINT.
     *
     * `fields` is what a CALLER may write — clean() walks exactly this list.
     * storageKey, checksum, bytes and mimeType used to be in it, so any
     * client could PATCH a document to claim any key, any size and any type.
     *
     * While nothing could download a file that was harmless. The moment a
     * download exists it is not: a caller could point their own document row
     * at another company's key and ask PALTAS to sign a link to it. The
     * download route checks the key's owner as well — two independent guards,
     * because this is the one that would be silent if it failed.
     *
     * The server writes all four, from what storage actually reports. Same
     * reasoning as `net` on payouts just below: a value a caller can name is
     * a value that need not follow from anything.
     */
    fields: {
      name: "string", kind: "enum:DocumentKind", about: "string",
      expiresAt: "date",
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
      dueOn: "date", stage: "enum:ProjectStage", built: "int", budget: "money",
      spent: "money", currency: "string",
    },
    required: ["name"],
    search: ["name", "city"],
    order: [{ dueOn: "asc" }],

    /*
     * HOW MUCH OF IT IS SOLD.
     *
     * The Development console has always shown "sold", "reserved" and
     * "revenue banked" per project. Nothing computed them: the frontend
     * adapter hard-coded `sold: 0, res: 0` with a note that the sales
     * pipeline was "a pipeline this schema does not model", and sent the
     * construction BUDGET as revenue banked. So a developer with a tower half
     * sold saw 0 sold, 0 reserved, and a revenue figure that was really a
     * cost — three wrong numbers on the screen that exists to show them.
     *
     * Contract models the sale now, so these are counted from it.
     *
     * ── WHY revenue IS SOLD-ONLY ───────────────────────────────────────
     *
     * The console labels the figure "Agreed prices on sold units only", and
     * that is the honest reading: a RESERVED unit is a deposit and an
     * intention, not an agreed price. Counting reservations into revenue
     * would inflate it by exactly the units most likely to fall through.
     *
     * CANCELLED is excluded from all three. A reservation that collapsed is
     * why a unit is back on the market; it is not stock committed.
     *
     * findMany rather than groupBy, deliberately: the fake Prisma the offline
     * suite runs the real app against implements findMany and not groupBy, and
     * a rollup that only works against real Postgres is a rollup that is
     * untested everywhere it is cheap to test.
     */
    async rollup(rows, orgId) {
      if (!rows.length) return rows;
      const contracts = await db.contract.findMany({
        where: {
          orgId,
          projectId: { in: rows.map((r) => r.id) },
          status: { not: "CANCELLED" },
        },
        select: { projectId: true, status: true, price: true },
      });

      const by = new Map();
      for (const c of contracts) {
        const acc = by.get(c.projectId) || { sold: 0, reserved: 0, revenue: 0n };
        if (c.status === "RESERVED") acc.reserved += 1;
        else {
          acc.sold += 1;
          acc.revenue += BigInt(c.price || 0);
        }
        by.set(c.projectId, acc);
      }

      /*
       * AND HOW FAR BUILT, FROM THE PHASES WHERE THERE ARE ANY.
       *
       * `built` is a number somebody types, and it was the only structure a
       * development had. Where a project has phases, its real progress is the
       * WEIGHTED average of them — ten per cent of the superstructure is not
       * ten per cent of the job — and where no weights are set they count
       * equally.
       *
       * The typed figure is not overwritten. It is returned as `built` and the
       * derived one as `progress`, because a project manager who has entered a
       * number and a programme that disagrees with it needs to see both rather
       * than have one silently replace the other.
       */
      const phases = await db.projectPhase.findMany({
        where: { orgId, projectId: { in: rows.map((r) => r.id) } },
        select: { projectId: true, progress: true, weight: true },
      });
      const byProject = new Map();
      for (const ph of phases) {
        const acc = byProject.get(ph.projectId) || { weighted: 0, weight: 0, count: 0 };
        const w = ph.weight > 0 ? ph.weight : 1;
        acc.weighted += (ph.progress || 0) * w;
        acc.weight += w;
        acc.count += 1;
        byProject.set(ph.projectId, acc);
      }

      return rows.map((r) => {
        const a = by.get(r.id) || { sold: 0, reserved: 0, revenue: 0n };
        const ph = byProject.get(r.id);
        return {
          ...r,
          sold: a.sold, reserved: a.reserved, revenue: a.revenue,
          phases: ph ? ph.count : 0,
          progress: ph && ph.weight ? Math.round(ph.weighted / ph.weight) : r.built,
        };
      });
    },
  },

  /*
   * MEETINGS, DECISIONS AND TASKS — the loop a development is run in.
   *
   * Created and edited here; MOVED by routes/workflow.js, because holding a
   * meeting, deciding something and finishing a task all have consequences
   * beyond their own row.
   */
  meetings: {
    model: "meeting", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "meetings",
    fields: {
      projectId: "id:project", title: "string", kind: "enum:MeetingKind",
      startsAt: "date", endsAt: "date", location: "string", videoUrl: "string",
      agenda: "text",
    },
    /* `minutes`, `minutesSentAt` and `status` are not here — see
       NOT_WRITABLE_HERE in test/registry.test.js for why each is an act. */
    required: ["title"], numbered: "ref", prefix: "MTG",
    search: ["ref", "title", "agenda", "location"],
    order: [{ startsAt: "desc" }],
    include: {
      project: { select: { id: true, name: true } },
      participants: { select: { id: true, name: true, email: true, role: true, attended: true, partyId: true } },
    },
  },

  decisions: {
    model: "decision", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "decisions",
    fields: {
      projectId: "id:project", meetingId: "id:meeting", subject: "string",
      description: "text", options: "text", decision: "text",
      area: "string", ownerName: "string",
    },
    required: ["subject"], numbered: "ref", prefix: "DEC",
    search: ["ref", "subject", "description", "area", "ownerName"],
    order: [{ createdAt: "desc" }],
    include: {
      project: { select: { id: true, name: true } },
      meeting: { select: { id: true, ref: true, title: true } },
      history: {
        select: { id: true, status: true, note: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  tasks: {
    model: "task", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "tasks",
    fields: {
      projectId: "id:project", unitId: "id:unit", meetingId: "id:meeting",
      decisionId: "id:decision", leadId: "id:lead", parentId: "id:task",
      title: "string", detail: "text",
      assigneeId: "id:user", assigneeName: "string",
      priority: "enum:TaskPriority", dueOn: "date",
    },
    /* `status` and `completedAt` are moved by POST /tasks/:id/{done,reopen}. */
    required: ["title"], numbered: "ref", prefix: "TSK",
    search: ["ref", "title", "detail", "assigneeName"],
    order: [{ dueOn: "asc" }],
    include: {
      project: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true } },
      meeting: { select: { id: true, ref: true, title: true } },
      decision: { select: { id: true, ref: true, subject: true } },
      checklist: {
        select: { id: true, text: true, done: true, position: true, doneAt: true },
        orderBy: { position: "asc" },
      },
      comments: {
        select: { id: true, body: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
      subtasks: { select: { id: true, ref: true, title: true, status: true } },
    },
  },

  /*
   * OFFERS ON UNITS.
   *
   * Created and edited here like any resource; MOVED only through
   * routes/offers.js, because a status change has consequences — an accepted
   * offer reserves a unit and opens a reservation, and a caller that could
   * PATCH `status` directly would do the first without the second.
   */
  offers: {
    model: "offer", area: "agent", product: null,
    label: "offers",
    fields: {
      buyerId: "id:party", projectId: "id:project", unitId: "id:unit",
      price: "money", discount: "money", deposit: "money", currency: "string",
      paymentPlan: "string", terms: "text",
      validUntil: "date", note: "text",
    },
    /*
     * `status` IS NOT A WRITABLE FIELD, and that is the whole design.
     *
     * Send, view, accept and reject are acts with consequences, each with its
     * own route and its own rules about what may follow what. A field a
     * client can set is a state machine anybody can step around — accepting
     * an offer by PATCH would leave the unit unreserved and no reservation
     * anywhere, which is exactly the silent half-completed sale this models.
     */
    required: ["price"], numbered: "ref", prefix: "OFF",
    search: ["ref", "note", "terms"],
    order: [{ createdAt: "desc" }],
    include: {
      buyer: { select: { id: true, name: true, email: true, phone: true } },
      project: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true, status: true } },
      contract: { select: { id: true, ref: true, status: true } },
    },
  },

  /*
   * THE PROGRAMME A DEVELOPMENT IS BUILT TO.
   *
   * A phase is the unit construction is actually run in. Cascade on the
   * project, because a phase without its project is a progress figure
   * attached to nothing.
   */
  "project-phases": {
    model: "projectPhase", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "project phases",
    fields: {
      projectId: "id:project", name: "string", position: "int",
      status: "enum:PhaseStatus", progress: "int", weight: "int",
      startsOn: "date", endsOn: "date", note: "text",
    },
    /* projectId as well as a name: the column is NOT NULL with no default, so
       a create without it would reach the database and come back a 500
       instead of naming the field that was missing. */
    required: ["projectId", "name"],
    search: ["name", "note"],
    order: [{ position: "asc" }],
    include: { project: { select: { id: true, name: true } } },
  },

  /*
   * THE DATES A DEVELOPER IS HELD TO.
   *
   * `doneOn` is kept apart from `dueOn` so a milestone that slipped and was
   * then delivered still reads as slipped — which is the thing anybody
   * reviewing a development actually asks about.
   */
  milestones: {
    model: "milestone", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "milestones",
    fields: {
      projectId: "id:project", phaseId: "id:projectPhase", name: "string",
      status: "enum:MilestoneStatus", dueOn: "date", doneOn: "date",
      owner: "string", note: "text",
    },
    required: ["projectId", "name"],
    search: ["name", "owner", "note"],
    order: [{ dueOn: "asc" }],
    include: {
      project: { select: { id: true, name: true } },
      phase: { select: { id: true, name: true } },
    },
  },

  /*
   * THE SALE AGREEMENTS THEMSELVES.
   *
   * One contract, one unit — see the model. `required` is empty like `leases`
   * beside it: a reservation is often taken on the phone with a deposit and a
   * name, before the unit row for that floor exists, and refusing to record it
   * until every reference is known is how a sale ends up in somebody's inbox
   * instead of the system.
   */
  contracts: {
    model: "contract", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "sale contracts",
    fields: {
      projectId: "id:project", unitId: "id:unit", buyerId: "id:party",
      price: "money", deposit: "money", currency: "string",
      status: "enum:ContractStatus", instalments: "int",
      signedOn: "date", completedOn: "date", note: "text",
    },
    required: [], numbered: "ref",
    search: ["ref", "note"],
    order: [{ createdAt: "desc" }],
    include: {
      project: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true } },
      /* The buyer's name and phone, and nothing else. An include without a
         select is how a buyer's email ends up in a list nobody meant to
         expose it in. */
      buyer: { select: { id: true, name: true, phone: true } },
    },
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

    /*
     * AN INVOICE IS BOOKED WHEN IT IS ISSUED, NOT WHEN IT IS CREATED.
     *
     * It is created empty and its lines are added afterwards, so booking it
     * on create would book a total of nothing. The moment that matters is
     * DRAFT becoming anything else — the point a customer is actually being
     * asked for money.
     *
     * Dr accounts receivable the gross, Cr income the net, Cr tax payable the
     * tax. Tax is split out because it is not income: it is money held for a
     * tax authority, and a P&L that counts it overstates what was earned.
     */
    async afterWrite({ row, before, action, req, db }) {
      if (action !== "update") return {};
      const was = before && before.status;
      if (was !== "DRAFT" || row.status === "DRAFT" || row.status === "VOID") return {};

      const full = await db.invoice.findFirst({
        where: { id: row.id, orgId: req.actor.orgId }, include: { lines: true },
      });
      if (!full) return {};

      const b = await postForInvoice(db, {
        orgId: req.actor.orgId, invoice: full, userId: req.session.userId,
      });
      return { booking: { booked: b.posted ? b.posted.ref : null, why: b.skipped || null } };
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

    /*
     * A COST INCURRED IS A COST IN THE BOOKS.
     *
     * Dr the category's account, Cr accounts payable — payable rather than
     * bank, because this row records that the cost happened, not that it has
     * been paid. See domain/posting.js.
     *
     * It never refuses the expense. A company with no chart of accounts still
     * records what it spent; it is simply told that nothing was booked.
     */
    async afterWrite({ row, action, req, db }) {
      if (action !== "create") return {};
      const b = await postForExpense(db, {
        orgId: req.actor.orgId, expense: row, userId: req.session.userId,
      });
      return { booking: { booked: b.posted ? b.posted.ref : null, why: b.skipped || null } };
    },
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

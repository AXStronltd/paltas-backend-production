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

import type { $Enums } from "@prisma/client";
import type { Registry, ResourceDeclaration } from "./registry-types.ts";
import { bigOf, dateOf, isPast, isSet, numberOf, statusOf, textOf } from "./registry-types.ts";

import { ACQUISITION_NEXT, nextFor, PERMIT_NEXT } from "./decisions.ts";
import { feasibilityNumbers } from "./feasibility.ts";

/*
 * WHAT EACH STATE ACTUALLY MEANS, IN WORDS.
 *
 * SUBMITTED is the one everybody reads as "sent", and it is not: it means a
 * provider took it. QUEUED is the one everybody reads as "broken", and it is
 * not either: it means nothing has taken it yet, which with no provider
 * connected is the correct and expected place for a message to sit.
 *
 * Carried on the row rather than written into the console, so one sentence
 * answers for both and neither can drift into something more flattering.
 */
/*
 * APPROVED AS NOTED is the outcome everybody misreads, and reading it as a
 * rejection stops work that could have carried on. Said in words beside the
 * row rather than left to a console to interpret.
 */
/* What each stage of a land deal actually means, said once. */
const ACQUISITION_MEANS: Readonly<Record<string, string>> = {
  IDENTIFIED: "Found. Nobody has looked at the numbers.",
  APPRAISING: "Being tested on paper.",
  OFFERED: "An offer is with the seller.",
  UNDER_NEGOTIATION: "Being haggled over.",
  AGREED: "Price agreed. Nothing has been checked.",
  DUE_DILIGENCE: "Searches running. This is where most deals die.",
  COMPLETED: "Bought.",
  ABANDONED: "Dead, with the reason kept.",
};

const SUBMITTAL_MEANS: Readonly<Record<string, string>> = {
  DRAFT: "Being prepared. Nobody has been asked to look at it.",
  SUBMITTED: "With the reviewer, waiting.",
  UNDER_REVIEW: "Being looked at now.",
  APPROVED: "Build to this.",
  APPROVED_AS_NOTED: "Build to this, with the corrections marked on it. Work may continue.",
  REVISE_RESUBMIT: "Sent back. The next revision is open — build to nothing until it returns.",
  REJECTED: "Not acceptable. Start again.",
};

const DISPATCH_MEANS: Readonly<Record<string, string>> = {
  DRAFT: "Written, not released. Nobody is trying to send it.",
  QUEUED: "Waiting for something to carry it. Nothing has been sent.",
  SUBMITTED: "A provider accepted it. That is not the same as it arriving.",
  DELIVERED: "The provider confirmed it arrived.",
  FAILED: "A provider refused it.",
  BOUNCED: "It was accepted and then came back.",
  CANCELLED: "Stopped before anything carried it.",
};
import { db } from "../db.ts";
import { aliasesFor } from "./console-map.ts";
import { postForExpense, postForInvoice } from "./posting.ts";
import { syncUnitToLease } from "./occupancy.ts";

/* Field kinds:
     string · text · int · money · float · bool · date · json
     enum:<EnumName>   one of that enum's values
     id:<resourceName> the id of another row IN THE SAME COMPANY — the
                       framework checks that before writing it, so a caller
                       cannot attach their invoice to somebody else's lease
                       by guessing an id. */

const AT = { createdAt: "date", updatedAt: "date" };   // never writable; listed for clarity only

/*
 * `satisfies`, NOT an annotation.
 *
 * An annotation would check every declaration against the type and then throw
 * away what it learned — `RESOURCES.offers.model` would be `ModelKey`, the
 * union of all 132, rather than `"offer"`. `satisfies` checks the same things
 * and keeps the literal, so anything reading a specific resource still knows
 * exactly which model it names.
 */
const DECLARATIONS = {

  /* ================================================== SHARED SPINE */

  sites: {
    model: "site", area: "property", product: null,
    label: "sites",
    fields: {
      name: "string", kind: "enum:SiteKind",
      address: "string", city: "string", country: "string",
      lat: "float", lng: "float", note: "text", status: "string",
      unitCount: "int", value: "money",
      /* What this property's money is in. Writable, because a property in one
         country held by a company in another is the ordinary case and only the
         property knows. Left blank it resolves from `country` — see
         domain/currency.ts. */
      currency: "string",
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
      /* WHOSE RELATIONSHIP THIS IS, where it came from, and when somebody
         should next speak to them. Writable because they are a company's own
         words about its own clients — a source or a status nobody can set is
         a column nobody can use. */
      assignedToId: "id:user", source: "string", status: "string",
      tags: "string", city: "string", country: "string",
      nextFollowUpOn: "date",
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
      /* Whose it is, when it is somebody's. `about` stays for a document about
         a property or a project — this is for the person. */
      partyId: "id:party",
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
      /* WHEN the rent is owed, and how often. Writable because a landlord has
         to be able to say it — rent that recurs on a day nobody can set is a
         feature nobody can use. See domain/rent.ts. */
      rentDay: "int:1..31", billing: "enum:LeaseBilling",
      status: "enum:LeaseStatus", note: "text",
    },
    required: [], numbered: "ref",
    search: ["ref"],
    order: [{ createdAt: "desc" }],
    include: {
      unit: { select: { id: true, ref: true } },
      tenant: { select: { id: true, name: true, phone: true } },
    },

    /*
     * THE UNIT FOLLOWS THE LEASE.
     *
     * Runs on create as well as update: a lease is very often written
     * ACTIVE in one go rather than drafted first, and a flat occupied by
     * that lease must not depend on somebody editing the row afterwards.
     *
     * The reason a unit was left alone is returned rather than dropped, so
     * "this lease did not occupy its unit" is answerable from the response
     * and from the audit trail instead of being inferred later from a
     * vacancy figure that looks wrong. See domain/occupancy.ts.
     */
    async afterWrite({ row, req, db }) {
      const unitId = textOf(row, "unitId");
      if (!unitId) return {};

      const moved = await syncUnitToLease(db, {
        orgId: req.actor.orgId,
        unitId,
        status: statusOf(row) as $Enums.LeaseStatus,
      });

      if (moved.changed) {
        await db.auditEvent.create({
          data: {
            orgId: req.actor.orgId, actorId: req.session.userId,
            actorName: req.view?.user?.name || req.view?.user?.email || "",
            action: "unit.occupancy", entity: "unit", entityId: unitId,
            detail: { from: moved.from, to: moved.to, because: textOf(row, "ref") },
            ip: req.ip || "",
          },
        });
      }
      return {
        occupancy: moved.changed
          ? { unitId, from: moved.from, to: moved.to }
          : (moved.why ? { unitId, unchanged: moved.why } : null),
      };
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
  /* --------------------------------------- HANDING IT OVER, AND WHO */
  handovers: {
    model: "handover", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "handovers",
    fields: {
      projectId: "id:project", unitId: "id:unit", contractId: "id:contract",
      partyId: "id:party", toName: "string", scheduledOn: "date", notes: "text",
    },
    /* `status`, both names and the refusal reason are written by
       routes/handover.js, which is the only thing that reads the defect
       register first. */
    required: ["toName"], numbered: "ref", prefix: "HOV",
    search: ["ref", "toName", "handedBy", "receivedBy"],
    order: [{ scheduledOn: "desc" }],
    onRead: (row) => ({
      canComplete: !["COMPLETED", "CANCELLED"].includes(statusOf(row)),
      means: statusOf(row) === "COMPLETED"
        ? "Handed over. What was handed over that day does not change afterwards."
        : statusOf(row) === "REFUSED"
          ? "The buyer would not take it. The reason is what has to be put right."
          : "Not yet handed over. Serious defects against the unit will stop it.",
    }),
    include: {
      project: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true, status: true } },
      contract: { select: { id: true, ref: true, status: true } },
      items: {
        select: { id: true, title: true, kind: true, status: true,
                  reading: true, note: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  },

  "project-team": {
    model: "projectMember", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "project team",
    /*
     * `noCreate`, not `ownCreate`: there is no POST /project-team, and there
     * should not be. Somebody joins A PROJECT — that is the whole shape of the
     * thing — so the create hangs off the project, where the userId can be
     * checked against this company's own membership.
     */
    noCreate:
      "Somebody joins a project, so the create hangs off one: POST " +
      "/projects/:id/team in routes/handover.js. A team member may be a login, " +
      "a contact, or just a name — most of a project team works for other " +
      "companies — and a userId is checked against this company's membership " +
      "before it is believed.",
    fields: {
      projectId: "id:project", userId: "id:user", partyId: "id:party",
      name: "string", role: "string", company: "string",
      email: "string", phone: "string", responsible: "text",
      joinedOn: "date",
    },
    required: ["projectId", "name", "role"],
    search: ["name", "role", "company", "responsible"],
    order: [{ role: "asc" }],
    onRead: (row) => ({
      current: !isSet(row, "leftOn"),
      /* Somebody in a role with nothing said about what they answer for is a
         name, not a contact. */
      stated: !!isSet(row, "responsible"),
    }),
    include: {
      project: { select: { id: true, name: true } },
      user: { select: { id: true, name: true, email: true } },
    },
  },

  /* ------------------------------------------- BEFORE ANYBODY BUILDS */
  acquisitions: {
    model: "acquisition", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "land acquisitions",
    fields: {
      projectId: "id:project", parcelId: "id:parcel", sellerId: "id:party",
      sellerName: "string", title: "string", location: "string",
      areaSqm: "int", tenure: "string",
      askingPrice: "money", currency: "string", targetOn: "date",
    },
    /* `offeredPrice`, `agreedPrice` and every date beside them are written by
       the status route, which is the only thing that knows what was agreed
       and when. */
    required: ["title"], numbered: "ref", prefix: "ACQ",
    search: ["ref", "title", "location", "sellerName", "tenure"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      canComplete: ["AGREED", "DUE_DILIGENCE"].includes(statusOf(row)),
      live: !["COMPLETED", "ABANDONED"].includes(statusOf(row)),
      /* The moves still open from here, so the console draws exactly the
         buttons the route would accept — rather than keeping its own copy of
         the table, which drifts on the first change to either. */
      nextStatuses: ACQUISITION_NEXT[statusOf(row)] || [],
      means: ACQUISITION_MEANS[statusOf(row)] || "",
    }),
    include: {
      project: { select: { id: true, name: true } },
      parcel: { select: { id: true, ref: true, zoning: true, tenure: true } },
      seller: { select: { id: true, name: true } },
      diligence: {
        select: { id: true, title: true, category: true, status: true,
                  finding: true, waivedBy: true, waivedReason: true,
                  checkedBy: true, checkedOn: true, dueOn: true, position: true },
        orderBy: { position: "asc" },
      },
    },
  },

  feasibilities: {
    model: "feasibility", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "feasibility studies",
    fields: {
      projectId: "id:project", acquisitionId: "id:acquisition",
      title: "string", assumptions: "text",
      landCost: "money", buildCost: "money", professional: "money",
      financeCost: "money", otherCost: "money", grossValue: "money",
      currency: "string", targetMarginBps: "int",
    },
    required: ["title"], numbered: "ref", prefix: "FEA",
    search: ["ref", "title", "assumptions"],
    order: [{ createdAt: "desc" }],
    /*
     * EVERY DERIVED FIGURE, COMPUTED HERE AND STORED NOWHERE.
     *
     * A margin in a column is one that disagrees with its own inputs the
     * first time a cost changes and nothing recalculates — and nobody ever
     * notices, because the number still looks like a number.
     */
    /*
     * The row's money columns are BigInt in the database and `unknown` to a
     * generic reader, so they are collected into the shape the arithmetic
     * needs rather than the arithmetic being loosened to accept anything.
     */
    onRead: (row) => feasibilityNumbers({
      landCost: bigOf(row, "landCost"),
      buildCost: bigOf(row, "buildCost"),
      professional: bigOf(row, "professional"),
      financeCost: bigOf(row, "financeCost"),
      otherCost: bigOf(row, "otherCost"),
      grossValue: bigOf(row, "grossValue"),
      targetMarginBps: numberOf(row, "targetMarginBps"),
    }),
    include: {
      project: { select: { id: true, name: true } },
      acquisition: { select: { id: true, ref: true, title: true } },
    },
  },

  drawings: {
    model: "drawing", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "drawings",
    fields: {
      projectId: "id:project", number: "string", title: "string",
      discipline: "string", revision: "string", scale: "string",
      documentId: "id:document",
    },
    required: ["number", "title"], numbered: "ref", prefix: "DRW",
    search: ["ref", "number", "title", "discipline"],
    order: [{ number: "asc" }],
    onRead: (row) => ({
      canIssue: statusOf(row) !== "SUPERSEDED",
      canRevise: statusOf(row) !== "SUPERSEDED",
      /* The one thing somebody on site needs to know about a sheet. */
      buildToThis: statusOf(row) === "ISSUED_FOR_CONSTRUCTION",
      means: statusOf(row) === "ISSUED_FOR_CONSTRUCTION"
        ? "Build to this. It is fixed — a change is a new revision."
        : statusOf(row) === "SUPERSEDED"
          ? "Replaced. Somebody on site may still be holding it."
          : statusOf(row) === "ISSUED_FOR_COMMENT"
            ? "Out for comment. Not to be built from."
            : "Being drawn. Nobody has seen it.",
    }),
    include: {
      project: { select: { id: true, name: true } },
      previous: { select: { id: true, ref: true, revision: true, status: true } },
      next: { select: { id: true, ref: true, revision: true, status: true } },
    },
  },

  permits: {
    model: "permit", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "permits",
    fields: {
      projectId: "id:project", title: "string", kind: "string",
      authority: "string", fee: "money", currency: "string",
      blocking: "bool", expiresOn: "date",
    },
    /* `reference`, `status`, `conditions` and the decision dates are written
       by POST /permits/:id/status — an approval needs the authority's own
       number, and a caller who could type one could invent it. */
    required: ["title"], numbered: "ref", prefix: "PER",
    search: ["ref", "title", "kind", "authority", "reference"],
    order: [{ createdAt: "desc" }],
    /*
     * EXPIRY IS WORKED OUT ON THE WAY OUT.
     *
     * A stored APPROVED on a consent that lapsed last March is a licence to
     * build illegally, and nothing would ever change it — the column is
     * correct about what the authority said and wrong about today.
     */
    onRead: (row) => {
      const lapsed = statusOf(row) === "APPROVED" && isPast(row, "expiresOn");
      const granted = statusOf(row) === "APPROVED" && !lapsed;
      return {
        lapsed,
        granted,
        blocks: !!isSet(row, "blocking") && !granted,
        /* Sent for the same reason as an acquisition's. */
        nextStatuses: PERMIT_NEXT[statusOf(row)] || [],
        means: lapsed
          ? "GRANTED AND SINCE LAPSED. Work relying on it is unlawful today."
          : granted ? "Granted and current."
          : statusOf(row) === "REFUSED" ? "Refused, with the authority's reason kept."
          : isSet(row, "blocking") ? "Required, and not granted. Work cannot lawfully proceed."
          : "Not granted. Work does not depend on it.",
      };
    },
    include: {
      project: { select: { id: true, name: true } },
      events: {
        select: { id: true, status: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  /* --------------------------------------- PROCUREMENT AND VARIATIONS */
  /*
   * NONE OF THESE IS AN ACCOUNTING RECORD. A purchase order is a commitment
   * and a change order is an agreement about what a contract is now worth;
   * the money stays in Expense, Invoice, Payment and the ledger. They are in
   * the `finance` area all the same, because committing a company to pay
   * somebody is a money decision even before any money moves.
   */
  rfqs: {
    model: "rfq", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "requests for quotation",
    fields: {
      projectId: "id:project", title: "string", description: "text",
      category: "string", dueOn: "date",
    },
    required: ["title"], numbered: "ref", prefix: "RFQ",
    search: ["ref", "title", "description", "category"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      canIssue: statusOf(row) === "DRAFT",
      canAward: ["ISSUED", "CLOSED"].includes(statusOf(row)),
    }),
    include: {
      project: { select: { id: true, name: true } },
      quotes: {
        select: { id: true, ref: true, vendorName: true, amount: true,
                  currency: true, leadTimeDays: true, status: true, decidedNote: true },
        orderBy: { amount: "asc" },
      },
    },
  },

  quotes: {
    model: "quote", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "quotes",
    fields: {
      rfqId: "id:rfq", vendorId: "id:party", vendorName: "string",
      amount: "money", currency: "string", leadTimeDays: "int",
      validUntil: "date", notes: "text",
    },
    required: ["rfqId"], numbered: "ref", prefix: "QUO",
    search: ["ref", "vendorName", "notes"],
    order: [{ amount: "asc" }],
    include: {
      rfq: { select: { id: true, ref: true, title: true, status: true } },
      vendor: { select: { id: true, name: true } },
    },
  },

  "purchase-orders": {
    model: "purchaseOrder", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "purchase orders",
    fields: {
      projectId: "id:project", vendorId: "id:party", vendorName: "string",
      title: "string", description: "text", currency: "string",
      expectedOn: "date",
    },
    /* `subtotal`, `tax` and `total` are computed from the lines; `status` and
       `expenseId` are moved by routes/procurement.js. */
    required: ["title"], numbered: "ref", prefix: "PO",
    search: ["ref", "title", "vendorName", "description"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      canIssue: statusOf(row) === "DRAFT",
      canReceive: ["ISSUED", "PARTIALLY_RECEIVED"].includes(statusOf(row)),
      canInvoice: statusOf(row) !== "DRAFT" && !isSet(row, "expenseId"),
      /* COMMITTED, NOT SPENT. The distinction the whole design rests on, said
         beside the row so no console has to decide how to word it. */
      means: isSet(row, "expenseId")
        ? "Invoiced. The cost is in the books as an expense."
        : statusOf(row) === "DRAFT"
          ? "Not yet issued. The company is committed to nothing."
          : "Committed, not spent. Nothing reaches the ledger until the invoice is recorded.",
    }),
    include: {
      project: { select: { id: true, name: true } },
      vendor: { select: { id: true, name: true } },
      lines: {
        select: { id: true, position: true, description: true, quantity: true,
                  unit: true, unitPrice: true, total: true, receivedQty: true },
        orderBy: { position: "asc" },
      },
      receipts: {
        select: { id: true, ref: true, receivedOn: true, receivedBy: true, deliveryNote: true },
        orderBy: { receivedOn: "asc" },
      },
      expense: { select: { id: true, amount: true, currency: true, spentOn: true } },
    },
  },

  "goods-receipts": {
    model: "goodsReceipt", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "goods receipts",
    /*
     * `noCreate`, not `ownCreate`: there is no POST /goods-receipts at all,
     * and there must not be. A delivery is recorded against the ORDER, which
     * is the only place that can refuse to receive more than was ordered and
     * update each line's running total in the same transaction. A receipt
     * created on its own would be a delivery of nothing in particular.
     */
    noCreate:
      "A delivery is recorded against the order it arrived against, by POST " +
      "/purchase-orders/:id/receive. That route refuses to receive more than " +
      "was ordered and updates each line in the same transaction; a receipt " +
      "created on its own path could do neither.",
    fields: { orderId: "id:purchaseOrder", receivedBy: "string", deliveryNote: "string", note: "text" },
    required: ["orderId"], numbered: "ref", prefix: "GRN",
    search: ["ref", "deliveryNote", "receivedBy"],
    order: [{ receivedOn: "desc" }],
    include: {
      order: { select: { id: true, ref: true, title: true, vendorName: true } },
      lines: {
        select: { id: true, lineId: true, quantity: true, condition: true, note: true },
      },
    },
  },

  "change-orders": {
    model: "changeOrder", area: "finance", product: "PROPERTY_MANAGEMENT",
    label: "variations",
    fields: {
      projectId: "id:project", contractId: "id:contract", rfiId: "id:rfi",
      title: "string", reason: "text",
      /* SIGNED. An omission reduces a contract, and forcing it positive would
         mean recording a credit as a charge. */
      amount: "signed-money", currency: "string",
      /* Signed for the same reason: work can be brought forward. */
      days: "int",
    },
    required: ["title"], numbered: "ref", prefix: "CO",
    search: ["ref", "title", "reason", "decidedBy"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      canSubmit: statusOf(row) === "DRAFT",
      canDecide: statusOf(row) === "SUBMITTED",
      canWithdraw: ["DRAFT", "SUBMITTED"].includes(statusOf(row)),
      /* An approved variation is the only kind that changes anything. */
      counts: statusOf(row) === "APPROVED",
      means: statusOf(row) === "APPROVED"
        ? "Approved. The contract's current value includes this; the signed figure does not change."
        : statusOf(row) === "SUBMITTED" ? "Waiting for somebody to decide."
        : statusOf(row) === "REJECTED" ? "Turned down, with the reason kept."
        : statusOf(row) === "WITHDRAWN" ? "Taken back before anybody decided."
        : "Being prepared. Nobody has been asked.",
    }),
    include: {
      project: { select: { id: true, name: true } },
      contract: { select: { id: true, ref: true, price: true, currency: true } },
      rfi: { select: { id: true, ref: true, subject: true } },
    },
  },

  /* ------------------------------------------------- SITE OPERATIONS */
  /*
   * Five registers. Every status below is absent from `fields` and moved by
   * routes/site.js, because each move is a rule a column cannot hold: an RFI
   * cannot be closed unanswered, a submittal sent back opens the next
   * revision, a defect cannot be verified by whoever fixed it.
   */
  rfis: {
    model: "rfi", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "RFIs",
    fields: {
      projectId: "id:project", phaseId: "id:projectPhase",
      subject: "string", question: "text", discipline: "string",
      raisedByName: "string", toName: "string", dueOn: "date",
    },
    required: ["subject"], numbered: "ref", prefix: "RFI",
    search: ["ref", "subject", "question", "discipline", "toName"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      /* Overdue is a fact about now, so it is worked out on the way out
         rather than stored and left to go stale overnight. */
      overdue: statusOf(row) === "OPEN" && isPast(row, "dueOn"),
      canAnswer: statusOf(row) !== "VOID" && statusOf(row) !== "CLOSED",
      canClose: statusOf(row) === "ANSWERED",
    }),
    include: {
      project: { select: { id: true, name: true } },
      events: {
        select: { id: true, action: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  submittals: {
    model: "submittal", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "submittals",
    fields: {
      projectId: "id:project", title: "string", specRef: "string",
      discipline: "string", contractor: "string", dueOn: "date",
    },
    /* `revision` and `previousId` are set when a review sends one back. A
       caller choosing its own revision number could file rev 5 before rev 2. */
    required: ["title"], numbered: "ref", prefix: "SUB",
    search: ["ref", "title", "specRef", "discipline", "contractor"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      canSubmit: statusOf(row) === "DRAFT",
      canReview: ["SUBMITTED", "UNDER_REVIEW"].includes(statusOf(row)),
      /* Said out loud: approved-as-noted is the outcome everybody misreads,
         and reading it as a rejection stops work that could continue. */
      means: SUBMITTAL_MEANS[statusOf(row)] || "",
    }),
    include: {
      project: { select: { id: true, name: true } },
      previous: { select: { id: true, ref: true, revision: true, status: true } },
      next: { select: { id: true, ref: true, revision: true, status: true } },
      events: {
        select: { id: true, action: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  inspections: {
    model: "inspection", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "inspections",
    fields: {
      projectId: "id:project", unitId: "id:unit", title: "string",
      kind: "string", area: "string", scheduledOn: "date",
      inspectorName: "string",
    },
    required: ["title"], numbered: "ref", prefix: "INS",
    search: ["ref", "title", "kind", "area", "inspectorName"],
    order: [{ scheduledOn: "desc" }],
    onRead: (row) => ({ canRecord: statusOf(row) === "SCHEDULED" }),
    include: {
      project: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true } },
      defects: { select: { id: true, ref: true, title: true, severity: true, status: true } },
      events: {
        select: { id: true, action: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  defects: {
    model: "defect", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "defects",
    fields: {
      projectId: "id:project", unitId: "id:unit", inspectionId: "id:inspection",
      title: "string", description: "text", location: "string", trade: "string",
      severity: "enum:DefectSeverity", assigneeName: "string", dueOn: "date",
    },
    required: ["title"], numbered: "ref", prefix: "DEF",
    search: ["ref", "title", "description", "location", "trade", "assigneeName"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      overdue: ["OPEN", "IN_PROGRESS"].includes(statusOf(row))
        && isPast(row, "dueOn"),
      canFix: !["VERIFIED", "CLOSED", "REJECTED"].includes(statusOf(row)),
      canVerify: statusOf(row) === "FIXED",
      /* FIXED is the state everybody reads as finished. It is not. */
      means: statusOf(row) === "FIXED"
        ? `${textOf(row, "fixedByName") || "Somebody"} says it is done. It is not closed until ` +
          `somebody else checks it.`
        : "",
    }),
    include: {
      project: { select: { id: true, name: true } },
      unit: { select: { id: true, ref: true } },
      inspection: { select: { id: true, ref: true, title: true } },
      events: {
        select: { id: true, action: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  "site-diary": {
    model: "siteDiary", area: "property", product: "PROPERTY_MANAGEMENT",
    label: "site diary",
    /*
     * ownCreate AND ownUpdate: three of this table's rules are about WHICH DAY
     * an entry is for — one per project per day, never a day that has not
     * happened, and fixed once the day is over — and the framework has no
     * opinion about days. See routes/site.js.
     */
    ownCreate:
      "Three of this table's rules are about WHICH DAY an entry is for — one " +
      "per project per day, never a day that has not happened yet — and the " +
      "framework has no opinion about days. See POST /site-diary in routes/site.js.",
    ownUpdate:
      "A diary entry is fixed once the day it records is over, which is the " +
      "whole reason anybody keeps one. The framework's PATCH would happily " +
      "rewrite last March. See PATCH /site-diary/:id in routes/site.js.",
    fields: {
      projectId: "id:project", on: "date", weather: "string",
      temperature: "string", labourCount: "int", contractors: "text",
      equipment: "text", workDone: "text", delays: "text",
      visitors: "text", safetyNotes: "text", materials: "text",
    },
    /* The DAY is required, not defaulted, so the form asks for it. A diary
       whose date is whatever the server thought at the time is a diary that
       records the wrong Tuesday whenever somebody writes one up late. */
    required: ["projectId", "on"], numbered: "ref", prefix: "SD",
    search: ["ref", "workDone", "delays", "contractors"],
    order: [{ on: "desc" }],
    onRead: (row) => ({
      locked: !!isSet(row, "lockedAt"),
      means: isSet(row, "lockedAt")
        ? "The day is over, so this entry is fixed. Corrections are appended as amendments."
        : "Still today — this entry can be edited until the day is out.",
    }),
    include: {
      project: { select: { id: true, name: true } },
      events: {
        select: { id: true, action: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  /*
   * COMMUNICATIONS. `status`, `provider`, `providerRef` and every timestamp
   * are absent from `fields` deliberately — a dispatch's state is the record
   * of what a carrier did, and a PATCH that could write DELIVERED would make
   * the whole table worthless. See routes/comms.js.
   */
  dispatches: {
    model: "dispatch", area: "people", product: null,
    label: "messages",
    fields: {
      channel: "enum:DispatchChannel", toName: "string", toAddress: "string",
      partyId: "id:party", subject: "string", body: "text",
      projectId: "id:project", meetingId: "id:meeting", taskId: "id:task",
    },
    required: ["toAddress"], numbered: "ref", prefix: "MSG",
    search: ["ref", "toName", "toAddress", "subject"],
    order: [{ createdAt: "desc" }],
    /* What a person may still do with it, decided by the same states the
       route enforces so the console never draws a button that would 409. */
    onRead: (row) => ({
      canSend: ["DRAFT", "QUEUED", "FAILED"].includes(statusOf(row)),
      canCancel: !["SUBMITTED", "DELIVERED", "CANCELLED"].includes(statusOf(row)),
      /* Said out loud, because SUBMITTED is the state everybody misreads. */
      means: DISPATCH_MEANS[statusOf(row)] || "",
    }),
    include: {
      campaign: { select: { id: true, ref: true, name: true } },
      party: { select: { id: true, name: true } },
      events: {
        select: { id: true, status: true, detail: true, byName: true, at: true },
        orderBy: { at: "asc" },
      },
    },
  },

  campaigns: {
    model: "campaign", area: "people", product: null,
    label: "campaigns",
    fields: {
      name: "string", channel: "enum:DispatchChannel",
      subject: "string", body: "text", projectId: "id:project",
    },
    /* `status` and the four counters are written by POST /campaigns/:id/send,
       which is the only thing that knows what actually happened. */
    required: ["name"], numbered: "ref", prefix: "CMP",
    search: ["ref", "name", "subject"],
    order: [{ createdAt: "desc" }],
    onRead: (row) => ({
      canSend: statusOf(row) === "DRAFT",
      canCancel: ["DRAFT", "SENDING", "PARTIAL"].includes(statusOf(row)),
      /* Neither a count nor a percentage on its own: "18 of 40 accepted" is
         what somebody watching a campaign go out actually reads. */
      progress: numberOf(row, "total")
        ? `${numberOf(row, "submitted")} of ${numberOf(row, "total")} accepted` +
          (numberOf(row, "delivered") ? `, ${numberOf(row, "delivered")} confirmed delivered` : "") +
          (numberOf(row, "failed") ? `, ${numberOf(row, "failed")} failed` : "")
        : "Not sent yet",
    }),
    include: { project: { select: { id: true, name: true } } },
  },

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
    /* The moves still open from here, so the console can draw exactly the
       buttons the register would accept and no others. */
    onRead: (row) => ({ nextStatuses: nextFor(statusOf(row)) }),
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
      /* How to reach them, whose it is, and what happens next — without these
         a lead is a note rather than something anybody can work. `partyId` is
         the link that turns a converted lead into a client. */
      email: "string", phone: "string", partyId: "id:party",
      assignedToId: "id:user", priority: "enum:WorkPriority",
      nextFollowUpOn: "date",
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
      /* Which unit it is for, and who is working it. An opportunity worth a
         number but attached to no unit cannot be reconciled against what was
         actually sold or let. */
      unitId: "id:unit", assignedToId: "id:user",
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
      partyId: "id:party", leaseId: "id:lease",
      /* The sale this is an instalment of, where it is one. It is the only
         path from money to a contract — a payment settles an invoice, and
         without this an instalment belongs to nothing. */
      contractId: "id:contract",
      source: "string",
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
      if (was !== "DRAFT" || statusOf(row) === "DRAFT" || statusOf(row) === "VOID") return {};

      const full = await db.invoice.findFirst({
        where: { id: textOf(row, "id"), orgId: req.actor.orgId }, include: { lines: true },
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

  "bank-accounts": {
    model: "bankAccount", area: "finance", product: null,
    label: "bank accounts",
    fields: {
      name: "string", kind: "enum:BankAccountKind", currency: "string",
      externalRef: "string", ledgerAccountId: "id:ledgerAccount",
      active: "bool",
    },
    required: ["name"],
    search: ["name", "externalRef"],
    order: [{ name: "asc" }],
    include: { ledgerAccount: { select: { id: true, code: true, name: true } } },
  },

  "cost-codes": {
    model: "costCode", area: "finance", product: null,
    label: "cost codes",
    fields: {
      projectId: "id:project", code: "string", name: "string", active: "bool",
    },
    required: ["code", "name"],
    search: ["code", "name"],
    order: [{ code: "asc" }],
    include: { project: { select: { id: true, name: true } } },
  },

  expenses: {
    model: "expense", area: "finance", product: null,
    label: "expenses",
    fields: {
      siteId: "id:site", partyId: "id:party", detail: "string",
      category: "string", amount: "money", currency: "string",
      costCodeId: "id:costCode", projectId: "id:project",
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
      /* The row is read column by column rather than handed over whole: the
         framework only knows it wrote SOMETHING, and the posting bridge is
         entitled to be told which columns it is being given. */
      const b = await postForExpense(db, {
        orgId: req.actor.orgId,
        expense: {
          id: textOf(row, "id"),
          amount: row["amount"],
          category: textOf(row, "category"),
          currency: textOf(row, "currency"),
          detail: textOf(row, "detail"),
          spentOn: dateOf(row, "spentOn"),
          siteId: textOf(row, "siteId") || null,
          partyId: textOf(row, "partyId") || null,
          /* The two development dimensions. Without these the cost code is
             recorded on the expense and never reaches the ledger, so spend
             can be tagged and never reported — which is the same as not
             having cost codes at all. */
          costCodeId: textOf(row, "costCodeId") || null,
          projectId: textOf(row, "projectId") || null,
        },
        userId: req.session.userId,
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

} satisfies Registry;

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
/*
 * BUILT IN RATHER THAN BOLTED ON.
 *
 * This used to mutate `r.aliases` onto each declaration after the fact, which
 * works and is invisible: a reader of the literal above sees no `aliases` and
 * has no reason to think one appears later. Composing the exported registry
 * from the declarations says it in one place, and it means the literal stays
 * exactly what it claims to be.
 */
export const RESOURCES: Registry = Object.fromEntries(
  Object.entries(DECLARATIONS).map(([slug, r]) => [slug, { ...r, aliases: aliasesFor(slug) }]),
);

export const resource = (slug: string): ResourceDeclaration | undefined => RESOURCES[slug];

export const slugs = (): string[] => Object.keys(RESOURCES);

/* Referenced above so a reader can see what is deliberately not writable. */
void AT;

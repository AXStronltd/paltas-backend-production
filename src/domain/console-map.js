/* ====================================================================== *
 * WHAT THE CONSOLE SENDS, AND WHAT THIS SERVICE CALLS IT.
 *
 * ── THE PROBLEM THIS FILE SOLVES ───────────────────────────────────────
 *
 * `contract/backend.md` §2 lists all 27 create forms in the built product
 * with the exact field names each one posts. They are the console's own
 * abbreviations:
 *
 *     s_visitors   ＋ Register visitor   { n, cat, host, veh }
 *     maintenance  ＋ Raise request      { t, p, pr, who }
 *     s_incidents  ＋ Report incident    { t, p, sev }
 *
 * This service calls those `visitor`, `category`, `hostName`, `vehicle`,
 * `title`, `place`, `priority`, `assignee`, `severity`. Both namings are
 * right for where they live — `t` is fine in a template that repeats it
 * forty times, and unreadable in a database — but they are not the same,
 * and until this file existed **every one of the 27 forms would have been
 * rejected**, field by field, with "nothing to change".
 *
 * ── WHY THE MAPPING LIVES HERE AND NOT IN THE FRONTEND ─────────────────
 *
 * Because the brief said not to rename anything in the built frontend, and
 * because it is the right call anyway: 135 console screens read these keys,
 * the abbreviations are load-bearing in template literals, and a rename
 * touches every one of them. One table on the server costs nothing and
 * breaks nothing.
 *
 * ── HOW THE MEANINGS WERE ESTABLISHED ──────────────────────────────────
 *
 * Not guessed. Read out of the console's own seed arrays in
 * `assets/console.js`, which carry example values:
 *
 *     AG_BOOKINGS = { guest:"N. Chebet", prop:"Kilimani Suites · A08",
 *                     inn:"9 Sep", nights:4, total:37_600 }
 *
 * `inn` is not an inn. It is the check-IN date. A guess would have made it
 * a property name and quietly stored a date in the wrong column forever.
 *
 * Anything below marked NEW is a field the console shows that had no column
 * at all. Those were added rather than dropped, because a form that saves
 * and silently loses a value is worse than one that refuses.
 * ====================================================================== */

/**
 * Console screen → the resource it writes to, and what each field is called.
 *
 * `resource` is a key in registry.js. `fields` maps the console's name to
 * this service's name; a field already sharing a name is listed anyway, so
 * that the table can be read against §2 line by line without cross-checking.
 */
export const CONSOLE_FORMS = {

  /* ---------------------------------------------------- agent & host */

  ag_bookings: {
    resource: "reservations",
    label: "＋ New booking",
    fields: {
      guest: "guestName",
      prop: "property",          // NEW — which property the stay is at
      inn: "arriveOn",           // the check-IN date: "9 Sep"
      nights: "nights",
      total: "rate",             // what the whole stay comes to
    },
  },

  ag_clients: {
    resource: "parties",
    label: "＋ Add a client",
    fields: { n: "name", type: "kind", since: "since", note: "note" },
  },

  ag_deals: {
    resource: "deals",
    label: "＋ New deal",
    fields: { n: "name", value: "value", fee: "fee", stage: "stage", close: "closesOn" },
  },

  ag_leads: {
    resource: "leads",
    label: "＋ Add a lead",
    fields: { n: "name", want: "wants", budget: "budget", stage: "stage", src: "source" },
  },

  ag_listings: {
    resource: "listings",
    label: "＋ New listing",
    fields: { n: "title", ch: "channel" },
  },

  ag_props: {
    resource: "listings",
    label: "＋ Add a property",
    fields: { n: "title", owner: "ownerName", kind: "kind", rate: "price", mandate: "mandate" },
  },

  ag_viewings: {
    resource: "viewings",
    label: "＋ Book a viewing",
    fields: { who: "who", prop: "property", when: "at", note: "note" },
  },

  /* ------------------------------------------------------- property */

  buildings: {
    resource: "buildings",
    label: "＋ Add a building",
    fields: {
      n: "name", city: "city", floors: "floors",
      units: "unitCount", built: "builtYear", cond: "condition",
    },
  },

  development: {
    resource: "projects",
    label: "＋ New project",
    fields: { name: "name", city: "city", units: "units", due: "dueOn" },
  },

  documents: {
    resource: "documents",
    label: "＋ Upload",
    fields: { n: "name", kind: "kind", who: "about", exp: "expiresAt" },
  },

  maintenance: {
    resource: "work-orders",
    label: "＋ Raise request",
    fields: { t: "title", p: "place", pr: "priority", who: "assignee" },
  },

  /*
   * The plant a building runs on. The `assets` resource has been served since
   * the registry was written and no screen has ever written to it, so the ＋
   * button is the first way a company can put a lift or a generator on its own
   * asset register.
   *
   * `st` is a free string on this model rather than an enum — a company's own
   * words for the condition of its plant, not a list this service chose.
   */
  /*
   * A unit sale. The three references are real pickers rather than typed
   * names: the form spec carries `lookup` for an `id:` field and the console
   * renders a <select> from what it has already loaded.
   *
   * That matters more here than on the lease form beside it, because the
   * Development screen COUNTS these rows per project. A sale captured as the
   * text "Golden Park Phase 2" would sit in the list looking correct and be
   * counted against nothing.
   */
  /*
   * The programme. `n` is `name` here as it is on every other form that has a
   * name, which is what keeps aliasesFor() from throwing.
   */
  /* An offer on a unit. The references are real pickers — see forms.js. */
  pm_offers: {
    resource: "offers",
    label: "＋ New offer",
    fields: {
      buyer: "buyerId", project: "projectId", unit: "unitId",
      price: "price", disc: "discount", dep: "deposit",
      plan: "paymentPlan", valid: "validUntil", terms: "terms",
    },
  },

  pm_phases: {
    resource: "project-phases",
    label: "＋ Add a phase",
    fields: {
      project: "projectId", n: "name", pos: "position", st: "status",
      pct: "progress", weight: "weight", from: "startsOn", to: "endsOn",
    },
  },

  pm_milestones: {
    resource: "milestones",
    label: "＋ Add a milestone",
    fields: {
      project: "projectId", phase: "phaseId", n: "name", st: "status",
      due: "dueOn", owner: "owner",
    },
  },

  /*
   * THE OPERATING LOOP. Three forms that only ask for the beginning of a
   * thing: a meeting's status, a decision's status and a task's status are
   * all moved by their own routes, so none of them is offered here. A form
   * that let somebody type "APPROVED" into a decision would write a word and
   * none of its consequences.
   */
  pm_meetings: {
    resource: "meetings",
    label: "＋ New meeting",
    fields: {
      project: "projectId", title: "title", kind: "kind",
      startsAt: "startsAt", endsAt: "endsAt",
      location: "location", videoUrl: "videoUrl", agenda: "agenda",
    },
  },

  pm_decisions: {
    resource: "decisions",
    label: "＋ Log a decision",
    fields: {
      project: "projectId", meeting: "meetingId", subject: "subject",
      description: "description", options: "options", area: "area",
      owner: "ownerName",
    },
  },

  pm_tasks: {
    resource: "tasks",
    label: "＋ New task",
    fields: {
      project: "projectId", meeting: "meetingId", decision: "decisionId",
      parent: "parentId", title: "title", detail: "detail",
      who: "assigneeName", priority: "priority", due: "dueOn",
    },
  },

  /*
   * BEFORE ANYBODY BUILDS. No form offers a status, a decision, an agreed
   * price or an authority's reference — every one of those is a move that
   * checks something first.
   */
  pm_land: {
    resource: "acquisitions",
    label: "＋ Add a site",
    fields: {
      project: "projectId", parcel: "parcelId", seller: "sellerId",
      sellerName: "sellerName", title: "title", loc: "location",
      area: "areaSqm", tenure: "tenure", asking: "askingPrice",
      cur: "currency", target: "targetOn",
    },
  },

  pm_feasibility: {
    resource: "feasibilities",
    label: "＋ New appraisal",
    fields: {
      project: "projectId", acquisition: "acquisitionId", title: "title",
      assumptions: "assumptions", land: "landCost", build: "buildCost",
      fees: "professional", finance: "financeCost", other: "otherCost",
      gdv: "grossValue", cur: "currency", target: "targetMarginBps",
    },
  },

  pm_drawings: {
    resource: "drawings",
    label: "＋ Add a drawing",
    fields: {
      project: "projectId", number: "number", title: "title",
      discipline: "discipline", rev: "revision", scale: "scale",
      document: "documentId",
    },
  },

  pm_permits: {
    resource: "permits",
    label: "＋ New application",
    fields: {
      project: "projectId", title: "title", kind: "kind",
      authority: "authority", fee: "fee", cur: "currency",
      blocking: "blocking", expires: "expiresOn",
    },
  },

  /*
   * PROCUREMENT AND VARIATIONS. No form offers a status, a total or a
   * decision: an order's figures come from its lines, and everything else is
   * a move that writes consequences beside it.
   */
  pm_rfqs: {
    resource: "rfqs",
    label: "＋ Ask for quotes",
    fields: {
      project: "projectId", title: "title", description: "description",
      category: "category", due: "dueOn",
    },
  },

  pm_quotes: {
    resource: "quotes",
    label: "＋ Record a quote",
    fields: {
      rfq: "rfqId", vendor: "vendorId", vendorName: "vendorName",
      amount: "amount", cur: "currency", lead: "leadTimeDays",
      valid: "validUntil", notes: "notes",
    },
  },

  pm_orders: {
    resource: "purchase-orders",
    label: "＋ New purchase order",
    fields: {
      project: "projectId", vendor: "vendorId", vendorName: "vendorName",
      title: "title", description: "description", cur: "currency",
      expected: "expectedOn",
    },
  },

  pm_variations: {
    resource: "change-orders",
    label: "＋ Raise a variation",
    fields: {
      project: "projectId", contract: "contractId", rfi: "rfiId",
      title: "title", reason: "reason", amount: "amount",
      cur: "currency", days: "days",
    },
  },

  /*
   * THE FIVE SITE REGISTERS. No form offers a status, an answer, a review
   * outcome, a fix or a lock — every one of those is a move with consequences,
   * and a field somebody types into would record the word without them.
   */
  pm_rfis: {
    resource: "rfis",
    label: "＋ Raise an RFI",
    fields: {
      project: "projectId", phase: "phaseId", subject: "subject",
      question: "question", discipline: "discipline",
      raisedBy: "raisedByName", to: "toName", due: "dueOn",
    },
  },

  pm_submittals: {
    resource: "submittals",
    label: "＋ New submittal",
    fields: {
      project: "projectId", title: "title", spec: "specRef",
      discipline: "discipline", contractor: "contractor", due: "dueOn",
    },
  },

  pm_inspections: {
    resource: "inspections",
    label: "＋ Book an inspection",
    fields: {
      project: "projectId", unit: "unitId", title: "title",
      kind: "kind", area: "area", on: "scheduledOn", who: "inspectorName",
    },
  },

  pm_defects: {
    resource: "defects",
    label: "＋ Raise a defect",
    fields: {
      project: "projectId", unit: "unitId", inspection: "inspectionId",
      title: "title", description: "description", loc: "location",
      trade: "trade", sev: "severity", who: "assigneeName", due: "dueOn",
    },
  },

  pm_diary: {
    resource: "site-diary",
    label: "＋ Write up a day",
    fields: {
      project: "projectId", on: "on", weather: "weather",
      temp: "temperature", labour: "labourCount", contractors: "contractors",
      equipment: "equipment", work: "workDone", delays: "delays",
      visitors: "visitors", safety: "safetyNotes", materials: "materials",
    },
  },

  /*
   * COMMUNICATIONS. Neither form offers a status: what a message's state is
   * depends on what a carrier did with it, and a field somebody can type into
   * would let a person record a delivery that never happened.
   */
  co_messages: {
    resource: "dispatches",
    label: "＋ New message",
    fields: {
      channel: "channel", toName: "toName", to: "toAddress",
      party: "partyId", subject: "subject", body: "body",
      project: "projectId", meeting: "meetingId", task: "taskId",
    },
  },

  co_campaigns: {
    resource: "campaigns",
    label: "＋ New campaign",
    fields: {
      n: "name", channel: "channel", subject: "subject",
      body: "body", project: "projectId",
    },
  },

  pm_contracts: {
    resource: "contracts",
    label: "＋ New sale",
    fields: {
      project: "projectId", unit: "unitId", buyer: "buyerId",
      price: "price", dep: "deposit", status: "status",
      signed: "signedOn", inst: "instalments", note: "note",
    },
  },

  /*
   * A buyer is a Party of kind BUYER, exactly as a vendor is one of kind
   * VENDOR. Same resource, same `n` → `name`, so aliasesFor() stays happy.
   */
  pm_buyers: {
    resource: "parties",
    label: "＋ Add a buyer",
    fields: {
      n: "name", kind: "kind", email: "email", phone: "phone",
      since: "since", note: "note",
    },
  },

  pm_assets: {
    resource: "assets",
    label: "＋ Add an asset",
    fields: {
      n: "name", kind: "kind", serial: "serial", place: "place",
      installed: "installedOn", next: "nextServiceOn", st: "status",
    },
  },

  /*
   * A vendor is a PARTY, not a table of its own — PartyKind already carries
   * VENDOR and CONTRACTOR, and Expense points at Party through ExpenseVendor.
   * So this writes the same resource `ag_clients` and `s_residents` do.
   *
   * `n` means `name` on all three, which is what keeps aliasesFor() from
   * throwing: two screens writing one resource may not disagree about what a
   * short name means.
   */
  pm_vendors: {
    resource: "parties",
    label: "＋ Add a vendor",
    fields: {
      n: "name", kind: "kind", email: "email", phone: "phone",
      since: "since", note: "note",
    },
  },

  pm_issues: {
    resource: "work-orders",
    label: "＋ Log a report",
    /* A resident's report is a work order raised by somebody who lives
       there. `b` is the building it is in. */
    fields: { t: "title", b: "place", kind: "kind", pr: "priority" },
  },

  pm_market: {
    resource: "listings",
    label: "＋ New listing",
    fields: { u: "title", ask: "price", note: "note" },
  },

  portfolio: {
    resource: "sites",
    label: "＋ Add property",
    fields: {
      name: "name", city: "city", kind: "kind",
      /* `unitCount`, not `units` — Site.units is already the relation to the
         unit records, and a scalar of the same name cannot exist beside it. */
      units: "unitCount",        // NEW — how many units the site holds
      val: "value",              // NEW — what it is worth, minor units
    },
  },

  rentals: {
    resource: "leases",
    label: "＋ New lease",
    fields: {
      n: "tenantName",           // NEW — text, because the tenant may not be a contact yet
      u: "unitRef",              // NEW — text, same reason
      rent: "rent",
      since: "startsOn",
    },
  },

  units: {
    resource: "units",
    label: "＋ Add a unit",
    fields: {
      id: "ref",
      b: "buildingName",         // NEW — text; the picker comes later
      type: "kind", sqm: "sqm", rent: "rent",
    },
  },

  sales: {
    resource: "leads",
    label: "＋ Add lead",
    fields: {
      n: "name",
      p: "property",             // NEW — which property they are asking about
      b: "budget", s: "stage",
    },
  },

  /* ---------------------------------------------------------- hotel */

  h_reservations: {
    resource: "reservations",
    label: "＋ New reservation",
    fields: {
      g: "guestName",
      r: "roomNumber",           // NEW — text; typed before a room record exists
      t: "roomType", n: "nights", eta: "eta",
    },
  },

  h_services: {
    resource: "services",
    label: "＋ Add a service",
    fields: { n: "name", kind: "kind", open: "opensAt", cap: "capacity" },
  },

  /* ------------------------------------------------------- security */

  s_deliveries: {
    resource: "deliveries",
    label: "＋ Log a delivery",
    fields: { who: "courier", what: "what", forWhom: "forWhom" },
  },

  s_guards: {
    resource: "shifts",
    label: "＋ Assign shift",
    fields: { n: "guard", post: "post", shift: "shift" },
  },

  s_incidents: {
    resource: "incidents",
    label: "＋ Report incident",
    fields: { t: "title", p: "place", sev: "severity" },
  },

  s_passes: {
    resource: "passes",
    label: "＋ Issue a pass",
    fields: {
      who: "holder", kind: "kind",
      /* "Mondays, 08:00–12:00" — a rule, not a date. It is text on purpose
         and validFrom/validTo stay for passes issued with real dates. */
      valid: "valid",            // NEW
      forWhom: "forWhom",
    },
  },

  s_patrols: {
    resource: "patrols",
    label: "＋ Schedule a round",
    fields: { route: "route", guard: "guard", due: "dueAt", points: "points" },
  },

  s_residents: {
    resource: "parties",
    label: "＋ Add a resident",
    fields: {
      n: "name",
      unit: "unit",              // NEW — which unit they live in
      phone: "phone", since: "since",
      cars: "cars",              // NEW — how many vehicles they keep
    },
  },

  s_vehicles: {
    resource: "vehicles",
    label: "＋ Register a vehicle",
    fields: { plate: "plate", make: "make", owner: "ownerName", kind: "kind", bay: "bay" },
  },

  s_visitors: {
    resource: "visits",
    label: "＋ Register visitor",
    fields: { n: "visitor", cat: "category", host: "hostName", veh: "vehicle" },
  },
};

/* ====================================================================== *
 * ENUM WORDING.
 *
 * The console writes enum values the way a person reads them — "Needs
 * work", "Short stay", "One visit". clean() already turns those into
 * NEEDS_WORK, SHORT_STAY and ONE_VISIT by upper-casing and replacing
 * spaces, which covers almost all of them.
 *
 * These are the ones that rule does not reach, and every one of them would
 * otherwise be a 400 on a value the console offers in its own dropdown.
 * ====================================================================== */

export const ENUM_WORDS = {
  /* Bedroom counts. "1 bed" upper-cases to "1_BED", which is not a valid
     identifier and so is not what the enum is called. */
  "1 BED": "ONE_BED",
  "2 BED": "TWO_BED",
  "3 BED": "THREE_BED",
  "4 BED": "FOUR_BED",

  /* The lead pipeline. The console's first stage is "Enquiry"; the same
     stage in the model is NEW. */
  ENQUIRY: "NEW",

  /* `sales` offers Reserved between Offer and Closed; `ag_leads` does not.
     Both are the same pipeline, so both words have to land somewhere. */
  "WALK-IN": "WALK_IN",
};

/** One place to ask: what is this console field really called? */
export function backendField(screen, consoleField) {
  const form = CONSOLE_FORMS[screen];
  if (!form) return null;
  return form.fields[consoleField] || null;
}

/** Every screen that writes to a given resource. */
export function screensFor(resource) {
  return Object.entries(CONSOLE_FORMS)
    .filter(([, f]) => f.resource === resource)
    .map(([screen]) => screen);
}

/**
 * The alias table a resource needs, assembled from every screen that
 * writes to it. Built once at import; registry.js hands it to clean().
 */
export function aliasesFor(resource) {
  const out = {};
  for (const [, form] of Object.entries(CONSOLE_FORMS)) {
    if (form.resource !== resource) continue;
    for (const [from, to] of Object.entries(form.fields)) {
      if (from === to) continue;
      /*
       * A COLLISION HERE WOULD BE SILENT AND AWFUL. Two screens writing to
       * one resource must not disagree about what a short name means — `n`
       * is `title` on ag_listings and `title` on pm_market, which is fine,
       * but if one of them meant `name` the second screen would write to
       * the wrong column with no error anywhere.
       */
      if (out[from] && out[from] !== to) {
        throw new Error(
          `console-map: "${from}" means both "${out[from]}" and "${to}" for ` +
          `resource "${resource}". Two screens disagree, and the second one ` +
          `would write to the wrong column without any error.`);
      }
      out[from] = to;
    }
  }
  return out;
}

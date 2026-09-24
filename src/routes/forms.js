/* ====================================================================== *
 * WHAT A "＋ ADD" BUTTON SHOULD ASK FOR.
 *
 * Thirty buttons in the property console said "＋ Add property", "＋ Add a
 * unit", "＋ Raise request" — and did nothing at all. There was no form
 * anywhere in the build: a customer could see every record the API could
 * create and had no way to create one.
 *
 * The console could not have drawn those forms even if it wanted to. It knows
 * the shape of a row it has been SENT; it does not know which fields a new one
 * needs, which are required, or what an enum will accept. Three files hold
 * those answers between them:
 *
 *   console-map.js  which resource a screen writes to, and what the console
 *                   calls each field
 *   registry.js     the field's kind and whether it is required
 *   Prisma          the values an enum will actually take
 *
 * So this assembles one answer out of the three and serves it. The alternative
 * was a copy of all three in the frontend, which drifts the first time
 * somebody adds a column — and a form that quietly drops a value is worse
 * than a button that does nothing, because the customer believes it worked.
 * ====================================================================== */

import { Router } from "express";
import pkg from "@prisma/client";
import { RESOURCES } from "../domain/registry.js";
import { CONSOLE_FORMS } from "../domain/console-map.js";
import { requireSession, requireOrganization } from "../http/session.ts";

export const formRoutes = Router();

/** The values an enum takes, from the generated client rather than a copy. */
function enumValues(name) {
  const e = pkg[name] || (pkg.Prisma && pkg.Prisma[name]);
  return e && typeof e === "object" ? Object.keys(e) : null;
}

/**
 * "tenantName" -> "Tenant name", "siteId" -> "Property", "sqm" -> "Sqm".
 *
 * The console's own word where console-map gives one, because the customer
 * reads "Rent", not "monthlyRentMinor".
 */
function humanise(key) {
  const SPECIAL = {
    siteId: "Property", buildingId: "Building", unitId: "Unit",
    partyId: "Contact", tenantId: "Tenant", investorId: "Investor",
    orgId: "Company", sqm: "Size (m²)", ref: "Reference",
    /* Whole words that are still not the word a customer uses. */
    unitCount: "Number of units", builtYear: "Year built",
    startsOn: "Starts", endsOn: "Ends", dueOn: "Due",
    expiresAt: "Expires", receivedAt: "Received",
    tenantName: "Tenant", ownerName: "Owner", guestName: "Guest",
    buildingName: "Building", unitRef: "Unit", assignee: "Assigned to",
    about: "About", detail: "Details", note: "Notes",
  };
  if (SPECIAL[key]) return SPECIAL[key];
  const words = String(key)
    .replace(/Id$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * GET /console/forms
 *
 * Every screen that can create something, and exactly what to ask for.
 * Behind a session because it describes this service's shape — not secret,
 * but not a thing to hand out to anyone who asks either.
 */
formRoutes.get("/console/forms",
  requireSession(), requireOrganization(),
  (_req, res) => {
    const out = {};

    for (const [screen, spec] of Object.entries(CONSOLE_FORMS)) {
      const resource = RESOURCES[spec.resource];
      if (!resource) continue;                    /* a screen with no resource */

      const required = new Set(resource.required || []);
      const fields = [];

      for (const [consoleName, backendName] of Object.entries(spec.fields || {})) {
        const kind = resource.fields[backendName];
        /*
         * A field the console shows that the resource cannot accept is not
         * put on the form. It would save, return 200, and drop the value —
         * which is the failure this whole file exists to avoid.
         */
        if (!kind) continue;

        const field = {
          name: backendName,
          /*
           * The BACKEND name, always.
           *
           * console-map keys are the console's own abbreviations — `n`, `t`,
           * `b`, `pr` — because they name the columns of a table that is
           * already headed. On a form they read "N", "T", "Pr", which asks a
           * person to fill in something nobody can identify. The service's
           * own names are whole words and become whole labels: "Name",
           * "Title", "Priority".
           */
          label: humanise(backendName),
          kind,
          required: required.has(backendName),
        };
        if (kind.startsWith("enum:")) field.options = enumValues(kind.slice(5)) || [];
        if (kind.startsWith("id:")) field.lookup = kind.slice(3);   /* which list to pick from */
        fields.push(field);
      }

      /*
       * Anything REQUIRED that the console's map did not mention. Without
       * this the form omits it, the POST is refused, and the person is told
       * off for a field they were never shown.
       */
      for (const name of required) {
        if (fields.some((f) => f.name === name)) continue;
        const kind = resource.fields[name];
        if (!kind) continue;
        const field = { name, label: humanise(name), kind, required: true };
        if (kind.startsWith("enum:")) field.options = enumValues(kind.slice(5)) || [];
        if (kind.startsWith("id:")) field.lookup = kind.slice(3);
        fields.unshift(field);                    /* required first */
      }

      out[screen] = {
        resource: spec.resource,
        label: spec.label || "＋ Add",
        product: resource.product || null,
        area: resource.area,
        fields,
      };
    }

    res.set("Cache-Control", "private, max-age=300");
    res.json({ forms: out });
  });

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
import { readFileSync } from "node:fs";
import pkg from "@prisma/client";
import { RESOURCES } from "../domain/registry.ts";
import { whyNotArea } from "../domain/access.ts";
import { CONSOLE_FORMS } from "../domain/console-map.ts";
import { requireSession, requireOrganization } from "../http/session.ts";

export const formRoutes = Router();

/**
 * The values an enum takes, from the generated client rather than a copy.
 *
 * Read through a Record index rather than the module's own type: the name
 * arrives as a string off a field kind ("enum:LeaseStatus"), so there is
 * nothing at compile time to key the module's shape by.
 */
function enumValues(name: string): string[] | null {
  const bag = pkg as unknown as Record<string, unknown>;
  const nested = bag["Prisma"] as Record<string, unknown> | undefined;
  const e = bag[name] ?? nested?.[name];
  return e && typeof e === "object" ? Object.keys(e) : null;
}

/**
 * One field of a generated form, as the console renders it.
 *
 * `options` is present only for an enum and `lookup` only for a reference —
 * which is why both are optional rather than empty defaults: a blank select
 * and a select the form has not decided about yet look the same on screen.
 */
interface FormField {
  readonly name: string;
  readonly label: string;
  readonly kind: string;
  readonly required: boolean;
  options?: string[];
  lookup?: string;
  /**
   * WHAT THE DATABASE WILL WRITE IF THIS IS LEFT BLANK.
   *
   * Only for an optional enum whose column carries a default, and only so the
   * console can SAY it. Leaving Kind blank on a property filed a Dubai office
   * tower as RESIDENTIAL; leaving it blank on a unit files a shop as a
   * one-bedroom flat. Neither is a lie the service tells — the column has
   * always had a default and always will — but a form that shows "—" where
   * the answer is "Residential" lets somebody agree to something they were
   * never asked.
   */
  fallback?: string;
  /** What the field means, where its name is not enough. */
  hint?: string;
}

/**
 * "tenantName" -> "Tenant name", "siteId" -> "Property", "sqm" -> "Sqm".
 *
 * The console's own word where console-map gives one, because the customer
 * reads "Rent", not "monthlyRentMinor".
 */
/**
 * The @default on an enum column, read from the schema rather than kept here.
 *
 * A second copy of 121 defaults would be wrong within a week. This is the
 * same file Prisma generates from, so the two cannot disagree.
 */
const SCHEMA_DEFAULTS: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  try {
    const text = readFileSync(
      new URL("../../prisma/schema.prisma", import.meta.url), "utf8");
    for (const m of text.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      for (const f of m[2]!.matchAll(/^\s+(\w+)\s+(\w+)\s+@default\((\w+)\)/gm)) {
        out[`${m[1]}.${f[1]}`] = f[3]!;
      }
    }
  } catch { /* packaged without the schema: the forms simply say less */ }
  return out;
})();

function humanise(key: string): string {
  const SPECIAL: Readonly<Record<string, string>> = {
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
  (req, res) => {
    /* One entry per console screen that can create something. */
    const out: Record<string, {
      resource: string;
      label: string;
      product: string | null;
      area: string;
      fields: FormField[];
    }> = {};

    for (const [screen, spec] of Object.entries(CONSOLE_FORMS)) {
      const resource = RESOURCES[spec.resource];
      if (!resource) continue;                    /* a screen with no resource */

      /*
       * A FORM THIS PERSON MAY NOT SUBMIT IS NOT A FORM.
       *
       * The console draws its ＋ buttons from this answer, so a form listed
       * here for somebody who cannot create the record is a button that opens,
       * asks for eight fields, and is refused on submit.
       *
       * Fifteen of those existed: an engineer was offered ＋ on buildings,
       * units, meetings, tasks, RFIs, inspections, defects, the site diary
       * and assets — nine screens whose area they may only read — and a
       * finance user was offered one on documents.
       *
       * Checked with the same whyNotArea() every create goes through, so the
       * button and the request cannot disagree. The screen itself still
       * renders: a role that may read these records should go on reading
       * them, and what goes away is only the offer to add one.
       */
      if (whyNotArea(req.actor, resource.area, "create", resource.area)) continue;

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
        } as FormField;
        const hint = spec.hints && spec.hints[backendName];
        if (hint) field.hint = hint;
        if (kind.startsWith("enum:")) {
          field.options = enumValues(kind.slice(5)) || [];
          /* Only when it is optional — a required field has no blank to
             explain, and saying "or else Residential" beside one somebody
             must answer is noise. */
          /* The model is capitalised in the schema and lower-camel in the
             registry — "site" is Prisma's `Site`. */
          const model = String(resource.model).charAt(0).toUpperCase()
                      + String(resource.model).slice(1);
          const dflt = SCHEMA_DEFAULTS[`${model}.${backendName}`];
          if (dflt && !field.required) field.fallback = dflt;
        }
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
        const field: FormField = { name, label: humanise(name), kind, required: true };
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

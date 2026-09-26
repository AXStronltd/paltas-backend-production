/* ====================================================================== *
 * THE REGISTRY AND THE SCHEMA, KEPT HONEST ABOUT EACH OTHER.
 *
 * registry.js says which fields a request may write. schema.prisma says
 * which columns exist. When they disagree the failure is silent in the worst
 * possible direction:
 *
 *   - a field in the registry that is NOT in the schema → every create
 *     against that resource throws a Prisma "Unknown argument" at run time,
 *     500, in production, on the first customer who fills the form in.
 *
 *   - a field in the schema that IS NOT in the registry → the form saves and
 *     the value is silently dropped. Nobody sees an error. The customer sees
 *     their note disappear and concludes the product loses data.
 *
 * The second is worse, and neither is catchable by reading. So both
 * directions are checked here, and the fields that are deliberately not
 * writable are named with the reason they are not.
 * ====================================================================== */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RESOURCES } from "../src/domain/registry.ts";
import { AREAS, ROLE_AREAS, LEVELS, allows, levelFor, whyNotArea } from "../src/domain/access.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(join(HERE, "..", "prisma", "schema.prisma"), "utf8");

const uncomment = (t: string): string =>
  t.replace(/^\s*\/\/.*$/gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const MODELS = new Map<string, string>(
  [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
    .map((m) => [String(m[1]), uncomment(String(m[2]))] as const)
);
const ENUMS = new Map<string, string[]>(
  [...schema.matchAll(/^enum (\w+) \{([\s\S]*?)\}/gm)]
    .map((m) => [String(m[1]), uncomment(String(m[2])).split(/\s+/).filter(Boolean)] as const)
);

/** One column, as this file reads it out of schema.prisma. */
interface Column {
  readonly type: string;
  readonly list: boolean;
  readonly optional: boolean;
  /** Everything after the type — the attributes. */
  readonly rest: string;
}

function fieldsOf(model: string): Map<string, Column> {
  const body = MODELS.get(model);
  const out = new Map<string, Column>();
  if (!body) return out;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("@@")) continue;
    const m = line.match(/^(\w+)\s+(\w+)(\[\]|\?)?\s*(.*)$/);
    if (!m) continue;
    out.set(String(m[1]), {
      type: String(m[2]), list: m[3] === "[]", optional: m[3] === "?",
      rest: m[4] || "",
    });
  }
  return out;
}

/** `site` → `Site`. */
const modelName = (accessor: string): string =>
  accessor.charAt(0).toUpperCase() + accessor.slice(1);

/**
 * Columns no request may ever write, and why.
 *
 * Each of these would be a security or correctness hole if a caller could
 * set it, so they are excluded from the registry ON PURPOSE and named here
 * rather than left to look like an oversight.
 */
const NEVER_WRITABLE = {
  id: "assigned by the database",
  orgId: "comes from the session, never from the request — that is the whole tenancy rule",
  userId: "the bridge from a company's record of a person to their login. Set when " +
          "somebody proves they are that party by signing in; a caller who could " +
          "send it could claim to be anybody the company has on file",
  ref: "allocated per company by the framework; a caller choosing one could collide or impersonate",
  code: "same as ref — a pass code is allocated, never chosen by the person it admits",
  createdAt: "set once, by the database",
  updatedAt: "set by Prisma on every write",
  closedAt: "set by the status change that closes it, not sent alongside it",
  providerRef: "the processor's own id for the money — written ONLY by the " +
               "verified Stripe webhook. A caller who could send it could file a " +
               "payment that never happened as one Stripe had confirmed, which is " +
               "the difference between a claim and a receipt",
  reconciledAt: "written ONLY by the reconciliation path, when a bank statement " +
                "line proves the money arrived. A caller who could send it could " +
                "mark their own payment as confirmed by the bank without a bank " +
                "line existing — which is the entire point of reconciling",
  voided: "a payment is voided through its own endpoint, with a reason",
  voidReason: "written by the void endpoint",
  voidedAt: "written by the void endpoint",
  closed: "a folio is closed by closing it",
  total: "computed from the invoice lines; a caller who can send a total can send zero",
  paid: "computed from the payments; same reason",
  net: "gross minus fees — a third number that must follow from the other two",
};

/*
 * PER-RESOURCE exemptions, for columns that are writable SOMEWHERE but not
 * through this resource. NEVER_WRITABLE above is keyed by column name and so
 * applies everywhere — adding `kind` to it would stop catching a genuinely
 * forgotten `kind` on some other resource, which is the bug that list exists
 * to find.
 */
const NOT_WRITABLE_HERE = {
  /*
   * THE OPERATING LOOP IS MOVED BY ACTS, NOT BY FIELDS.
   *
   * A decision whose status is a column can be edited from OPEN to
   * IMPLEMENTED with nothing recording who approved it — which is the single
   * thing a decision register exists to prevent. A task marked done by PATCH
   * leaves `completedAt` empty, so "finished late" and "finished on time"
   * collapse into the same fact.
   */
  meetings: {
    status: "moved by POST /meetings/:id/{hold,cancel} — holding a meeting also " +
            "records who actually attended",
    minutes: "written by POST /meetings/:id/minutes, which is also where they are issued",
    minutesSentAt: "stamped when the minutes are issued, never claimed",
  },

  decisions: {
    status: "moved by POST /decisions/:id/status, which enforces that a register " +
            "only goes forwards, requires an owner before APPROVED and a reason " +
            "before REJECTED, and appends to the history",
    decidedOn: "stamped when it is approved or rejected",
  },

  tasks: {
    status: "moved by POST /tasks/:id/{done,reopen} — finishing a parent is " +
            "refused while its subtasks are open",
    completedAt: "stamped when the task is finished, and cleared when it is " +
                 "reopened, so a reopened task is not also complete",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  /*
   * A DISPATCH'S STATE IS THE RECORD OF WHAT A CARRIER DID.
   *
   * It is the one table in this service where a writable column would make
   * the whole thing worthless: a PATCH that could set DELIVERED turns an
   * outbox from evidence into a claim, and the question it exists to answer
   * — "did you tell them?" — stops having an answer.
   *
   * SUBMITTED is written by POST /dispatches/:id/send, when a provider
   * accepts it. DELIVERED is written by the provider's own callback in
   * routes/comms-webhook.js and by nothing else anywhere in this service,
   * because nothing else knows.
   */
  dispatches: {
    status: "written by POST /dispatches/:id/{send,cancel} and by the provider's " +
            "delivery callback. DELIVERED in particular is only ever the " +
            "carrier's word — this service does not know and may not say",
    provider: "the name of whoever accepted it, recorded when they did",
    submittedAt: "stamped when a provider took it",
    deliveredAt: "stamped ONLY by a verified provider callback",
    failedAt: "stamped when a provider refused it",
    error: "the provider's own sentence about why. Ours would be a guess",
    campaignId: "set by POST /campaigns/:id/send. A caller who could file a " +
                "message into somebody else's campaign could make a batch " +
                "report numbers that never happened",
    conversationMessageId: "set when an outbound CRM message is actually sent; " +
                           "it is the link between a thread and a delivery, not " +
                           "a field to fill in",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  /*
   * HANDING IT OVER, AND WHO WAS ON IT.
   */
  handovers: {
    status: "moved by POST /handovers/:id/{complete,refuse}. Completing reads " +
            "the DEFECT REGISTER and refuses while a critical or major defect " +
            "is open against the unit — that is the moment a snagging list " +
            "either meant something or did not",
    startedOn: "stamped when it begins",
    completedOn: "stamped when it completes, which is the move that checks",
    handedBy: "who handed over",
    receivedBy: "who took it. Required, because without it there is no record " +
                "that anybody actually received the keys",
    refusedReason: "why the buyer would not take it — what has to be put right " +
                   "before anybody drives over again",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  "project-team": {
    leftOn: "leaving is a DATE, not a deletion, and it is stamped by POST " +
            "/projects/:id/team/:memberId/leave — which also says what the " +
            "person was carrying, because tasks do not leave with people",
  },

  /*
   * BEFORE ANYBODY BUILDS. Land, feasibility, drawings, permits.
   */
  acquisitions: {
    status: "moved by POST /acquisitions/:id/status, which refuses to COMPLETE " +
            "while a due-diligence item is unsettled. Buying land on an " +
            "unresolved title search is the single most expensive mistake " +
            "available in this business, and it is always made by ticking it off",
    offeredPrice: "written when an offer is made, with its date",
    agreedPrice: "written when a price is agreed, with the seller's name and the date",
    offeredOn: "stamped by the status route",
    agreedOn: "stamped by the status route",
    completedOn: "stamped when it completes, which is the move that checks the searches",
    abandonedReason: "why a deal died — required by the route, and the most useful " +
                     "column in the table by the third one that dies the same way",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  feasibilities: {
    status: "moved by POST /feasibilities/:id/{decide,supersede}. A scheme that " +
            "does not work on its own numbers may still be approved — companies " +
            "take strategic losses — but never silently",
    decidedBy: "who approved it",
    decidedOn: "stamped when somebody decides",
    decidedNote: "the reasoning, required on a rejection and on approving a loss",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  drawings: {
    status: "moved by POST /drawings/:id/{issue,revise}. Issuing a revision " +
            "supersedes the previous rather than overwriting it — somebody " +
            "built to revision B",
    issuedOn: "stamped when it goes out",
    issuedBy: "who issued it",
    previousId: "the chain between revisions, written when the next one is opened",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  permits: {
    status: "moved by POST /permits/:id/status. EXPIRED in particular is never " +
            "typed: a consent that lapsed is expired whatever the column says, " +
            "and that is worked out on the way out",
    reference: "the AUTHORITY'S own number, required before a permit may be " +
               "recorded as approved. It is the only handle that works when " +
               "ringing them up, and a caller who could type one could invent it",
    submittedOn: "stamped when the application goes in",
    decidedOn: "stamped when the authority decides",
    conditions: "what was granted subject to, recorded with the grant",
    refusedReason: "the authority's own reason. It is what an appeal is built on",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  /*
   * PROCUREMENT. Two rules run through all of it: an order's figures come
   * from its LINES, and money lives in the ledger rather than here.
   */
  rfqs: {
    status: "moved by POST /rfqs/:id/{issue,award}. Awarding also declines every " +
            "other quote and opens the purchase order, in one transaction",
    issuedOn: "stamped when it goes out",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  quotes: {
    status: "written by POST /rfqs/:id/award, which awards one and declines the rest. " +
            "A writable one would let two vendors both be the winner",
    decidedNote: "why this quote and not the others — required by the award route, " +
                 "because an award with no reasoning is the one somebody asks about later",
  },

  "purchase-orders": {
    status: "moved by POST /purchase-orders/:id/{issue,receive,invoice,cancel}",
    subtotal: "COMPUTED FROM THE LINES. A caller who can send a total can send one " +
              "that does not match what was ordered, and the order becomes two " +
              "documents disagreeing with each other",
    tax: "sent when the order is issued, and folded into the total there",
    total: "subtotal plus tax. Same reason as subtotal",
    rfqId: "set when a request is awarded",
    quoteId: "set when a request is awarded, and unique — an order that could be " +
             "pointed at a second quote could be bought twice",
    issuedOn: "stamped when the company commits",
    closedOn: "stamped when it is invoiced or cancelled",
    expenseId: "THE BRIDGE TO THE BOOKS, written when the invoice is recorded. A " +
               "caller who could set it could point an order at somebody else's " +
               "expense, or at one that does not exist, and the cost of a thing " +
               "would become unanswerable",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  "goods-receipts": {
    receivedOn: "when the delivery actually arrived, sent to the receive route " +
                "along with what was in it",
  },

  "change-orders": {
    status: "moved by POST /change-orders/:id/{submit,decide,withdraw}. Approving " +
            "one changes what a contract is WORTH without touching what it was " +
            "signed at — both figures survive, which is the only reason a " +
            "variation register is worth keeping",
    submittedOn: "stamped when it goes for a decision",
    decidedOn: "stamped when somebody decides",
    decidedBy: "who approved it. An approved variation with nobody's name on it " +
               "is the one that turns out to have been nobody's decision",
    decidedNote: "the reasoning, required on a rejection",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  /*
   * THE FIVE SITE REGISTERS. Each status below is moved by routes/site.js,
   * because each move is a rule a column cannot hold.
   */
  rfis: {
    status: "moved by POST /rfis/:id/{answer,close,void}. An RFI register whose " +
            "questions can be closed unanswered is a register that empties itself",
    answer: "written by the answer route, with a name and a date beside it — an " +
            "answer from nobody on no date is indistinguishable from no answer",
    answeredOn: "stamped when it is answered",
    answeredBy: "stamped when it is answered",
    costImpact: "sent WITH the answer, because it is the answer that has a " +
                "consequence. An RFI whose impact can be edited afterwards is " +
                "one where the consequence drifts from the reply that caused it",
    timeImpact: "same as costImpact — part of the answer, not a field beside it",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  submittals: {
    status: "moved by POST /submittals/:id/{submit,review}. Revise-and-resubmit " +
            "OPENS THE NEXT REVISION rather than editing this one — somebody " +
            "built to rev 1 and will need to know what rev 1 said",
    revision: "set when a review sends one back. A caller choosing its own could " +
              "file rev 5 before rev 2",
    previousId: "the chain between revisions, written when the next one is opened",
    submittedOn: "stamped when it is submitted",
    reviewedOn: "stamped when it is reviewed",
    reviewerName: "the person who actually looked at it",
    comments: "the reviewer's own words. A submittal sent back with no comments " +
              "is a contractor guessing",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  inspections: {
    status: "moved by POST /inspections/:id/record, which raises the defects it " +
            "found in the same transaction. An inspection passed with defects " +
            "that produced no defects is an inspection that passed",
    inspectedOn: "stamped when it is recorded",
    notes: "written when the result is",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  defects: {
    status: "moved by POST /defects/:id/{assign,fixed,verify,reject}",
    fixedByName: "who said it was done",
    fixedOn: "stamped when somebody said so",
    verifiedByName: "who AGREED — and it may not be the same person. A defect " +
                    "signed off by whoever caused it is not signed off",
    verifiedOn: "stamped when it was checked",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  "site-diary": {
    lockedAt: "a diary entry is fixed once the day it records is over. If a " +
              "caller could clear this, the lock would be a suggestion — and a " +
              "contemporaneous record that can be rewritten months later is " +
              "worth nothing in the dispute it exists for",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },

  campaigns: {
    status: "written by POST /campaigns/:id/{send,cancel}. PARTIAL in " +
            "particular is computed from what actually happened to each " +
            "message, and a writable one would let a batch that half failed " +
            "be recorded as SENT",
    audience: "written when the campaign is sent, describing who it ACTUALLY " +
              "went to. Editable, it would describe who somebody wishes it had",
    submitted: "counted from the messages",
    delivered: "counted from the messages, which are counted from callbacks",
    failed: "counted from the messages",
    sentAt: "stamped when it went",
    createdById: "the session's own user, not a field a caller supplies",
    createdByName: "taken from the session at create time",
  },


  /*
   * AN OFFER IS MOVED BY AN ACT, NEVER BY A FIELD.
   *
   * Every column below is set by routes/offers.js — send, view, accept,
   * reject — because each move has consequences beyond the row. Accepting
   * reserves the unit, opens a reservation and expires every rival offer on
   * that flat, all in one transaction.
   *
   * A writable `status` is that state machine with the door left open: a
   * caller could PATCH an offer to ACCEPTED and leave the unit on the market,
   * no reservation anywhere, and two buyers each still holding a live offer.
   * The sale would look complete on one screen and have happened on none.
   */
  offers: {
    status: "moved by POST /offers/:id/{send,view,accept,reject} — accepting " +
            "also reserves the unit and opens a reservation, and a settable " +
            "field would do the first without the rest",
    sentAt: "stamped when the offer is actually sent, not claimed by the caller",
    viewedAt: "stamped the first time the buyer opens it, and never overwritten",
    decidedAt: "stamped when it is accepted, rejected or expires",
    declineReason: "given to POST /offers/:id/reject, which requires one",
  },

  contracts: {
    offerId: "written by POST /offers/:id/accept, which is the only thing that " +
             "turns an offer into a reservation — a settable link would let a " +
             "reservation claim an offer nobody accepted",
  },


  /*
   * A DOCUMENT'S FILE IS DESCRIBED BY STORAGE, NOT BY THE UPLOADER.
   *
   * All four were writable, so any caller could PATCH a document to claim any
   * key, any size and any type. Harmless while nothing could download a file;
   * the moment a download exists it is not, because a caller could point their
   * own row at another company's key and ask PALTAS to sign a link to it.
   *
   * The server writes them from what the storage provider actually reports
   * when the upload is confirmed — see src/domain/storage.js head().
   */
  documents: {
    storageKey: "built by the server from the owning organization, at " +
                "POST /documents/:id/upload-url — a caller that can name the " +
                "key can name another company's key",
    bytes: "read back from storage after the upload, never claimed by the uploader",
    mimeType: "read back from storage after the upload, never claimed by the uploader",
    checksum: "read back from storage after the upload — its whole purpose is " +
              "detecting a file that is not what was sent, which it cannot do " +
              "if the sender supplies it",
  },

  "guest-requests": {
    reservationId: "the guest's own stay, resolved from their session at POST /guest/requests",
    partyId: "which guest they are, resolved from Party.userId — never sent",
    kind: "the guest chose it; staff answering must not be able to change what was asked",
    detail: "the guest's own words",
    note: "the guest's own words",
  },

  /* ------------------------------------------------ TOKENISED INVESTMENT */

  distributions: {
    offeringId: "set when a distribution is declared against an offering, at " +
                "POST /investments/offerings/:id/distributions — moving an " +
                "existing distribution to a different offering would rewrite " +
                "who was paid for what",
  },

  /*
   * AN ORDER IS A CONSEQUENCE, NOT A FORM.
   *
   * Every column here is decided by something other than the person looking at
   * it: the offering it was placed against, the investor who placed it, what
   * the compliance check said, and whether a payment actually arrived. A
   * writable `status` would be a way to record money nobody received, and a
   * writable `amount` a way to change what somebody committed after the fact.
   */
  "investment-orders": {
    offeringId: "the offering it was placed against, from the URL at POST /investments/offerings/:id/orders",
    investorId: "who placed it, resolved server-side — never sent",
    units: "what was asked for when it was placed; changing it later rewrites the commitment",
    amount: "units x the offering's unit price, computed, never typed",
    currency: "the offering's currency; an order in a different one is not the same order",
    status: "the result of a compliance decision and a settled payment. See the " +
            "actions in src/routes/investments.js — allocate, cancel, refuse",
    invoiceId: "the invoice raised for it, by the service that raised it",
    sandbox: "inherited from the offering, so a production query cannot include a test order",
    placedAt: "when it was placed",
    allocatedAt: "stamped when units are allocated",
    settledAt: "stamped when the invoice is paid in full",
    cancelledAt: "stamped when cancelled",
  },

  /*
   * AND A HOLDING IS WHAT A PROVIDER SAID.
   *
   * Nothing in this table is PALTAS's opinion. Every column is a value a
   * tokenisation provider or custodian returned, which is why the resource
   * declares no writable fields at all.
   */
  "token-holdings": {
    offeringId: "from the provider's report",
    investorId: "from the provider's report",
    orderId: "the order the provider was asked to fulfil",
    units: "WHAT THE PROVIDER REPORTED. A writable units column is how a " +
           "platform tells an investor they own something that does not exist",
    provider: "which provider reported it",
    providerRef: "the provider's own identifier for the position — authoritative",
    custodian: "from the provider's report",
    custodianRef: "from the provider's report",
    chain: "from the provider's report",
    contractRef: "from the provider's report",
    walletRef: "from the provider's report",
    asAt: "when the provider said it, not when we wrote it down",
    sandbox: "inherited from the offering",
  },
};

/* ================================================================ */

test("the generated client and schema.prisma name the same models", async () => {
  /*
   * THIS REPLACED "every resource names a model that exists".
   *
   * That test walked the registry asserting each `model` is in schema.prisma.
   * The compiler does it now, and better — `model: ModelKey` is derived from
   * Prisma's own generated names, so a typo does not reach a test at all:
   *
   *     Type '"handovers"' is not assignable to type '"user" | "session" | …'
   *     Did you mean '"handover"'?
   *
   * But the compiler checks against the GENERATED CLIENT, and the old test
   * checked against the SCHEMA. Those are the same thing only while somebody
   * has run `prisma generate` — and a stale client would make every type in
   * registry-types.ts quietly check the wrong list.
   *
   * So this is what is actually left to prove: the two agree. It is a
   * stronger guarantee than the test it replaces, and it is the one the types
   * now depend on.
   */
  const prismaPkg = await import("@prisma/client");
  const generated = new Set(Object.keys(prismaPkg.Prisma.ModelName));

  /* MODELS is a Map of name -> body, so its keys are the names. Spreading the
     Map itself gives [key, value] pairs, which compare equal to nothing. */
  const declared = [...MODELS.keys()];
  const missing = declared.filter((m) => !generated.has(m));
  const extra = [...generated].filter((m) => !MODELS.has(m));

  assert.deepEqual(missing, [],
    "schema.prisma declares models the generated client has never heard of. " +
    "Run `npx prisma generate` — until you do, every `model:` and `id:` in the " +
    "registry is being checked against a stale list.");
  assert.deepEqual(extra, [],
    "the generated client carries models schema.prisma no longer has. Run " +
    "`npx prisma generate`.");

  /* And it really compared something. */
  assert.ok(generated.size > 100, `only ${generated.size} models in the client`);
});

test("every field a request may write is a real column", () => {
  const problems = [];
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const cols = fieldsOf(modelName(r.model));
    for (const [name, kind] of Object.entries(r.fields)) {
      const col = cols.get(name);
      if (!col) {
        problems.push(`${slug}.${name} — in the registry, NOT in ${modelName(r.model)}. ` +
                      `Every create against this resource would throw.`);
        continue;
      }
      /* And the kind has to match, or the value is coerced into a column that
         cannot hold it. */
      /* Registry kind -> the Prisma type a column must have to hold it.
         A reference and an enum are worked out after, not listed. */
      const SCALAR: Record<string, string> = {
        string: "String", text: "String", int: "Int",
        /*
         * money is BigInt, not Int, and the difference is not cosmetic.
         *
         * Prisma's Int is PostgreSQL INT4, which caps at 2,147,483,647 minor
         * units — KES 21,474,836. A Nairobi valuation of KES 960,000,000 is
         * 96 billion minor units, so the write did not round or truncate: it
         * was REFUSED, and the API answered 500. See the note in
         * prisma/migrations/…_money_bigint.
         *
         * If this ever reads "Int" again, every property worth more than
         * about twenty-one million shillings becomes unsaveable.
         */
        money: "BigInt",
        /*
         * The same column, with the sign rule turned off in input.js.
         *
         * It exists for amounts that are a CHANGE to a figure rather than the
         * figure itself: a variation that omits a balcony reduces a contract,
         * and forcing it positive would record a credit as a charge. A
         * separate kind rather than a flag, so every use of it is visible
         * here and `money` stays strict by default.
         */
        "signed-money": "BigInt",
        float: "Float", bool: "Boolean", date: "DateTime", json: "Json",
      };
      const want = SCALAR[kind] ?? (kind.startsWith("enum:") ? kind.slice(5)
                : kind.startsWith("id:") ? "String" : null);
      assert.ok(want, `${slug}.${name} has unknown kind "${kind}"`);
      if (col.type !== want) {
        problems.push(`${slug}.${name} — registry says ${kind} (${want}), schema says ${col.type}`);
      }
      if (kind.startsWith("enum:")) {
        assert.ok(ENUMS.has(kind.slice(5)), `${slug}.${name} names enum ${kind.slice(5)}, which does not exist`);
      }
      if (kind.startsWith("id:")) {
        assert.ok(MODELS.has(modelName(kind.slice(3))),
          `${slug}.${name} points at model "${kind.slice(3)}", which does not exist`);
      }
    }
  }
  assert.deepEqual(problems, [], "registry.js and schema.prisma disagree:\n  " + problems.join("\n  "));
});

test("every column is either writable or deliberately not", () => {
  /*
   * THE SILENT ONE. A column the registry forgot is a form field that saves,
   * returns 200, and drops the value. The customer sees their note vanish and
   * concludes the product loses data — and there is no error anywhere to
   * find.
   */
  const problems = [];
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const cols = fieldsOf(modelName(r.model));
    for (const [name, col] of cols) {
      if (name in r.fields) continue;
      if (name in NEVER_WRITABLE) continue;
      if ((NOT_WRITABLE_HERE as Record<string, Record<string, unknown>>)[slug]?.[name]) continue;
      if (MODELS.has(col.type)) continue;              // a relation, written via its id
      problems.push(
        `${slug}: ${modelName(r.model)}.${name} (${col.type}) can be written by nothing. ` +
        `Add it to the resource's fields, or to NEVER_WRITABLE in this test with the reason.`);
    }
  }
  assert.deepEqual(problems, [], "Columns nothing can set:\n  " + problems.join("\n  "));
});

test("a resource that numbers its rows has somewhere to put the number", () => {
  for (const [slug, r] of Object.entries(RESOURCES)) {
    if (!r.numbered) continue;
    const col = r.numbered;
    const cols = fieldsOf(modelName(r.model));
    assert.ok(cols.has(col),
      `${slug} is numbered on "${col}" but ${modelName(r.model)} has no such column`);
    assert.ok(!(col in r.fields),
      `${slug} allocates its own ${col} AND lets a caller send one. Two sources for one ` +
      `number is how two companies' invoices come to share a reference.`);
    assert.ok(MODELS.get(modelName(r.model))?.includes(`@@unique([orgId, ${col}])`),
      `${slug} numbers its rows but ${modelName(r.model)} does not enforce ` +
      `@@unique([orgId, ${col}]) — so two requests racing can be handed the same ` +
      `number and the database will accept both`);
  }
});

test("every searchable field is a text column that exists", () => {
  /* `?q=` builds a `contains` filter. Pointed at a column that is not there,
     Prisma throws; pointed at an Int it throws differently. Both are a 500 on
     the search box, which is the feature people try first. */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    const cols = fieldsOf(modelName(r.model));
    for (const f of r.search || []) {
      const col = cols.get(f);
      assert.ok(col, `${slug} searches "${f}", which ${modelName(r.model)} does not have`);
      assert.equal(col.type, "String", `${slug} searches "${f}", which is a ${col.type}`);
    }
  }
});

test("every include asks for named columns, never a whole related row", () => {
  /*
   * `include: { tenant: true }` returns every column of the tenant — email,
   * phone, private note — inside a list that was only meant to show a name.
   * That is how personal data reaches a screen nobody audited, so it is
   * refused here rather than at review time.
   */
  for (const [slug, r] of Object.entries(RESOURCES)) {
    for (const [rel, spec] of Object.entries(r.include || {})) {
      if (rel === "lines") continue;          // a line table carries no personal data
      assert.ok(spec && typeof spec === "object" && "select" in spec,
        `${slug}.include.${rel} has no select — it would return every column of the ` +
        `related row, including any personal detail on it`);
    }
  }
});

test("every resource belongs to an area the access table knows", () => {
  for (const [slug, r] of Object.entries(RESOURCES)) {
    assert.ok(AREAS.includes(r.area), `resource "${slug}" is in area "${r.area}", which does not exist`);
  }
});

test("every area is reachable by somebody, and no role has a level that is not a level", () => {
  for (const [role, row] of Object.entries(ROLE_AREAS)) {
    for (const [area, level] of Object.entries(row)) {
      assert.ok((AREAS as readonly string[]).includes(area),
        `role ${role} names area "${area}", which does not exist`);
      assert.ok((LEVELS as readonly string[]).includes(String(level)),
        `role ${role} has level "${level}" in ${area}`);
    }
    for (const area of AREAS) {
      assert.ok(area in row, `role ${role} says nothing about "${area}" — silence is not a decision`);
    }
  }

  /* An area only OWNER can reach is an area the product does not really have. */
  for (const area of AREAS) {
    const who = Object.keys(ROLE_AREAS).filter((r) => ROLE_AREAS[r][area] !== "none");
    assert.ok(who.length >= 3,
      `only ${who.join(", ")} can reach "${area}" — check that is intended`);
  }
});

test("a guard may write the security log and delete none of it", () => {
  /*
   * The single most important row in the access table, so it is asserted
   * rather than left to be read. A guard who can delete a visit can delete
   * the record of the person they waved through.
   */
  const guard = { role: "GUARD" };
  assert.equal(levelFor(guard, "security"), "write");
  assert.ok(allows(guard, "security", "create"));
  assert.ok(allows(guard, "security", "update"));
  assert.ok(!allows(guard, "security", "delete"), "a guard can delete the security log");
  assert.ok(!allows(guard, "finance", "list"), "a guard can read the company's money");
  assert.ok(!allows(guard, "hotel", "list"));

  const why = whyNotArea(guard, "security", "delete", "visits");
  assert.ok(why, "a guard was allowed to delete the security log");
  assert.match(why, /not delete|only write/i);
  assert.ok(why.length > 40, "the refusal does not tell them what to do instead");
});

test("nobody outside the company's staff reaches a product at all", () => {
  for (const role of ["GUEST", "MARKETING", "COMPLIANCE", "PUBLISHER", "PROMO_CONTRIBUTOR"]) {
    for (const area of AREAS) {
      assert.equal(levelFor({ role }, area), "none",
        `${role} can reach ${area}. PALTAS staff review promotions; they do not read a ` +
        `customer's leases, and a guest is not staff at all.`);
    }
  }
  /* And an unknown role grants nothing rather than everything. */
  assert.equal(levelFor({ role: "SUPERUSER" }, "finance"), "none");
  assert.equal(levelFor(null, "finance"), "none");
});

test("finance can see everything and change only money", () => {
  const f = { role: "FINANCE" };
  assert.ok(allows(f, "finance", "delete"));
  assert.ok(allows(f, "property", "list"), "finance cannot read a lease it must invoice against");
  assert.ok(!allows(f, "property", "create"), "finance can write a lease");
  assert.ok(!allows(f, "security", "create"));
});

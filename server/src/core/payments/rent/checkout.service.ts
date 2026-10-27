import type { AppContext } from "../../../context.js";
import type { PortalScope } from "../../../products/property/shared/access.js";
import { agreementForUnit, balanceOf, invoiceRow } from "../../../products/property/shared/records.js";
import { fail } from "../../../http/errors.js";
import { rentAttemptService } from "./attempts.service.js";
import { assertRentMethod, eligibleRentMethods, RENT_METHODS, type RentMethod } from "./payment-methods.js";
import { rentMerchantService } from "./merchant.service.js";

/** Direct connected-account hosted checkout. Internal until payment-event posting and reconciliation acceptance pass.
 * It never changes subscription billing, creates a Stripe subscription or treats a browser return as payment.
 */
export function rentCheckoutService(ctx: AppContext) {
  const attempts = rentAttemptService(ctx),
    merchants = rentMerchantService(ctx, ctx.rentStripeClient);
  async function context(s: PortalScope, invoiceId: string, amountMinor: number) {
    const invoice = await invoiceRow(ctx.db, s.orgId, invoiceId);
    if (
      invoice.tenant_id !== s.contact.id ||
      !invoice.property_id ||
      (s.propertyIds && !s.propertyIds.includes(invoice.property_id))
    )
      throw fail.notFound("Invoice not found");
    if (!invoice.journal_id || amountMinor > balanceOf(invoice))
      throw fail.conflict("Review the issued invoice and current balance before paying");
    const agreement = invoice.unit_id ? await agreementForUnit(ctx.db, s.orgId, invoice.unit_id, s.today) : null;
    if (!agreement || agreement.owner_id !== invoice.owner_id)
      throw fail.conflict("Current collection authority for this invoice needs review; no payment was initiated");
    if (
      !(await ctx.db.row(
        "SELECT property_id FROM rent_collection_property_routes WHERE org_id=$1 AND property_id=$2 AND status='active'",
        [s.orgId, invoice.property_id],
      ))
    )
      throw fail.conflict("The company owner must authorise this property's collection account first");
    const verified = await merchants.collectionAccount(s);
    const list = await verified.stripe.paymentMethodConfigurations.list(
      { limit: 100 },
      { stripeAccount: verified.account.id },
    );
    const configuration = list.data.find((c) => c.active && c.is_default && c.livemode === (verified.mode === "live"));
    if (!configuration)
      throw fail.conflict(
        "The company's enabled Stripe payment methods could not be verified; no collection was started",
      );
    const providerAvailable = RENT_METHODS.filter((m) => configuration[m]?.available === true);
    const eligibility = {
      merchant: verified.account,
      currency: s.entitlement.org.currency,
      amountMinor,
      providerAvailable,
    };
    return { ...verified, invoice, eligibility, configuration };
  }
  return {
    async methods(s: PortalScope, invoiceId: string, amountMinor: number) {
      const c = await context(s, invoiceId, amountMinor);
      return {
        methods: eligibleRentMethods(c.eligibility),
        currency: c.eligibility.currency,
        amountMinor,
        testMode: c.mode === "test",
      };
    },
    async start(s: PortalScope, b: { invoiceId: string; amountMinor: number; method: RentMethod; requestKey: string }) {
      const c = await context(s, b.invoiceId, b.amountMinor);
      assertRentMethod(c.eligibility, b.method);
      const reserved = await attempts.reserve(s, b),
        prepared = await attempts.beginSubmission(s, reserved.id);
      if (!prepared.submit)
        throw fail.conflict("The previous collection needs reconciliation before another provider request can be made");
      const a = prepared.attempt,
        metadata = attempts.metadata(a);
      const back = new URL("/pm.html", ctx.config.signup.appBaseUrl);
      back.searchParams.set("org", s.orgId);
      back.hash = "mytenant";
      const success = new URL(back);
      success.searchParams.set("rent_collection", "return");
      const cancel = new URL(back);
      cancel.searchParams.set("rent_collection", "cancelled");
      let session;
      try {
        session = await c.stripe.checkout.sessions.create(
          {
            mode: "payment",
            client_reference_id: a.id,
            metadata,
            payment_intent_data: { metadata },
            allowed_payment_method_types: [b.method],
            payment_method_configuration: c.configuration.id,
            ...(b.method === "acss_debit"
              ? { payment_method_options: { acss_debit: { currency: a.currency.toLowerCase() as "cad" | "usd" } } }
              : {}),
            line_items: [
              {
                price_data: {
                  currency: a.currency.toLowerCase(),
                  unit_amount: a.amount_minor,
                  product_data: { name: "Rent invoice " + c.invoice.number },
                },
                quantity: 1,
              },
            ],
            success_url: success.toString(),
            cancel_url: cancel.toString(),
          },
          { stripeAccount: a.connected_account_id, idempotencyKey: prepared.idempotencyKey },
        );
      } catch {
        throw fail.conflict(
          "Stripe checkout could not be confirmed. The request was retained to prevent duplicate collection. Retry this same request or review its status; do not start a second payment.",
        );
      }
      const linked = await attempts.attachHostedSession(s, a.id, session);
      return { ...linked, attemptId: a.id, testMode: a.mode === "test" };
    },
  };
}

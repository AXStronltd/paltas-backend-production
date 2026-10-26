import { z } from "zod";
import { endpoint } from "../endpoint.js";
import { OrgParams } from "./organisations.js";

/** Requested company jurisdictions; Stripe must independently accept and verify each merchant. */
export const RentMerchantCountry = z.enum([
  "US",
  "GB",
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);
export const RentCollectionModel = z.enum(["landlord", "property_manager"]);
export const RentMerchant = z.object({
  country: RentMerchantCountry,
  model: RentCollectionModel,
  status: z.enum(["pending", "onboarding", "restricted", "verified"]),
  chargesEnabled: z.boolean(),
  payoutsEnabled: z.boolean(),
  testMode: z.boolean(),
  requirements: z.array(z.string()),
  checkedAt: z.string().nullable(),
});
export const merchantStatus = endpoint({
  id: "rentCollection.merchantStatus",
  method: "GET",
  path: "/api/v1/orgs/:orgId/rent-collection/merchant",
  auth: "user",
  summary: "Company's verified Stripe onboarding status; never proof of operational rent collection",
  params: OrgParams,
  response: z.object({
    enabled: z.boolean(),
    merchant: RentMerchant.nullable(),
    countries: z.array(RentMerchantCountry),
    collectionOperational: z.literal(false),
    note: z.string(),
  }),
});
export const onboardMerchant = endpoint({
  id: "rentCollection.onboardMerchant",
  method: "POST",
  path: "/api/v1/orgs/:orgId/rent-collection/merchant/onboarding",
  auth: "user",
  summary: "Organisation owner explicitly starts hosted company account verification; no payments or bank credentials",
  params: OrgParams,
  body: z.object({ country: RentMerchantCountry, model: RentCollectionModel, confirmLegalCountry: z.literal(true) }),
  response: z.object({ url: z.string().url(), testMode: z.boolean() }),
});
export const refreshMerchant = endpoint({
  id: "rentCollection.refreshMerchant",
  method: "POST",
  path: "/api/v1/orgs/:orgId/rent-collection/merchant/refresh",
  auth: "user",
  summary: "Recheck the connected merchant's actual provider capabilities after returning from onboarding",
  params: OrgParams,
  body: z.object({}),
  response: merchantStatus.response,
});

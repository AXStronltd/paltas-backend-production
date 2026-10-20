// @paltas/contracts — the one definition shared by the PALTAS server and front end.
//
//   common      dates, money (minor units), currency, error format
//   access      products, roles, capabilities (who may do what)
//   endpoint    how an API call is defined
//   api/*       every endpoint, grouped by area (API)
//   entitlements  the subscription rules (also generated for the browser as shared/entitlements.js)
export { z } from "zod";
export * from "./common.js";
export * from "./access.js";
export * from "./endpoint.js";
export * from "./api/index.js";
export * from "./api/identity.js";
export * from "./api/organisations.js";
export * from "./api/subscriptions.js";
export * from "./api/payments.js";
export * from "./api/ledger.js";
export * from "./api/admin.js";
export * from "./api/migration.js";
export * as entitlements from "./entitlements/rules.js";
export * as rentalRules from "./rental-rules.js";
export type * from "./entitlements/types.js";

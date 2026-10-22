// Entry for the browser bundle (shared/paltas-api-client.js, global PaltasApi).
export { createClient, PaltasApiError } from "./client.js";
export {
  API,
  buildPath,
  rentalRules,
  ROLE_DEFINITIONS,
  CAPABILITIES,
  roleCan,
  delegatedCapabilityCan,
} from "@paltas/contracts";

// What every hotel service receives: the core services, the hotel access gate and the integration adapters.
import type { AppContext } from "../../context.js";
import type { Actor } from "../../core/audit/audit.service.js";
import type { CoreServices } from "../../core/core-services.js";
import type { HotelAdapters } from "./integrations/adapters.js";
import type { HotelAccess } from "./shared/access.js";
import type { PropertyRow } from "./shared/property.js";

export interface HotelDeps {
  ctx: AppContext;
  core: CoreServices;
  access: HotelAccess;
  adapters: HotelAdapters;
}

/**
 * Who acts, in which hotel. A signed-in member's HotelScope is one; a signed channel-manager webhook acts as the
 * system (userId null).
 */
export interface HotelOp {
  orgId: string;
  userId: string | null;
  actor: Actor;
  property: PropertyRow;
}

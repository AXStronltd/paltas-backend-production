// What every security service receives: the app context, the core services and the integration adapters.
import type { AppContext } from "../../context.js";
import type { CoreServices } from "../../core/core-services.js";
import type { SecurityAdapters } from "./integrations/adapters.js";

export interface SecurityDeps {
  ctx: AppContext;
  core: CoreServices;
  adapters: SecurityAdapters;
}

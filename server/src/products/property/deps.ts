// What every Property Management service receives: the core services and the PM access gate.
import type { AppContext } from "../../context.js";
import type { CoreServices } from "../../core/core-services.js";
import type { PmAccess } from "./shared/access.js";

export interface PmDeps {
  ctx: AppContext;
  core: CoreServices;
  access: PmAccess;
}

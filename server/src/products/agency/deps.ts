// What every agency service receives: the app context, the core services, the storage adapter and the public limiter.
import type { AppContext } from "../../context.js";
import type { CoreServices } from "../../core/core-services.js";
import type { MediaStorage } from "./integrations/storage.js";
import type { PublicLimiter } from "./shared/limiter.js";

export interface AgencyDeps {
  ctx: AppContext;
  core: CoreServices;
  storage: MediaStorage;
  limiter: PublicLimiter;
}

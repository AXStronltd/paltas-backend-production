import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, FINANCE } from "../shared/gate.js";
import type { collectionRemindersService } from "./collection-reminders.service.js";
export function collectionReminderRoutes(access: PmAccess, S: ReturnType<typeof collectionRemindersService>) {
  const g = gate(access);
  return [
    route(api.getReminderPolicy, async (req) => S.get(await g.org(req, "property.read"), req.params.propertyId)),
    route(api.saveReminderPolicy, async (req) =>
      S.save(await g.org(req, "property.billing", FINANCE), req.params.propertyId, req.body),
    ),
    route(api.previewCollectionReminders, async (req) =>
      S.preview(await g.org(req, "property.billing"), req.params.propertyId, req.query),
    ),
    route(api.sendCollectionReminders, async (req) =>
      S.send(await g.org(req, "property.billing", FINANCE), req.params.propertyId, req.body.items),
    ),
    route(api.collectionReminderHistory, async (req) =>
      S.history(await g.org(req, "property.billing"), req.params.propertyId, req.query),
    ),
  ];
}

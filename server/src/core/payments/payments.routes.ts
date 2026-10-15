import { payments } from "@paltas/contracts";
import { route } from "../../http/route.js";
import type { PaymentsService } from "./payments.service.js";

// The signature is verified by the route layer (auth: "signed-webhook") before this handler runs.
export function paymentsRoutes(service: PaymentsService) {
  return [route(payments.receivePaymentEvent, async (req) => service.receive(req.params.provider, req.body))];
}

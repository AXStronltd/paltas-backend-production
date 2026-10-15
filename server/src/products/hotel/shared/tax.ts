/*
 * The hotel tax engine. Each property configures its own VAT, service charge and tourism / city levy — no country is
 * hard-coded. Everything is integer minor units and basis points; each tax is rounded half-up once, per charge.
 *
 *   service charge = net × SC%            (only departments the property lists)
 *   VAT            = (net [+ service charge]) × VAT%
 *   levy           = rooms only: a fixed amount per night, or a share of the room revenue
 *
 * The no-show / cancellation department carries VAT but no service charge or levy (no stay took place).
 */
import type { hotel } from "@paltas/contracts";
import type { PropertyRow } from "./property.js";

export interface TaxedAmount {
  net: number;
  service: number;
  vat: number;
  levy: number;
  total: number;
}

const share = (amount: number, bp: number): number => Math.round((amount * bp) / 10_000);

export function applyTaxes(
  p: Pick<
    PropertyRow,
    | "vat_bp"
    | "service_charge_bp"
    | "service_charge_departments"
    | "vat_on_service_charge"
    | "levy_kind"
    | "levy_amount_minor"
    | "levy_bp"
  >,
  department: hotel.HotelDepartment,
  net: number,
  nights = 0,
): TaxedAmount {
  const service =
    department !== "noshow" && p.service_charge_departments.includes(department) ? share(net, p.service_charge_bp) : 0;
  const vat = share(net + (p.vat_on_service_charge ? service : 0), p.vat_bp);
  let levy = 0;
  if (department === "rooms") {
    if (p.levy_kind === "per_night") levy = p.levy_amount_minor * nights;
    else if (p.levy_kind === "percent_of_room") levy = share(net, p.levy_bp);
  }
  return { net, service, vat, levy, total: net + service + vat + levy };
}

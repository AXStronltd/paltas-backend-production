import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { gate, FINANCE } from "../shared/gate.js";
import type { propertyPayrollService } from "./payroll.service.js";
export function propertyPayrollRoutes(access: PmAccess, P: ReturnType<typeof propertyPayrollService>) {
  const g = gate(access);
  return [
    route(api.payrollEmployees, async (req) => P.employees(await g.org(req, "property.payroll.view"))),
    route(api.savePayrollEmployee, async (req) =>
      P.employee(await g.org(req, "property.payroll.prepare", FINANCE), req.params.employeeId, req.body),
    ),
    route(api.payrollRuns, async (req) => P.list(await g.org(req, "property.payroll.view"))),
    route(api.preparePayroll, async (req) =>
      P.prepare(await g.org(req, "property.payroll.prepare", FINANCE), req.body),
    ),
    route(api.payrollAction, async (req) =>
      P.action(
        await g.org(
          req,
          req.body.action === "approve" || req.body.action === "reverse"
            ? "property.payroll.approve"
            : req.body.action === "pay"
              ? "property.payroll.pay"
              : "property.payroll.prepare",
          FINANCE,
        ),
        req.params.runId,
        req.body,
      ),
    ),
    route(api.payrollRemit, async (req) =>
      P.remit(await g.org(req, "property.payroll.pay", FINANCE), req.params.runId, req.body),
    ),
  ];
}

// HTTP only: settings, charge types, properties, buildings, units, agreements and owners.
import { property as api } from "@paltas/contracts";
import { route } from "../../../http/route.js";
import type { PmAccess } from "../shared/access.js";
import { ANY_PM_READ, FINANCE, gate, WRITE } from "../shared/gate.js";
import type { SetupService } from "./setup.service.js";

export function setupRoutes(access: PmAccess, S: SetupService) {
  const g = gate(access);
  return [
    route(api.exportAuditIntegrity, async (req) => S.financeConfig.exportAudit(await g.org(req, "audit.read"))),
    route(api.listUtilityTariffs, async (req) =>
      S.financeConfig.tariffs(await g.org(req, "property.read"), req.params.chargeTypeId),
    ),
    route(api.createUtilityTariff, async (req) =>
      S.financeConfig.createTariff(await g.org(req, "property.setup", FINANCE), req.params.chargeTypeId, req.body),
    ),
    route(api.listExpenseCategories, async (req) => S.financeConfig.categories(await g.org(req, "property.read"))),
    route(api.createExpenseCategory, async (req) =>
      S.financeConfig.saveCategory(await g.org(req, "property.setup", FINANCE), null, req.body),
    ),
    route(api.updateExpenseCategory, async (req) =>
      S.financeConfig.saveCategory(await g.org(req, "property.setup", FINANCE), req.params.categoryId, req.body),
    ),
    route(api.getSettings, async (req) => S.settings((await g.org(req, "property.read")).orgId)),
    route(api.updateSettings, async (req) => S.updateSettings(await g.org(req, "property.setup", WRITE), req.body)),
    route(api.listChargeTypes, async (req) => S.listChargeTypes((await g.org(req, ANY_PM_READ)).orgId)),
    route(api.createChargeType, async (req) => S.createChargeType(await g.org(req, "property.setup", WRITE), req.body)),
    route(api.updateChargeType, async (req) =>
      S.updateChargeType(await g.org(req, "property.setup", WRITE), req.params.chargeTypeId, req.body),
    ),
    route(api.listProperties, async (req) => S.listProperties(await g.org(req, ANY_PM_READ))),
    route(api.createProperty, async (req) => S.createProperty(await g.org(req, "property.setup", WRITE), req.body)),
    route(api.getProperty, async (req) => S.getProperty(await g.org(req, ANY_PM_READ), req.params.propertyId)),
    route(api.updateProperty, async (req) =>
      S.updateProperty(await g.org(req, "property.setup", WRITE), req.params.propertyId, req.body),
    ),
    route(api.setAutomation, async (req) =>
      S.setAutomation(await g.org(req, "property.billing", FINANCE), req.params.propertyId, req.body),
    ),
    route(api.createBuilding, async (req) =>
      S.createBuilding(await g.org(req, "property.setup", WRITE), req.params.propertyId, req.body),
    ),
    route(api.updateBuilding, async (req) =>
      S.updateBuilding(await g.org(req, "property.setup", WRITE), req.params.buildingId, req.body),
    ),
    route(api.deleteBuilding, async (req) =>
      S.deleteBuilding(await g.org(req, "property.setup", WRITE), req.params.buildingId),
    ),
    route(api.createUnits, async (req) =>
      S.createUnits(await g.org(req, "property.setup", WRITE), req.params.propertyId, req.body.units),
    ),
    route(api.updateUnit, async (req) =>
      S.updateUnit(await g.org(req, "property.setup", WRITE), req.params.unitId, req.body),
    ),
    route(api.listHistoricalSummaries, async (req) =>
      S.historicalSummaries((await g.org(req, "property.reports.read")).orgId, req.query),
    ),
    route(api.listOwnerships, async (req) =>
      S.ownership.list((await g.org(req, "property.read")).orgId, req.query.propertyId),
    ),
    route(api.createOwnership, async (req) => S.ownership.create(await g.org(req, "property.setup", WRITE), req.body)),
    route(api.verifyOwnership, async (req) =>
      S.ownership.verify(await g.org(req, "property.setup", WRITE), req.params.ownershipId),
    ),
    route(api.updateOwnership, async (req) =>
      S.ownership.update(await g.org(req, "property.setup", WRITE), req.params.ownershipId, req.body),
    ),
    route(api.updateAgreement, async (req) =>
      S.updateAgreement(await g.org(req, "property.setup", WRITE), req.params.agreementId, req.body),
    ),
    route(api.activateAgreement, async (req) =>
      S.activateAgreement(await g.org(req, "property.setup", WRITE), req.params.agreementId, req.body),
    ),
    route(api.listAgreements, async (req) => S.listAgreements((await g.org(req, "property.read")).orgId, req.query)),
    route(api.createAgreement, async (req) => S.createAgreement(await g.org(req, "property.setup", WRITE), req.body)),
    route(api.endAgreement, async (req) =>
      S.endAgreement(await g.org(req, "property.setup", WRITE), req.params.agreementId, req.body),
    ),
    route(api.listOwners, async (req) => S.listOwners(await g.org(req, "property.read"))),
    // bank details and their verification belong to finance, not to the person running the buildings
    route(api.updateOwnerProfile, async (req) =>
      S.updateOwnerProfile(await g.org(req, "property.payouts.approve", WRITE), req.params.ownerId, req.body),
    ),
  ];
}

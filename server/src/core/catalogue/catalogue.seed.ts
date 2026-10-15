/*
 * The starting catalogue, matching what the browser demo shows. KES prices are PALTAS demo configuration, to be
 * confirmed by PALTAS before any customer is billed; tax rates must be confirmed with a tax adviser. After seeding,
 * Super Admin changes prices through the admin API — nothing in the code reads a price.
 * Seeding is idempotent: existing rows are never overwritten.
 */
import type { Db } from "../../db/database.js";

// key, name, products, dependencies, price (KES per month)
const MODULES: [string, string, string[], string[], number][] = [
  ["crm", "Advanced CRM and Marketing", ["property", "agency", "developer", "hotel"], [], 5000],
  ["maint", "Maintenance and SLA Management", ["property", "hotel"], [], 3000],
  ["finance", "Finance and Accounting", ["property", "agency", "developer", "hotel", "security"], [], 6000],
  [
    "payments",
    "Payments and Banking Integrations",
    ["property", "agency", "developer", "hotel", "security"],
    ["finance"],
    4000,
  ],
  ["procurement", "Supplier and Procurement Management", ["property", "developer", "hotel"], ["finance"], 3000],
  ["intelligence", "Advanced Reports and Intelligence", ["property", "developer", "hotel"], ["finance"], 4000],
  ["docs", "Document Intelligence", ["property", "agency", "developer", "hotel", "security"], [], 2000],
  ["automation", "Workflow Automation", ["property", "agency", "developer", "hotel", "security"], [], 2500],
];

const TAX_NOTE = "Demo configuration — VAT as configured by PALTAS; confirm with your tax adviser";

// id, name, tier, product, modules, buildings included, base KES, extra building KES, cap sites, cap units, trial days
const PLANS: [
  string,
  string,
  "Standard" | "Pro" | "Enterprise",
  string,
  string[],
  number,
  number | null,
  number | null,
  number | null,
  number | null,
  number,
][] = [
  [
    "PM-STARTER",
    "Property Management — Standard",
    "Standard",
    "property",
    ["maint", "finance", "docs"],
    1,
    25000,
    15000,
    2,
    100,
    30,
  ],
  [
    "PM-GROWTH",
    "Property Management — Pro",
    "Pro",
    "property",
    ["crm", "maint", "finance", "payments", "procurement", "intelligence", "docs"],
    3,
    60000,
    12000,
    10,
    1000,
    30,
  ],
  [
    "PM-ENTERPRISE",
    "Property Management — Enterprise",
    "Enterprise",
    "property",
    ["crm", "maint", "finance", "payments", "procurement", "intelligence", "docs", "automation"],
    10,
    null,
    null,
    null,
    null,
    30,
  ],
  [
    "DEV-STD",
    "Property Development — Standard",
    "Standard",
    "developer",
    ["crm", "finance", "payments", "procurement"],
    1,
    80000,
    null,
    1,
    300,
    30,
  ],
  [
    "DEV-PRO",
    "Property Development — Pro",
    "Pro",
    "developer",
    ["crm", "finance", "payments", "procurement", "intelligence"],
    5,
    150000,
    null,
    5,
    2000,
    30,
  ],
  [
    "DEV-ENTERPRISE",
    "Property Development — Enterprise",
    "Enterprise",
    "developer",
    ["crm", "finance", "payments", "procurement", "intelligence", "automation"],
    20,
    null,
    null,
    null,
    null,
    30,
  ],
];

export async function seedCatalogue(db: Db): Promise<void> {
  for (const [key, name, products, deps, kes] of MODULES) {
    await db.run(
      `INSERT INTO catalogue_modules (key, name, products, deps, price_minor, price_ccy)
       VALUES ($1, $2, $3, $4, $5, 'KES') ON CONFLICT (key) DO NOTHING`,
      [key, name, products, deps, kes * 100],
    );
  }
  for (const [id, name, tier, product, modules, included, base, extra, sites, units, trial] of PLANS) {
    await db.run(
      `INSERT INTO catalogue_plans (id, name, tier, product, modules, buildings_included, base_minor, extra_building_minor,
         currency, trial_days, tax_pct, tax_note, cap_sites, cap_units)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,16,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
      [
        id,
        name,
        tier,
        product,
        modules,
        included,
        base == null ? null : base * 100,
        extra == null ? null : extra * 100,
        base == null && extra == null ? null : "KES",
        trial,
        TAX_NOTE,
        sites,
        units,
      ],
    );
  }
}

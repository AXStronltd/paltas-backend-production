/*
 * The product data domains this server runs. Each implemented domain is added here, e.g.
 *   import { propertyManagement } from "./property-management/index.js";
 *   export const PRODUCTS: ProductModule[] = [propertyManagement];
 * Current modules: Hotel record APIs and Development migration support. See products/README.md.
 */
import { agency } from "./agency/index.js";
import { development } from "./development/index.js";
import { hotel } from "./hotel/index.js";
import { property } from "./property/index.js";
import type { ProductModule } from "./registry.js";
import { security } from "./security/index.js";

export const PRODUCTS: ProductModule[] = [development, hotel, agency, security, property];

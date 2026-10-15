/*
 * The products this server runs. Each product is added here in its own build round, e.g.
 *   import { propertyManagement } from "./property-management/index.js";
 *   export const PRODUCTS: ProductModule[] = [propertyManagement];
 * See products/README.md.
 */
import { development } from "./development/index.js";
import { hotel } from "./hotel/index.js";
import type { ProductModule } from "./registry.js";

export const PRODUCTS: ProductModule[] = [development, hotel];

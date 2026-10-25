import { expect, it, vi } from "vitest";
import type { Db } from "../dist/db/database.js";
import type { OrgScope } from "../dist/core/access/org-access.js";
vi.mock("../dist/products/property/reports/collections-overview.js", () => ({ collectionsOverview: vi.fn() }));
import { collectionsOverview } from "../dist/products/property/reports/collections-overview.js";
import { exportCollections } from "../dist/products/property/reports/collections-export.js";
it("refuses oversized exports rather than returning a truncated screen page", async () => {
  vi.mocked(collectionsOverview).mockResolvedValue({ total: 10001 } as Awaited<ReturnType<typeof collectionsOverview>>);
  const run = vi.fn();
  await expect(
    exportCollections({ run } as unknown as Db, {} as OrgScope, {
      from: "2026-10-01",
      to: "2026-10-25",
      invoiceStatus: "open",
      kind: "receipts",
    }),
  ).rejects.toThrow("Narrow the date, property or tenant filters");
  expect(run).not.toHaveBeenCalled();
});
it("refuses missing rows instead of pretending the export is complete", async () => {
  vi.mocked(collectionsOverview).mockResolvedValue({ total: 2, rows: [] } as unknown as Awaited<
    ReturnType<typeof collectionsOverview>
  >);
  await expect(
    exportCollections({} as Db, {} as OrgScope, {
      from: "2026-10-01",
      to: "2026-10-25",
      invoiceStatus: "open",
      kind: "receipts",
    }),
  ).rejects.toThrow("complete report could not be read");
});

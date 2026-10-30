import { it, expect } from "vitest";
import { reportXlsx, reportPrint } from "../dist/lib/tabular-export.js";
import { readZip } from "../dist/core/migration/files/zip.js";
it("keeps untrusted text literal, exact large amounts and valid Unicode", () => {
  const b = reportXlsx(
    ["Name", "Amount"],
    [
      ["<script>alert(1)</script>😀\u0000", { decimal: "9007199254740991" }],
      ["=SUM(A1)", { decimal: "25.00" }],
    ],
  );
  const xml = readZip(b, { maxEntries: 20, maxUncompressedBytes: 100000 })
    .find((x) => x.name === "xl/worksheets/sheet1.xml")!
    .data.toString();
  expect(xml).toContain("&lt;script&gt;");
  expect(xml).toContain("😀");
  expect(xml).not.toContain("\u0000");
  expect(xml).toContain('<c r="B2" t="inlineStr">');
  expect(xml).toContain('<c r="B3" s="2"><v>25.00</v>');
  expect(xml).not.toContain("<f>");
  const html = reportPrint("<img onerror=x>", "<script>", ["Customer"], [["</td><script>bad</script>"]]);
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;script&gt;");
});
it("rejects oversized or malformed worksheet dimensions", () => {
  expect(() => reportXlsx(["x"], [["x", "y"]])).toThrow();
  expect(() =>
    reportXlsx(
      ["x"],
      Array.from({ length: 10001 }, () => ["x"]),
    ),
  ).toThrow();
});

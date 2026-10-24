import { readFile } from "node:fs/promises";
const manifest = JSON.parse(
  await readFile(new URL("../docs/finance/rent-collections-acceptance.json", import.meta.url), "utf8"),
);
const requirements = manifest.sections.flatMap((x) => x.requirements);
const unresolved = [...requirements, ...manifest.mandatoryJourneys].filter(
  (x) => x.status !== "verified" || !Array.isArray(x.evidence) || !x.evidence.length,
);
const customerAccepted =
  manifest.customerAcceptance.status === "verified" && manifest.customerAcceptance.evidence.length > 0;
if (unresolved.length || !customerAccepted) {
  console.error(
    `RENT & COLLECTIONS RELEASE BLOCKED: ${unresolved.length} requirements/journeys need verification; customer acceptance ${customerAccepted ? "verified" : "pending"}.`,
  );
  console.error(
    "Do not deploy a partial implementation or claim enterprise completion. See docs/finance/rent-collections-acceptance.json.",
  );
  process.exitCode = 1;
} else
  console.log(
    "Rent & Collections acceptance evidence is complete. Review production configuration and provider dependencies before release.",
  );

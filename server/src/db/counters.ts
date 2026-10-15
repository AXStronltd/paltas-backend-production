import type { Db } from "./database.js";

/**
 * The next document number in a sequence, e.g. nextNumber(t, "platform", "SUB", 5) → "SUB-00001".
 * Atomic: two requests can never get the same number. Use inside the transaction that creates the document.
 */
export async function nextNumber(db: Db, scope: string, name: string, digits = 5): Promise<string> {
  const row = await db.row<{ value: number }>(
    `INSERT INTO counters (scope, name, value) VALUES ($1, $2, 1)
     ON CONFLICT (scope, name) DO UPDATE SET value = counters.value + 1
     RETURNING value`,
    [scope, name],
  );
  return `${name}-${String(row?.value).padStart(digits, "0")}`;
}

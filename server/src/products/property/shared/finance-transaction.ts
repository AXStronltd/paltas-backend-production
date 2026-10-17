import type { Db } from "../../../db/database.js";

/** Keep a company's financial checks and postings together without blocking other organisations. */
export function financeTransaction<T>(db: Db, orgId: string, work: (t: Db) => Promise<T>): Promise<T> {
  return db.tx(async (t) => {
    await t.run("SELECT pg_advisory_xact_lock(hashtextextended('paltas-pm-finance:' || $1,0))", [orgId]);
    return work(t);
  });
}

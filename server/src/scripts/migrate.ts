// Apply database migrations:  npm run db:migrate   (uses DATABASE_URL)
import { loadConfig } from "../config.js";
import { connect } from "../db/database.js";
import { migrate } from "../db/migrate.js";

const config = loadConfig();
const db = connect(config.databaseUrl, 1);
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
} finally {
  await db.close();
}

import { runMigrations } from "graphile-worker";
import { config } from "../config.js";
import { createDb, migrate } from "../db/index.js";

const db = createDb(config.databaseUrl);
await migrate(db);
await db.destroy();
await runMigrations({ connectionString: config.databaseUrl });
console.log("migrated");

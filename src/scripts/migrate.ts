import { runMigrations } from "graphile-worker";
import { config } from "../config.js";
import { createDb, grantJobPrivileges, migrate } from "../db/index.js";

const db = createDb(config.databaseUrl);
await migrate(db);
await runMigrations({ connectionString: config.databaseUrl });
await grantJobPrivileges(db);
await db.destroy();
console.log("migrated");

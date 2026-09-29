import { sql } from "kysely";
import { config } from "../config.js";
import { createDb } from "../db/index.js";

// Wipes the demo database. Refuses outside development.
if (config.production || !config.devLogin)
  throw new Error("reset is only for the dev demo (DEV_LOGIN=1)");
const db = createDb(config.databaseUrl);
await sql`drop schema if exists public cascade; drop schema if exists graphile_worker cascade; drop schema if exists fakepay cascade; create schema public;`.execute(
  db,
);
await db.destroy();
console.log("demo database reset");

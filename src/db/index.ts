import { Kysely, PostgresDialect, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import * as kernel from "./migrations/0001_kernel.js";
import * as finance from "./migrations/0002_finance.js";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
export type Executor = Db | Tx;

// Calendar dates stay "YYYY-MM-DD" strings; converting them to JS Dates would
// shift them by the local time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createDb(connectionString: string): Db {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 20 }) }),
  });
}

export async function migrate(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: async () => ({ "0001_kernel": kernel, "0002_finance": finance }),
    },
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Error") throw new Error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}

import { Kysely, PostgresDialect, sql, type Transaction } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import * as kernel from "./migrations/0001_kernel.js";
import * as finance from "./migrations/0002_finance.js";
import * as security from "./migrations/0003_security.js";
import * as recovery from "./migrations/0004_recovery_state.js";
import type { Database } from "./schema.js";

export type Db = Kysely<Database>;
export type Tx = Transaction<Database>;
export type Executor = Db | Tx;

// Calendar dates stay "YYYY-MM-DD" strings; converting them to JS Dates would
// shift them by the local time zone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

// Every connection drops to a least-privilege role when one is given, so the
// database, not only the application, refuses what that role must not do.
export type DbRole = "delegate_app" | "delegate_fakepay";

export function createDb(connectionString: string, role?: DbRole): Db {
  const pool = new pg.Pool({ connectionString, max: 20 });
  if (role) pool.on("connect", (client) => void client.query(`set role ${role}`));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export async function migrate(db: Db): Promise<void> {
  const migrator = new Migrator({
    db,
    provider: {
      getMigrations: async () => ({
        "0001_kernel": kernel,
        "0002_finance": finance,
        "0003_security": security,
        "0004_recovery_state": recovery,
      }),
    },
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Error") throw new Error(`migration ${r.migrationName} failed`);
  }
  if (error) throw error;
}

// graphile-worker creates its schema after ours, so this runs afterwards. The
// application role's only access to the queue is this definer function. It
// accepts only known tasks, derives each job key from the payload itself, and
// never moves pending work later, so re-enqueuing can bring work forward but
// can't postpone it.
export async function grantJobPrivileges(db: Db): Promise<void> {
  await sql`
    drop function if exists public.delegate_enqueue(text, json, timestamptz, text, integer);
    create or replace function public.delegate_enqueue(p_identifier text, p_payload json, p_run_at timestamptz)
    returns void
    language plpgsql security definer set search_path = pg_catalog, graphile_worker as $$
    declare
      v_key text;
    begin
      v_key := case p_identifier
        when 'dispatch' then 'dispatch:' || (p_payload->>'intentId')
        when 'reconcile' then 'reconcile:' || (p_payload->>'intentId')
        when 'cancel_in_flight' then 'cancel:' || (p_payload->>'intentId')
        when 'process_inbox' then 'inbox:' || (p_payload->>'provider') || ':' || (p_payload->>'eventId')
      end;
      if v_key is null then
        raise exception 'unknown task or missing id: %', p_identifier;
      end if;
      perform graphile_worker.add_job(
        p_identifier, p_payload, run_at => p_run_at, job_key => v_key,
        max_attempts => 25, job_key_mode => 'preserve_run_at'
      );
      -- Bring pending work forward if asked, never back.
      if p_run_at is not null then
        update graphile_worker._private_jobs set run_at = least(run_at, p_run_at)
        where key = v_key and locked_at is null;
      end if;
    end $$;
    revoke all on function public.delegate_enqueue(text, json, timestamptz) from public;
    grant execute on function public.delegate_enqueue(text, json, timestamptz) to delegate_app;
  `.execute(db);
}

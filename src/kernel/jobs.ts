import { sql } from "kysely";
import type { Executor } from "../db/index.js";

// Jobs are rows in graphile-worker's tables in the same database, so enqueuing
// inside a transaction is the transactional outbox: the job exists if and only
// if the state change that called for it committed.
export type JobName = "dispatch" | "reconcile" | "process_inbox" | "cancel_in_flight";

export async function enqueue(
  ex: Executor,
  task: JobName,
  payload: Record<string, unknown>,
  opts: { runAt?: Date; jobKey?: string } = {},
): Promise<void> {
  await sql`select graphile_worker.add_job(
    ${task},
    ${JSON.stringify(payload)}::json,
    run_at => ${opts.runAt ?? null}::timestamptz,
    job_key => ${opts.jobKey ?? null}::text,
    max_attempts => 25
  )`.execute(ex);
}

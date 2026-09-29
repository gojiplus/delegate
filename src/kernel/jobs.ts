import { sql } from "kysely";
import type { Executor } from "../db/index.js";

// Jobs are rows in graphile-worker's tables in the same database, so enqueuing
// inside a transaction is the transactional outbox: the job exists if and only
// if the state change that called for it committed.
export type JobName = "dispatch" | "reconcile" | "process_inbox" | "cancel_in_flight";

// The job key is derived inside the database from the task and payload, so
// enqueuing is idempotent per intent (or per webhook event) by construction.
export async function enqueue(
  ex: Executor,
  task: JobName,
  payload: Record<string, unknown>,
  opts: { runAt?: Date } = {},
): Promise<void> {
  await sql`select public.delegate_enqueue(
    ${task},
    ${JSON.stringify(payload)}::json,
    ${opts.runAt ?? null}::timestamptz
  )`.execute(ex);
}

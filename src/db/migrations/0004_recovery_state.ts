import { type Kysely, sql } from "kysely";

// Recovery is a state of its own, not a freeze reason typed as free text, so
// support can't open an enrolment window by freezing with the right words.
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table person add column recovery_started_at timestamptz`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("no down migrations");
}

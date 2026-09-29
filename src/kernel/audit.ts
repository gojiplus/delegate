import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db, Tx } from "../db/index.js";
import { canonicalJson } from "./canonical.js";

export type ActorKind = "person" | "support" | "system" | "provider";

export interface AuditInput {
  actorId: string | null;
  actorKind: ActorKind;
  ownerId: string | null;
  action: string;
  subjectType?: string;
  subjectId?: string;
  detail?: Record<string, unknown>;
}

export interface AuditRecord {
  seq: string;
  at: string;
  actor_id: string | null;
  actor_kind: ActorKind;
  owner_id: string | null;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  detail: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

const GENESIS = "sha256:genesis";
// Arbitrary constant; serialises audit appends so each row can chain to the previous hash.
const AUDIT_LOCK = 7_331_001;

function hashBody(r: Omit<AuditRecord, "seq" | "hash">): string {
  const body = canonicalJson({
    at: r.at,
    actor_id: r.actor_id,
    actor_kind: r.actor_kind,
    owner_id: r.owner_id,
    action: r.action,
    subject_type: r.subject_type,
    subject_id: r.subject_id,
    detail: r.detail,
    prev_hash: r.prev_hash,
  });
  return "sha256:" + createHash("sha256").update(body).digest("hex");
}

// The table rejects UPDATE and DELETE by trigger, and each row commits to the
// hash of the one before it. The trigger stops casual edits; the chain lets an
// exported copy prove that nothing was altered or removed after export.
export async function audit(tx: Tx, e: AuditInput): Promise<void> {
  await sql`select pg_advisory_xact_lock(${AUDIT_LOCK})`.execute(tx);
  const last = await tx
    .selectFrom("audit_event")
    .select("hash")
    .orderBy("seq", "desc")
    .limit(1)
    .executeTakeFirst();
  const row = {
    at: new Date().toISOString(),
    actor_id: e.actorId,
    actor_kind: e.actorKind,
    owner_id: e.ownerId,
    action: e.action,
    subject_type: e.subjectType ?? null,
    subject_id: e.subjectId ?? null,
    detail: e.detail ?? {},
    prev_hash: last?.hash ?? GENESIS,
  };
  await tx
    .insertInto("audit_event")
    .values({ ...row, detail: JSON.stringify(row.detail), hash: hashBody(row) })
    .execute();
}

export async function exportAudit(db: Db, ownerId?: string): Promise<AuditRecord[]> {
  let q = db.selectFrom("audit_event").selectAll().orderBy("seq");
  if (ownerId) q = q.where("owner_id", "=", ownerId);
  const rows = await q.execute();
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}

// Verifies a full export (not an owner-filtered slice, whose links skip rows).
export function verifyChain(records: AuditRecord[]): { ok: true } | { ok: false; seq: string } {
  let prev = GENESIS;
  for (const r of records) {
    if (r.prev_hash !== prev || hashBody(r) !== r.hash) return { ok: false, seq: r.seq };
    prev = r.hash;
  }
  return { ok: true };
}

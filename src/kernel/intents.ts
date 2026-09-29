import { z } from "zod";
import type { Executor, Tx } from "../db/index.js";
import { canAccess } from "./access.js";
import { audit } from "./audit.js";
import { digestOf } from "./canonical.js";
import type { Kernel } from "./context.js";
import { newId } from "./ids.js";
import { notify } from "./notify.js";
import { enqueue } from "./jobs.js";
import { UNDISPATCHED, isTerminal, transition } from "./lifecycle.js";
import { type Capability, type IntentTypeDef, KernelError } from "./registry.js";
import { consumeStepUp, issueChallenge } from "./stepup.js";

// An intent is a proposed action by its owner or a delegate. Its content lives
// in immutable revisions; approval is bound to the digest of one revision, so
// any change to payee, source, amount, fee, currency or date forces a new
// revision and a new approval (P6). Nothing a client sends can mark an intent
// approved or executed: approval needs the owner's passkey over the digest and
// execution status comes only from the provider.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIntentType = IntentTypeDef<any>;

const APPROVAL_REQUEST_TTL_MS = 7 * 24 * 3600 * 1000;

export const NewIntent = z.object({
  type: z.string(),
  details: z.unknown(),
  workItemId: z.string().nullable().default(null),
});

export function revisionDigest(
  intentId: string,
  revision: number,
  ownerId: string,
  type: string,
  details: unknown,
) {
  return digestOf({ intentId, revision, ownerId, type, details });
}

async function ownerOf(ex: Executor, resourceIds: string[]): Promise<string> {
  const owners = await ex
    .selectFrom("resource")
    .select("owner_id")
    .distinct()
    .where("id", "in", resourceIds)
    .execute();
  if (owners.length !== 1 || !owners[0]) throw new KernelError("not_found", "not found");
  return owners[0].owner_id;
}

// The owner may prepare anything over their own resources; a delegate needs the
// type's prepare scope on every resource the intent touches.
async function mayPrepare(
  ex: Executor,
  k: Kernel,
  actorId: string,
  def: AnyIntentType,
  resourceIds: string[],
) {
  for (const r of resourceIds) {
    if (!(await canAccess(ex, k.registry, actorId, def.prepareScope, r))) return false;
  }
  return true;
}

export class UnsupportedAction extends KernelError {
  constructor(readonly capability: Capability) {
    super("invalid", capability.reason);
  }
}

export async function prepareIntent(
  k: Kernel,
  actorId: string,
  clientKey: string,
  input: z.infer<typeof NewIntent>,
): Promise<{ intentId: string; created: boolean }> {
  const def = k.registry.intentType(input.type);
  const details = def.details.parse(input.details);
  const resourceIds = def.resourcesOf(details);
  if (!(await mayPrepare(k.db, k, actorId, def, resourceIds)))
    throw new KernelError("not_found", "not found");
  const ownerId = await ownerOf(k.db, resourceIds);
  const cap = await def.capability(k.db, ownerId, details);
  if (cap.state !== "executable") throw new UnsupportedAction(cap);
  // A payment can only settle a bill that belongs to the same owner, sits on an
  // account the payment touches, and that the preparer can see. Otherwise a
  // delegate could mark anyone's bill "verified paid" with a token payment.
  if (input.workItemId) {
    const w = await k.db
      .selectFrom("work_item")
      .selectAll()
      .where("id", "=", input.workItemId)
      .executeTakeFirst();
    const ok =
      w &&
      w.owner_id === ownerId &&
      resourceIds.includes(w.resource_id) &&
      (await canAccess(
        k.db,
        k.registry,
        actorId,
        k.registry.workItemType(w.type).scope,
        w.resource_id,
      ));
    if (!ok) throw new KernelError("not_found", "not found");
  }

  // Repeated clicks and client retries carry the same key and return the same intent.
  const idempotencyKey = `${actorId}:${clientKey}`;
  return k.db.transaction().execute(async (tx) => {
    const prior = await tx
      .selectFrom("intent")
      .select("id")
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (prior) return { intentId: prior.id, created: false };
    const intentId = newId("intent");
    await tx
      .insertInto("intent")
      .values({
        id: intentId,
        owner_id: ownerId,
        initiator_id: actorId,
        type: def.type,
        status: "Draft",
        current_revision: 1,
        idempotency_key: idempotencyKey,
        work_item_id: input.workItemId,
      })
      .execute();
    await tx
      .insertInto("intent_revision")
      .values({
        intent_id: intentId,
        revision: 1,
        details: JSON.stringify(details),
        resource_ids: resourceIds,
        digest: revisionDigest(intentId, 1, ownerId, def.type, details),
        created_by: actorId,
      })
      .execute();
    await tx
      .insertInto("intent_event")
      .values({
        intent_id: intentId,
        to_status: "Draft",
        actor_id: actorId,
        actor_kind: "person",
        detail: "{}",
      })
      .execute();
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId,
      action: "intent.prepared",
      subjectType: "intent",
      subjectId: intentId,
      detail: { type: def.type, revision: 1 },
    });
    return { intentId, created: true };
  });
}

async function lockIntent(tx: Tx, intentId: string) {
  const i = await tx
    .selectFrom("intent")
    .selectAll()
    .where("id", "=", intentId)
    .forUpdate()
    .executeTakeFirst();
  if (!i) throw new KernelError("not_found", "not found");
  return i;
}

async function currentRevision(ex: Executor, intentId: string, revision: number) {
  return ex
    .selectFrom("intent_revision")
    .selectAll()
    .where("intent_id", "=", intentId)
    .where("revision", "=", revision)
    .executeTakeFirstOrThrow();
}

export async function reviseIntent(
  k: Kernel,
  actorId: string,
  intentId: string,
  expectedRevision: number,
  rawDetails: unknown,
): Promise<number> {
  return k.db.transaction().execute(async (tx) => {
    const i = await lockIntent(tx, intentId);
    const def = k.registry.intentType(i.type);
    const details = def.details.parse(rawDetails);
    const resourceIds = def.resourcesOf(details);
    const prev = await currentRevision(tx, intentId, i.current_revision);
    // Only the person who prepared it, or the owner, may change it. A delegate
    // rewriting the owner's own draft would escape every delegate control:
    // limits, revocation, attribution and the trusted contact's notice.
    const mayChange = actorId === i.owner_id || actorId === i.initiator_id;
    if (
      !mayChange ||
      !(await mayPrepare(tx, k, actorId, def, [...new Set([...resourceIds, ...prev.resource_ids])]))
    ) {
      throw new KernelError("not_found", "not found");
    }
    if ((await ownerOf(tx, resourceIds)) !== i.owner_id)
      throw new KernelError("invalid", "owner cannot change");
    if (!UNDISPATCHED.includes(i.status))
      throw new KernelError("conflict", `cannot revise when ${i.status}`);
    if (i.current_revision !== expectedRevision)
      throw new KernelError("conflict", "stale revision");
    const cap = await def.capability(tx, i.owner_id, details);
    if (cap.state !== "executable") throw new UnsupportedAction(cap);
    const revision = i.current_revision + 1;
    await tx
      .insertInto("intent_revision")
      .values({
        intent_id: intentId,
        revision,
        details: JSON.stringify(details),
        resource_ids: resourceIds,
        digest: revisionDigest(intentId, revision, i.owner_id, i.type, details),
        created_by: actorId,
      })
      .execute();
    await tx
      .updateTable("intent")
      .set({ current_revision: revision })
      .where("id", "=", intentId)
      .execute();
    // Any earlier approval was for a different digest and no longer applies.
    if (i.status !== "Draft") {
      await transition(tx, k.registry, {
        intentId,
        from: i.status,
        to: "AwaitingApproval",
        actorId,
        actorKind: "person",
        reason: `Changed (revision ${revision}); needs a fresh approval.`,
      });
    }
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: i.owner_id,
      action: "intent.revised",
      subjectType: "intent",
      subjectId: intentId,
      detail: { revision, previous_digest: prev.digest },
    });
    return revision;
  });
}

export async function requestApproval(k: Kernel, actorId: string, intentId: string): Promise<void> {
  await k.db.transaction().execute(async (tx) => {
    const i = await lockIntent(tx, intentId);
    const def = k.registry.intentType(i.type);
    const rev = await currentRevision(tx, intentId, i.current_revision);
    const mayAsk = actorId === i.owner_id || actorId === i.initiator_id;
    if (!mayAsk || !(await mayPrepare(tx, k, actorId, def, rev.resource_ids)))
      throw new KernelError("not_found", "not found");
    // Only a draft can be sent for approval; an approved payment can't be pulled back this way.
    if (i.status !== "Draft") throw new KernelError("conflict", `intent is ${i.status}`);
    await transition(tx, k.registry, {
      intentId,
      from: i.status,
      to: "AwaitingApproval",
      actorId,
      actorKind: "person",
    });
    if (actorId !== i.owner_id) {
      await notify(tx, {
        ownerId: i.owner_id,
        kind: "intent.approval_requested",
        message:
          "A payment is waiting for your approval. Open FamilyOps yourself to review it; approving always needs your passkey.",
        toOwner: true,
      });
    }
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: i.owner_id,
      action: "intent.approval_requested",
      subjectType: "intent",
      subjectId: intentId,
      detail: { revision: i.current_revision },
    });
  });
}

async function expireIfStale(
  tx: Tx,
  k: Kernel,
  i: { id: string; status: string; updated_at: Date },
) {
  if (
    i.status === "AwaitingApproval" &&
    Date.now() - i.updated_at.getTime() > APPROVAL_REQUEST_TTL_MS
  ) {
    await transition(tx, k.registry, {
      intentId: i.id,
      from: "AwaitingApproval",
      to: "Expired",
      actorId: null,
      actorKind: "system",
      reason: "Approval request was not answered within 7 days.",
    });
    return true;
  }
  return false;
}

// What the owner sees before approving: everything on one screen (PRD §5C),
// plus a single-use challenge bound to this revision's digest.
export async function approvalOptions(k: Kernel, ownerId: string, intentId: string) {
  const view = await intentView(k, ownerId, intentId);
  if (view.owner_id !== ownerId) throw new KernelError("forbidden", "only the owner can approve");
  if (view.status !== "AwaitingApproval")
    throw new KernelError("conflict", `intent is ${view.status}`);
  const challenge = await k.db
    .transaction()
    .execute((tx) => issueChallenge(tx, ownerId, "approve", view.revision.digest));
  return { ...view, challenge };
}

export async function approveIntent(
  k: Kernel,
  actorId: string,
  intentId: string,
  revision: number,
  digest: string,
  stepUpResponse: unknown,
): Promise<void> {
  // Expiry is committed on its own so that refusing the approval doesn't roll it back.
  const expired = await k.db.transaction().execute(async (tx) => {
    const i = await lockIntent(tx, intentId);
    return i.owner_id === actorId && (await expireIfStale(tx, k, i));
  });
  if (expired) throw new KernelError("conflict", "approval request expired");
  await k.db.transaction().execute(async (tx) => {
    const i = await lockIntent(tx, intentId);
    // Support staff and delegates are refused here regardless of anything else (P12).
    if (i.owner_id !== actorId) throw new KernelError("forbidden", "only the owner can approve");
    if (i.status !== "AwaitingApproval") throw new KernelError("conflict", `intent is ${i.status}`);
    if (revision !== i.current_revision)
      throw new KernelError("conflict", "a newer revision exists");
    const def = k.registry.intentType(i.type);
    const rev = await currentRevision(tx, intentId, revision);
    const recomputed = revisionDigest(
      intentId,
      revision,
      i.owner_id,
      i.type,
      def.details.parse(rev.details),
    );
    if (digest !== rev.digest || recomputed !== rev.digest) {
      throw new KernelError("conflict", "approval does not match the current request");
    }
    const evidence = await consumeStepUp(
      tx,
      k.stepUp,
      actorId,
      "approve",
      rev.digest,
      stepUpResponse,
    );
    const details = def.details.parse(rev.details);
    const cap = await def.capability(tx, i.owner_id, details);
    if (cap.state !== "executable") throw new UnsupportedAction(cap);
    const approvedAt = new Date();
    await tx
      .insertInto("approval")
      .values({
        id: newId("appr"),
        intent_id: intentId,
        revision,
        digest: rev.digest,
        approver_id: actorId,
        method: String(evidence.method ?? "passkey"),
        evidence: JSON.stringify(evidence),
        approved_at: approvedAt,
        expires_at: def.approvalExpiresAt(details, approvedAt),
      })
      .execute();
    await transition(tx, k.registry, {
      intentId,
      from: "AwaitingApproval",
      to: "Scheduled",
      actorId,
      actorKind: "person",
      detail: { revision, digest: rev.digest },
    });
    await enqueue(tx, "dispatch", { intentId }, { runAt: def.dispatchAt(details) });
    const summary = (await def.describe(tx, details)).summary;
    await notify(tx, {
      ownerId: i.owner_id,
      kind: "intent.approved",
      message: `You approved ${summary}. If this wasn't you, stop all payments and contact support.`,
      toOwner: true,
      // The independent contact hears about payments someone else prepared.
      toTrustedContact: i.initiator_id !== i.owner_id,
      toPeople: i.initiator_id !== i.owner_id ? [i.initiator_id] : [],
    });
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: i.owner_id,
      action: "intent.approved",
      subjectType: "intent",
      subjectId: intentId,
      detail: { revision, digest: rev.digest, stepup_method: evidence.method ?? null },
    });
  });
}

export async function rejectIntent(
  k: Kernel,
  actorId: string,
  intentId: string,
  reason: string | null,
) {
  await k.db.transaction().execute(async (tx) => {
    const i = await lockIntent(tx, intentId);
    if (i.owner_id !== actorId) throw new KernelError("forbidden", "only the owner can reject");
    await transition(tx, k.registry, {
      intentId,
      from: i.status,
      to: "Rejected",
      actorId,
      actorKind: "person",
      reason: reason ?? undefined,
    });
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: i.owner_id,
      action: "intent.rejected",
      subjectType: "intent",
      subjectId: intentId,
    });
  });
}

// Before dispatch, canceling is final. After dispatch it is only a request to
// the provider, which may already be too late; the timeline says which.
export async function cancelIntent(k: Kernel, actorId: string, intentId: string) {
  await k.db.transaction().execute(async (tx) => {
    const i = await lockIntent(tx, intentId);
    const def = k.registry.intentType(i.type);
    const rev = await currentRevision(tx, intentId, i.current_revision);
    const allowed =
      i.owner_id === actorId ||
      (i.initiator_id === actorId && (await mayPrepare(tx, k, actorId, def, rev.resource_ids)));
    if (!allowed) throw new KernelError("not_found", "not found");
    if (isTerminal(k.registry, i.type, i.status))
      throw new KernelError("conflict", `intent is ${i.status}`);
    if (UNDISPATCHED.includes(i.status)) {
      await transition(tx, k.registry, {
        intentId,
        from: i.status,
        to: "Canceled",
        actorId,
        actorKind: "person",
      });
    } else {
      await enqueue(tx, "cancel_in_flight", { intentId });
    }
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: i.owner_id,
      action: UNDISPATCHED.includes(i.status) ? "intent.canceled" : "intent.cancel_requested",
      subjectType: "intent",
      subjectId: intentId,
    });
  });
}

export async function intentView(k: Kernel, actorId: string, intentId: string) {
  const i = await k.db
    .selectFrom("intent")
    .selectAll()
    .where("id", "=", intentId)
    .executeTakeFirst();
  if (!i) throw new KernelError("not_found", "not found");
  const def = k.registry.intentType(i.type);
  const rev = await currentRevision(k.db, intentId, i.current_revision);
  const visible =
    i.owner_id === actorId || (await mayPrepare(k.db, k, actorId, def, rev.resource_ids));
  if (!visible) throw new KernelError("not_found", "not found");
  const details = def.details.parse(rev.details);
  const [description, warnings, capability, events, approval, attempt, people] = await Promise.all([
    def.describe(k.db, details),
    // Warnings draw on balances, other payments and card activity: owner only,
    // or a prepare-only delegate could read the balance by probing amounts.
    i.owner_id === actorId
      ? def.warnings(k.db, i.owner_id, intentId, details)
      : Promise.resolve([]),
    def.capability(k.db, i.owner_id, details),
    k.db
      .selectFrom("intent_event")
      .selectAll()
      .where("intent_id", "=", intentId)
      .orderBy("id")
      .execute(),
    k.db
      .selectFrom("approval")
      .select(["approver_id", "approved_at", "expires_at", "method", "revision", "digest"])
      .where("intent_id", "=", intentId)
      .where("revision", "=", i.current_revision)
      .executeTakeFirst(),
    k.db
      .selectFrom("execution_attempt")
      .select(["executor", "provider_operation_id", "raw_status", "last_checked_at"])
      .where("intent_id", "=", intentId)
      .executeTakeFirst(),
    k.db
      .selectFrom("person")
      .select(["id", "display_name"])
      .where("id", "in", [i.owner_id, i.initiator_id])
      .execute(),
  ]);
  const name = (id: string) => people.find((p) => p.id === id)?.display_name ?? id;
  return {
    id: i.id,
    type: i.type,
    status: i.status,
    hold_reason: i.hold_reason,
    status_reason: i.status_reason,
    owner_id: i.owner_id,
    owner_name: name(i.owner_id),
    initiator_id: i.initiator_id,
    initiator_name: name(i.initiator_id),
    work_item_id: i.work_item_id,
    revision: { number: rev.revision, digest: rev.digest, details, created_at: rev.created_at },
    description,
    warnings,
    capability,
    approval: approval ?? null,
    attempt: attempt ?? null,
    timeline: events,
  };
}

export async function listIntents(k: Kernel, actorId: string) {
  const rows = await k.db
    .selectFrom("intent as i")
    .innerJoin("intent_revision as r", (j) =>
      j.onRef("r.intent_id", "=", "i.id").onRef("r.revision", "=", "i.current_revision"),
    )
    .select([
      "i.id",
      "i.type",
      "i.owner_id",
      "i.initiator_id",
      "i.status",
      "i.hold_reason",
      "i.updated_at",
      "r.resource_ids",
    ])
    .orderBy("i.updated_at", "desc")
    .execute();
  const out = [];
  for (const r of rows) {
    if (r.owner_id === actorId) {
      out.push(r);
      continue;
    }
    const def = k.registry.intentType(r.type);
    if (await mayPrepare(k.db, k, actorId, def, r.resource_ids)) out.push(r);
  }
  return out;
}

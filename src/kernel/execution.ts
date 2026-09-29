import { sql } from "kysely";
import type { Tx } from "../db/index.js";
import { audit } from "./audit.js";
import type { Kernel } from "./context.js";
import { newId } from "./ids.js";
import { enqueue } from "./jobs.js";
import { allowedTransitions, isTerminal, note, transition } from "./lifecycle.js";
import { revisionDigest } from "./intents.js";
import type { IntentTypeDef, LookupResult, SubmitResult } from "./registry.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyIntentType = IntentTypeDef<any>;

const SAFETY_RECONCILE_MS = 2 * 60 * 1000;
const RECONCILE_BACKOFF_MS = [5_000, 30_000, 120_000, 600_000];
const SETTLEMENT_POLL_MS = 60_000;

type GateOutcome =
  | { kind: "noop"; why: string }
  | { kind: "held"; why: string }
  | { kind: "stopped"; status: string; why: string }
  | { kind: "dispatching"; key: string; details: unknown; def: AnyIntentType };

async function hold(tx: Tx, intentId: string, status: string, why: string): Promise<GateOutcome> {
  await tx.updateTable("intent").set({ hold_reason: why }).where("id", "=", intentId).execute();
  await note(tx, intentId, status, "system", `Held: ${why}`);
  return { kind: "held", why };
}

// Every check that authorised this intent is repeated here, inside one
// transaction that holds a lock on the intent and a share lock on the
// delegate's grant. Revocation takes an update lock on the same grant row, so
// the two serialise: if revocation commits first, this sees it and nothing is
// sent; if this commits first, the intent is already Dispatching and
// revocation can only request cancellation (P7, PRD §10).
//
// Lock order is grant, then intent — the same order revocation uses — so the
// two can wait on each other but never deadlock.
async function gate(k: Kernel, tx: Tx, intentId: string): Promise<GateOutcome> {
  const peek = await tx
    .selectFrom("intent")
    .select(["owner_id", "initiator_id"])
    .where("id", "=", intentId)
    .executeTakeFirst();
  if (!peek) return { kind: "noop", why: "missing" };
  const g =
    peek.initiator_id === peek.owner_id
      ? undefined
      : await tx
          .selectFrom("delegation_grant")
          .selectAll()
          .where("grantor_id", "=", peek.owner_id)
          .where("delegate_id", "=", peek.initiator_id)
          .where("status", "<>", "revoked")
          .forShare()
          .executeTakeFirst();
  const i = await tx
    .selectFrom("intent")
    .selectAll()
    .where("id", "=", intentId)
    .forUpdate()
    .executeTakeFirst();
  if (!i || i.status !== "Scheduled")
    return { kind: "noop", why: `status ${i?.status ?? "missing"}` };
  const def = k.registry.intentType(i.type);
  const rev = await tx
    .selectFrom("intent_revision")
    .selectAll()
    .where("intent_id", "=", intentId)
    .where("revision", "=", i.current_revision)
    .executeTakeFirstOrThrow();
  const details = def.details.parse(rev.details);
  const stop = async (to: string, why: string): Promise<GateOutcome> => {
    await transition(tx, k.registry, {
      intentId,
      from: "Scheduled",
      to,
      actorId: null,
      actorKind: "system",
      reason: why,
    });
    return { kind: "stopped", status: to, why };
  };

  if (revisionDigest(intentId, rev.revision, i.owner_id, i.type, details) !== rev.digest) {
    return stop("Canceled", "Stored request does not match its digest.");
  }
  const approval = await tx
    .selectFrom("approval")
    .selectAll()
    .where("intent_id", "=", intentId)
    .where("revision", "=", rev.revision)
    .executeTakeFirst();
  if (!approval || approval.digest !== rev.digest || approval.approver_id !== i.owner_id) {
    return stop("Canceled", "No valid owner approval for this exact request.");
  }
  if (approval.expires_at.getTime() <= Date.now())
    return stop("Expired", "Approval expired before it could be sent.");

  const notBefore = def.dispatchAt(details);
  if (notBefore.getTime() > Date.now()) {
    await enqueue(tx, "dispatch", { intentId }, { runAt: notBefore });
    return { kind: "noop", why: "not yet due" };
  }

  const enabled = await tx
    .selectFrom("system_control")
    .select("value")
    .where("key", "=", "submissions_enabled")
    .executeTakeFirst();
  if (enabled?.value === false)
    return hold(tx, intentId, i.status, "new submissions are paused system-wide");
  const freeze = await tx
    .selectFrom("owner_freeze")
    .select("reason")
    .where("owner_id", "=", i.owner_id)
    .executeTakeFirst();
  if (freeze) return hold(tx, intentId, i.status, `activity frozen (${freeze.reason})`);

  let grant: { id: string; version: number; constraints: Record<string, unknown> } | null = null;
  if (i.initiator_id !== i.owner_id) {
    if (!g) return stop("Canceled", "The person who prepared this no longer has access.");
    if (g.expires_at && g.expires_at.getTime() <= Date.now()) {
      return stop("Canceled", "The access this was prepared under has expired.");
    }
    if (g.status === "paused")
      return hold(tx, intentId, i.status, "access of the person who prepared this is paused");
    const covered = await tx
      .selectFrom("delegation_grant_resource")
      .select("resource_id")
      .where("grant_id", "=", g.id)
      .where("resource_id", "in", rev.resource_ids)
      .execute();
    if (!g.scopes.includes(def.prepareScope) || covered.length !== new Set(rev.resource_ids).size) {
      return stop("Canceled", "Access no longer covers every account this request uses.");
    }
    grant = { id: g.id, version: g.version, constraints: g.constraints };
  }

  const cap = await def.capability(tx, i.owner_id, details);
  if (cap.state !== "executable") return hold(tx, intentId, i.status, cap.reason);

  if (def.reserve) {
    const r = await def.reserve(
      tx,
      { intentId, ownerId: i.owner_id, initiatorId: i.initiator_id, grant },
      details,
    );
    if (!r.ok) return stop("Canceled", r.reason);
  }

  // The provider idempotency key is fixed per intent: every submission,
  // retry or recovery of this intent carries the same one (P8).
  const key = intentId;
  await tx
    .insertInto("execution_attempt")
    .values({
      id: newId("att"),
      intent_id: intentId,
      executor: def.executor.id,
      idempotency_key: key,
    })
    .onConflict((oc) => oc.column("intent_id").doNothing())
    .execute();
  await transition(tx, k.registry, {
    intentId,
    from: "Scheduled",
    to: "Dispatching",
    actorId: null,
    actorKind: "system",
    detail: { grant_version: grant?.version ?? null, revision: rev.revision },
  });
  // If this process dies after commit, reconciliation still finds the intent.
  await enqueue(
    tx,
    "reconcile",
    { intentId },
    { runAt: new Date(Date.now() + SAFETY_RECONCILE_MS) },
  );
  await audit(tx, {
    actorId: null,
    actorKind: "system",
    ownerId: i.owner_id,
    action: "intent.dispatching",
    subjectType: "intent",
    subjectId: intentId,
    detail: {
      revision: rev.revision,
      digest: rev.digest,
      grant_id: grant?.id ?? null,
      grant_version: grant?.version ?? null,
    },
  });
  return { kind: "dispatching", key, details, def };
}

export async function dispatch(k: Kernel, intentId: string): Promise<GateOutcome> {
  const g = await k.db.transaction().execute((tx) => gate(k, tx, intentId));
  if (g.kind !== "dispatching") return g;
  const result = await safeSubmit(g.def, g.key, g.details);
  await applySubmitResult(k, intentId, result, 0);
  return g;
}

async function safeSubmit(
  def: AnyIntentType,
  key: string,
  details: unknown,
): Promise<SubmitResult> {
  try {
    return await def.executor.submit(key, details);
  } catch (e) {
    return { kind: "unknown", reason: e instanceof Error ? e.message : String(e) };
  }
}

async function settle(tx: Tx, def: AnyIntentType, intentId: string, status: string) {
  if (!def.settle) return;
  if (status === "Failed" || def.postSubmission.releasing.includes(status))
    await def.settle(tx, intentId, "released");
  else if (def.postSubmission.verified.includes(status)) await def.settle(tx, intentId, "consumed");
}

async function markWorkVerified(tx: Tx, intentId: string) {
  const i = await tx
    .selectFrom("intent")
    .select(["work_item_id"])
    .where("id", "=", intentId)
    .executeTakeFirstOrThrow();
  if (!i.work_item_id) return;
  await tx
    .updateTable("work_item")
    .set({
      status: "verified_done",
      completion: JSON.stringify({
        kind: "verified",
        intent_id: intentId,
        at: new Date().toISOString(),
      }),
      updated_at: new Date(),
    })
    .where("id", "=", i.work_item_id)
    .execute();
}

// A payment returned after it was counted as done means the obligation is open again.
async function reopenWork(tx: Tx, intentId: string, status: string) {
  const i = await tx
    .selectFrom("intent")
    .select(["work_item_id"])
    .where("id", "=", intentId)
    .executeTakeFirstOrThrow();
  if (!i.work_item_id) return;
  await tx
    .updateTable("work_item")
    .set({
      status: "open",
      completion: JSON.stringify({
        kind: "reopened",
        intent_id: intentId,
        outcome: status,
        at: new Date().toISOString(),
      }),
      updated_at: new Date(),
    })
    .where("id", "=", i.work_item_id)
    .where("status", "in", ["verified_done", "in_progress", "open"])
    .execute();
}

// Moves an intent toward a provider-reported state, one legal step at a time.
// Returns false if the state is not reachable (stale or conflicting report).
async function advanceTo(
  k: Kernel,
  tx: Tx,
  intentId: string,
  target: string,
  detail: Record<string, unknown>,
): Promise<boolean> {
  const i = await tx
    .selectFrom("intent")
    .selectAll()
    .where("id", "=", intentId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (i.status === target) return true;
  const def = k.registry.intentType(i.type);
  const allowed = allowedTransitions(k.registry, i.type);
  const path = [i.status];
  if (i.status === "Dispatching" || i.status === "Reconciling") {
    if (target !== "Failed") path.push("Submitted");
  }
  if (path.at(-1) !== target) path.push(target);
  for (let n = 1; n < path.length; n++) {
    if (!allowed.has(`${path[n - 1]}>${path[n]}`)) return false;
  }
  for (let n = 1; n < path.length; n++) {
    await transition(tx, k.registry, {
      intentId,
      from: path[n - 1]!,
      to: path[n]!,
      actorId: null,
      actorKind: "provider",
      detail,
    });
  }
  await settle(tx, def, intentId, target);
  if (def.postSubmission.verified.includes(target)) await markWorkVerified(tx, intentId);
  if (target === "Failed" || def.postSubmission.releasing.includes(target))
    await reopenWork(tx, intentId, target);
  await audit(tx, {
    actorId: null,
    actorKind: "provider",
    ownerId: i.owner_id,
    action: "intent.provider_state",
    subjectType: "intent",
    subjectId: intentId,
    detail: { from: i.status, to: target, ...detail },
  });
  return true;
}

async function applySubmitResult(
  k: Kernel,
  intentId: string,
  result: SubmitResult,
  attempt: number,
) {
  await k.db.transaction().execute(async (tx) => {
    const i = await tx
      .selectFrom("intent")
      .selectAll()
      .where("id", "=", intentId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const def = k.registry.intentType(i.type);
    if (result.kind === "accepted") {
      await tx
        .updateTable("execution_attempt")
        .set({
          provider_operation_id: result.operationId,
          raw_status: result.rawStatus,
          last_checked_at: new Date(),
        })
        .where("intent_id", "=", intentId)
        .execute();
      const target = def.executor.normalize(result.rawStatus);
      await advanceTo(k, tx, intentId, target, {
        operation_id: result.operationId,
        raw_status: result.rawStatus,
      });
      if (!isTerminal(k.registry, i.type, target) && !def.postSubmission.settled.includes(target)) {
        await enqueue(
          tx,
          "reconcile",
          { intentId },
          { runAt: new Date(Date.now() + SETTLEMENT_POLL_MS) },
        );
      }
    } else if (result.kind === "rejected") {
      if (i.status === "Dispatching" || i.status === "Reconciling") {
        await transition(tx, k.registry, {
          intentId,
          from: i.status,
          to: "Failed",
          actorId: null,
          actorKind: "provider",
          reason: `Provider declined: ${result.reason}`,
        });
        await settle(tx, def, intentId, "Failed");
      }
    } else {
      // Unknown is not failure: the provider may have accepted. Never resubmit
      // blindly; reconcile against the provider by idempotency key (P9).
      if (i.status === "Dispatching") {
        await transition(tx, k.registry, {
          intentId,
          from: "Dispatching",
          to: "Reconciling",
          actorId: null,
          actorKind: "system",
          reason: `Outcome unknown: ${result.reason}`,
        });
      }
      const delay = RECONCILE_BACKOFF_MS[Math.min(attempt, RECONCILE_BACKOFF_MS.length - 1)]!;
      await enqueue(
        tx,
        "reconcile",
        { intentId, attempt: attempt + 1 },
        { runAt: new Date(Date.now() + delay) },
      );
    }
  });
}

export async function reconcile(k: Kernel, intentId: string, attempt = 0): Promise<void> {
  const i = await k.db
    .selectFrom("intent")
    .selectAll()
    .where("id", "=", intentId)
    .executeTakeFirst();
  if (!i) return;
  const def = k.registry.intentType(i.type);
  const att = await k.db
    .selectFrom("execution_attempt")
    .selectAll()
    .where("intent_id", "=", intentId)
    .executeTakeFirst();
  if (!att) return;

  if (i.status === "Dispatching" || i.status === "Reconciling") {
    let found: LookupResult;
    try {
      found = await def.executor.lookup(att.idempotency_key);
    } catch (e) {
      found = { kind: "unknown", reason: e instanceof Error ? e.message : String(e) };
    }
    if (found.kind === "found") {
      await applySubmitResult(
        k,
        intentId,
        { kind: "accepted", operationId: found.operationId, rawStatus: found.rawStatus },
        attempt,
      );
    } else if (found.kind === "not_found" && def.executor.idempotentRetry) {
      // Safe only because the provider guarantees one operation per key.
      const rev = await k.db
        .selectFrom("intent_revision")
        .select("details")
        .where("intent_id", "=", intentId)
        .where("revision", "=", i.current_revision)
        .executeTakeFirstOrThrow();
      await applySubmitResult(
        k,
        intentId,
        await safeSubmit(def, att.idempotency_key, def.details.parse(rev.details)),
        attempt,
      );
    } else if (found.kind === "not_found") {
      await k.db.transaction().execute(async (tx) => {
        if (i.status === "Dispatching") {
          await transition(tx, k.registry, {
            intentId,
            from: "Dispatching",
            to: "Reconciling",
            actorId: null,
            actorKind: "system",
            reason:
              "Needs manual reconciliation: provider has no record and does not support safe resubmission.",
          });
        } else {
          await note(
            tx,
            intentId,
            i.status,
            "system",
            "Needs manual reconciliation: provider has no record and does not support safe resubmission.",
          );
        }
      });
    } else {
      await applySubmitResult(k, intentId, found, attempt);
    }
    return;
  }

  if (
    att.provider_operation_id &&
    !isTerminal(k.registry, i.type, i.status) &&
    !def.postSubmission.settled.includes(i.status)
  ) {
    const op = await def.executor.getOperation(att.provider_operation_id);
    await k.db.transaction().execute(async (tx) => {
      if (op.kind === "found") {
        await tx
          .updateTable("execution_attempt")
          .set({ raw_status: op.rawStatus, last_checked_at: new Date() })
          .where("intent_id", "=", intentId)
          .execute();
        await advanceTo(k, tx, intentId, def.executor.normalize(op.rawStatus), {
          raw_status: op.rawStatus,
          via: "poll",
        });
      }
      const now = await tx
        .selectFrom("intent")
        .select("status")
        .where("id", "=", intentId)
        .executeTakeFirstOrThrow();
      if (
        !isTerminal(k.registry, i.type, now.status) &&
        !def.postSubmission.settled.includes(now.status)
      ) {
        await enqueue(
          tx,
          "reconcile",
          { intentId },
          { runAt: new Date(Date.now() + SETTLEMENT_POLL_MS) },
        );
      }
    });
  }
}

export async function receiveWebhook(
  k: Kernel,
  executorId: string,
  headers: Record<string, string | undefined>,
  body: string,
): Promise<boolean> {
  const def = [...k.registry.intentTypes.values()].find((t) => t.executor.id === executorId);
  if (!def) return false;
  const event = def.executor.verifyWebhook(headers, body);
  if (!event) return false;
  await k.db.transaction().execute(async (tx) => {
    const ins = await tx
      .insertInto("inbox_event")
      .values({ provider: executorId, event_id: event.eventId, payload: JSON.stringify(event) })
      .onConflict((oc) => oc.columns(["provider", "event_id"]).doNothing())
      .returning("event_id")
      .executeTakeFirst();
    if (ins) {
      await enqueue(tx, "process_inbox", { provider: executorId, eventId: event.eventId });
    }
  });
  return true;
}

export class AttemptNotYetKnown extends Error {}

export async function processInbox(k: Kernel, provider: string, eventId: string): Promise<void> {
  await k.db.transaction().execute(async (tx) => {
    const ev = await tx
      .selectFrom("inbox_event")
      .selectAll()
      .where("provider", "=", provider)
      .where("event_id", "=", eventId)
      .forUpdate()
      .executeTakeFirst();
    if (!ev || ev.processed_at) return;
    const payload = ev.payload as unknown as { operationId: string; rawStatus: string };
    const att = await tx
      .selectFrom("execution_attempt")
      .selectAll()
      .where("executor", "=", provider)
      .where("provider_operation_id", "=", payload.operationId)
      .executeTakeFirst();
    // The event can beat our own record of the submission; the job retries.
    if (!att) throw new AttemptNotYetKnown(`no attempt for operation ${payload.operationId}`);
    const i = await tx
      .selectFrom("intent")
      .selectAll()
      .where("id", "=", att.intent_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const def = k.registry.intentType(i.type);
    const target = def.executor.normalize(payload.rawStatus);
    const applied = await advanceTo(k, tx, i.id, target, {
      event_id: eventId,
      raw_status: payload.rawStatus,
    });
    if (!applied) {
      // Out of order or conflicting: ask the provider what is actually true.
      const op = await def.executor.getOperation(payload.operationId);
      const note_ =
        op.kind === "found" &&
        (await advanceTo(k, tx, i.id, def.executor.normalize(op.rawStatus), {
          via: "authoritative_fetch",
          event_id: eventId,
        }))
          ? `Stale event (${payload.rawStatus}) superseded by provider state ${op.kind === "found" ? op.rawStatus : "?"}.`
          : `Ignored event (${payload.rawStatus}) that conflicts with current state.`;
      await note(
        tx,
        i.id,
        (
          await tx
            .selectFrom("intent")
            .select("status")
            .where("id", "=", i.id)
            .executeTakeFirstOrThrow()
        ).status,
        "provider",
        note_,
        { event_id: eventId },
      );
    }
    await tx
      .updateTable("inbox_event")
      .set({ processed_at: sql<Date>`now()` })
      .where("provider", "=", provider)
      .where("event_id", "=", eventId)
      .execute();
  });
}

export async function cancelInFlight(
  k: Kernel,
  intentId: string,
): Promise<"requested" | "retry_later" | "nothing_to_do"> {
  const i = await k.db
    .selectFrom("intent")
    .selectAll()
    .where("id", "=", intentId)
    .executeTakeFirst();
  if (!i || isTerminal(k.registry, i.type, i.status)) return "nothing_to_do";
  const def = k.registry.intentType(i.type);
  const att = await k.db
    .selectFrom("execution_attempt")
    .selectAll()
    .where("intent_id", "=", intentId)
    .executeTakeFirst();
  if (!att?.provider_operation_id) return "retry_later";
  const res = await def.executor.cancel(att.provider_operation_id);
  await k.db.transaction().execute(async (tx) => {
    await note(
      tx,
      intentId,
      i.status,
      "system",
      res.canceled
        ? "Cancellation accepted by provider."
        : `Cancellation not possible: ${res.reason}`,
    );
    await audit(tx, {
      actorId: null,
      actorKind: "system",
      ownerId: i.owner_id,
      action: "intent.cancel_attempted",
      subjectType: "intent",
      subjectId: intentId,
      detail: { canceled: res.canceled, reason: res.reason },
    });
  });
  if (res.canceled) await reconcile(k, intentId);
  return "requested";
}

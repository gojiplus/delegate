import { isSupport } from "./access.js";
import { audit } from "./audit.js";
import type { Kernel } from "./context.js";
import { enqueue } from "./jobs.js";
import { KernelError } from "./registry.js";
import { consumeStepUp } from "./stepup.js";

// Operational controls. Support can stop money moving (freeze an owner, pause
// all new submissions) but cannot start it: nothing here approves, and resuming
// an owner frozen for recovery needs that owner's fresh step-up.

async function requireSupport(k: Kernel, actorId: string) {
  if (!(await isSupport(k.db, actorId))) throw new KernelError("forbidden", "support only");
}

export async function setSubmissionsEnabled(k: Kernel, actorId: string, enabled: boolean) {
  await requireSupport(k, actorId);
  await k.db.transaction().execute(async (tx) => {
    await tx
      .updateTable("system_control")
      .set({ value: JSON.stringify(enabled) })
      .where("key", "=", "submissions_enabled")
      .execute();
    if (enabled) {
      const held = await tx
        .selectFrom("intent")
        .select("id")
        .where("status", "=", "Scheduled")
        .where("hold_reason", "is not", null)
        .execute();
      for (const h of held)
        await enqueue(tx, "dispatch", { intentId: h.id }, { jobKey: `dispatch:${h.id}` });
    }
    await audit(tx, {
      actorId,
      actorKind: "support",
      ownerId: null,
      action: enabled ? "control.submissions_enabled" : "control.submissions_paused",
    });
  });
}

export async function freezeOwner(k: Kernel, actorId: string, ownerId: string, reason: string) {
  const bySupport = actorId !== ownerId;
  if (bySupport) await requireSupport(k, actorId);
  await k.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("owner_freeze")
      .values({ owner_id: ownerId, reason, frozen_by: actorId })
      .onConflict((oc) => oc.column("owner_id").doUpdateSet({ reason, frozen_by: actorId }))
      .execute();
    await audit(tx, {
      actorId,
      actorKind: bySupport ? "support" : "person",
      ownerId,
      action: "control.owner_frozen",
      detail: { reason },
    });
  });
}

// Only the owner can lift a freeze, and only with step-up; support can freeze
// but a support account alone can never restart someone else's money.
export async function unfreezeOwner(k: Kernel, ownerId: string, stepUpResponse: unknown) {
  await k.db.transaction().execute(async (tx) => {
    const f = await tx
      .selectFrom("owner_freeze")
      .selectAll()
      .where("owner_id", "=", ownerId)
      .forUpdate()
      .executeTakeFirst();
    if (!f) return;
    await consumeStepUp(tx, k.stepUp, ownerId, "recovery", `unfreeze:${ownerId}`, stepUpResponse);
    await tx.deleteFrom("owner_freeze").where("owner_id", "=", ownerId).execute();
    const held = await tx
      .selectFrom("intent")
      .select("id")
      .where("owner_id", "=", ownerId)
      .where("status", "=", "Scheduled")
      .where("hold_reason", "is not", null)
      .execute();
    for (const h of held)
      await enqueue(tx, "dispatch", { intentId: h.id }, { jobKey: `dispatch:${h.id}` });
    await audit(tx, {
      actorId: ownerId,
      actorKind: "person",
      ownerId,
      action: "control.owner_unfrozen",
    });
  });
}

// Recovery (lost passkey). The owner's old credentials are removed and all
// execution is frozen until the owner completes independent verification and
// enrols a new passkey. A delegate can neither start nor finish this: the
// actor must be the owner (in R0 the independent verification is simulated).
export async function startRecovery(k: Kernel, actorId: string, ownerId: string) {
  if (actorId !== ownerId && !(await isSupport(k.db, actorId))) {
    throw new KernelError("forbidden", "only the owner or support can start recovery");
  }
  await k.db.transaction().execute(async (tx) => {
    await tx.deleteFrom("webauthn_credential").where("person_id", "=", ownerId).execute();
    await tx
      .insertInto("owner_freeze")
      .values({ owner_id: ownerId, reason: "account recovery in progress", frozen_by: actorId })
      .onConflict((oc) =>
        oc
          .column("owner_id")
          .doUpdateSet({ reason: "account recovery in progress", frozen_by: actorId }),
      )
      .execute();
    await audit(tx, {
      actorId,
      actorKind: actorId === ownerId ? "person" : "support",
      ownerId,
      action: "recovery.started",
    });
  });
}

// Support sees states, times and references, never amounts, payees or balances.
export async function supportOverview(k: Kernel, actorId: string) {
  await requireSupport(k, actorId);
  const [intents, freezes, control] = await Promise.all([
    k.db
      .selectFrom("intent as i")
      .leftJoin("execution_attempt as a", "a.intent_id", "i.id")
      .select([
        "i.id",
        "i.owner_id",
        "i.type",
        "i.status",
        "i.hold_reason",
        "i.status_reason",
        "i.updated_at",
        "a.provider_operation_id",
        "a.raw_status",
        "a.last_checked_at",
      ])
      .where("i.status", "in", [
        "Dispatching",
        "Reconciling",
        "Submitted",
        "Scheduled",
        "Failed",
        "Returned",
      ])
      .orderBy("i.updated_at", "desc")
      .limit(200)
      .execute(),
    k.db.selectFrom("owner_freeze").selectAll().execute(),
    k.db.selectFrom("system_control").selectAll().execute(),
  ]);
  return { intents, freezes, control };
}

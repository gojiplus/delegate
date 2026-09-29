import { z } from "zod";
import { audit } from "./audit.js";
import { canAccess, visibleResourceIds } from "./access.js";
import type { Kernel } from "./context.js";
import { newId } from "./ids.js";
import { KernelError } from "./registry.js";

// Work items are the shared queue: things someone has to handle. Each carries
// its evidence level — provider-reported, confirmed by a person, or inferred
// from a pattern — because an inference is a prompt to look, not a fact.
// "Marked done" by a person is kept distinct from "verified done", which only
// the system records from evidence such as a posted payment.

export const NewWorkItem = z.object({
  resourceId: z.string(),
  type: z.string(),
  title: z.string().min(1).max(200),
  details: z.record(z.string(), z.unknown()).default({}),
  evidenceLevel: z.enum(["provider", "user_confirmed", "inferred"]),
  source: z.string().min(1),
  observedAt: z.iso.datetime().optional(),
});

export async function createWorkItem(
  k: Kernel,
  actorId: string,
  input: z.infer<typeof NewWorkItem>,
): Promise<string> {
  const def = k.registry.workItemType(input.type);
  const details = def.details.parse(input.details);
  if (!(await canAccess(k.db, k.registry, actorId, def.scope, input.resourceId))) {
    throw new KernelError("not_found", "not found");
  }
  const resource = await k.db
    .selectFrom("resource")
    .select("owner_id")
    .where("id", "=", input.resourceId)
    .executeTakeFirstOrThrow();
  const id = newId("work");
  await k.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("work_item")
      .values({
        id,
        owner_id: resource.owner_id,
        resource_id: input.resourceId,
        type: input.type,
        title: input.title,
        details: JSON.stringify(details),
        evidence_level: input.evidenceLevel,
        source: input.source,
        observed_at: input.observedAt ?? new Date(),
        status: "open",
        created_by: actorId,
      })
      .execute();
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: resource.owner_id,
      action: "work_item.created",
      subjectType: "work_item",
      subjectId: id,
      detail: { type: input.type, evidence_level: input.evidenceLevel },
    });
  });
  return id;
}

export async function visibleWorkItems(k: Kernel, actorId: string) {
  const out = [];
  for (const def of k.registry.workItemTypes.values()) {
    const ids = await visibleResourceIds(k.db, k.registry, actorId, def.scope);
    if (!ids.length) continue;
    const rows = await k.db
      .selectFrom("work_item as w")
      .innerJoin("person as o", "o.id", "w.owner_id")
      .innerJoin("resource as r", "r.id", "w.resource_id")
      .leftJoin("person as a", "a.id", "w.assignee_id")
      .select([
        "w.id",
        "w.owner_id",
        "o.display_name as owner_name",
        "w.resource_id",
        "r.label as resource_label",
        "w.type",
        "w.title",
        "w.details",
        "w.evidence_level",
        "w.source",
        "w.observed_at",
        "w.status",
        "w.assignee_id",
        "a.display_name as assignee_name",
        "w.completion",
      ])
      .where("w.type", "=", def.type)
      .where("w.resource_id", "in", ids)
      .where("w.status", "<>", "dismissed")
      .execute();
    out.push(...rows);
  }
  return out;
}

export async function updateWorkItem(
  k: Kernel,
  actorId: string,
  id: string,
  change: {
    status?: "open" | "in_progress" | "marked_done" | "dismissed";
    assigneeId?: string | null;
  },
): Promise<void> {
  await k.db.transaction().execute(async (tx) => {
    const w = await tx
      .selectFrom("work_item")
      .selectAll()
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!w) throw new KernelError("not_found", "not found");
    const def = k.registry.workItemType(w.type);
    if (!(await canAccess(tx, k.registry, actorId, def.scope, w.resource_id))) {
      throw new KernelError("not_found", "not found");
    }
    if (w.status === "verified_done") throw new KernelError("conflict", "already verified");
    // Only the owner can dismiss: a dismissed bill disappears for everyone, so
    // a delegate dismissing one would hide it from the owner.
    if (change.status === "dismissed" && actorId !== w.owner_id) {
      throw new KernelError("forbidden", "only the owner can dismiss this");
    }
    if (change.assigneeId) {
      const assigneeOk =
        change.assigneeId === w.owner_id ||
        (await canAccess(tx, k.registry, change.assigneeId, def.scope, w.resource_id));
      if (!assigneeOk) throw new KernelError("invalid", "assignee cannot see this item");
    }
    await tx
      .updateTable("work_item")
      .set({
        status: change.status ?? w.status,
        assignee_id: change.assigneeId === undefined ? w.assignee_id : change.assigneeId,
        completion:
          change.status === "marked_done"
            ? JSON.stringify({ kind: "marked_done", by: actorId, at: new Date().toISOString() })
            : w.completion === null
              ? null
              : JSON.stringify(w.completion),
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
    await audit(tx, {
      actorId,
      actorKind: "person",
      ownerId: w.owner_id,
      action: "work_item.updated",
      subjectType: "work_item",
      subjectId: id,
      detail: change,
    });
  });
}

import { sql } from "kysely";
import type { Executor } from "../db/index.js";
import { KernelError, type Registry } from "./registry.js";

// Authorisation is plain SQL over grants rather than a policy engine. The
// rules that matter here are stateful (grant versions, row locks against
// revocation, spending reservations), which a stateless engine such as Cedar
// cannot enforce, so it would add a second system without removing any code.
//
// The one rule: an actor may exercise `scope` on a resource if they own it, or
// if its owner selected it, it is shareable, and a live grant from the owner to
// the actor names both the scope and the resource. Group membership,
// invitations and payment of the subscription confer nothing.

function liveGrant(ex: Executor) {
  return ex
    .selectFrom("delegation_grant as g")
    .where("g.status", "=", "active")
    .where((eb) =>
      eb.or([eb("g.expires_at", "is", null), eb("g.expires_at", ">", sql<Date>`now()`)]),
    );
}

export async function visibleResourceIds(
  ex: Executor,
  registry: Registry,
  actorId: string,
  scope: string,
): Promise<string[]> {
  const types = registry.scope(scope).resourceTypes;
  const owned = await ex
    .selectFrom("resource")
    .select("id")
    .where("owner_id", "=", actorId)
    .where("type", "in", types)
    .execute();
  const granted = await liveGrant(ex)
    .innerJoin("delegation_grant_resource as gr", "gr.grant_id", "g.id")
    .innerJoin("resource as r", "r.id", "gr.resource_id")
    .select("r.id")
    .where("g.delegate_id", "=", actorId)
    .where(sql<boolean>`${scope} = any(g.scopes)`)
    .whereRef("r.owner_id", "=", "g.grantor_id")
    .where("r.selected", "=", true)
    .where("r.shareable", "=", true)
    .where("r.type", "in", types)
    .execute();
  return [...new Set([...owned, ...granted].map((r) => r.id))];
}

export async function canAccess(
  ex: Executor,
  registry: Registry,
  actorId: string,
  scope: string,
  resourceId: string,
): Promise<boolean> {
  const types = registry.scope(scope).resourceTypes;
  const r = await ex
    .selectFrom("resource")
    .selectAll()
    .where("id", "=", resourceId)
    .executeTakeFirst();
  if (!r || !types.includes(r.type)) return false;
  if (r.owner_id === actorId) return true;
  if (!r.selected || !r.shareable) return false;
  const g = await liveGrant(ex)
    .innerJoin("delegation_grant_resource as gr", "gr.grant_id", "g.id")
    .select("g.id")
    .where("g.grantor_id", "=", r.owner_id)
    .where("g.delegate_id", "=", actorId)
    .where("gr.resource_id", "=", resourceId)
    .where(sql<boolean>`${scope} = any(g.scopes)`)
    .executeTakeFirst();
  return g !== undefined;
}

// Unauthorised and nonexistent look identical, so a guessed ID reveals nothing.
export async function requireAccess(
  ex: Executor,
  registry: Registry,
  actorId: string,
  scope: string,
  resourceId: string,
): Promise<void> {
  if (!(await canAccess(ex, registry, actorId, scope, resourceId))) {
    throw new KernelError("not_found", "not found");
  }
}

// Owners with whom the actor has any live grant, for navigation only.
export async function peopleIHelp(ex: Executor, actorId: string) {
  return liveGrant(ex)
    .innerJoin("person as p", "p.id", "g.grantor_id")
    .select(["p.id", "p.display_name"])
    .where("g.delegate_id", "=", actorId)
    .orderBy("p.display_name")
    .execute();
}

export async function isSupport(ex: Executor, personId: string): Promise<boolean> {
  const r = await ex
    .selectFrom("staff_role")
    .select("role")
    .where("person_id", "=", personId)
    .executeTakeFirst();
  return r?.role === "support";
}

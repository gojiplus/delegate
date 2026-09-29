import { z } from "zod";
import type { Executor, Tx } from "../db/index.js";
import { audit } from "./audit.js";
import { digestOf } from "./canonical.js";
import type { Kernel } from "./context.js";
import { newId } from "./ids.js";
import { enqueue } from "./jobs.js";
import { UNDISPATCHED, isTerminal, note, transition } from "./lifecycle.js";
import { sameMailbox } from "./contacts.js";
import { notify } from "./notify.js";
import { KernelError, type Registry } from "./registry.js";
import { consumeStepUp } from "./stepup.js";

export const GrantProposal = z.object({
  delegateId: z.string(),
  scopes: z.array(z.string()).min(1),
  resourceIds: z.array(z.string()).min(1),
  constraints: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  expiresAt: z.iso.datetime().nullable().default(null),
});
export type GrantProposal = z.infer<typeof GrantProposal>;

function normalise(p: GrantProposal): GrantProposal {
  return {
    ...p,
    scopes: [...new Set(p.scopes)].sort(),
    resourceIds: [...new Set(p.resourceIds)].sort(),
  };
}

// What the grantor's passkey signs: the exact grant, not "a grant".
export function grantDigest(grantorId: string, p: GrantProposal): string {
  return digestOf({ op: "grant", grantorId, ...normalise(p) });
}

async function validate(ex: Executor, registry: Registry, grantorId: string, p: GrantProposal) {
  if (p.delegateId === grantorId) throw new KernelError("invalid", "cannot grant to yourself");
  const delegate = await ex
    .selectFrom("person")
    .select("id")
    .where("id", "=", p.delegateId)
    .executeTakeFirst();
  if (!delegate) throw new KernelError("invalid", "unknown delegate");
  const resources = await ex
    .selectFrom("resource")
    .selectAll()
    .where("id", "in", p.resourceIds)
    .execute();
  if (resources.length !== new Set(p.resourceIds).size)
    throw new KernelError("invalid", "unknown resource");
  for (const r of resources) {
    if (r.owner_id !== grantorId)
      throw new KernelError("invalid", "you can only share what you own");
    if (!r.selected)
      throw new KernelError("invalid", `${r.label} is not selected for use in the app`);
    if (!r.shareable)
      throw new KernelError("invalid", `${r.label} cannot be shared: ${r.unshareable_reason}`);
  }
  for (const s of p.scopes) {
    const def = registry.scope(s);
    if (!resources.some((r) => def.resourceTypes.includes(r.type))) {
      throw new KernelError("invalid", `scope ${s} applies to none of the selected resources`);
    }
  }
  for (const [moduleId, c] of Object.entries(p.constraints)) {
    const schema = registry.grantConstraints.get(moduleId);
    if (!schema) throw new KernelError("invalid", `no constraints defined for ${moduleId}`);
    const parsed = schema.safeParse(c);
    if (!parsed.success) throw new KernelError("invalid", `invalid ${moduleId} constraints`);
  }
  return resources;
}

export interface GrantPreview {
  digest: string;
  delegateName: string;
  sentences: string[];
}

// Plain-language preview of exactly what the delegate will be able to do.
export async function previewGrant(
  k: Kernel,
  grantorId: string,
  input: GrantProposal,
): Promise<GrantPreview> {
  const p = normalise(input);
  const resources = await validate(k.db, k.registry, grantorId, p);
  const delegate = await k.db
    .selectFrom("person")
    .select("display_name")
    .where("id", "=", p.delegateId)
    .executeTakeFirstOrThrow();
  const sentences = p.scopes.map((s) => {
    const def = k.registry.scope(s);
    const labels = resources.filter((r) => def.resourceTypes.includes(r.type)).map((r) => r.label);
    return `${def.describe}: ${labels.join(", ")}.`;
  });
  for (const [moduleId, c] of Object.entries(p.constraints)) {
    const describe = k.registry.constraintDescribers.get(moduleId);
    if (!describe) throw new KernelError("invalid", `no description for ${moduleId} limits`);
    sentences.push(...describe(c));
  }

  sentences.push(
    p.expiresAt
      ? `Access ends automatically on ${p.expiresAt.slice(0, 10)}.`
      : "Access lasts until you revoke it.",
  );
  sentences.push(
    `${delegate.display_name} cannot approve payments, change this access, or see anything else you own.`,
  );
  return { digest: grantDigest(grantorId, p), delegateName: delegate.display_name, sentences };
}

async function writeResources(tx: Tx, grantId: string, resourceIds: string[]) {
  await tx.deleteFrom("delegation_grant_resource").where("grant_id", "=", grantId).execute();
  await tx
    .insertInto("delegation_grant_resource")
    .values(resourceIds.map((resource_id) => ({ grant_id: grantId, resource_id })))
    .execute();
}

async function liveGrantForPair(tx: Tx, grantorId: string, delegateId: string) {
  return tx
    .selectFrom("delegation_grant")
    .selectAll()
    .where("grantor_id", "=", grantorId)
    .where("delegate_id", "=", delegateId)
    .where("status", "<>", "revoked")
    .forUpdate()
    .executeTakeFirst();
}

// Creates the grant, or replaces the live one for this pair with a new version.
// Only the grantor can call this, and only with a fresh passkey assertion over
// the exact proposal, so a delegate can never widen their own access (P10).
export async function setGrant(
  k: Kernel,
  grantorId: string,
  input: GrantProposal,
  stepUpResponse: unknown,
): Promise<{ grantId: string; version: number }> {
  const p = normalise(input);
  return k.db.transaction().execute(async (tx) => {
    await validate(tx, k.registry, grantorId, p);
    const evidence = await consumeStepUp(
      tx,
      k.stepUp,
      grantorId,
      "grant",
      grantDigest(grantorId, p),
      stepUpResponse,
    );
    const existing = await liveGrantForPair(tx, grantorId, p.delegateId);
    let grantId: string;
    let version: number;
    if (existing) {
      grantId = existing.id;
      version = existing.version + 1;
      await tx
        .updateTable("delegation_grant")
        .set({
          scopes: p.scopes,
          constraints: JSON.stringify(p.constraints),
          expires_at: p.expiresAt,
          version,
          updated_at: new Date(),
        })
        .where("id", "=", grantId)
        .execute();
    } else {
      grantId = newId("grant");
      version = 1;
      await tx
        .insertInto("delegation_grant")
        .values({
          id: grantId,
          grantor_id: grantorId,
          delegate_id: p.delegateId,
          scopes: p.scopes,
          constraints: JSON.stringify(p.constraints),
          status: "active",
          expires_at: p.expiresAt,
        })
        .execute();
    }
    await writeResources(tx, grantId, p.resourceIds);
    const delegate = await tx
      .selectFrom("person")
      .select(["display_name", "email"])
      .where("id", "=", p.delegateId)
      .executeTakeFirstOrThrow();
    const contact = await tx
      .selectFrom("trusted_contact")
      .select("email")
      .where("owner_id", "=", grantorId)
      .executeTakeFirst();
    if (contact && sameMailbox(contact.email) === sameMailbox(delegate.email)) {
      throw new KernelError("invalid", "your trusted contact cannot also help with your accounts");
    }
    const preparesPayments = p.scopes.some((s) => s.endsWith(".prepare"));
    await notify(tx, {
      ownerId: grantorId,
      kind: existing ? "grant.changed" : "grant.created",
      message: `${delegate.display_name} ${existing ? "now has changed" : "now has"} access to ${p.resourceIds.length} of your accounts${preparesPayments ? ", including preparing payments for your approval" : ""}. If you didn't do this, revoke it and contact support.`,
      toOwner: true,
      toTrustedContact: true,
      toPeople: [p.delegateId],
    });
    await audit(tx, {
      actorId: grantorId,
      actorKind: "person",
      ownerId: grantorId,
      action: existing ? "grant.updated" : "grant.created",
      subjectType: "grant",
      subjectId: grantId,
      detail: {
        version,
        delegate_id: p.delegateId,
        scopes: p.scopes,
        resource_ids: p.resourceIds,
        constraints: p.constraints,
        expires_at: p.expiresAt,
        previous: existing ? { version: existing.version, scopes: existing.scopes } : null,
        stepup: {
          method: evidence.method ?? "unknown",
          credential_id: evidence.credentialId ?? null,
        },
      },
    });
    return { grantId, version };
  });
}

export const resumeBinding = (grantId: string, version: number) => `resume:${grantId}:${version}`;

// Reducing access never requires step-up: making revocation hard would only
// protect the delegate. Pause and revoke take effect at commit. Resuming
// restores authority, so it needs the grantor's passkey like any widening,
// and the owner and trusted contact are told.
export async function setGrantStatus(
  k: Kernel,
  grantorId: string,
  grantId: string,
  status: "active" | "paused" | "revoked",
  stepUpResponse?: unknown,
): Promise<{ inFlight: string[] }> {
  return k.db.transaction().execute(async (tx) => {
    const g = await tx
      .selectFrom("delegation_grant")
      .selectAll()
      .where("id", "=", grantId)
      .forUpdate()
      .executeTakeFirst();
    if (!g || g.grantor_id !== grantorId) throw new KernelError("not_found", "not found");
    if (g.status === "revoked") throw new KernelError("conflict", "grant already revoked");
    if (status === "active") {
      if (g.status === "active") return { inFlight: [] };
      await consumeStepUp(
        tx,
        k.stepUp,
        grantorId,
        "grant",
        resumeBinding(grantId, g.version),
        stepUpResponse,
      );
      const d = await tx
        .selectFrom("person")
        .select("display_name")
        .where("id", "=", g.delegate_id)
        .executeTakeFirstOrThrow();
      await notify(tx, {
        ownerId: grantorId,
        kind: "grant.resumed",
        message: `${d.display_name}'s paused access to your accounts was resumed. If you didn't do this, revoke it and contact support.`,
        toOwner: true,
        toTrustedContact: true,
      });
    }
    await tx
      .updateTable("delegation_grant")
      .set({
        status,
        version: g.version + 1,
        updated_at: new Date(),
        revoked_at: status === "revoked" ? new Date() : null,
      })
      .where("id", "=", grantId)
      .execute();

    const intents = await tx
      .selectFrom("intent")
      .select(["id", "type", "status"])
      .where("owner_id", "=", g.grantor_id)
      .where("initiator_id", "=", g.delegate_id)
      .forUpdate()
      .execute();
    const inFlight: string[] = [];
    for (const i of intents) {
      if (isTerminal(k.registry, i.type, i.status)) continue;
      if (status === "revoked" && UNDISPATCHED.includes(i.status)) {
        await transition(tx, k.registry, {
          intentId: i.id,
          from: i.status,
          to: "Canceled",
          actorId: grantorId,
          actorKind: "person",
          reason: "The person who prepared this lost access before it was sent.",
        });
      } else if (status === "revoked") {
        inFlight.push(i.id);
        await note(
          tx,
          i.id,
          i.status,
          "person",
          "Access revoked while this was already in flight; cancellation will be attempted.",
          {},
          grantorId,
        );
        await enqueue(tx, "cancel_in_flight", { intentId: i.id });
      } else if (status === "active" && i.status === "Scheduled") {
        await enqueue(tx, "dispatch", { intentId: i.id });
      }
    }
    await notify(tx, {
      ownerId: grantorId,
      kind: `grant.${status}`,
      message:
        status === "revoked"
          ? "Your access to someone's accounts has been revoked."
          : status === "paused"
            ? "Your access to someone's accounts has been paused."
            : "Your access to someone's accounts has been resumed.",
      toPeople: [g.delegate_id],
    });
    await audit(tx, {
      actorId: grantorId,
      actorKind: "person",
      ownerId: grantorId,
      action: `grant.${status === "active" ? "resumed" : status}`,
      subjectType: "grant",
      subjectId: grantId,
      detail: { version: g.version + 1, delegate_id: g.delegate_id, in_flight: inFlight },
    });
    return { inFlight };
  });
}

export async function requestMoreAccess(
  k: Kernel,
  delegateId: string,
  grantorId: string,
  scopes: string[],
  resourceIds: string[],
  note: string | null,
): Promise<string> {
  const id = newId("greq");
  await k.db.transaction().execute(async (tx) => {
    for (const s of scopes) k.registry.scope(s);
    // Only someone already helping may ask for more; strangers can't use
    // requests as a way to reach an owner with a persuasive note.
    const existing = await tx
      .selectFrom("delegation_grant")
      .select("id")
      .where("grantor_id", "=", grantorId)
      .where("delegate_id", "=", delegateId)
      .where("status", "<>", "revoked")
      .executeTakeFirst();
    if (!existing) throw new KernelError("not_found", "not found");
    await tx
      .insertInto("grant_request")
      .values({
        id,
        grantor_id: grantorId,
        delegate_id: delegateId,
        scopes,
        resource_ids: resourceIds,
        note,
        status: "pending",
      })
      .execute();
    await audit(tx, {
      actorId: delegateId,
      actorKind: "person",
      ownerId: grantorId,
      action: "grant.requested",
      subjectType: "grant_request",
      subjectId: id,
      detail: { scopes, resource_ids: resourceIds },
    });
  });
  return id;
}

// For a pending request: the current grant and the proposal, side by side.
export async function describeRequest(k: Kernel, grantorId: string, requestId: string) {
  const req = await k.db
    .selectFrom("grant_request")
    .selectAll()
    .where("id", "=", requestId)
    .where("grantor_id", "=", grantorId)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!req) throw new KernelError("not_found", "not found");
  const current = await k.db
    .selectFrom("delegation_grant")
    .selectAll()
    .where("grantor_id", "=", grantorId)
    .where("delegate_id", "=", req.delegate_id)
    .where("status", "<>", "revoked")
    .executeTakeFirst();
  const currentResources = current
    ? (
        await k.db
          .selectFrom("delegation_grant_resource")
          .select("resource_id")
          .where("grant_id", "=", current.id)
          .execute()
      ).map((r) => r.resource_id)
    : [];
  const proposed: GrantProposal = {
    delegateId: req.delegate_id,
    scopes: [...new Set([...(current?.scopes ?? []), ...req.scopes])],
    resourceIds: [...new Set([...currentResources, ...req.resource_ids])],
    constraints: (current?.constraints as GrantProposal["constraints"]) ?? {},
    expiresAt: current?.expires_at?.toISOString() ?? null,
  };
  return {
    request: req,
    current: current
      ? { scopes: current.scopes, resourceIds: currentResources, version: current.version }
      : null,
    proposed: normalise(proposed),
  };
}

export async function decideRequest(
  k: Kernel,
  grantorId: string,
  requestId: string,
  decision: "accepted" | "declined",
): Promise<void> {
  await k.db.transaction().execute(async (tx) => {
    const res = await tx
      .updateTable("grant_request")
      .set({ status: decision, decided_at: new Date() })
      .where("id", "=", requestId)
      .where("grantor_id", "=", grantorId)
      .where("status", "=", "pending")
      .executeTakeFirst();
    if (res.numUpdatedRows !== 1n) throw new KernelError("not_found", "not found");
    await audit(tx, {
      actorId: grantorId,
      actorKind: "person",
      ownerId: grantorId,
      action: `grant_request.${decision}`,
      subjectType: "grant_request",
      subjectId: requestId,
    });
  });
}

export async function grantsInvolving(ex: Executor, personId: string) {
  const grants = await ex
    .selectFrom("delegation_grant as g")
    .innerJoin("person as grantor", "grantor.id", "g.grantor_id")
    .innerJoin("person as delegate", "delegate.id", "g.delegate_id")
    .select([
      "g.id",
      "g.grantor_id",
      "g.delegate_id",
      "grantor.display_name as grantor_name",
      "delegate.display_name as delegate_name",
      "g.scopes",
      "g.constraints",
      "g.status",
      "g.expires_at",
      "g.version",
      "g.updated_at",
    ])
    .where((eb) => eb.or([eb("g.grantor_id", "=", personId), eb("g.delegate_id", "=", personId)]))
    .where("g.status", "<>", "revoked")
    .execute();
  const res = grants.length
    ? await ex
        .selectFrom("delegation_grant_resource as gr")
        .innerJoin("resource as r", "r.id", "gr.resource_id")
        .select(["gr.grant_id", "r.id", "r.label"])
        .where(
          "gr.grant_id",
          "in",
          grants.map((g) => g.id),
        )
        .execute()
    : [];
  return grants.map((g) => ({
    ...g,
    resources: res.filter((r) => r.grant_id === g.id).map(({ id, label }) => ({ id, label })),
  }));
}

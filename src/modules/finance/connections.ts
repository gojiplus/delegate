import { randomBytes } from "node:crypto";
import type { Tx } from "../../db/index.js";
import { audit } from "../../kernel/audit.js";
import type { Kernel } from "../../kernel/context.js";
import { newId } from "../../kernel/ids.js";
import { KernelError } from "../../kernel/registry.js";
import { FIXTURE_DATA, type FixtureAccount, INSTITUTIONS } from "./fixtures.js";

// Connection is always an owner action: the owner consents to data retrieval
// for one institution, and every discovered account arrives unselected and so
// invisible to everyone else until the owner chooses it (PRD §5A).

const SOURCE = "fixture";
const JOINT_REASON =
  "Joint account: sharing needs a documented ownership and sharing policy (not yet supported).";

function labelFor(a: FixtureAccount) {
  return `${a.name} ••${a.mask}`;
}

async function importObservations(tx: Tx, resourceId: string, a: FixtureAccount, observedAt: Date) {
  await tx
    .insertInto("finance_balance")
    .values({
      resource_id: resourceId,
      current_cents: a.currentCents,
      available_cents: a.availableCents,
      source: SOURCE,
      observed_at: observedAt,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  for (const t of a.transactions) {
    const posted = new Date(observedAt.getTime() - t.daysAgo * 86_400_000)
      .toISOString()
      .slice(0, 10);
    await tx
      .insertInto("finance_transaction")
      .values({
        id: newId("txn"),
        resource_id: resourceId,
        provider_ref: t.ref,
        amount_cents: t.amountCents,
        description: t.description,
        posted_date: posted,
        pending: t.pending ?? false,
        source: SOURCE,
        observed_at: observedAt,
      })
      .onConflict((oc) => oc.columns(["resource_id", "provider_ref"]).doNothing())
      .execute();
  }
}

// Provider-reported obligations (statement data) and inferred ones (a
// recurring charge). Unknown amounts stay null; they are never written as 0.
async function importObligations(
  tx: Tx,
  ownerId: string,
  resourceId: string,
  a: FixtureAccount,
  observedAt: Date,
) {
  if (a.liability) {
    const l = a.liability;
    await tx
      .insertInto("work_item")
      .values({
        id: newId("work"),
        owner_id: ownerId,
        resource_id: resourceId,
        type: "finance.obligation",
        title: `${a.name} statement`,
        details: JSON.stringify({
          amountCents: l.statementBalanceCents,
          minimumDueCents: l.minimumDueCents,
          dueDate:
            l.dueInDays === null
              ? null
              : new Date(observedAt.getTime() + l.dueInDays * 86_400_000)
                  .toISOString()
                  .slice(0, 10),
          autopay: l.autopay,
        }),
        evidence_level: "provider",
        source: `${SOURCE}:liabilities`,
        observed_at: observedAt,
        status: "open",
        created_by: ownerId,
      })
      .execute();
  }
  const byDesc = new Map<string, number>();
  for (const t of a.transactions)
    if (t.amountCents < 0) byDesc.set(t.description, (byDesc.get(t.description) ?? 0) + 1);
  for (const [desc, n] of byDesc) {
    if (n < 3) continue;
    await tx
      .insertInto("work_item")
      .values({
        id: newId("work"),
        owner_id: ownerId,
        resource_id: resourceId,
        type: "finance.obligation",
        title: `Possible recurring bill: ${desc}`,
        details: JSON.stringify({
          amountCents: null,
          minimumDueCents: null,
          dueDate: null,
          autopay: "unknown",
        }),
        evidence_level: "inferred",
        source: `${SOURCE}:transactions (${n} similar charges)`,
        observed_at: observedAt,
        status: "open",
        created_by: ownerId,
      })
      .execute();
  }
}

export function listInstitutions(email: string) {
  const mine = FIXTURE_DATA[email] ?? {};
  return INSTITUTIONS.filter((i) => mine[i.id]).map((i) => ({ id: i.id, name: i.name }));
}

export async function connectInstitution(
  k: Kernel,
  ownerId: string,
  institutionId: string,
): Promise<string> {
  const person = await k.db
    .selectFrom("person")
    .select("email")
    .where("id", "=", ownerId)
    .executeTakeFirstOrThrow();
  const accounts = FIXTURE_DATA[person.email]?.[institutionId];
  const inst = INSTITUTIONS.find((i) => i.id === institutionId);
  if (!accounts || !inst) throw new KernelError("not_found", "institution not available");
  const connectionId = newId("conn");
  const observedAt = new Date();
  await k.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("finance_connection")
      .values({
        id: connectionId,
        owner_id: ownerId,
        institution_id: institutionId,
        status: "active",
        token_ref: `sim-token-ref:${randomBytes(8).toString("hex")}`,
        consented_products: ["balances", "transactions", "liabilities"],
        last_refreshed_at: observedAt,
      })
      .execute();
    for (const a of accounts) {
      const resourceId = newId("acct");
      await tx
        .insertInto("resource")
        .values({
          id: resourceId,
          owner_id: ownerId,
          type: "finance.account",
          label: labelFor(a),
          selected: false,
          shareable: a.ownership === "sole",
          unshareable_reason: a.ownership === "sole" ? null : JOINT_REASON,
        })
        .execute();
      await tx
        .insertInto("finance_account")
        .values({
          resource_id: resourceId,
          connection_id: connectionId,
          provider_account_id: a.providerAccountId,
          persistent_account_id: a.persistentAccountId,
          institution_id: institutionId,
          name: a.name,
          mask: a.mask,
          kind: a.kind,
          subtype: a.subtype,
          ownership: a.ownership,
        })
        .execute();
      await importObservations(tx, resourceId, a, observedAt);
      await importObligations(tx, ownerId, resourceId, a, observedAt);
    }
    await audit(tx, {
      actorId: ownerId,
      actorKind: "person",
      ownerId,
      action: "finance.connection.created",
      subjectType: "finance_connection",
      subjectId: connectionId,
      detail: { institution_id: institutionId, accounts: accounts.length },
    });
  });
  return connectionId;
}

export async function selectAccounts(
  k: Kernel,
  ownerId: string,
  resourceIds: string[],
  selected: boolean,
) {
  await k.db.transaction().execute(async (tx) => {
    const res = await tx
      .updateTable("resource")
      .set({ selected })
      .where("id", "in", resourceIds)
      .where("owner_id", "=", ownerId)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== resourceIds.length)
      throw new KernelError("not_found", "not found");
    // Deselecting removes the resource from every grant rather than leaving a dormant entry.
    if (!selected)
      await tx
        .deleteFrom("delegation_grant_resource")
        .where("resource_id", "in", resourceIds)
        .execute();
    await audit(tx, {
      actorId: ownerId,
      actorKind: "person",
      ownerId,
      action: selected ? "finance.accounts.selected" : "finance.accounts.deselected",
      detail: { resource_ids: resourceIds },
    });
  });
}

export async function markNeedsReconnect(k: Kernel, connectionId: string) {
  await k.db
    .updateTable("finance_connection")
    .set({ status: "needs_reconnect" })
    .where("id", "=", connectionId)
    .execute();
}

// Relinking can hand back new provider account IDs. An account keeps its
// internal ID (and so its grants and history) only when the institution gives
// a persistent identity that matches. Anything else, including a match on the
// last four digits alone, becomes a new unselected account plus a review item.
export async function reconnect(
  k: Kernel,
  ownerId: string,
  connectionId: string,
  freshAccounts?: FixtureAccount[],
): Promise<{ remapped: number; needsReview: number }> {
  const conn = await k.db
    .selectFrom("finance_connection")
    .selectAll()
    .where("id", "=", connectionId)
    .where("owner_id", "=", ownerId)
    .executeTakeFirst();
  if (!conn) throw new KernelError("not_found", "not found");
  const person = await k.db
    .selectFrom("person")
    .select("email")
    .where("id", "=", ownerId)
    .executeTakeFirstOrThrow();
  const relinked = (freshAccounts ?? FIXTURE_DATA[person.email]?.[conn.institution_id] ?? []).map(
    (a) => ({
      ...a,
      providerAccountId: `${a.providerAccountId}-relink-${randomBytes(3).toString("hex")}`,
    }),
  );
  let remapped = 0;
  let needsReview = 0;
  const observedAt = new Date();
  await k.db.transaction().execute(async (tx) => {
    const existing = await tx
      .selectFrom("finance_account")
      .selectAll()
      .where("connection_id", "=", connectionId)
      .execute();
    for (const a of relinked) {
      const match = a.persistentAccountId
        ? existing.find((e) => e.persistent_account_id === a.persistentAccountId)
        : undefined;
      if (match) {
        await tx
          .updateTable("finance_account")
          .set({ provider_account_id: a.providerAccountId })
          .where("resource_id", "=", match.resource_id)
          .execute();
        await importObservations(tx, match.resource_id, a, observedAt);
        remapped++;
        continue;
      }
      const resourceId = newId("acct");
      await tx
        .insertInto("resource")
        .values({
          id: resourceId,
          owner_id: ownerId,
          type: "finance.account",
          label: labelFor(a),
          selected: false,
          shareable: a.ownership === "sole",
          unshareable_reason: a.ownership === "sole" ? null : JOINT_REASON,
        })
        .execute();
      await tx
        .insertInto("finance_account")
        .values({
          resource_id: resourceId,
          connection_id: connectionId,
          provider_account_id: a.providerAccountId,
          persistent_account_id: a.persistentAccountId,
          institution_id: conn.institution_id,
          name: a.name,
          mask: a.mask,
          kind: a.kind,
          subtype: a.subtype,
          ownership: a.ownership,
        })
        .execute();
      await importObservations(tx, resourceId, a, observedAt);
      const lookalike = existing.find((e) => e.mask === a.mask && e.subtype === a.subtype);
      if (lookalike) {
        needsReview++;
        await tx
          .insertInto("work_item")
          .values({
            id: newId("work"),
            owner_id: ownerId,
            resource_id: resourceId,
            type: "finance.account_review",
            title: `Is ${a.name} ••${a.mask} the same account as before?`,
            details: JSON.stringify({ possibleMatchResourceId: lookalike.resource_id }),
            evidence_level: "inferred",
            source: "reconnect: same last four digits and type, no persistent identity",
            observed_at: observedAt,
            status: "open",
            created_by: ownerId,
          })
          .execute();
      }
    }
    await tx
      .updateTable("finance_connection")
      .set({ status: "active", last_refreshed_at: observedAt })
      .where("id", "=", connectionId)
      .execute();
    await audit(tx, {
      actorId: ownerId,
      actorKind: "person",
      ownerId,
      action: "finance.connection.reconnected",
      subjectType: "finance_connection",
      subjectId: connectionId,
      detail: { remapped, needs_review: needsReview },
    });
  });
  return { remapped, needsReview };
}

export async function addPayee(
  k: Kernel,
  ownerId: string,
  p: { name: string; category: "utility" | "tax" | "insurance" | "other"; website: string | null },
): Promise<string> {
  const id = newId("payee");
  await k.db.transaction().execute(async (tx) => {
    await tx
      .insertInto("resource")
      .values({ id, owner_id: ownerId, type: "finance.payee", label: p.name, selected: true })
      .execute();
    await tx
      .insertInto("finance_payee")
      .values({ resource_id: id, ...p })
      .execute();
    await audit(tx, {
      actorId: ownerId,
      actorKind: "person",
      ownerId,
      action: "finance.payee.added",
      subjectType: "resource",
      subjectId: id,
    });
  });
  return id;
}

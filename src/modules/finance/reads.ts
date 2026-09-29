import { canAccess, requireAccess, visibleResourceIds } from "../../kernel/access.js";
import { audit } from "../../kernel/audit.js";
import type { Kernel } from "../../kernel/context.js";
import { visibleWorkItems } from "../../kernel/work.js";
import { paymentCapability, QUOTED_FEE_CENTS } from "./payment.js";

// Every read here starts from the set of resources the actor may see for the
// relevant scope, so lists, totals and the queue cannot include anything
// unshared (P3). Reads of someone else's data are audited (P1).

const STALE_MS = 36 * 3600 * 1000;

async function auditRead(k: Kernel, actorId: string, ownerIds: string[], what: string) {
  const others = [...new Set(ownerIds)].filter((o) => o !== actorId);
  if (!others.length) return;
  await k.db.transaction().execute(async (tx) => {
    for (const ownerId of others) {
      await audit(tx, { actorId, actorKind: "person", ownerId, action: `read.${what}` });
    }
  });
}

export async function accountsView(k: Kernel, actorId: string) {
  const ids = await visibleResourceIds(k.db, k.registry, actorId, "finance.balances.read");
  if (!ids.length) return { accounts: [], totals: [] };
  const rows = await k.db
    .selectFrom("resource as r")
    .innerJoin("finance_account as a", "a.resource_id", "r.id")
    .innerJoin("finance_connection as c", "c.id", "a.connection_id")
    .innerJoin("person as o", "o.id", "r.owner_id")
    .select([
      "r.id",
      "r.owner_id",
      "o.display_name as owner_name",
      "r.label",
      "r.selected",
      "r.shareable",
      "r.unshareable_reason",
      "a.institution_id",
      "a.name",
      "a.mask",
      "a.kind",
      "a.subtype",
      "a.ownership",
      "c.id as connection_id",
      "c.status as connection_status",
      "c.last_refreshed_at",
    ])
    .where("r.id", "in", ids)
    .orderBy("o.display_name")
    .orderBy("r.label")
    .execute();
  const balances = await k.db
    .selectFrom("finance_balance")
    .selectAll()
    .where("resource_id", "in", ids)
    .orderBy("observed_at", "desc")
    .execute();
  const txnIds = new Set(
    await visibleResourceIds(k.db, k.registry, actorId, "finance.transactions.read"),
  );
  const accounts = rows.map((r) => {
    const b = balances.find((x) => x.resource_id === r.id);
    return {
      ...r,
      balance: b
        ? {
            currentCents: b.current_cents === null ? null : Number(b.current_cents),
            availableCents: b.available_cents === null ? null : Number(b.available_cents),
            source: b.source,
            observedAt: b.observed_at,
            stale: Date.now() - b.observed_at.getTime() > STALE_MS,
          }
        : null,
      canSeeTransactions: txnIds.has(r.id),
    };
  });
  // Totals over selected depository accounts only; unknown balances are
  // reported as unknown rather than silently counted as zero.
  const byOwner = new Map<
    string,
    { ownerId: string; ownerName: string; knownCents: number; unknownCount: number }
  >();
  for (const a of accounts) {
    if (a.kind !== "depository" || !a.selected) continue;
    const t = byOwner.get(a.owner_id) ?? {
      ownerId: a.owner_id,
      ownerName: a.owner_name,
      knownCents: 0,
      unknownCount: 0,
    };
    if (a.balance?.availableCents == null) t.unknownCount++;
    else t.knownCents += a.balance.availableCents;
    byOwner.set(a.owner_id, t);
  }
  await auditRead(
    k,
    actorId,
    accounts.map((a) => a.owner_id),
    "finance.accounts",
  );
  return { accounts, totals: [...byOwner.values()] };
}

export async function transactionsView(k: Kernel, actorId: string, resourceId: string) {
  await requireAccess(k.db, k.registry, actorId, "finance.transactions.read", resourceId);
  const owner = await k.db
    .selectFrom("resource")
    .select("owner_id")
    .where("id", "=", resourceId)
    .executeTakeFirstOrThrow();
  const rows = await k.db
    .selectFrom("finance_transaction")
    .select([
      "id",
      "provider_ref",
      "amount_cents",
      "description",
      "posted_date",
      "pending",
      "source",
      "observed_at",
    ])
    .where("resource_id", "=", resourceId)
    .orderBy("posted_date", "desc")
    .limit(200)
    .execute();
  await auditRead(k, actorId, [owner.owner_id], "finance.transactions");
  return rows.map((r) => ({ ...r, amount_cents: Number(r.amount_cents) }));
}

export async function payeesView(k: Kernel, actorId: string) {
  const ids = await visibleResourceIds(k.db, k.registry, actorId, "finance.payments.prepare");
  const payeeIds = (
    await visibleResourceIds(k.db, k.registry, actorId, "finance.obligations.manage")
  ).concat(ids);
  if (!payeeIds.length) return [];
  return k.db
    .selectFrom("resource as r")
    .innerJoin("finance_payee as p", "p.resource_id", "r.id")
    .select(["r.id", "r.owner_id", "r.label", "p.category", "p.website"])
    .where("r.id", "in", [...new Set(payeeIds)])
    .execute();
}

// For the payment form: what can this actor prepare between these two
// resources, and why not if not. Executability is checked before any approval
// action is offered (PRD §5C).
export async function capabilityFor(k: Kernel, actorId: string, sourceId: string, payeeId: string) {
  for (const r of [sourceId, payeeId]) {
    if (!(await canAccess(k.db, k.registry, actorId, "finance.payments.prepare", r))) {
      return {
        state: "unavailable" as const,
        reason: "You do not have access to prepare payments between these accounts.",
      };
    }
  }
  const owner = await k.db
    .selectFrom("resource")
    .select("owner_id")
    .where("id", "=", sourceId)
    .executeTakeFirstOrThrow();
  const today = new Date().toISOString().slice(0, 10);
  const cap = await paymentCapability(k.db, owner.owner_id, {
    sourceAccountId: sourceId,
    payeeResourceId: payeeId,
    amount: { currency: "USD", cents: 1 },
    feeCents: QUOTED_FEE_CENTS,
    scheduledDate: today,
  });
  return { ...cap, quotedFeeCents: QUOTED_FEE_CENTS };
}

// The delegate's queue (PRD §5B): obligations, payment exceptions, stale
// connections, grouped by owner. Every entry names its source and freshness.
export async function queueView(k: Kernel, actorId: string) {
  const items = await visibleWorkItems(k, actorId);
  const { accounts } = await accountsView(k, actorId);
  const stale = accounts
    .filter((a) => a.connection_status !== "active" || a.balance?.stale)
    .map((a) => ({
      kind: "stale_connection" as const,
      owner_id: a.owner_id,
      owner_name: a.owner_name,
      label: a.label,
      detail:
        a.connection_status !== "active"
          ? "Needs the owner to reconnect"
          : "Data is more than 36 hours old",
      observed_at: a.balance?.observedAt ?? null,
    }));
  return { workItems: items, stale };
}

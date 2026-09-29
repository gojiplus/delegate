import { sql } from "kysely";
import { z } from "zod";
import type { Executor, Tx } from "../../db/index.js";
import type { Capability, IntentTypeDef } from "../../kernel/registry.js";
import type { Fakepay } from "./fakepay.js";
import { INSTITUTIONS } from "./fixtures.js";
import { formatCents } from "./money.js";

export const PaymentDetails = z
  .object({
    sourceAccountId: z.string(),
    payeeResourceId: z.string(),
    amount: z.object({
      currency: z.literal("USD"),
      cents: z.number().int().positive().max(10_000_000),
    }),
    feeCents: z.number().int().nonnegative(),
    scheduledDate: z.iso.date(),
  })
  .strict();
export type PaymentDetails = z.infer<typeof PaymentDetails>;

export const FinanceConstraints = z
  .object({
    perPaymentCapCents: z.number().int().positive().optional(),
    monthlyCapCents: z.number().int().positive().optional(),
    periodTimezone: z.string().default("America/Los_Angeles"),
  })
  .strict();

// The simulated provider charges nothing. The fee is still part of what the
// owner approves, so a quote change would invalidate an earlier approval.
export const QUOTED_FEE_CENTS = 0;
const MAX_DAYS_AHEAD = 60;
const STALE_MS = 36 * 3600 * 1000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function loadParty(ex: Executor, resourceId: string) {
  return ex
    .selectFrom("resource as r")
    .leftJoin("finance_account as a", "a.resource_id", "r.id")
    .leftJoin("finance_connection as c", "c.id", "a.connection_id")
    .leftJoin("finance_payee as p", "p.resource_id", "r.id")
    .select([
      "r.id",
      "r.owner_id",
      "r.type",
      "r.label",
      "r.selected",
      "a.kind",
      "a.ownership",
      "a.institution_id",
      "a.mask",
      "c.status as connection_status",
      "p.name as payee_name",
      "p.website",
    ])
    .where("r.id", "=", resourceId)
    .executeTakeFirst();
}

// Honest capability (P4): executable only for the one route the simulated
// provider supports; everything else says what would have to happen instead.
export async function paymentCapability(
  ex: Executor,
  ownerId: string,
  d: PaymentDetails,
): Promise<Capability> {
  const [src, dst] = await Promise.all([
    loadParty(ex, d.sourceAccountId),
    loadParty(ex, d.payeeResourceId),
  ]);
  if (!src || !dst || src.owner_id !== ownerId || dst.owner_id !== ownerId) {
    return { state: "unavailable", reason: "Both accounts must belong to the same person." };
  }
  if (!src.selected || !dst.selected)
    return { state: "unavailable", reason: "An account is not selected for use in the app." };
  if (src.type !== "finance.account" || src.kind !== "depository") {
    return {
      state: "unavailable",
      reason: "Payments must be funded from a checking or savings account.",
    };
  }
  if (src.ownership === "joint") {
    return {
      state: "requires_setup",
      reason: "Joint accounts need a documented ownership and sharing policy first.",
    };
  }
  if (
    src.connection_status !== "active" ||
    (dst.type === "finance.account" && dst.connection_status !== "active")
  ) {
    return {
      state: "requires_setup",
      reason: "The account owner needs to reconnect this institution.",
    };
  }
  if (dst.type === "finance.payee") {
    return {
      state: "external",
      reason: `No supported integration pays ${dst.payee_name}. Pay on their website, then mark the task done.`,
      externalUrl: dst.website ?? undefined,
    };
  }
  if (dst.kind === "depository") {
    return {
      state: "unavailable",
      reason: "Transfers between your own accounts are excluded in this release.",
    };
  }
  const issuer = INSTITUTIONS.find((i) => i.id === dst.institution_id);
  if (!issuer?.acceptsCreditorPayments) {
    return {
      state: "external",
      reason: `${issuer?.name ?? "This issuer"} is not supported for in-app payment. Pay through the issuer, then mark the task done.`,
    };
  }
  if (d.feeCents !== QUOTED_FEE_CENTS) {
    return {
      state: "unavailable",
      reason: `The fee no longer matches the current quote (${formatCents(QUOTED_FEE_CENTS)}). Prepare it again.`,
    };
  }
  const days = (Date.parse(d.scheduledDate) - Date.parse(todayUtc())) / 86_400_000;
  // Owners' time zones are not modelled yet; allowing yesterday-in-UTC accepts
  // "today" anywhere in the Americas. Dispatch never happens before now anyway.
  if (days < -1) return { state: "unavailable", reason: "The scheduled date is in the past." };
  if (days > MAX_DAYS_AHEAD)
    return {
      state: "unavailable",
      reason: `Payments can be scheduled at most ${MAX_DAYS_AHEAD} days ahead.`,
    };
  return {
    state: "executable",
    executor: "fakepay",
    reason: "Simulated creditor payment. This is the R0 demonstrator: no money moves.",
  };
}

async function describe(ex: Executor, d: PaymentDetails) {
  const [src, dst] = await Promise.all([
    loadParty(ex, d.sourceAccountId),
    loadParty(ex, d.payeeResourceId),
  ]);
  const from = src ? `${src.label}` : "unknown account";
  const to = dst ? `${dst.label}` : "unknown payee";
  return {
    summary: `${formatCents(d.amount.cents)} from ${from} to ${to} on ${d.scheduledDate}`,
    lines: [
      { label: "Amount", value: formatCents(d.amount.cents) },
      { label: "Fee", value: formatCents(d.feeCents) },
      { label: "From", value: from },
      { label: "To", value: to },
      { label: "Send on", value: d.scheduledDate },
      {
        label: "Expected timing",
        value:
          "Simulated: delivered to the card issuer within 1 business day; the issuer confirms posting 1–3 days later.",
      },
    ],
    cancellation:
      "You can cancel until it is sent on the scheduled date. After that, cancellation is only a request and may be refused.",
  };
}

// Advisory checks before approval. Each is a reason to look, not proof of a
// duplicate: the app cannot see payments made outside it (PRD §5D).
async function warnings(
  ex: Executor,
  ownerId: string,
  intentId: string,
  d: PaymentDetails,
): Promise<string[]> {
  const out: string[] = [];
  const autopay = await ex
    .selectFrom("work_item")
    .select("details")
    .where("resource_id", "=", d.payeeResourceId)
    .where("type", "=", "finance.obligation")
    .where("status", "not in", ["dismissed", "verified_done"])
    .execute();
  if (autopay.some((w) => (w.details as { autopay?: string }).autopay === "on")) {
    out.push("Autopay appears to be on for this card. Another payment may be a duplicate.");
  }
  const recent = await ex
    .selectFrom("finance_transaction")
    .select(["amount_cents", "posted_date", "description"])
    .where("resource_id", "=", d.payeeResourceId)
    .where("amount_cents", ">", "0")
    .where(sql<boolean>`posted_date >= current_date - 10`)
    .execute();
  for (const t of recent) {
    out.push(
      `A payment of ${formatCents(Number(t.amount_cents))} (${t.description}) already reached this card on ${t.posted_date}.`,
    );
  }
  const others = await ex
    .selectFrom("intent as i")
    .innerJoin("intent_revision as r", (j) =>
      j.onRef("r.intent_id", "=", "i.id").onRef("r.revision", "=", "i.current_revision"),
    )
    .select(["i.id", "i.status"])
    .where("i.owner_id", "=", ownerId)
    .where("i.id", "<>", intentId)
    .where("i.status", "not in", ["Rejected", "Expired", "Canceled", "Failed", "Returned"])
    .where(sql<boolean>`r.details->>'payeeResourceId' = ${d.payeeResourceId}`)
    .where("i.created_at", ">", sql<Date>`now() - interval '30 days'`)
    .execute();
  if (others.length)
    out.push(`${others.length} other payment request(s) to this card are open or recent.`);
  const bal = await ex
    .selectFrom("finance_balance")
    .select(["available_cents", "observed_at"])
    .where("resource_id", "=", d.sourceAccountId)
    .orderBy("observed_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!bal || bal.available_cents === null) {
    out.push("Available balance of the funding account is unknown.");
  } else {
    if (Number(bal.available_cents) < d.amount.cents)
      out.push("The last reported available balance is lower than this payment.");
    if (Date.now() - bal.observed_at.getTime() > STALE_MS)
      out.push("The funding account's balance is more than 36 hours old.");
  }
  out.push("A balance check does not reserve funds.");
  return out;
}

function periodKey(tz: string, at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(at);
  return `${parts.find((p) => p.type === "year")!.value}-${parts.find((p) => p.type === "month")!.value}`;
}

// Cumulative caps are reserved atomically: an advisory lock per grant
// serialises concurrent dispatches, pending payments count, and only a
// definitive failure or return gives the capacity back (PRD §7).
async function reserve(
  tx: Tx,
  ctx: Parameters<NonNullable<IntentTypeDef["reserve"]>>[1],
  d: PaymentDetails,
) {
  if (!ctx.grant) return { ok: true as const };
  const parsed = FinanceConstraints.safeParse(ctx.grant.constraints.finance ?? {});
  if (!parsed.success) return { ok: false as const, reason: "Limits on this access are invalid." };
  const c = parsed.data;
  if (c.perPaymentCapCents !== undefined && d.amount.cents > c.perPaymentCapCents) {
    return {
      ok: false as const,
      reason: `Exceeds the ${formatCents(c.perPaymentCapCents)} per-payment limit on this access.`,
    };
  }
  const period = periodKey(c.periodTimezone);
  if (c.monthlyCapCents !== undefined) {
    await sql`select pg_advisory_xact_lock(hashtext(${"limit:" + ctx.grant.id}))`.execute(tx);
    const used = await tx
      .selectFrom("finance_limit_reservation")
      .select(sql<string>`coalesce(sum(amount_cents), 0)`.as("total"))
      .where("grant_id", "=", ctx.grant.id)
      .where("period_key", "=", period)
      .where("status", "in", ["held", "consumed"])
      .executeTakeFirstOrThrow();
    if (Number(used.total) + d.amount.cents > c.monthlyCapCents) {
      return {
        ok: false as const,
        reason: `Would exceed the ${formatCents(c.monthlyCapCents)} monthly limit on this access.`,
      };
    }
  }
  if (c.monthlyCapCents !== undefined || c.perPaymentCapCents !== undefined) {
    await tx
      .insertInto("finance_limit_reservation")
      .values({
        intent_id: ctx.intentId,
        grant_id: ctx.grant.id,
        period_key: period,
        amount_cents: d.amount.cents,
        status: "held",
      })
      .execute();
  }
  return { ok: true as const };
}

async function settle(tx: Tx, intentId: string, outcome: "consumed" | "released") {
  await tx
    .updateTable("finance_limit_reservation")
    .set({ status: outcome, settled_at: new Date() })
    .where("intent_id", "=", intentId)
    // A payment returned after posting gives its capacity back as well.
    .where("status", "in", outcome === "released" ? ["held", "consumed"] : ["held"])
    .execute();
}

export function paymentIntentType(fakepay: Fakepay): IntentTypeDef<PaymentDetails> {
  return {
    type: "finance.payment",
    prepareScope: "finance.payments.prepare",
    details: PaymentDetails,
    resourcesOf: (d) => [d.sourceAccountId, d.payeeResourceId],
    capability: paymentCapability,
    describe,
    warnings,
    approvalExpiresAt: (d) => new Date(Date.parse(d.scheduledDate) + 2 * 86_400_000),
    dispatchAt: (d) => new Date(Math.max(Date.now(), Date.parse(d.scheduledDate))),
    reserve,
    settle,
    executor: fakepay,
    postSubmission: {
      states: ["Delivered", "Posted", "Returned", "Canceled"],
      transitions: [
        ["Submitted", "Delivered"],
        ["Submitted", "Posted"],
        ["Delivered", "Posted"],
        ["Submitted", "Returned"],
        ["Delivered", "Returned"],
        ["Posted", "Returned"],
        ["Submitted", "Canceled"],
        ["Delivered", "Failed"],
      ],
      terminal: ["Returned", "Canceled"],
      settled: ["Posted"],
      verified: ["Posted"],
      releasing: ["Returned", "Canceled"],
    },
  };
}

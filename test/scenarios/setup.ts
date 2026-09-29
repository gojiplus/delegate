import type { App } from "../../src/app.js";
import { prepareIntent, requestApproval } from "../../src/kernel/intents.js";
import { newId } from "../../src/kernel/ids.js";
import { approve, connectAll, freshApp, grant, today } from "../helpers.js";

export interface Scenario {
  app: App & { url: string };
  maria: Record<string, string>;
  grantId: string;
}

export const CAPS = {
  finance: {
    perPaymentCapCents: 100_000,
    monthlyCapCents: 150_000,
    periodTimezone: "America/Los_Angeles",
  },
};

// Maria shares checking ••3821 and Visa ••9042 with Sam, who may prepare
// payments between them, under a $1,000 per-payment and $1,500 monthly cap.
export async function scenario(): Promise<Scenario> {
  const app = await freshApp();
  const maria = await connectAll(app.kernel, "p_maria", [
    "harbor",
    "lakeside",
    "summit",
    "northstar",
  ]);
  const { grantId } = await grant(app.kernel, "p_maria", {
    delegateId: "p_sam",
    scopes: ["finance.balances.read", "finance.obligations.manage", "finance.payments.prepare"],
    resourceIds: [maria["3821"]!, maria["9042"]!, maria["5510"]!],
    constraints: CAPS,
  });
  return { app, maria, grantId };
}

export function payment(
  s: Scenario,
  cents: number,
  extra: Partial<{ scheduledDate: string; source: string; payee: string }> = {},
) {
  return {
    type: "finance.payment",
    details: {
      sourceAccountId: extra.source ?? s.maria["3821"]!,
      payeeResourceId: extra.payee ?? s.maria["9042"]!,
      amount: { currency: "USD", cents },
      feeCents: 0,
      scheduledDate: extra.scheduledDate ?? today(),
    },
    workItemId: null,
  };
}

// Sam prepares, asks, Maria approves: the intent ends Scheduled.
export async function approvedIntent(s: Scenario, cents = 42_817, by = "p_sam"): Promise<string> {
  const { intentId } = await prepareIntent(s.app.kernel, by, newId("click"), payment(s, cents));
  await requestApproval(s.app.kernel, by, intentId);
  await approve(s.app.kernel, "p_maria", intentId);
  return intentId;
}

export async function status(s: Scenario, intentId: string) {
  return (
    await s.app.kernel.db
      .selectFrom("intent")
      .selectAll()
      .where("id", "=", intentId)
      .executeTakeFirstOrThrow()
  ).status;
}

export async function providerOps(s: Scenario, intentId: string) {
  return s.app.kernel.db
    .selectFrom("fakepay.operation")
    .selectAll()
    .where("idempotency_key", "=", intentId)
    .execute();
}

export async function deliver(
  s: Scenario,
  ev: { eventId: string; operationId: string; rawStatus: string },
) {
  const { receiveWebhook, processInbox } = await import("../../src/kernel/execution.js");
  const { headers, body } = s.app.fakepay.sign(ev);
  const ok = await receiveWebhook(s.app.kernel, "fakepay", headers, body);
  if (ok) await processInbox(s.app.kernel, "fakepay", ev.eventId);
  return ok;
}

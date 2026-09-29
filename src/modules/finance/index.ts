import { z } from "zod";
import type { Db } from "../../db/index.js";
import type { DomainModule } from "../../kernel/registry.js";
import { Fakepay } from "./fakepay.js";
import { formatCents } from "./money.js";
import { FinanceConstraints, paymentIntentType } from "./payment.js";

const ObligationDetails = z
  .object({
    amountCents: z.number().int().nullable(),
    minimumDueCents: z.number().int().nullable().default(null),
    dueDate: z.iso.date().nullable(),
    autopay: z.enum(["on", "off", "unknown"]).default("unknown"),
  })
  .strict();

const AccountReviewDetails = z.object({ possibleMatchResourceId: z.string() }).strict();

export function financeModule(fakepay: Fakepay): DomainModule {
  return {
    id: "finance",
    resourceTypes: [
      { type: "finance.account", describe: "A bank or card account" },
      { type: "finance.payee", describe: "A biller that is not an account you hold" },
    ],
    scopes: [
      {
        id: "finance.balances.read",
        resourceTypes: ["finance.account"],
        describe: "See balances and account details for",
      },
      {
        id: "finance.transactions.read",
        resourceTypes: ["finance.account"],
        describe: "See transaction history for",
      },
      {
        id: "finance.obligations.manage",
        resourceTypes: ["finance.account", "finance.payee"],
        describe: "Track bills and tasks, add notes and mark them done, for",
      },
      {
        id: "finance.payments.prepare",
        resourceTypes: ["finance.account", "finance.payee"],
        describe: "Prepare payments for you to approve (never send them) between",
      },
    ],
    workItemTypes: [
      {
        type: "finance.obligation",
        scope: "finance.obligations.manage",
        details: ObligationDetails,
      },
      {
        type: "finance.account_review",
        scope: "finance.balances.read",
        details: AccountReviewDetails,
      },
    ],
    intentTypes: [paymentIntentType(fakepay)],
    grantConstraints: FinanceConstraints,
    describeConstraints: (raw) => {
      const c = FinanceConstraints.parse(raw);
      const out: string[] = [];
      if (c.perPaymentCapCents)
        out.push(`Payments they prepare can be at most ${formatCents(c.perPaymentCapCents)} each.`);
      if (c.monthlyCapCents)
        out.push(
          `Payments they prepare can add up to at most ${formatCents(c.monthlyCapCents)} a month.`,
        );
      return out;
    },
  };
}

export function createFakepay(providerDb: Db, secret: string): Fakepay {
  return new Fakepay(providerDb, secret);
}

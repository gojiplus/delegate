import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { contactDigest, setTrustedContact } from "../src/kernel/contacts.js";
import { dispatch } from "../src/kernel/execution.js";
import {
  decideRequest,
  describeRequest,
  grantDigest,
  requestMoreAccess,
  setGrantStatus,
} from "../src/kernel/grants.js";
import { newId } from "../src/kernel/ids.js";
import {
  approvalOptions,
  intentView,
  prepareIntent,
  requestApproval,
  reviseIntent,
} from "../src/kernel/intents.js";
import { SESSION_COOKIE } from "../src/kernel/sessions.js";
import { updateWorkItem, visibleWorkItems } from "../src/kernel/work.js";
import { accountsView } from "../src/modules/finance/reads.js";
import { approve, connectAll, freshApp, grant, jobs, signed, today, resume } from "./helpers.js";
import {
  approvedIntent,
  deliver,
  payment,
  providerOps,
  type Scenario,
  scenario,
  status,
} from "./scenarios/setup.js";

// Red-team tests. Each asserts the SECURE behaviour, so each fails while the
// weakness it names exists. Adversary labels follow docs/THREAT_MODEL.md.

const rp = { id: "localhost", name: "test", origin: "http://localhost:5173" };

async function withServer(s: Scenario, fn: (srv: FastifyInstance) => Promise<void>) {
  const srv = await buildServer(s.app, { rp, devLogin: true });
  try {
    await fn(srv);
  } finally {
    await srv.close();
  }
}

async function login(srv: FastifyInstance, personId: string) {
  const res = await srv.inject({
    method: "POST",
    url: "/api/dev/login",
    payload: { personId },
    headers: { origin: rp.origin },
  });
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
  return { cookie: `${SESSION_COOKIE}=${c.value}`, origin: rp.origin };
}

async function setRosa(s: Scenario) {
  const c = { name: "Rosa", email: "rosa@example.test" };
  await setTrustedContact(
    s.app.kernel,
    "p_maria",
    c,
    await signed(s.app.kernel, "p_maria", "grant", contactDigest("p_maria", c)),
  );
}

// Maria prepares a $10 draft herself; Sam then silently rewrites it to $5,000,
// five times his $1,000 per-payment cap. Returns false if the rewrite is refused.
async function delegateRewritesOwnersDraft(s: Scenario, scheduledDate = today()) {
  const k = s.app.kernel;
  const { intentId } = await prepareIntent(
    k,
    "p_maria",
    newId("c"),
    payment(s, 1_000, { scheduledDate }),
  );
  const rewrote = await reviseIntent(
    k,
    "p_sam",
    intentId,
    1,
    payment(s, 500_000, { scheduledDate }).details,
  ).then(
    () => true,
    () => false,
  );
  return { intentId, rewrote };
}

describe("R1. a delegate can rewrite a payment the owner prepared", () => {
  it("refuses a delegate's revision of an intent they did not initiate", async () => {
    const s = await scenario();
    try {
      const { rewrote } = await delegateRewritesOwnersDraft(s);
      expect(rewrote).toBe(false);
    } finally {
      await s.app.close();
    }
  });

  it("enforces the delegate's per-payment cap on an amount the delegate chose", async () => {
    const s = await scenario();
    try {
      const { intentId, rewrote } = await delegateRewritesOwnersDraft(s);
      if (!rewrote) return;
      await requestApproval(s.app.kernel, "p_maria", intentId);
      await approve(s.app.kernel, "p_maria", intentId);
      const out = await dispatch(s.app.kernel, intentId);
      // Cap is $1,000; Sam set $5,000. Secure: never reaches the provider.
      expect(out.kind).not.toBe("dispatching");
      expect(await providerOps(s, intentId)).toHaveLength(0);
    } finally {
      await s.app.close();
    }
  });

  it("revoking the delegate cancels payments whose content the delegate wrote", async () => {
    const s = await scenario();
    try {
      const { intentId, rewrote } = await delegateRewritesOwnersDraft(s);
      if (!rewrote) return;
      await requestApproval(s.app.kernel, "p_maria", intentId);
      await approve(s.app.kernel, "p_maria", intentId);
      await setGrantStatus(s.app.kernel, "p_maria", s.grantId, "revoked");
      const out = await dispatch(s.app.kernel, intentId);
      expect(out.kind).not.toBe("dispatching");
      expect(await status(s, intentId)).toBe("Canceled");
    } finally {
      await s.app.close();
    }
  });

  it("the approval screen and the trusted contact learn that the delegate wrote it", async () => {
    const s = await scenario();
    try {
      await setRosa(s);
      const { intentId, rewrote } = await delegateRewritesOwnersDraft(s);
      if (!rewrote) return;
      await requestApproval(s.app.kernel, "p_maria", intentId);
      const screen = await approvalOptions(s.app.kernel, "p_maria", intentId);
      await approve(s.app.kernel, "p_maria", intentId);
      const notes = await s.app.admin
        .selectFrom("notification")
        .select(["kind", "recipient_email"])
        .where("owner_id", "=", "p_maria")
        .where("kind", "=", "intent.approved")
        .execute();
      expect({
        screenMentionsSam: JSON.stringify(screen).includes("p_sam"),
        rosaTold: notes.some((n) => n.recipient_email === "rosa@example.test"),
      }).toEqual({ screenMentionsSam: true, rosaTold: true });
    } finally {
      await s.app.close();
    }
  });
});

describe("R2. a delegate can un-approve an approved payment", () => {
  it("refuses a delegate's approval request on an intent the owner already approved", async () => {
    const s = await scenario();
    try {
      const k = s.app.kernel;
      const { intentId } = await prepareIntent(k, "p_maria", newId("c"), payment(s, 3_500));
      await requestApproval(k, "p_maria", intentId);
      await approve(k, "p_maria", intentId);
      expect(await status(s, intentId)).toBe("Scheduled");
      await expect(requestApproval(k, "p_sam", intentId)).rejects.toThrow();
      expect(await status(s, intentId)).toBe("Scheduled");
    } finally {
      await s.app.close();
    }
  });

  it("after such a bounce the owner can still re-approve the same revision", async () => {
    const s = await scenario();
    try {
      const k = s.app.kernel;
      const intentId = await approvedIntent(s, 3_500);
      const bounced = await requestApproval(k, "p_sam", intentId).then(
        () => true,
        () => false,
      );
      if (!bounced) return;
      // The (intent_id, revision) approval row from the first approval is still there.
      await expect(approve(k, "p_maria", intentId)).resolves.toBeUndefined();
    } finally {
      await s.app.close();
    }
  });
});

describe("R3. a delegate can mark any owner's bill verified-paid", () => {
  it("ignores a workItemId the preparer cannot see (another owner's obligation)", async () => {
    const s = await scenario();
    try {
      const k = s.app.kernel;
      const lee = await connectAll(k, "p_lee", ["harbor", "summit"]);
      const leesBill = await s.app.admin
        .selectFrom("work_item")
        .select(["id", "status"])
        .where("owner_id", "=", "p_lee")
        .where("resource_id", "=", lee["3300"]!)
        .where("evidence_level", "=", "provider")
        .executeTakeFirstOrThrow();
      // Sam has no relationship with Lee at all. He pays $1 of Maria's money
      // and attaches Lee's $1,204.55 card statement to it.
      const input = { ...payment(s, 100), workItemId: leesBill.id };
      const prepared = await prepareIntent(k, "p_sam", newId("c"), input).then(
        (r) => r,
        () => null,
      );
      if (prepared) {
        await requestApproval(k, "p_sam", prepared.intentId);
        await approve(k, "p_maria", prepared.intentId);
        await dispatch(k, prepared.intentId);
        const [op] = await providerOps(s, prepared.intentId);
        await deliver(s, await s.app.fakepay.advance(op!.id, "posted"));
      }
      const after = await s.app.admin
        .selectFrom("work_item")
        .select("status")
        .where("id", "=", leesBill.id)
        .executeTakeFirstOrThrow();
      expect(after.status).toBe("open");
    } finally {
      await s.app.close();
    }
  });
});

describe("R4. a prepare-only delegate can read balances through approval warnings", () => {
  it("cannot recover the funding account's available balance", async () => {
    const app = await freshApp();
    try {
      const k = app.kernel;
      const maria = await connectAll(k, "p_maria", ["harbor", "summit"]);
      await grant(k, "p_maria", {
        delegateId: "p_sam",
        scopes: ["finance.payments.prepare"],
        resourceIds: [maria["3821"]!, maria["9042"]!],
      });
      // The rule says Sam may not see balances.
      expect((await accountsView(k, "p_sam")).accounts).toHaveLength(0);
      const details = (cents: number) => ({
        sourceAccountId: maria["3821"]!,
        payeeResourceId: maria["9042"]!,
        amount: { currency: "USD" as const, cents },
        feeCents: 0,
        scheduledDate: today(),
      });
      const { intentId } = await prepareIntent(k, "p_sam", newId("c"), {
        type: "finance.payment",
        details: details(1),
        workItemId: null,
      });
      let rev = 1;
      const lowerThan = async (cents: number) => {
        await reviseIntent(k, "p_sam", intentId, rev, details(cents));
        rev++;
        const v = await intentView(k, "p_sam", intentId);
        return v.warnings.some((w) => w.includes("lower than this payment"));
      };
      let lo = 1;
      let hi = 10_000_000;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (await lowerThan(mid)) hi = mid;
        else lo = mid + 1;
      }
      const recovered = lo - 1;
      const truth = await app.admin
        .selectFrom("finance_balance")
        .select("available_cents")
        .where("resource_id", "=", maria["3821"]!)
        .executeTakeFirstOrThrow();
      expect(recovered).not.toBe(Number(truth.available_cents));
    } finally {
      await app.close();
    }
  });
});

describe("R5. authority restored with a session alone", () => {
  it("resuming a paused grant needs the owner's passkey", async () => {
    const s = await scenario();
    try {
      await setGrantStatus(s.app.kernel, "p_maria", s.grantId, "paused");
      await withServer(s, async (srv) => {
        // Sam holds Maria's unlocked tablet (threat model #1).
        const mariasSession = await login(srv, "p_maria");
        const res = await srv.inject({
          method: "POST",
          url: `/api/delegation-grants/${s.grantId}/status`,
          headers: mariasSession,
          payload: { status: "active" },
        });
        expect(res.statusCode).toBe(401);
      });
    } finally {
      await s.app.close();
    }
  });

  it("the owner and trusted contact hear when paused authority is resumed", async () => {
    const s = await scenario();
    try {
      await setRosa(s);
      await setGrantStatus(s.app.kernel, "p_maria", s.grantId, "paused");
      // Resuming now needs Maria's passkey; the question is who hears about it.
      await resume(s.app.kernel, "p_maria", s.grantId);
      const recipients = (
        await s.app.admin
          .selectFrom("notification")
          .select(["recipient_person_id", "recipient_email"])
          .where("kind", "in", ["grant.active", "grant.resumed"])
          .execute()
      ).map((n) => n.recipient_person_id ?? n.recipient_email);
      expect(recipients).toEqual(expect.arrayContaining(["p_maria", "rosa@example.test"]));
    } finally {
      await s.app.close();
    }
  });
});

describe("R6. a delegate can hide the owner's bills", () => {
  it("the owner still sees a provider-reported statement a delegate dismissed", async () => {
    const s = await scenario();
    try {
      const k = s.app.kernel;
      const bill = await s.app.admin
        .selectFrom("work_item")
        .select("id")
        .where("owner_id", "=", "p_maria")
        .where("resource_id", "=", s.maria["9042"]!)
        .where("evidence_level", "=", "provider")
        .executeTakeFirstOrThrow();
      await updateWorkItem(k, "p_sam", bill.id, { status: "dismissed" }).catch(() => undefined);
      const mine = (await visibleWorkItems(k, "p_maria")).map((w) => w.id);
      expect(mine).toContain(bill.id);
    } finally {
      await s.app.close();
    }
  });
});

describe("R7. dev-only routes (DEV_LOGIN demonstrator)", () => {
  it("the notification outbox is not readable without a session", async () => {
    const s = await scenario();
    try {
      await setRosa(s);
      await withServer(s, async (srv) => {
        const res = await srv.inject({ method: "GET", url: "/api/dev/outbox" });
        expect(res.statusCode).toBe(401);
      });
    } finally {
      await s.app.close();
    }
  });

  it("a stranger cannot declare someone else's payment returned", async () => {
    const s = await scenario();
    try {
      const intentId = await approvedIntent(s, 42_817);
      await dispatch(s.app.kernel, intentId);
      expect(await status(s, intentId)).toBe("Submitted");
      await withServer(s, async (srv) => {
        const priya = await login(srv, "p_priya");
        const res = await srv.inject({
          method: "POST",
          url: "/api/dev/fakepay/advance",
          headers: priya,
          payload: { intentId, state: "returned" },
        });
        expect(res.statusCode).toBe(404);
      });
      expect(await status(s, intentId)).toBe("Submitted");
    } finally {
      await s.app.close();
    }
  });
});

describe("R8. the application role can rewrite queued jobs through the definer function", () => {
  it("cannot postpone an existing dispatch job by reusing its job key", async () => {
    const s = await scenario();
    try {
      const intentId = await approvedIntent(s, 3_500);
      const key = `dispatch:${intentId}`;
      const before = (await jobs(s.app, "dispatch")).find((j) => j.key === key)!;
      await sql`select public.delegate_enqueue(
        'dispatch', '{"intentId":"nothing"}'::json, '2999-01-01'::timestamptz, ${key}, 25
      )`
        .execute(s.app.kernel.db)
        .catch(() => undefined);
      const after = (await jobs(s.app, "dispatch")).find((j) => j.key === key)!;
      expect(after.run_at.getTime()).toBe(before.run_at.getTime());
    } finally {
      await s.app.close();
    }
  });
});

describe("R9. accepting a request that is no longer pending", () => {
  it("does not apply a grant when the route reports failure", async () => {
    const s = await scenario();
    try {
      const k = s.app.kernel;
      const reqId = await requestMoreAccess(
        k,
        "p_sam",
        "p_maria",
        ["finance.transactions.read"],
        [s.maria["3821"]!],
        null,
      );
      // Maria signs while it is pending; it is then declined before the accept lands.
      const d = await describeRequest(k, "p_maria", reqId);
      const stepUp = await signed(k, "p_maria", "grant", grantDigest("p_maria", d.proposed));
      await decideRequest(k, "p_maria", reqId, "declined");
      await withServer(s, async (srv) => {
        const maria = await login(srv, "p_maria");
        const res = await srv.inject({
          method: "POST",
          url: `/api/grant-requests/${reqId}/accept`,
          headers: maria,
          payload: { stepUp },
        });
        const g = await s.app.admin
          .selectFrom("delegation_grant")
          .select("scopes")
          .where("id", "=", s.grantId)
          .executeTakeFirstOrThrow();
        const applied = g.scopes.includes("finance.transactions.read");
        // Either it succeeds and says so, or it fails and changes nothing.
        expect({ ok: res.statusCode < 300, applied }).toEqual({ ok: applied, applied });
      });
    } finally {
      await s.app.close();
    }
  });
});

describe("R10. support sees amounts in the audit export", () => {
  it("the support export carries no spending limits", async () => {
    const s = await scenario();
    try {
      await withServer(s, async (srv) => {
        const support = await login(srv, "p_support");
        const res = await srv.inject({
          method: "GET",
          url: "/api/audit/export",
          headers: support,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).not.toContain("perPaymentCapCents");
      });
    } finally {
      await s.app.close();
    }
  });
});

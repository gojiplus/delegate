import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freezeOwner,
  setSubmissionsEnabled,
  startRecovery,
  supportOverview,
  unfreezeOwner,
} from "../../src/kernel/control.js";
import { dispatch } from "../../src/kernel/execution.js";
import { setGrantStatus } from "../../src/kernel/grants.js";
import { newId } from "../../src/kernel/ids.js";
import { approvalOptions, prepareIntent, requestApproval } from "../../src/kernel/intents.js";
import { markNeedsReconnect, reconnect } from "../../src/modules/finance/connections.js";
import { accountsView, queueView } from "../../src/modules/finance/reads.js";
import { connectAll, grant, jobs, signed, resume } from "../helpers.js";
import { approvedIntent, payment, providerOps, type Scenario, scenario, status } from "./setup.js";

let s: Scenario;
beforeAll(async () => {
  s = await scenario();
});
afterAll(() => s.app.close());

const holdOf = async (id: string) =>
  (
    await s.app.kernel.db
      .selectFrom("intent")
      .select("hold_reason")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).hold_reason;

describe("owner and operational controls", () => {
  it("pausing a delegate holds their approved payment; resuming releases it", async () => {
    const id = await approvedIntent(s, 3_000);
    await setGrantStatus(s.app.kernel, "p_maria", s.grantId, "paused");
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Scheduled");
    expect(await holdOf(id)).toMatch(/paused/);
    await resume(s.app.kernel, "p_maria", s.grantId);
    expect((await jobs(s.app, "dispatch")).some((j) => j.key === `dispatch:${id}`)).toBe(true);
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Submitted");
  });

  it("support can stop submissions but cannot approve or restart an owner", async () => {
    const id = await approvedIntent(s, 3_100);
    await expect(setSubmissionsEnabled(s.app.kernel, "p_sam", false)).rejects.toThrow(
      /support only/,
    );
    await setSubmissionsEnabled(s.app.kernel, "p_support", false);
    await dispatch(s.app.kernel, id);
    expect(await holdOf(id)).toMatch(/paused system-wide/);
    await setSubmissionsEnabled(s.app.kernel, "p_support", true);
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Submitted");

    // Support sees states and references, not amounts or payees.
    const o = await supportOverview(s.app.kernel, "p_support");
    const row = o.intents.find((r) => r.id === id)!;
    // Exactly these fields: states, times and provider references; no amounts, accounts or payees.
    expect(Object.keys(row).sort()).toEqual([
      "hold_reason",
      "id",
      "last_checked_at",
      "owner_id",
      "provider_operation_id",
      "raw_status",
      "status",
      "status_reason",
      "type",
      "updated_at",
    ]);
    await expect(supportOverview(s.app.kernel, "p_sam")).rejects.toThrow(/support only/);
  });

  it("recovery freezes execution until the owner verifies again; a delegate cannot start it", async () => {
    const id = await approvedIntent(s, 3_200);
    await expect(startRecovery(s.app.kernel, "p_sam", "p_maria")).rejects.toThrow(
      /only the owner or support/,
    );
    await startRecovery(s.app.kernel, "p_maria", "p_maria");
    await dispatch(s.app.kernel, id);
    expect(await holdOf(id)).toMatch(/recovery/);
    // Support froze nothing it can thaw: only the owner, with step-up.
    await expect(
      unfreezeOwner(
        s.app.kernel,
        "p_maria",
        await signed(s.app.kernel, "p_maria", "recovery", "unfreeze:p_maria", "p_sam"),
      ),
    ).rejects.toThrow(/wrong device/);
    await unfreezeOwner(
      s.app.kernel,
      "p_maria",
      await signed(s.app.kernel, "p_maria", "recovery", "unfreeze:p_maria"),
    );
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Submitted");
  });

  it("an owner can freeze their own activity", async () => {
    await freezeOwner(s.app.kernel, "p_maria", "p_maria", "traveling");
    const id = await approvedIntent(s, 3_300);
    await dispatch(s.app.kernel, id);
    expect(await holdOf(id)).toMatch(/traveling/);
    await unfreezeOwner(
      s.app.kernel,
      "p_maria",
      await signed(s.app.kernel, "p_maria", "recovery", "unfreeze:p_maria"),
    );
    expect(await providerOps(s, id)).toHaveLength(0);
  });
});

describe("the dispatch gate re-checks access", () => {
  it("revocation cancels approved-but-unsent payments at once", async () => {
    const id = await approvedIntent(s, 4_000);
    await setGrantStatus(s.app.kernel, "p_maria", s.grantId, "revoked");
    expect(await status(s, id)).toBe("Canceled");
    s.grantId = (
      await grant(s.app.kernel, "p_maria", {
        delegateId: "p_sam",
        scopes: ["finance.balances.read", "finance.obligations.manage", "finance.payments.prepare"],
        resourceIds: [s.maria["3821"]!, s.maria["9042"]!],
      })
    ).grantId;
  });

  it("narrowing a grant stops payments it no longer covers", async () => {
    const id = await approvedIntent(s, 4_100);
    await grant(s.app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read"],
      resourceIds: [s.maria["3821"]!, s.maria["9042"]!],
    });
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Canceled");
    expect(await providerOps(s, id)).toHaveLength(0);
  });

  it("an expired grant stops a scheduled payment", async () => {
    await grant(s.app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read", "finance.obligations.manage", "finance.payments.prepare"],
      resourceIds: [s.maria["3821"]!, s.maria["9042"]!],
    });
    const id = await approvedIntent(s, 4_200);
    await s.app.kernel.db
      .updateTable("delegation_grant")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("id", "=", s.grantId)
      .execute();
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Canceled");
    expect(await providerOps(s, id)).toHaveLength(0);
    await s.app.kernel.db
      .updateTable("delegation_grant")
      .set({ expires_at: null })
      .where("id", "=", s.grantId)
      .execute();
  });
});

describe("evidence, freshness and reconnection", () => {
  it("keeps unknown amounts unknown and labels inferred bills", async () => {
    const items = await s.app.kernel.db
      .selectFrom("work_item")
      .selectAll()
      .where("owner_id", "=", "p_maria")
      .execute();
    const northstar = items.find((w) => w.title.startsWith("Northstar"))!;
    expect(northstar.evidence_level).toBe("provider");
    expect((northstar.details as { amountCents: unknown }).amountCents).toBeNull();
    const water = items.find((w) => w.title.includes("CITY WATER"))!;
    expect(water.evidence_level).toBe("inferred");
    expect(water.source).toMatch(/similar charges/);
    expect((water.details as { amountCents: unknown }).amountCents).toBeNull();
  });

  it("flags existing autopay and a recent payment before approval", async () => {
    const lee = await connectAll(s.app.kernel, "p_lee", ["harbor", "summit"]);
    const { intentId } = await prepareIntent(s.app.kernel, "p_lee", newId("c"), {
      ...payment(s, 120_455, { source: lee["1200"]!, payee: lee["3300"]! }),
    });
    await requestApproval(s.app.kernel, "p_lee", intentId);
    const v = await approvalOptions(s.app.kernel, "p_lee", intentId);
    expect(v.warnings).toContain(
      "Autopay appears to be on for this card. Another payment may be a duplicate.",
    );
    expect(
      v.warnings.some((w) =>
        w.startsWith("A payment of $980.00 (AUTOPAY PAYMENT) already reached this card"),
      ),
    ).toBe(true);
  });

  it("shows stale connections in the delegate's queue and holds payments until reconnect", async () => {
    const conn = await s.app.kernel.db
      .selectFrom("finance_account")
      .select("connection_id")
      .where("resource_id", "=", s.maria["3821"]!)
      .executeTakeFirstOrThrow();
    const id = await approvedIntent(s, 3_400);
    await markNeedsReconnect(s.app.kernel, conn.connection_id);
    const q = await queueView(s.app.kernel, "p_sam");
    expect(q.stale.map((x) => x.detail)).toContain("Needs the owner to reconnect");
    await dispatch(s.app.kernel, id);
    expect(await holdOf(id)).toMatch(/reconnect/);
    // Reconnection is an owner action.
    await expect(reconnect(s.app.kernel, "p_sam", conn.connection_id)).rejects.toThrow("not found");
    const r = await reconnect(s.app.kernel, "p_maria", conn.connection_id);
    // Checking has a persistent identity and keeps its ID and grants; savings
    // matches only on last four + type, so it comes back as a new account for review.
    expect(r).toEqual({ remapped: 1, needsReview: 1 });
    expect((await accountsView(s.app.kernel, "p_sam")).accounts.map((a) => a.id)).toContain(
      s.maria["3821"]!,
    );
    const review = await s.app.kernel.db
      .selectFrom("work_item")
      .selectAll()
      .where("type", "=", "finance.account_review")
      .executeTakeFirstOrThrow();
    expect(review.title).toBe("Is Harbor Savings ••5510 the same account as before?");
    const fresh = await s.app.kernel.db
      .selectFrom("resource")
      .selectAll()
      .where("id", "=", review.resource_id)
      .executeTakeFirstOrThrow();
    expect(fresh.selected).toBe(false);
  });

  it("a grant for one owner never exposes another's queue", async () => {
    await grant(s.app.kernel, "p_priya", {
      delegateId: "p_omar",
      scopes: ["finance.balances.read", "finance.obligations.manage"],
      resourceIds: Object.values(await connectAll(s.app.kernel, "p_priya", ["harbor", "summit"])),
    });
    const omar = await queueView(s.app.kernel, "p_omar");
    expect(new Set(omar.workItems.map((w) => w.owner_id))).toEqual(new Set(["p_priya"]));
    const sam = await queueView(s.app.kernel, "p_sam");
    expect(sam.workItems.every((w) => w.owner_id === "p_maria")).toBe(true);
  });
});

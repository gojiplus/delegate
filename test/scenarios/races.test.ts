import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch } from "../../src/kernel/execution.js";
import { setGrantStatus } from "../../src/kernel/grants.js";
import { jobs, grant } from "../helpers.js";
import { approvedIntent, CAPS, providerOps, type Scenario, scenario, status } from "./setup.js";

let s: Scenario;
beforeAll(async () => {
  s = await scenario();
});
afterAll(() => s.app.close());

async function liveGrantId() {
  const g = await s.app.kernel.db
    .selectFrom("delegation_grant")
    .select("id")
    .where("grantor_id", "=", "p_maria")
    .where("delegate_id", "=", "p_sam")
    .where("status", "<>", "revoked")
    .executeTakeFirst();
  return g?.id;
}

async function regrant() {
  await grant(s.app.kernel, "p_maria", {
    delegateId: "p_sam",
    scopes: ["finance.balances.read", "finance.obligations.manage", "finance.payments.prepare"],
    resourceIds: [s.maria["3821"]!, s.maria["9042"]!],
    constraints: { finance: { periodTimezone: "America/Los_Angeles" } },
  });
}

describe("races", () => {
  it("revocation racing dispatch: either nothing is sent, or the owner is told it was in flight", async () => {
    const outcomes = { revokedFirst: 0, dispatchedFirst: 0 };
    await setGrantStatus(s.app.kernel, "p_maria", (await liveGrantId())!, "revoked");
    for (let n = 0; n < 40; n++) {
      await regrant();
      const id = await approvedIntent(s, 100 + n);
      const gid = (await liveGrantId())!;
      await Promise.all([
        dispatch(s.app.kernel, id),
        setGrantStatus(s.app.kernel, "p_maria", gid, "revoked"),
      ]);
      const ops = await providerOps(s, id);
      const st = await status(s, id);
      const events = await s.app.kernel.db
        .selectFrom("intent_event")
        .selectAll()
        .where("intent_id", "=", id)
        .orderBy("id")
        .execute();
      const revokeEvent = events.find(
        (e) =>
          e.reason?.includes("lost access") ||
          e.reason?.includes("no longer has access") ||
          e.reason?.includes("Access revoked while"),
      );
      expect(revokeEvent, `intent ${id} (${st}) has no revocation trace`).toBeDefined();
      if (ops.length === 0) {
        expect(st).toBe("Canceled");
        outcomes.revokedFirst++;
      } else {
        expect(ops).toHaveLength(1);
        // Dispatch won: the grant was live when the gate committed, and the
        // owner's timeline says the payment was already in flight.
        expect(revokeEvent!.reason).toContain("Access revoked while this was already in flight");
        expect((await jobs(s.app, "cancel_in_flight")).some((j) => j.key === `cancel:${id}`)).toBe(
          true,
        );
        const dispatching = events.find((e) => e.to_status === "Dispatching")!;
        expect(dispatching.id < revokeEvent!.id).toBe(true);
        outcomes.dispatchedFirst++;
      }
    }
    // Both orders must actually occur, or this test proves nothing about the race.
    expect(outcomes.revokedFirst).toBeGreaterThan(0);
    expect(outcomes.dispatchedFirst).toBeGreaterThan(0);
  }, 120_000);

  it("concurrent payments cannot jointly exceed a monthly cap", async () => {
    await grant(s.app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read", "finance.obligations.manage", "finance.payments.prepare"],
      resourceIds: [s.maria["3821"]!, s.maria["9042"]!],
      constraints: CAPS,
    });
    const ids = await Promise.all(
      Array.from({ length: 6 }, (_, n) => approvedIntent(s, 60_000 + n)),
    );
    await Promise.all(ids.map((id) => dispatch(s.app.kernel, id)));
    const sent: string[] = [];
    for (const id of ids) if ((await providerOps(s, id)).length) sent.push(id);
    // $1,500 monthly cap, ~$600 each: exactly two fit.
    expect(sent).toHaveLength(2);
    for (const id of ids.filter((i) => !sent.includes(i))) {
      expect(await status(s, id)).toBe("Canceled");
    }
  });

  it("enforces the per-payment cap at dispatch", async () => {
    const id = await approvedIntent(s, 100_001);
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Canceled");
    expect(await providerOps(s, id)).toHaveLength(0);
  });
});

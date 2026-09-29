import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelInFlight,
  dispatch,
  processInbox,
  receiveWebhook,
  reconcile,
} from "../../src/kernel/execution.js";
import { intentView } from "../../src/kernel/intents.js";
import { approvedIntent, deliver, providerOps, type Scenario, scenario, status } from "./setup.js";

let s: Scenario;
beforeAll(async () => {
  s = await scenario();
});
afterAll(() => s.app.close());

const reasons = async (id: string) =>
  (await intentView(s.app.kernel, "p_maria", id)).timeline.map((e) => e.reason ?? "");

describe("provider failures never create a second payment", () => {
  it("duplicate dispatch jobs submit once", async () => {
    const id = await approvedIntent(s, 1_000);
    await Promise.all([
      dispatch(s.app.kernel, id),
      dispatch(s.app.kernel, id),
      dispatch(s.app.kernel, id),
    ]);
    expect(await providerOps(s, id)).toHaveLength(1);
    expect(await status(s, id)).toBe("Submitted");
  });

  it("a timeout after the provider accepted is reconciled, not resubmitted", async () => {
    const id = await approvedIntent(s, 1_100);
    await s.app.fakepay.setMode("timeout_after_accept");
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Reconciling");
    expect(await providerOps(s, id)).toHaveLength(1);
    await reconcile(s.app.kernel, id);
    expect(await status(s, id)).toBe("Submitted");
    expect(await providerOps(s, id)).toHaveLength(1);
  });

  it("a request lost before the provider saw it is retried with the same key", async () => {
    const id = await approvedIntent(s, 1_200);
    await s.app.fakepay.setMode("timeout_before_accept");
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Reconciling");
    expect(await providerOps(s, id)).toHaveLength(0);
    await reconcile(s.app.kernel, id);
    await reconcile(s.app.kernel, id);
    expect(await status(s, id)).toBe("Submitted");
    expect(await providerOps(s, id)).toHaveLength(1);
  });

  it("without documented idempotent retry, an unknown outcome stops for a human", async () => {
    const id = await approvedIntent(s, 1_300);
    await s.app.fakepay.setMode("timeout_before_accept");
    const fp = s.app.fakepay as unknown as { idempotentRetry: boolean };
    fp.idempotentRetry = false;
    try {
      await dispatch(s.app.kernel, id);
      await reconcile(s.app.kernel, id);
      expect(await status(s, id)).toBe("Reconciling");
      expect(await providerOps(s, id)).toHaveLength(0);
      expect((await reasons(id)).some((r) => r.startsWith("Needs manual reconciliation"))).toBe(
        true,
      );
    } finally {
      fp.idempotentRetry = true;
    }
  });

  it("a worker that died after the gate is recovered by the safety reconcile", async () => {
    const id = await approvedIntent(s, 1_400);
    // Simulate: gate committed (Dispatching), then the process died before submitting.
    const realSubmit = s.app.fakepay.submit.bind(s.app.fakepay);
    s.app.fakepay.submit = () => new Promise(() => undefined);
    void dispatch(s.app.kernel, id);
    for (let n = 0; n < 50 && (await status(s, id)) !== "Dispatching"; n++)
      await new Promise((r) => setTimeout(r, 20));
    s.app.fakepay.submit = realSubmit;
    expect(await status(s, id)).toBe("Dispatching");
    // A restarted worker re-running dispatch does nothing; reconcile finishes it.
    expect((await dispatch(s.app.kernel, id)).kind).toBe("noop");
    await reconcile(s.app.kernel, id);
    expect(await status(s, id)).toBe("Submitted");
    expect(await providerOps(s, id)).toHaveLength(1);
  });

  it("a declined payment fails and releases its limit reservation", async () => {
    const id = await approvedIntent(s, 1_500);
    await s.app.fakepay.setMode("reject");
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Failed");
    const r = await s.app.kernel.db
      .selectFrom("finance_limit_reservation")
      .selectAll()
      .where("intent_id", "=", id)
      .executeTakeFirstOrThrow();
    expect(r.status).toBe("released");
  });
});

describe("webhooks", () => {
  it("rejects bad signatures and deduplicates repeats", async () => {
    const id = await approvedIntent(s, 2_000);
    await dispatch(s.app.kernel, id);
    const [op] = await providerOps(s, id);
    const ev = await s.app.fakepay.advance(op!.id, "delivered");
    const { body } = s.app.fakepay.sign(ev);
    expect(
      await receiveWebhook(
        s.app.kernel,
        "fakepay",
        { "x-fakepay-signature": "00".repeat(32) },
        body,
      ),
    ).toBe(false);
    expect(await receiveWebhook(s.app.kernel, "fakepay", {}, body)).toBe(false);
    expect(await deliver(s, ev)).toBe(true);
    expect(await deliver(s, ev)).toBe(true);
    const n = await s.app.kernel.db
      .selectFrom("inbox_event")
      .select("event_id")
      .where("event_id", "=", ev.eventId)
      .execute();
    expect(n).toHaveLength(1);
    expect(await status(s, id)).toBe("Delivered");
  });

  it("applies reordered events by asking the provider what is true", async () => {
    const id = await approvedIntent(s, 2_100);
    await dispatch(s.app.kernel, id);
    const [op] = await providerOps(s, id);
    const delivered = await s.app.fakepay.advance(op!.id, "delivered");
    const posted = await s.app.fakepay.advance(op!.id, "posted");
    await deliver(s, posted);
    expect(await status(s, id)).toBe("Posted");
    await deliver(s, delivered);
    expect(await status(s, id)).toBe("Posted");
    expect((await reasons(id)).some((r) => r.includes("delivered"))).toBe(true);
  });

  it("waits for our own record when an event beats it", async () => {
    const ev = {
      eventId: "fpev_early",
      operationId: "fpop_not_yet_recorded",
      rawStatus: "delivered",
    };
    const { headers, body } = s.app.fakepay.sign(ev);
    await receiveWebhook(s.app.kernel, "fakepay", headers, body);
    await expect(processInbox(s.app.kernel, "fakepay", ev.eventId)).rejects.toThrow(/no attempt/);
  });

  it("a return after posting reopens the bill and gives capacity back", async () => {
    const id = await approvedIntent(s, 2_200);
    await dispatch(s.app.kernel, id);
    const [op] = await providerOps(s, id);
    await deliver(s, await s.app.fakepay.advance(op!.id, "posted"));
    const r1 = await s.app.kernel.db
      .selectFrom("finance_limit_reservation")
      .selectAll()
      .where("intent_id", "=", id)
      .executeTakeFirstOrThrow();
    expect(r1.status).toBe("consumed");
    await deliver(s, await s.app.fakepay.advance(op!.id, "returned"));
    expect(await status(s, id)).toBe("Returned");
    const r2 = await s.app.kernel.db
      .selectFrom("finance_limit_reservation")
      .selectAll()
      .where("intent_id", "=", id)
      .executeTakeFirstOrThrow();
    expect(r2.status).toBe("released");
  });

  it("cancellation after dispatch is a request that may succeed or be refused", async () => {
    const a = await approvedIntent(s, 2_300);
    await dispatch(s.app.kernel, a);
    await cancelInFlight(s.app.kernel, a);
    expect(await status(s, a)).toBe("Canceled");

    const b = await approvedIntent(s, 2_400);
    await dispatch(s.app.kernel, b);
    const [op] = await providerOps(s, b);
    await deliver(s, await s.app.fakepay.advance(op!.id, "delivered"));
    await cancelInFlight(s.app.kernel, b);
    expect(await status(s, b)).toBe("Delivered");
    expect((await reasons(b)).some((r) => r.startsWith("Cancellation not possible"))).toBe(true);
  });
});

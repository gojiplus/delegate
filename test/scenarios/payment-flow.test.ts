import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dispatch } from "../../src/kernel/execution.js";
import { newId } from "../../src/kernel/ids.js";
import {
  approvalOptions,
  approveIntent,
  intentView,
  prepareIntent,
  requestApproval,
  reviseIntent,
  UnsupportedAction,
} from "../../src/kernel/intents.js";
import { addPayee } from "../../src/modules/finance/connections.js";
import { approve, jobs, signed, today } from "../helpers.js";
import {
  approvedIntent,
  deliver,
  payment,
  providerOps,
  type Scenario,
  scenario,
  status,
} from "./setup.js";

let s: Scenario;
beforeAll(async () => {
  s = await scenario();
});
afterAll(() => s.app.close());

describe("prepare → approve → dispatch → reconcile", () => {
  it("runs the whole path on evidence, and verifies the bill only when posted", async () => {
    const work = await s.app.kernel.db
      .selectFrom("work_item")
      .select("id")
      .where("resource_id", "=", s.maria["9042"]!)
      .executeTakeFirstOrThrow();
    const { intentId } = await prepareIntent(s.app.kernel, "p_sam", "click-1", {
      ...payment(s, 42_817),
      workItemId: work.id,
    });
    expect(await status(s, intentId)).toBe("Draft");
    await requestApproval(s.app.kernel, "p_sam", intentId);

    const view = await approvalOptions(s.app.kernel, "p_maria", intentId);
    expect(view.initiator_name).toBe("Sam Alvarez");
    expect(view.description.lines.map((l) => l.label)).toEqual([
      "Amount",
      "Fee",
      "From",
      "To",
      "Send on",
      "Expected timing",
    ]);
    expect(view.description.summary).toBe(
      `$428.17 from Harbor Checking ••3821 to Summit Visa ••9042 on ${today()}`,
    );
    expect(view.warnings).toContain("A balance check does not reserve funds.");

    await approve(s.app.kernel, "p_maria", intentId);
    expect(await status(s, intentId)).toBe("Scheduled");
    expect((await jobs(s.app.kernel, "dispatch")).map((j) => j.key)).toContain(
      `dispatch:${intentId}`,
    );

    await dispatch(s.app.kernel, intentId);
    expect(await status(s, intentId)).toBe("Submitted");
    const [op] = await providerOps(s, intentId);
    expect(op).toBeDefined();

    await deliver(s, await s.app.fakepay.advance(op!.id, "delivered"));
    expect(await status(s, intentId)).toBe("Delivered");
    const w1 = await s.app.kernel.db
      .selectFrom("work_item")
      .selectAll()
      .where("id", "=", work.id)
      .executeTakeFirstOrThrow();
    expect(w1.status).toBe("open");

    await deliver(s, await s.app.fakepay.advance(op!.id, "posted"));
    expect(await status(s, intentId)).toBe("Posted");
    const w2 = await s.app.kernel.db
      .selectFrom("work_item")
      .selectAll()
      .where("id", "=", work.id)
      .executeTakeFirstOrThrow();
    expect(w2.status).toBe("verified_done");

    const timeline = (await intentView(s.app.kernel, "p_maria", intentId)).timeline.map(
      (e) => e.to_status,
    );
    expect(timeline).toEqual([
      "Draft",
      "AwaitingApproval",
      "Scheduled",
      "Dispatching",
      "Submitted",
      "Delivered",
      "Posted",
    ]);
  });

  it("returns the same intent for repeated clicks", async () => {
    const a = await prepareIntent(s.app.kernel, "p_sam", "same-click", payment(s, 1_000));
    const b = await prepareIntent(s.app.kernel, "p_sam", "same-click", payment(s, 1_000));
    expect(b).toEqual({ intentId: a.intentId, created: false });
  });

  it("says honestly what cannot be executed, and why", async () => {
    const kinds = async (d: ReturnType<typeof payment>, by = "p_sam") => {
      try {
        await prepareIntent(s.app.kernel, by, newId("c"), d);
        return "executable";
      } catch (e) {
        if (e instanceof UnsupportedAction) return `${e.capability.state}: ${e.capability.reason}`;
        throw e;
      }
    };
    expect(await kinds(payment(s, 5_000, { payee: s.maria["5510"]! }))).toBe(
      "unavailable: Transfers between your own accounts are excluded in this release.",
    );
    expect(await kinds(payment(s, 5_000, { source: s.maria["7744"]! }), "p_maria")).toMatch(
      /^requires_setup: Joint accounts/,
    );
    expect(await kinds(payment(s, 5_000, { payee: s.maria["6120"]! }), "p_maria")).toMatch(
      /^external: Northstar Card is not supported/,
    );
    const water = await addPayee(s.app.kernel, "p_maria", {
      name: "City Water Dept",
      category: "utility",
      website: "https://water.example.test",
    });
    expect(await kinds(payment(s, 5_000, { payee: water }), "p_maria")).toMatch(
      /^external: No supported integration pays City Water Dept/,
    );
    // Sam cannot even ask about a payee he was not given.
    await expect(
      prepareIntent(s.app.kernel, "p_sam", newId("c"), payment(s, 5_000, { payee: water })),
    ).rejects.toThrow("not found");
  });

  it("invalidates approval when anything in the request changes", async () => {
    const id = await approvedIntent(s, 20_000);
    const old = await s.app.kernel.db
      .selectFrom("intent_revision")
      .selectAll()
      .where("intent_id", "=", id)
      .executeTakeFirstOrThrow();
    const changed = payment(s, 20_001).details;
    await reviseIntent(s.app.kernel, "p_sam", id, 1, changed);
    expect(await status(s, id)).toBe("AwaitingApproval");
    // The Scheduled dispatch job still fires, but finds nothing approved to send.
    const out = await dispatch(s.app.kernel, id);
    expect(out.kind).toBe("noop");
    expect(await providerOps(s, id)).toEqual([]);
    // An approval signed for revision 1 cannot approve revision 2.
    const sig = await signed(s.app.kernel, "p_maria", "approve", old.digest);
    await expect(approveIntent(s.app.kernel, "p_maria", id, 2, old.digest, sig)).rejects.toThrow(
      /does not match/,
    );
    const v2 = await approvalOptions(s.app.kernel, "p_maria", id);
    await expect(
      approveIntent(s.app.kernel, "p_maria", id, 2, v2.revision.digest, sig),
    ).rejects.toThrow(/step-up/);
    await approve(s.app.kernel, "p_maria", id);
    expect(await status(s, id)).toBe("Scheduled");
  });

  it("lets only the owner approve, and only with step-up", async () => {
    const { intentId } = await prepareIntent(s.app.kernel, "p_sam", newId("c"), payment(s, 3_000));
    await requestApproval(s.app.kernel, "p_sam", intentId);
    const v = await approvalOptions(s.app.kernel, "p_maria", intentId);
    await expect(
      approveIntent(s.app.kernel, "p_sam", intentId, 1, v.revision.digest, {
        challenge: v.challenge,
        signedBy: "p_sam",
      }),
    ).rejects.toThrow(/only the owner/);
    await expect(
      approveIntent(s.app.kernel, "p_support", intentId, 1, v.revision.digest, {
        challenge: v.challenge,
        signedBy: "p_support",
      }),
    ).rejects.toThrow(/only the owner/);
    // Following a notification link is not approval: no step-up, no approval.
    await expect(
      approveIntent(s.app.kernel, "p_maria", intentId, 1, v.revision.digest, {}),
    ).rejects.toThrow(/step-up/);
    await expect(approvalOptions(s.app.kernel, "p_sam", intentId)).rejects.toThrow(
      /only the owner/,
    );
    expect(await status(s, intentId)).toBe("AwaitingApproval");
  });

  it("refuses to send once the approval has expired", async () => {
    const id = await approvedIntent(s, 2_500);
    await s.app.kernel.db
      .updateTable("approval")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("intent_id", "=", id)
      .execute();
    await dispatch(s.app.kernel, id);
    expect(await status(s, id)).toBe("Expired");
    expect(await providerOps(s, id)).toEqual([]);
  });

  it("waits for the scheduled date", async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const { intentId } = await prepareIntent(
      s.app.kernel,
      "p_sam",
      newId("c"),
      payment(s, 2_000, { scheduledDate: future }),
    );
    await requestApproval(s.app.kernel, "p_sam", intentId);
    await approve(s.app.kernel, "p_maria", intentId);
    expect((await dispatch(s.app.kernel, intentId)).kind).toBe("noop");
    expect(await status(s, intentId)).toBe("Scheduled");
    const job = (await jobs(s.app.kernel, "dispatch")).find(
      (j) => j.key === `dispatch:${intentId}`,
    );
    expect(job!.run_at.toISOString().slice(0, 10)).toBe(future);
  });
});

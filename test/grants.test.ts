import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canAccess, visibleResourceIds } from "../src/kernel/access.js";
import { exportAudit, verifyChain } from "../src/kernel/audit.js";
import {
  decideRequest,
  describeRequest,
  grantDigest,
  previewGrant,
  requestMoreAccess,
  setGrant,
  setGrantStatus,
} from "../src/kernel/grants.js";
import { addPayee, connectInstitution } from "../src/modules/finance/connections.js";
import { accountsView, queueView, transactionsView } from "../src/modules/finance/reads.js";
import { type App } from "../src/app.js";
import { connectAll, freshApp, grant, signed } from "./helpers.js";

let app: App;
let maria: Record<string, string>;

beforeAll(async () => {
  app = await freshApp();
  maria = await connectAll(app.kernel, "p_maria", ["harbor", "lakeside", "summit", "northstar"]);
  await connectAll(app.kernel, "p_lee", ["harbor", "summit"]);
});
afterAll(() => app.close());

describe("grants and scoped reads", () => {
  it("shows a delegate nothing before a grant", async () => {
    const v = await accountsView(app.kernel, "p_sam");
    expect(v.accounts).toEqual([]);
    expect((await queueView(app.kernel, "p_sam")).workItems).toEqual([]);
  });

  it("previews exactly what will be shared, in plain language", async () => {
    const p = await previewGrant(app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read"],
      resourceIds: [maria["3821"]!],
      constraints: {},
      expiresAt: null,
    });
    expect(p.sentences[0]).toBe("See balances and account details for: Harbor Checking ••3821.");
    expect(p.sentences.at(-1)).toContain("cannot approve payments");
    const limited = await previewGrant(app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.payments.prepare"],
      resourceIds: [maria["3821"]!, maria["9042"]!],
      constraints: { finance: { perPaymentCapCents: 100_000, monthlyCapCents: 150_000 } },
      expiresAt: null,
    });
    expect(limited.sentences).toContain("Payments they prepare can be at most $1,000.00 each.");
    expect(limited.sentences.join(" ")).not.toMatch(/[{}]/);
  });

  it("scopes reads, totals and guessed IDs to the grant", async () => {
    await grant(app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read"],
      resourceIds: [maria["3821"]!],
    });
    const v = await accountsView(app.kernel, "p_sam");
    expect(v.accounts.map((a) => a.mask)).toEqual(["3821"]);
    // Aggregates include only what is shared: checking's $5,982.10, not savings.
    expect(v.totals).toEqual([
      { ownerId: "p_maria", ownerName: "Maria Alvarez", knownCents: 598_210, unknownCount: 0 },
    ]);
    // Balances do not imply transactions.
    await expect(transactionsView(app.kernel, "p_sam", maria["3821"]!)).rejects.toThrow(
      "not found",
    );
    // A guessed ID of an unshared account fails exactly like a nonexistent one.
    await expect(transactionsView(app.kernel, "p_sam", maria["5510"]!)).rejects.toThrow(
      "not found",
    );
    await expect(transactionsView(app.kernel, "p_sam", "acct_doesnotexist")).rejects.toThrow(
      "not found",
    );
  });

  it("does not share with anyone else in the family", async () => {
    expect((await accountsView(app.kernel, "p_tom")).accounts).toEqual([]);
    expect(
      await canAccess(
        app.kernel.db,
        app.kernel.registry,
        "p_tom",
        "finance.balances.read",
        maria["3821"]!,
      ),
    ).toBe(false);
  });

  it("refuses to share a joint account or an unselected one", async () => {
    await expect(
      grant(app.kernel, "p_maria", {
        delegateId: "p_sam",
        scopes: ["finance.balances.read"],
        resourceIds: [maria["7744"]!],
      }),
    ).rejects.toThrow(/Joint account/);
    await connectInstitution(app.kernel, "p_maria", "harbor");
    const fresh = await app.kernel.db
      .selectFrom("resource")
      .select("id")
      .where("owner_id", "=", "p_maria")
      .where("selected", "=", false)
      .executeTakeFirstOrThrow();
    await expect(
      grant(app.kernel, "p_maria", {
        delegateId: "p_sam",
        scopes: ["finance.balances.read"],
        resourceIds: [fresh.id],
      }),
    ).rejects.toThrow(/not selected/);
  });

  it("never lets a delegate widen their own access", async () => {
    // Sam cannot grant himself Maria's savings: he does not own it.
    await expect(
      grant(app.kernel, "p_sam", {
        delegateId: "p_lee",
        scopes: ["finance.balances.read"],
        resourceIds: [maria["5510"]!],
      }),
    ).rejects.toThrow(/only share what you own/);
    // Nor can he sign Maria's grant with his own device.
    const p = {
      delegateId: "p_sam",
      scopes: ["finance.balances.read", "finance.transactions.read"],
      resourceIds: [maria["3821"]!, maria["5510"]!],
      constraints: {},
      expiresAt: null,
    };
    await expect(
      setGrant(
        app.kernel,
        "p_maria",
        p,
        await signed(app.kernel, "p_maria", "grant", grantDigest("p_maria", p), "p_sam"),
      ),
    ).rejects.toThrow(/wrong device/);
  });

  it("binds the passkey to the exact grant and uses it once", async () => {
    const narrow = {
      delegateId: "p_sam",
      scopes: ["finance.balances.read"],
      resourceIds: [maria["3821"]!],
      constraints: {},
      expiresAt: null,
    };
    const wide = { ...narrow, resourceIds: [maria["3821"]!, maria["5510"]!] };
    const sig = await signed(app.kernel, "p_maria", "grant", grantDigest("p_maria", narrow));
    await expect(setGrant(app.kernel, "p_maria", wide, sig)).rejects.toThrow(/step-up/);
    await setGrant(app.kernel, "p_maria", narrow, sig);
    await expect(setGrant(app.kernel, "p_maria", narrow, sig)).rejects.toThrow(/step-up/);
  });

  it("turns a request for more into access only when the owner signs it", async () => {
    const reqId = await requestMoreAccess(
      app.kernel,
      "p_sam",
      "p_maria",
      ["finance.transactions.read"],
      [maria["3821"]!],
      "to check the water bill",
    );
    expect(
      await canAccess(
        app.kernel.db,
        app.kernel.registry,
        "p_sam",
        "finance.transactions.read",
        maria["3821"]!,
      ),
    ).toBe(false);
    const d = await describeRequest(app.kernel, "p_maria", reqId);
    expect(d.current?.scopes).toEqual(["finance.balances.read"]);
    expect(d.proposed.scopes).toEqual(["finance.balances.read", "finance.transactions.read"]);
    await expect(describeRequest(app.kernel, "p_sam", reqId)).rejects.toThrow("not found");
    await setGrant(
      app.kernel,
      "p_maria",
      d.proposed,
      await signed(app.kernel, "p_maria", "grant", grantDigest("p_maria", d.proposed)),
    );
    await decideRequest(app.kernel, "p_maria", reqId, "accepted");
    expect((await transactionsView(app.kernel, "p_sam", maria["3821"]!)).length).toBeGreaterThan(0);
  });

  it("cuts access on the next read after revocation commits", async () => {
    const g = await app.kernel.db
      .selectFrom("delegation_grant")
      .selectAll()
      .where("delegate_id", "=", "p_sam")
      .where("status", "=", "active")
      .executeTakeFirstOrThrow();
    await setGrantStatus(app.kernel, "p_maria", g.id, "paused");
    expect((await accountsView(app.kernel, "p_sam")).accounts).toEqual([]);
    await setGrantStatus(app.kernel, "p_maria", g.id, "active");
    expect((await accountsView(app.kernel, "p_sam")).accounts).toHaveLength(1);
    await expect(setGrantStatus(app.kernel, "p_sam", g.id, "revoked")).rejects.toThrow("not found");
    await setGrantStatus(app.kernel, "p_maria", g.id, "revoked");
    expect((await accountsView(app.kernel, "p_sam")).accounts).toEqual([]);
    await expect(transactionsView(app.kernel, "p_sam", maria["3821"]!)).rejects.toThrow(
      "not found",
    );
  });

  it("expires grants on their own", async () => {
    await grant(app.kernel, "p_lee", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read"],
      resourceIds: (
        await visibleResourceIds(
          app.kernel.db,
          app.kernel.registry,
          "p_lee",
          "finance.balances.read",
        )
      ).slice(0, 1),
      expiresAt: new Date(Date.now() + 1500).toISOString(),
    });
    expect((await accountsView(app.kernel, "p_sam")).accounts).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 1600));
    expect((await accountsView(app.kernel, "p_sam")).accounts).toHaveLength(0);
  });

  it("shares payees only when named", async () => {
    const water = await addPayee(app.kernel, "p_maria", {
      name: "City Water Dept",
      category: "utility",
      website: "https://water.example.test",
    });
    expect(
      await canAccess(
        app.kernel.db,
        app.kernel.registry,
        "p_sam",
        "finance.obligations.manage",
        water,
      ),
    ).toBe(false);
  });

  it("keeps an append-only, hash-chained audit trail", async () => {
    const records = await exportAudit(app.kernel.db);
    expect(
      records.some(
        (r) =>
          r.action === "read.finance.accounts" &&
          r.actor_id === "p_sam" &&
          r.owner_id === "p_maria",
      ),
    ).toBe(true);
    expect(verifyChain(records)).toEqual({ ok: true });
    await expect(
      app.kernel.db.updateTable("audit_event").set({ action: "x" }).execute(),
    ).rejects.toThrow(/append-only/);
    await expect(app.kernel.db.deleteFrom("audit_event").execute()).rejects.toThrow(/append-only/);
    const tampered = records.map((r, n) =>
      n === 3 ? { ...r, detail: { ...r.detail, forged: true } } : r,
    );
    expect(verifyChain(tampered)).toEqual({ ok: false, seq: records[3]!.seq });
    const dropped = records.filter((_, n) => n !== 5);
    expect(verifyChain(dropped).ok).toBe(false);
  });
});

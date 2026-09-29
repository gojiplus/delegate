import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/api/server.js";
import type { App } from "../src/app.js";
import { connectAll, freshApp, grant, today } from "./helpers.js";

// The HTTP layer adds one thing the kernel cannot check: that the actor comes
// from the session and nothing else. These tests go through real routes.

let app: App;
let server: FastifyInstance;
let maria: Record<string, string>;
const rp = { id: "localhost", name: "test", origin: "http://localhost:5173" };

async function login(personId: string) {
  const res = await server.inject({ method: "POST", url: "/api/dev/login", payload: { personId } });
  const c = res.cookies.find((x) => x.name === "sid")!;
  return { cookie: `sid=${c.value}` };
}

beforeAll(async () => {
  app = await freshApp();
  server = await buildServer(app, { rp, devLogin: true });
  maria = await connectAll(app.kernel, "p_maria", ["harbor", "summit"]);
  await grant(app.kernel, "p_maria", {
    delegateId: "p_sam",
    scopes: ["finance.balances.read", "finance.payments.prepare"],
    resourceIds: [maria["3821"]!, maria["9042"]!],
  });
});
afterAll(async () => {
  await server.close();
  await app.close();
});

describe("http", () => {
  it("requires a session", async () => {
    expect((await server.inject({ method: "GET", url: "/api/accounts" })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/api/accounts",
          headers: { cookie: "sid=forged" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("ignores any actor the client claims", async () => {
    const sam = await login("p_sam");
    const res = await server.inject({
      method: "POST",
      url: "/api/delegation-grants/whatever/status",
      headers: sam,
      payload: { status: "revoked", personId: "p_maria", actorId: "p_maria" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for guessed IDs, identical to nonexistent ones", async () => {
    const tom = await login("p_tom");
    const a = await server.inject({
      method: "GET",
      url: `/api/accounts/${maria["3821"]}/transactions`,
      headers: tom,
    });
    const b = await server.inject({
      method: "GET",
      url: `/api/accounts/acct_nope/transactions`,
      headers: tom,
    });
    expect([a.statusCode, b.statusCode]).toEqual([404, 404]);
    expect(a.body).toBe(b.body);
  });

  it("requires an idempotency key and honours it", async () => {
    const sam = await login("p_sam");
    const payload = {
      type: "finance.payment",
      details: {
        sourceAccountId: maria["3821"],
        payeeResourceId: maria["9042"],
        amount: { currency: "USD", cents: 5_000 },
        feeCents: 0,
        scheduledDate: today(),
      },
    };
    expect(
      (await server.inject({ method: "POST", url: "/api/payment-intents", headers: sam, payload }))
        .statusCode,
    ).toBe(400);
    const h = { ...sam, "idempotency-key": "k-12345678" };
    const first = await server.inject({
      method: "POST",
      url: "/api/payment-intents",
      headers: h,
      payload,
    });
    const second = await server.inject({
      method: "POST",
      url: "/api/payment-intents",
      headers: h,
      payload,
    });
    expect([first.statusCode, second.statusCode]).toEqual([201, 200]);
    expect(first.json().intentId).toBe(second.json().intentId);
  });

  it("returns an honest capability for unsupported actions", async () => {
    const maria_ = await login("p_maria");
    const res = await server.inject({
      method: "POST",
      url: "/api/payment-intents",
      headers: { ...maria_, "idempotency-key": "k-transfer-1" },
      payload: {
        type: "finance.payment",
        details: {
          sourceAccountId: maria["3821"],
          payeeResourceId: maria["5510"],
          amount: { currency: "USD", cents: 5_000 },
          feeCents: 0,
          scheduledDate: today(),
        },
      },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().capability.state).toBe("unavailable");
  });

  it("will not approve without a passkey, whatever the client sends", async () => {
    const sam = await login("p_sam");
    const created = await server.inject({
      method: "POST",
      url: "/api/payment-intents",
      headers: { ...sam, "idempotency-key": "k-approve-test" },
      payload: {
        type: "finance.payment",
        details: {
          sourceAccountId: maria["3821"],
          payeeResourceId: maria["9042"],
          amount: { currency: "USD", cents: 7_000 },
          feeCents: 0,
          scheduledDate: today(),
        },
      },
    });
    const id = created.json().intentId;
    await server.inject({
      method: "POST",
      url: `/api/payment-intents/${id}/approval-requests`,
      headers: sam,
    });
    const m = await login("p_maria");
    const view = (
      await server.inject({ method: "GET", url: `/api/payment-intents/${id}`, headers: m })
    ).json();
    const res = await server.inject({
      method: "POST",
      url: `/api/payment-intents/${id}/approvals`,
      headers: m,
      payload: {
        revision: view.revision.number,
        digest: view.revision.digest,
        stepUp: { approved: true },
      },
    });
    expect(res.statusCode).toBe(401);
    const after = (
      await server.inject({ method: "GET", url: `/api/payment-intents/${id}`, headers: m })
    ).json();
    expect(after.status).toBe("AwaitingApproval");
  });

  it("accepts only signed webhooks", async () => {
    const body = JSON.stringify({ eventId: "e1", operationId: "o1", rawStatus: "posted" });
    const bad = await server.inject({
      method: "POST",
      url: "/api/webhooks/fakepay",
      headers: { "content-type": "application/json", "x-fakepay-signature": "ab" },
      payload: body,
    });
    expect(bad.statusCode).toBe(401);
    const { headers, body: signedBody } = app.fakepay.sign({
      eventId: "e2",
      operationId: "o2",
      rawStatus: "posted",
    });
    const good = await server.inject({
      method: "POST",
      url: "/api/webhooks/fakepay",
      headers: { ...headers, "content-type": "application/json" },
      payload: signedBody,
    });
    expect(good.statusCode).toBe(202);
  });

  it("gives an owner only their own audit events", async () => {
    const lee = await login("p_lee");
    const res = await server.inject({ method: "GET", url: "/api/audit/export", headers: lee });
    const lines = res.body
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines.every((l: { owner_id: string }) => l.owner_id === "p_lee")).toBe(true);
    const support = await login("p_support");
    const full = await server.inject({ method: "GET", url: "/api/audit/export", headers: support });
    expect(full.headers["x-audit-chain"]).toBe("verified");
  });
});

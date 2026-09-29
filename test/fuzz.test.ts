import fc from "fast-check";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { newId } from "../src/kernel/ids.js";
import { prepareIntent } from "../src/kernel/intents.js";
import { addPayee } from "../src/modules/finance/connections.js";
import { SESSION_COOKIE } from "../src/kernel/sessions.js";
import { connectAll, freshApp, grant, type TestApp, today } from "./helpers.js";

// Authorisation-aware API fuzzing. Random requests (real routes, random
// methods of attack: other people's IDs, junk IDs, injection strings, random
// bodies) are sent as people who should see little or nothing of Maria's or
// Priya's. The properties: no 5xx, no response ever contains an identifier or
// label they may not see, and nothing the owners own changes.

let app: TestApp;
let server: FastifyInstance;
const rp = { id: "localhost", name: "test", origin: "http://localhost:5173" };
const cookies: Record<string, string> = {};
let ids: string[] = [];
const secrets: Record<string, string[]> = {};
let ownerState = "";

async function snapshotOwnerState() {
  const [grants, intents, approvals, ops, freezes] = await Promise.all([
    app.admin
      .selectFrom("delegation_grant")
      .select(["id", "status", "version", "scopes"])
      .orderBy("id")
      .execute(),
    app.admin
      .selectFrom("intent")
      .select(["id", "status", "current_revision"])
      .where("initiator_id", "in", ["p_maria", "p_priya"])
      .orderBy("id")
      .execute(),
    app.admin.selectFrom("approval").select("id").execute(),
    app.admin.selectFrom("fakepay.operation").select("id").execute(),
    app.admin
      .selectFrom("owner_freeze")
      .select("owner_id")
      .where("owner_id", "in", ["p_maria", "p_priya"])
      .execute(),
  ]);
  const selected = await app.admin
    .selectFrom("resource")
    .select(["id", "selected"])
    .where("owner_id", "in", ["p_maria", "p_priya"])
    .orderBy("id")
    .execute();
  return JSON.stringify({ grants, intents, approvals, ops, freezes, selected });
}

beforeAll(async () => {
  app = await freshApp();
  server = await buildServer(app, { rp, devLogin: true });
  const maria = await connectAll(app.kernel, "p_maria", [
    "harbor",
    "lakeside",
    "summit",
    "northstar",
  ]);
  const water = await addPayee(app.kernel, "p_maria", {
    name: "City Water Dept",
    category: "utility",
    website: null,
  });
  const priya = await connectAll(app.kernel, "p_priya", ["harbor", "summit"]);
  await grant(app.kernel, "p_maria", {
    delegateId: "p_sam",
    scopes: ["finance.balances.read", "finance.payments.prepare"],
    resourceIds: [maria["3821"]!, maria["9042"]!],
  });
  // Maria's own payment from savings, which Sam was not given.
  const { intentId: mariaIntent } = await prepareIntent(app.kernel, "p_maria", newId("c"), {
    type: "finance.payment",
    details: {
      sourceAccountId: maria["5510"],
      payeeResourceId: maria["9042"],
      amount: { currency: "USD", cents: 5_000 },
      feeCents: 0,
      scheduledDate: today(),
    },
    workItemId: null,
  });
  const work = await app.admin
    .selectFrom("work_item")
    .select(["id", "owner_id", "resource_id"])
    .execute();
  const connections = await app.admin.selectFrom("finance_connection").select("id").execute();
  const resources = await app.admin
    .selectFrom("resource")
    .select(["id", "owner_id", "label"])
    .execute();
  ids = [
    ...resources.map((r) => r.id),
    mariaIntent,
    ...work.map((w) => w.id),
    ...connections.map((c) => c.id),
    water,
  ];

  const sharedWithSam = new Set([maria["3821"], maria["9042"]]);
  const hidden = (who: "p_sam" | "p_tom" | "p_omar") => [
    ...resources
      .filter((r) => r.owner_id !== who && !(who === "p_sam" && sharedWithSam.has(r.id)))
      .flatMap((r) => [r.id, r.label]),
    ...work.filter((w) => !(who === "p_sam" && sharedWithSam.has(w.resource_id))).map((w) => w.id),
    mariaIntent,
  ];
  secrets.p_sam = hidden("p_sam");
  secrets.p_tom = hidden("p_tom");
  secrets.p_omar = hidden("p_omar");
  void priya;

  for (const who of ["p_sam", "p_tom", "p_omar"]) {
    const res = await server.inject({
      method: "POST",
      url: "/api/dev/login",
      payload: { personId: who },
      headers: { origin: rp.origin },
    });
    cookies[who] = res.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
  }
  ownerState = await snapshotOwnerState();
}, 120_000);
afterAll(async () => {
  await server.close();
  await app.close();
});

const JUNK = [
  "",
  "x",
  "' or 1=1 --",
  "../../etc/passwd",
  "acct_",
  "%00",
  "{}",
  "null",
  "__proto__",
  "9".repeat(40),
];

describe("authorisation-aware API fuzzing", () => {
  it("never 5xx, never leaks, never changes what owners own", async () => {
    const id = () =>
      fc.oneof(fc.constantFrom(...ids), fc.constantFrom(...JUNK), fc.string({ maxLength: 12 }));
    const person = fc.constantFrom(
      "p_maria",
      "p_priya",
      "p_sam",
      "p_tom",
      "p_omar",
      "p_support",
      "nobody",
    );
    const scopes = fc.subarray([
      "finance.balances.read",
      "finance.transactions.read",
      "finance.obligations.manage",
      "finance.payments.prepare",
      "admin",
      "*",
    ]);
    const details = fc.record({
      sourceAccountId: id(),
      payeeResourceId: id(),
      amount: fc.record({
        currency: fc.constantFrom("USD", "EUR"),
        cents: fc.integer({ min: -5, max: 20_000_000 }),
      }),
      feeCents: fc.integer({ min: -1, max: 5 }),
      scheduledDate: fc.constantFrom(today(), "2000-01-01", "not-a-date"),
    });
    const request = fc.oneof(
      fc
        .constantFrom(
          "/api/accounts",
          "/api/queue",
          "/api/payment-intents",
          "/api/payees",
          "/api/grants",
          "/api/grant-requests",
          "/api/notifications",
          "/api/resources/mine",
          "/api/me",
          "/api/support/overview",
          "/api/audit/export",
          "/api/trusted-contact",
        )
        .map((url) => ({ method: "GET", url })),
      id().map((i) => ({
        method: "GET",
        url: `/api/accounts/${encodeURIComponent(i)}/transactions`,
      })),
      fc.tuple(id(), id()).map(([a, b]) => ({
        method: "GET",
        url: `/api/accounts/${encodeURIComponent(a)}/capabilities?payee=${encodeURIComponent(b)}`,
      })),
      id().map((i) => ({ method: "GET", url: `/api/payment-intents/${encodeURIComponent(i)}` })),
      id().map((i) => ({ method: "GET", url: `/api/grant-requests/${encodeURIComponent(i)}` })),
      fc.tuple(details, fc.constantFrom("finance.payment", "x")).map(([d, type]) => ({
        method: "POST",
        url: "/api/payment-intents",
        body: { type, details: d },
        key: true,
      })),
      fc.tuple(id(), details).map(([i, d]) => ({
        method: "PUT",
        url: `/api/payment-intents/${encodeURIComponent(i)}/revisions`,
        body: { expectedRevision: 1, details: d },
      })),
      fc
        .tuple(
          id(),
          fc.constantFrom(
            "approval-requests",
            "approval-options",
            "approvals",
            "rejections",
            "cancel-requests",
          ),
        )
        .map(([i, a]) => ({
          method: "POST",
          url: `/api/payment-intents/${encodeURIComponent(i)}/${a}`,
          body: {
            revision: 1,
            digest: "sha256:0",
            stepUp: { challenge: "x", signedBy: "p_maria" },
          },
        })),
      fc.tuple(id(), fc.constantFrom("active", "paused", "revoked")).map(([i, status]) => ({
        method: "POST",
        url: `/api/delegation-grants/${encodeURIComponent(i)}/status`,
        body: { status },
      })),
      id().map((i) => ({
        method: "DELETE",
        url: `/api/delegation-grants/${encodeURIComponent(i)}`,
      })),
      fc
        .tuple(
          fc.constantFrom("/api/grants/preview", "/api/delegation-grants"),
          person,
          scopes,
          fc.array(id(), { maxLength: 3 }),
        )
        .map(([url, delegateId, sc, resourceIds]) => ({
          method: "POST",
          url,
          body: {
            delegateId,
            scopes: sc,
            resourceIds,
            proposal: { delegateId, scopes: sc, resourceIds },
            stepUp: { signedBy: "p_maria" },
          },
        })),
      fc
        .tuple(id(), fc.constantFrom("open", "marked_done", "dismissed", "verified_done"))
        .map(([i, status]) => ({
          method: "PATCH",
          url: `/api/work-items/${encodeURIComponent(i)}`,
          body: { status },
        })),
      id().map((i) => ({
        method: "POST",
        url: "/api/obligations",
        body: { resourceId: i, title: "t", amountCents: 100, dueDate: null },
      })),
      fc.tuple(id(), fc.boolean()).map(([i, selected]) => ({
        method: "POST",
        url: "/api/accounts/selection",
        body: { resourceIds: [i], selected },
      })),
      id().map((i) => ({
        method: "POST",
        url: `/api/connections/${encodeURIComponent(i)}/reconnect`,
      })),
      fc
        .tuple(person, scopes, fc.array(id(), { maxLength: 3 }))
        .map(([grantorId, sc, resourceIds]) => ({
          method: "POST",
          url: "/api/grant-requests",
          body: { grantorId, scopes: sc, resourceIds },
        })),
      fc.tuple(id(), fc.constantFrom("accept", "decline")).map(([i, a]) => ({
        method: "POST",
        url: `/api/grant-requests/${encodeURIComponent(i)}/${a}`,
        body: { stepUp: {} },
      })),
      person.map((ownerId) => ({
        method: "POST",
        url: "/api/support/freeze",
        body: { ownerId, reason: "x" },
      })),
      person.map((ownerId) => ({
        method: "POST",
        url: "/api/support/recovery-verified",
        body: { ownerId },
      })),
      fc.constant({ method: "POST", url: "/api/support/submissions", body: { enabled: false } }),
      fc
        .anything()
        .map((body) => ({ method: "POST", url: "/api/payment-intents", body, key: true })),
    );

    const statuses: Record<number, number> = {};
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("p_sam", "p_tom", "p_omar"),
        request,
        fc.nat({ max: 250 }),
        async (who, r, ip) => {
          const res = await server.inject({
            method: r.method as "GET",
            url: r.url,
            remoteAddress: `10.0.${ip % 250}.${(ip * 7) % 250}`,
            headers: {
              cookie: `${SESSION_COOKIE}=${cookies[who]}`,
              origin: rp.origin,
              ...("key" in r && r.key ? { "idempotency-key": newId("fuzz") } : {}),
            },
            ...("body" in r ? { payload: r.body as object } : {}),
          });
          statuses[res.statusCode] = (statuses[res.statusCode] ?? 0) + 1;
          expect(
            res.statusCode,
            `${who} ${r.method} ${r.url} -> ${res.body.slice(0, 200)}`,
          ).toBeLessThan(500);
          for (const s of secrets[who]!) {
            expect(res.body.includes(s), `${who} ${r.method} ${r.url} leaked ${s}`).toBe(false);
          }
        },
      ),
      { numRuns: 1500 },
    );
    // The run must reach real handlers, not bounce off authentication or rate limits.
    console.log("fuzz status histogram", statuses);
    const total = Object.values(statuses).reduce((a, b) => a + b, 0);
    expect(total).toBe(1500);
    expect((statuses[200] ?? 0) + (statuses[201] ?? 0)).toBeGreaterThan(total * 0.05);
    expect((statuses[401] ?? 0) + (statuses[429] ?? 0)).toBeLessThan(total * 0.2);
    expect(await snapshotOwnerState()).toBe(ownerState);
  }, 300_000);
});

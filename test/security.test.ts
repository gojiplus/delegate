import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createDb } from "../src/db/index.js";
import {
  exportAudit,
  exportCheckpoints,
  keyIdOf,
  verifyAgainstCheckpoints,
  verifyChain,
  writeCheckpoint,
} from "../src/kernel/audit.js";
import { contactDigest, setTrustedContact } from "../src/kernel/contacts.js";
import { completeRecoveryVerification, startRecovery } from "../src/kernel/control.js";
import { newId } from "../src/kernel/ids.js";
import {
  approvalOptions,
  approveIntent,
  prepareIntent,
  requestApproval,
} from "../src/kernel/intents.js";
import { SESSION_COOKIE } from "../src/kernel/sessions.js";
import { enrolBinding, registrationOptions } from "../src/kernel/webauthn.js";
import { connectAll, freshApp, grant, signed, type TestApp, today } from "./helpers.js";

// One test per hardening item in docs/THREAT_MODEL.md. Each was checked to
// fail with its guard removed (README, "Checking that the tests can fail").

let app: TestApp;
let server: FastifyInstance;
let maria: Record<string, string>;
const rp = { id: "localhost", name: "test", origin: "http://localhost:5173" };
const logLines: string[] = [];

async function login(personId: string) {
  const res = await server.inject({
    method: "POST",
    url: "/api/dev/login",
    payload: { personId },
    headers: { origin: rp.origin },
  });
  const c = res.cookies.find((x) => x.name === SESSION_COOKIE)!;
  return {
    token: c.value,
    headers: { cookie: `${SESSION_COOKIE}=${c.value}`, origin: rp.origin },
    raw: c,
  };
}

async function giveFakePasskey(personId: string) {
  await app.admin
    .insertInto("webauthn_credential")
    .values({
      id: `cred-${personId}`,
      person_id: personId,
      public_key: Buffer.from("x"),
      transports: [],
      counter: 0,
    })
    .execute();
}

async function notices(ownerId: string) {
  return app.admin.selectFrom("notification").selectAll().where("owner_id", "=", ownerId).execute();
}

beforeAll(async () => {
  app = await freshApp();
  server = await buildServer(app, {
    rp,
    devLogin: true,
    logger: { level: "info", stream: { write: (m: string) => void logLines.push(m) } },
  });
  maria = await connectAll(app.kernel, "p_maria", ["harbor", "summit"]);
});
afterAll(async () => {
  await server.close();
  await app.close();
});

describe("1. passkey enrolment needs more than a session", () => {
  it("with a passkey enrolled, adding another needs an assertion from it", async () => {
    await giveFakePasskey("p_lee");
    await expect(registrationOptions(app.kernel, rp, "p_lee")).rejects.toThrow(
      /existing passkey|step-up/,
    );
    // The delegate holding Lee's session cannot sign with Lee's passkey.
    const wrongDevice = { ...(await issueEnrol("p_lee")), signedBy: "p_sam" };
    await expect(registrationOptions(app.kernel, rp, "p_lee", wrongDevice)).rejects.toThrow(
      /wrong device/,
    );
    const opts = await registrationOptions(app.kernel, rp, "p_lee", await issueEnrol("p_lee"));
    expect(opts.challenge).toBeTruthy();
  });

  it("with none, only inside an enrolment window", async () => {
    await expect(registrationOptions(app.kernel, rp, "p_omar")).rejects.toThrow(
      /existing passkey or account recovery/,
    );
    await app.admin
      .updateTable("person")
      .set({ enrolment_open_until: new Date(Date.now() + 60_000) })
      .where("id", "=", "p_omar")
      .execute();
    expect((await registrationOptions(app.kernel, rp, "p_omar")).challenge).toBeTruthy();
  });

  it("recovery ends every session and only support-attested verification reopens enrolment", async () => {
    const tom = await login("p_tom");
    await giveFakePasskey("p_tom");
    await startRecovery(app.kernel, "p_tom", "p_tom");
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: tom.headers })).statusCode,
    ).toBe(401);
    await expect(registrationOptions(app.kernel, rp, "p_tom")).rejects.toThrow(/account recovery/);
    await expect(completeRecoveryVerification(app.kernel, "p_sam", "p_tom")).rejects.toThrow(
      /support only/,
    );
    await completeRecoveryVerification(app.kernel, "p_support", "p_tom");
    expect((await registrationOptions(app.kernel, rp, "p_tom")).challenge).toBeTruthy();
    expect((await notices("p_tom")).map((n) => n.kind)).toContain("recovery.started");
  });
});

async function issueEnrol(personId: string) {
  return signed(app.kernel, personId, "enrol", enrolBinding(personId));
}

describe("2. owners and a trusted contact hear about authority and money", () => {
  it("keeps the trusted contact independent of every delegate", async () => {
    const c = { name: "Rosa", email: "rosa@example.test" };
    await setTrustedContact(
      app.kernel,
      "p_maria",
      c,
      await signed(app.kernel, "p_maria", "grant", contactDigest("p_maria", c)),
    );
    // Sam cannot be made trusted contact once he helps, and the contact cannot become a helper.
    await grant(app.kernel, "p_maria", {
      delegateId: "p_sam",
      scopes: ["finance.balances.read", "finance.payments.prepare"],
      resourceIds: [maria["3821"]!, maria["9042"]!],
    });
    const sam = { name: "Sam", email: "sam@example.test" };
    await expect(
      setTrustedContact(
        app.kernel,
        "p_maria",
        sam,
        await signed(app.kernel, "p_maria", "grant", contactDigest("p_maria", sam)),
      ),
    ).rejects.toThrow(/cannot also be someone who helps/);
    // Lee names Sam as trusted contact; Lee then cannot make Sam a helper.
    const leeAccounts = await connectAll(app.kernel, "p_lee", ["harbor"]);
    await setTrustedContact(
      app.kernel,
      "p_lee",
      sam,
      await signed(app.kernel, "p_lee", "grant", contactDigest("p_lee", sam)),
    );
    await expect(
      grant(app.kernel, "p_lee", {
        delegateId: "p_sam",
        scopes: ["finance.balances.read"],
        resourceIds: Object.values(leeAccounts),
      }),
    ).rejects.toThrow(/trusted contact cannot also help/);
  });

  it("notifies the owner, the delegate and the trusted contact of a new grant, and of approvals", async () => {
    const kinds = (await notices("p_maria")).map(
      (n) => `${n.kind}:${n.recipient_person_id ?? n.recipient_email}`,
    );
    expect(kinds).toContain("grant.created:p_maria");
    expect(kinds).toContain("grant.created:p_sam");
    expect(kinds).toContain("grant.created:rosa@example.test");

    const { intentId } = await prepareIntent(app.kernel, "p_sam", newId("c"), {
      type: "finance.payment",
      details: {
        sourceAccountId: maria["3821"],
        payeeResourceId: maria["9042"],
        amount: { currency: "USD", cents: 12_345 },
        feeCents: 0,
        scheduledDate: today(),
      },
      workItemId: null,
    });
    await requestApproval(app.kernel, "p_sam", intentId);
    await giveFakePasskey("p_maria");
    const v = await approvalOptions(app.kernel, "p_maria", intentId);
    await approveIntent(app.kernel, "p_maria", intentId, 1, v.revision.digest, {
      challenge: v.challenge,
      signedBy: "p_maria",
    });
    const after = (await notices("p_maria")).map(
      (n) => `${n.kind}:${n.recipient_person_id ?? n.recipient_email}`,
    );
    expect(after).toContain("intent.approval_requested:p_maria");
    expect(after).toContain("intent.approved:rosa@example.test");
    expect(after).toContain("intent.approved:p_sam");
  });
});

describe("4. sessions", () => {
  it("uses a __Host- cookie that is Secure, HttpOnly and SameSite=Strict, stored only as a hash", async () => {
    const s = await login("p_priya");
    expect(s.raw.name).toBe("__Host-sid");
    expect(s.raw.secure).toBe(true);
    expect(s.raw.httpOnly).toBe(true);
    expect(s.raw.sameSite).toBe("Strict");
    expect(s.raw.path).toBe("/");
    const dump = JSON.stringify(await app.admin.selectFrom("session").selectAll().execute());
    expect(dump).not.toContain(s.token);
  });

  it("expires after 30 idle minutes and after 12 hours regardless", async () => {
    const a = await login("p_priya");
    await app.admin
      .updateTable("session")
      .set({ last_seen_at: new Date(Date.now() - 31 * 60_000) })
      .where("person_id", "=", "p_priya")
      .execute();
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: a.headers })).statusCode,
    ).toBe(401);
    const b = await login("p_priya");
    await app.admin
      .updateTable("session")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("person_id", "=", "p_priya")
      .execute();
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: b.headers })).statusCode,
    ).toBe(401);
  });

  it("signs out everywhere", async () => {
    const a = await login("p_omar");
    const b = await login("p_omar");
    expect(
      (await server.inject({ method: "POST", url: "/api/sessions/end-all", headers: a.headers }))
        .statusCode,
    ).toBe(200);
    expect(
      (await server.inject({ method: "GET", url: "/api/me", headers: b.headers })).statusCode,
    ).toBe(401);
  });
});

describe("5. cross-site requests", () => {
  it("rejects mutations from another origin or with no origin, but not webhooks", async () => {
    const s = await login("p_priya");
    const cookie = { cookie: s.headers.cookie };
    const evil = await server.inject({
      method: "POST",
      url: "/api/freeze",
      headers: { ...cookie, origin: "https://evil.example" },
      payload: { reason: "x" },
    });
    const none = await server.inject({
      method: "POST",
      url: "/api/freeze",
      headers: cookie,
      payload: { reason: "x" },
    });
    const sameSite = await server.inject({
      method: "POST",
      url: "/api/logout",
      headers: { ...cookie, "sec-fetch-site": "same-origin" },
    });
    expect([evil.statusCode, none.statusCode, sameSite.statusCode]).toEqual([403, 403, 200]);
    const hook = await server.inject({
      method: "POST",
      url: "/api/webhooks/fakepay",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(hook.statusCode).toBe(401);
  });
});

describe("6. browser hardening", () => {
  it("sends a strict CSP and related headers, including on the served app", async () => {
    const root = mkdtempSync(join(tmpdir(), "fo-web-"));
    writeFileSync(join(root, "index.html"), "<!doctype html><title>x</title>");
    const web = await buildServer(app, { rp, devLogin: false, webRoot: root });
    const res = await web.inject({ method: "GET", url: "/" });
    await web.close();
    expect(res.headers["cache-control"]).toBe("no-cache");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-embedder-policy"]).toBe("require-corp");
    expect(String(res.headers["permissions-policy"])).toContain("camera=()");
    const api = await buildServer(app, { rp, devLogin: false });
    const me = await api.inject({ method: "GET", url: "/api/me" });
    await api.close();
    expect(me.headers["cache-control"]).toBe("no-store");
  });

  it("loads nothing from third-party hosts", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("web/index.html", "utf8")).not.toMatch(/https?:\/\//);
  });
});

describe("7. rate limits", () => {
  it("limits sign-in attempts per client", async () => {
    const codes = [];
    for (let n = 0; n < 22; n++) {
      codes.push(
        (
          await server.inject({
            method: "POST",
            url: "/api/dev/login",
            payload: { personId: "p_nobody" },
            remoteAddress: "10.9.9.9",
            headers: { origin: rp.origin },
          })
        ).statusCode,
      );
    }
    expect(codes).toContain(429);
  });
});

describe("8. demo features fail closed", () => {
  it("refuses DEV_LOGIN in production", () => {
    let out = "";
    try {
      execFileSync("npx", ["tsx", "-e", "import('./src/config.ts')"], {
        env: { ...process.env, NODE_ENV: "production", DEV_LOGIN: "1" },
        stdio: "pipe",
      });
    } catch (e) {
      out = String((e as { stderr: Buffer }).stderr);
    }
    expect(out).toContain("DEV_LOGIN cannot be enabled");
  });
});

describe("9. least privilege in the database", () => {
  it("the app role cannot touch the provider, the job queue internals or the audit history", async () => {
    await expect(
      app.kernel.db.selectFrom("fakepay.operation").selectAll().execute(),
    ).rejects.toThrow(/permission denied/);
    await expect(sql`truncate audit_event`.execute(app.kernel.db)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`select * from graphile_worker._private_jobs`.execute(app.kernel.db),
    ).rejects.toThrow(/permission denied/);
  });

  it("the provider role cannot read FamilyOps data", async () => {
    const provider = createDb(app.url, "familyops_fakepay");
    await expect(provider.selectFrom("person").selectAll().execute()).rejects.toThrow(
      /permission denied/,
    );
    await provider.destroy();
  });
});

describe("10. signed audit checkpoints", () => {
  it("detect a rewrite even when every later hash is recomputed", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signer = { keyId: keyIdOf(publicKey), privateKey };
    await writeCheckpoint(app.kernel.db, signer);
    const trusted = new Map([[signer.keyId, publicKey]]);
    expect(
      verifyAgainstCheckpoints(
        await exportAudit(app.admin),
        await exportCheckpoints(app.admin),
        trusted,
      ),
    ).toEqual({ ok: true });

    // An attacker with owner rights forges an early row and rebuilds the chain after it.
    const records = await exportAudit(app.admin);
    const { createHash } = await import("node:crypto");
    const { canonicalJson } = await import("../src/kernel/canonical.js");
    let prev = "sha256:genesis";
    const forged = records.map((r, n) => {
      const detail = n === 2 ? { ...r.detail, forged: true } : r.detail;
      const body = {
        at: r.at,
        actor_id: r.actor_id,
        actor_kind: r.actor_kind,
        owner_id: r.owner_id,
        action: r.action,
        subject_type: r.subject_type,
        subject_id: r.subject_id,
        detail,
        prev_hash: prev,
      };
      const hash = "sha256:" + createHash("sha256").update(canonicalJson(body)).digest("hex");
      prev = hash;
      return { ...r, detail, prev_hash: body.prev_hash, hash };
    });
    expect(verifyChain(forged)).toEqual({ ok: true });
    const result = verifyAgainstCheckpoints(forged, await exportCheckpoints(app.admin), trusted);
    expect(result.ok).toBe(false);

    const other = generateKeyPairSync("ed25519").publicKey;
    expect(
      verifyAgainstCheckpoints(
        records,
        await exportCheckpoints(app.admin),
        new Map([[signer.keyId, other]]),
      ).ok,
    ).toBe(false);
  });
});

describe("11. webhooks", () => {
  it("rejects stale timestamps and altered bodies", async () => {
    const ev = { eventId: "e-stale", operationId: "o", rawStatus: "posted" };
    const stale = app.fakepay.sign(ev, Date.now() - 10 * 60_000);
    expect(app.fakepay.verifyWebhook(stale.headers, stale.body)).toBeNull();
    const fresh = app.fakepay.sign(ev);
    expect(app.fakepay.verifyWebhook(fresh.headers, fresh.body)).not.toBeNull();
    expect(
      app.fakepay.verifyWebhook(fresh.headers, fresh.body.replace("posted", "returned")),
    ).toBeNull();
  });
});

describe("12. logs hold no secrets", () => {
  it("never logs session tokens, bodies or query strings", async () => {
    const s = await login("p_maria");
    await server.inject({
      method: "GET",
      url: `/api/accounts/${maria["3821"]}/capabilities?payee=${maria["9042"]}`,
      headers: s.headers,
    });
    await server.inject({
      method: "POST",
      url: "/api/obligations",
      headers: s.headers,
      payload: {
        resourceId: maria["9042"],
        title: "secret-title-42",
        amountCents: 987_654,
        dueDate: null,
      },
    });
    const log = logLines.join("\n");
    expect(logLines.length).toBeGreaterThan(0);
    expect(log).not.toContain(s.token);
    expect(log).not.toContain("secret-title-42");
    expect(log).not.toContain("987654");
    expect(log).not.toContain(maria["9042"]!);
  });
});

describe("red-team follow-ups", () => {
  it("a delegate cannot send the owner's own draft for approval", async () => {
    const { intentId } = await prepareIntent(app.kernel, "p_maria", newId("c"), {
      type: "finance.payment",
      details: {
        sourceAccountId: maria["3821"],
        payeeResourceId: maria["9042"],
        amount: { currency: "USD", cents: 777 },
        feeCents: 0,
        scheduledDate: today(),
      },
      workItemId: null,
    });
    await expect(requestApproval(app.kernel, "p_sam", intentId)).rejects.toThrow("not found");
  });

  it("a payment can only settle a bill on an account it pays", async () => {
    const savingsBill = await app.admin
      .selectFrom("work_item")
      .select("id")
      .where("owner_id", "=", "p_lee")
      .executeTakeFirstOrThrow();
    await expect(
      prepareIntent(app.kernel, "p_sam", newId("c"), {
        type: "finance.payment",
        details: {
          sourceAccountId: maria["3821"],
          payeeResourceId: maria["9042"],
          amount: { currency: "USD", cents: 100 },
          feeCents: 0,
          scheduledDate: today(),
        },
        workItemId: savingsBill.id,
      }),
    ).rejects.toThrow("not found");
  });

  it("the app role can add known jobs and bring them forward, never postpone or invent them", async () => {
    const payload = JSON.stringify({ intentId: "intent_queue_probe" });
    const soon = new Date(Date.now() + 3_600_000);
    const later = new Date("2999-01-01T00:00:00Z");
    const earlier = new Date(Date.now() + 60_000);
    const runAt = async () =>
      (
        await sql<{
          run_at: Date;
        }>`select run_at from graphile_worker.jobs where key = 'dispatch:intent_queue_probe'`.execute(
          app.admin,
        )
      ).rows[0]!.run_at.getTime();
    await sql`select public.familyops_enqueue('dispatch', ${payload}::json, ${soon}::timestamptz)`.execute(
      app.kernel.db,
    );
    await sql`select public.familyops_enqueue('dispatch', ${payload}::json, ${later}::timestamptz)`.execute(
      app.kernel.db,
    );
    expect(await runAt()).toBe(soon.getTime());
    await sql`select public.familyops_enqueue('dispatch', ${payload}::json, ${earlier}::timestamptz)`.execute(
      app.kernel.db,
    );
    expect(await runAt()).toBe(earlier.getTime());
    await expect(
      sql`select public.familyops_enqueue('drop_everything', ${payload}::json, null)`.execute(
        app.kernel.db,
      ),
    ).rejects.toThrow(/unknown task/);
  });
});

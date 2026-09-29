import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import type { App } from "../app.js";
import { isSupport, peopleIHelp } from "../kernel/access.js";
import { audit, exportAudit, verifyChain } from "../kernel/audit.js";
import {
  freezeOwner,
  setSubmissionsEnabled,
  startRecovery,
  supportOverview,
  unfreezeOwner,
} from "../kernel/control.js";
import { receiveWebhook } from "../kernel/execution.js";
import {
  decideRequest,
  describeRequest,
  GrantProposal,
  grantsInvolving,
  previewGrant,
  requestMoreAccess,
  setGrant,
  setGrantStatus,
} from "../kernel/grants.js";
import { newId } from "../kernel/ids.js";
import {
  approvalOptions,
  approveIntent,
  cancelIntent,
  intentView,
  listIntents,
  NewIntent,
  prepareIntent,
  rejectIntent,
  requestApproval,
  reviseIntent,
  UnsupportedAction,
} from "../kernel/intents.js";
import { KernelError } from "../kernel/registry.js";
import {
  registerPasskey,
  registrationOptions,
  type RelyingParty,
  stepUpOptions,
} from "../kernel/webauthn.js";
import { updateWorkItem, createWorkItem } from "../kernel/work.js";
import {
  addPayee,
  connectInstitution,
  listInstitutions,
  markNeedsReconnect,
  reconnect,
  selectAccounts,
} from "../modules/finance/connections.js";
import type { FakepayMode, FakepayState } from "../modules/finance/fakepay.js";
import { FIXTURE_PEOPLE } from "../modules/finance/fixtures.js";
import {
  accountsView,
  capabilityFor,
  payeesView,
  queueView,
  transactionsView,
} from "../modules/finance/reads.js";

const SESSION_TTL_MS = 12 * 3600 * 1000;

export interface ServerOptions {
  rp: RelyingParty;
  devLogin: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    personId: string;
  }
}

const HTTP: Record<string, number> = {
  not_found: 404,
  forbidden: 403,
  invalid: 400,
  conflict: 409,
  stepup_required: 401,
  unknown_scope: 400,
  unknown_intent_type: 400,
  unknown_work_item_type: 400,
};

export async function buildServer(app: App, opts: ServerOptions) {
  const k = app.kernel;
  const f = Fastify({ logger: false });
  await f.register(cookie);

  f.setErrorHandler((err, _req, reply) => {
    if (err instanceof UnsupportedAction) {
      return reply.code(422).send({ error: "unsupported", capability: err.capability });
    }
    if (err instanceof KernelError)
      return reply.code(HTTP[err.code] ?? 400).send({ error: err.code, message: err.message });
    if (err instanceof ZodError)
      return reply.code(400).send({ error: "invalid", message: z.prettifyError(err) });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500)
      return reply.code(e.statusCode).send({ error: "bad_request", message: e.message });
    console.error(err);
    return reply.code(500).send({ error: "internal" });
  });

  // The actor always comes from the session, never from the request body.
  async function auth(req: FastifyRequest, reply: FastifyReply) {
    const sid = req.cookies.sid;
    const s = sid
      ? await k.db
          .selectFrom("session")
          .selectAll()
          .where("id", "=", sid)
          .where("expires_at", ">", new Date())
          .executeTakeFirst()
      : undefined;
    if (!s) return reply.code(401).send({ error: "unauthenticated" });
    req.personId = s.person_id;
  }

  // ---- identity -----------------------------------------------------------
  if (opts.devLogin) {
    f.get("/api/dev/people", async () =>
      FIXTURE_PEOPLE.map(({ id, display_name }) => ({ id, display_name })),
    );
    f.post("/api/dev/login", async (req, reply) => {
      const { personId } = z.object({ personId: z.string() }).parse(req.body);
      const p = await k.db
        .selectFrom("person")
        .select("id")
        .where("id", "=", personId)
        .executeTakeFirst();
      if (!p) throw new KernelError("not_found", "not found");
      const id = randomBytes(24).toString("base64url");
      await k.db
        .insertInto("session")
        .values({ id, person_id: personId, expires_at: new Date(Date.now() + SESSION_TTL_MS) })
        .execute();
      await k.db.transaction().execute((tx) =>
        audit(tx, {
          actorId: personId,
          actorKind: "person",
          ownerId: personId,
          action: "session.dev_login",
        }),
      );
      reply.setCookie("sid", id, { path: "/", httpOnly: true, sameSite: "strict" });
      return { ok: true };
    });
  }

  f.post("/api/logout", { preHandler: auth }, async (req, reply) => {
    await k.db.deleteFrom("session").where("id", "=", req.cookies.sid!).execute();
    reply.clearCookie("sid", { path: "/" });
    return { ok: true };
  });

  f.get("/api/me", { preHandler: auth }, async (req) => {
    const me = await k.db
      .selectFrom("person")
      .selectAll()
      .where("id", "=", req.personId)
      .executeTakeFirstOrThrow();
    const passkeys = await k.db
      .selectFrom("webauthn_credential")
      .select("id")
      .where("person_id", "=", req.personId)
      .execute();
    const freeze = await k.db
      .selectFrom("owner_freeze")
      .selectAll()
      .where("owner_id", "=", req.personId)
      .executeTakeFirst();
    return {
      id: me.id,
      displayName: me.display_name,
      email: me.email,
      isSupport: await isSupport(k.db, req.personId),
      hasPasskey: passkeys.length > 0,
      freeze: freeze ?? null,
      peopleIHelp: await peopleIHelp(k.db, req.personId),
      scopes: [...k.registry.scopes.values()],
    };
  });

  f.post("/api/passkeys/options", { preHandler: auth }, async (req) =>
    registrationOptions(k, opts.rp, req.personId),
  );
  f.post("/api/passkeys", { preHandler: auth }, async (req) => {
    await registerPasskey(k, opts.rp, req.personId, req.body as never);
    return { ok: true };
  });

  f.get("/api/people", { preHandler: auth }, async (req) =>
    k.db
      .selectFrom("person")
      .select(["id", "display_name"])
      .where("id", "<>", req.personId)
      .orderBy("display_name")
      .execute(),
  );

  // ---- invitations: introductions only, never access ----------------------
  f.post("/api/invitations", { preHandler: auth }, async (req) => {
    const b = z
      .object({ email: z.email(), note: z.string().max(500).nullable().default(null) })
      .parse(req.body);
    const id = newId("inv");
    await k.db
      .insertInto("invitation")
      .values({ id, from_person_id: req.personId, to_email: b.email, note: b.note })
      .execute();
    return { id };
  });
  f.get("/api/invitations", { preHandler: auth }, async (req) => {
    const me = await k.db
      .selectFrom("person")
      .select("email")
      .where("id", "=", req.personId)
      .executeTakeFirstOrThrow();
    return k.db
      .selectFrom("invitation as i")
      .innerJoin("person as p", "p.id", "i.from_person_id")
      .select([
        "i.id",
        "i.from_person_id",
        "p.display_name as from_name",
        "i.to_email",
        "i.note",
        "i.created_at",
        "i.accepted_at",
      ])
      .where((eb) =>
        eb.or([eb("i.to_email", "=", me.email), eb("i.from_person_id", "=", req.personId)]),
      )
      .execute();
  });

  // ---- connections and accounts (owner actions) ----------------------------
  f.get("/api/institutions", { preHandler: auth }, async (req) => {
    const me = await k.db
      .selectFrom("person")
      .select("email")
      .where("id", "=", req.personId)
      .executeTakeFirstOrThrow();
    return listInstitutions(me.email);
  });
  f.post("/api/connection-sessions", { preHandler: auth }, async (req) => {
    const { institutionId } = z.object({ institutionId: z.string() }).parse(req.body);
    return { connectionId: await connectInstitution(k, req.personId, institutionId) };
  });
  f.post("/api/connections/:id/reconnect", { preHandler: auth }, async (req) =>
    reconnect(k, req.personId, (req.params as { id: string }).id),
  );
  f.post("/api/accounts/selection", { preHandler: auth }, async (req) => {
    const b = z
      .object({ resourceIds: z.array(z.string()).min(1), selected: z.boolean() })
      .parse(req.body);
    await selectAccounts(k, req.personId, b.resourceIds, b.selected);
    return { ok: true };
  });
  f.get("/api/accounts", { preHandler: auth }, async (req) => accountsView(k, req.personId));
  f.get("/api/accounts/:id/transactions", { preHandler: auth }, async (req) =>
    transactionsView(k, req.personId, (req.params as { id: string }).id),
  );
  f.get("/api/accounts/:id/capabilities", { preHandler: auth }, async (req) => {
    const { payee } = z.object({ payee: z.string() }).parse(req.query);
    return capabilityFor(k, req.personId, (req.params as { id: string }).id, payee);
  });
  f.get("/api/payees", { preHandler: auth }, async (req) => payeesView(k, req.personId));
  f.post("/api/payees", { preHandler: auth }, async (req) => {
    const b = z
      .object({
        name: z.string().min(1),
        category: z.enum(["utility", "tax", "insurance", "other"]),
        website: z.url().nullable().default(null),
      })
      .parse(req.body);
    return { id: await addPayee(k, req.personId, b) };
  });
  f.get("/api/resources/mine", { preHandler: auth }, async (req) =>
    k.db
      .selectFrom("resource")
      .select(["id", "type", "label", "selected", "shareable", "unshareable_reason"])
      .where("owner_id", "=", req.personId)
      .orderBy("type")
      .orderBy("label")
      .execute(),
  );

  // ---- grants ---------------------------------------------------------------
  f.get("/api/grants", { preHandler: auth }, async (req) => grantsInvolving(k.db, req.personId));
  // Preview and the passkey options are issued together, bound to the same digest.
  f.post("/api/grants/preview", { preHandler: auth }, async (req) => {
    const proposal = GrantProposal.parse(req.body);
    const preview = await previewGrant(k, req.personId, proposal);
    const options = await stepUpOptions(k, opts.rp, req.personId, "grant", preview.digest);
    return { preview, options };
  });
  f.post("/api/delegation-grants", { preHandler: auth }, async (req) => {
    const b = z.object({ proposal: GrantProposal, stepUp: z.unknown() }).parse(req.body);
    return setGrant(k, req.personId, b.proposal, b.stepUp);
  });
  f.post("/api/delegation-grants/:id/status", { preHandler: auth }, async (req) => {
    const { status } = z
      .object({ status: z.enum(["active", "paused", "revoked"]) })
      .parse(req.body);
    return setGrantStatus(k, req.personId, (req.params as { id: string }).id, status);
  });
  f.delete("/api/delegation-grants/:id", { preHandler: auth }, async (req) =>
    setGrantStatus(k, req.personId, (req.params as { id: string }).id, "revoked"),
  );
  f.post("/api/grant-requests", { preHandler: auth }, async (req) => {
    const b = z
      .object({
        grantorId: z.string(),
        scopes: z.array(z.string()).min(1),
        resourceIds: z.array(z.string()).min(1),
        note: z.string().max(500).nullable().default(null),
      })
      .parse(req.body);
    return {
      id: await requestMoreAccess(k, req.personId, b.grantorId, b.scopes, b.resourceIds, b.note),
    };
  });
  f.get("/api/grant-requests", { preHandler: auth }, async (req) =>
    k.db
      .selectFrom("grant_request as r")
      .innerJoin("person as d", "d.id", "r.delegate_id")
      .select([
        "r.id",
        "r.delegate_id",
        "d.display_name as delegate_name",
        "r.scopes",
        "r.note",
        "r.status",
        "r.created_at",
      ])
      .where("r.grantor_id", "=", req.personId)
      .where("r.status", "=", "pending")
      .execute(),
  );
  f.get("/api/grant-requests/:id", { preHandler: auth }, async (req) => {
    const d = await describeRequest(k, req.personId, (req.params as { id: string }).id);
    const preview = await previewGrant(k, req.personId, d.proposed);
    const options = await stepUpOptions(k, opts.rp, req.personId, "grant", preview.digest);
    return { ...d, preview, options };
  });
  f.post("/api/grant-requests/:id/accept", { preHandler: auth }, async (req) => {
    const id = (req.params as { id: string }).id;
    const { stepUp } = z.object({ stepUp: z.unknown() }).parse(req.body);
    const d = await describeRequest(k, req.personId, id);
    const out = await setGrant(k, req.personId, d.proposed, stepUp);
    await decideRequest(k, req.personId, id, "accepted");
    return out;
  });
  f.post("/api/grant-requests/:id/decline", { preHandler: auth }, async (req) => {
    await decideRequest(k, req.personId, (req.params as { id: string }).id, "declined");
    return { ok: true };
  });

  // ---- work queue -------------------------------------------------------------
  f.get("/api/queue", { preHandler: auth }, async (req) => ({
    ...(await queueView(k, req.personId)),
    intents: await listIntents(k, req.personId),
  }));
  f.post("/api/obligations", { preHandler: auth }, async (req) => {
    const b = z
      .object({
        resourceId: z.string(),
        title: z.string().min(1).max(200),
        amountCents: z.number().int().positive().nullable(),
        dueDate: z.iso.date().nullable(),
      })
      .parse(req.body);
    const id = await createWorkItem(k, req.personId, {
      resourceId: b.resourceId,
      type: "finance.obligation",
      title: b.title,
      details: {
        amountCents: b.amountCents,
        minimumDueCents: null,
        dueDate: b.dueDate,
        autopay: "unknown",
      },
      evidenceLevel: "user_confirmed",
      source: "entered by a person",
    });
    return { id };
  });
  f.patch("/api/work-items/:id", { preHandler: auth }, async (req) => {
    const b = z
      .object({
        status: z.enum(["open", "in_progress", "marked_done", "dismissed"]).optional(),
        assigneeId: z.string().nullable().optional(),
      })
      .parse(req.body);
    await updateWorkItem(k, req.personId, (req.params as { id: string }).id, b);
    return { ok: true };
  });

  // ---- intents ----------------------------------------------------------------
  f.get("/api/payment-intents", { preHandler: auth }, async (req) => listIntents(k, req.personId));
  f.post("/api/payment-intents", { preHandler: auth }, async (req, reply) => {
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8) {
      return reply.code(400).send({ error: "invalid", message: "Idempotency-Key header required" });
    }
    const out = await prepareIntent(k, req.personId, key, NewIntent.parse(req.body));
    return reply.code(out.created ? 201 : 200).send(out);
  });
  f.get("/api/payment-intents/:id", { preHandler: auth }, async (req) =>
    intentView(k, req.personId, (req.params as { id: string }).id),
  );
  f.put("/api/payment-intents/:id/revisions", { preHandler: auth }, async (req) => {
    const b = z
      .object({ expectedRevision: z.number().int(), details: z.unknown() })
      .parse(req.body);
    return {
      revision: await reviseIntent(
        k,
        req.personId,
        (req.params as { id: string }).id,
        b.expectedRevision,
        b.details,
      ),
    };
  });
  f.post("/api/payment-intents/:id/approval-requests", { preHandler: auth }, async (req) => {
    await requestApproval(k, req.personId, (req.params as { id: string }).id);
    return { ok: true };
  });
  f.post("/api/payment-intents/:id/approval-options", { preHandler: auth }, async (req) => {
    const view = await approvalOptions(k, req.personId, (req.params as { id: string }).id);
    const creds = await k.db
      .selectFrom("webauthn_credential")
      .select("id")
      .where("person_id", "=", req.personId)
      .execute();
    if (!creds.length) throw new KernelError("stepup_required", "set up a passkey first");
    const options = await generateAuthenticationOptions({
      rpID: opts.rp.id,
      challenge: Buffer.from(view.challenge, "base64url"),
      allowCredentials: creds.map((c) => ({ id: c.id })),
      userVerification: "required",
    });
    return { ...view, challenge: undefined, options };
  });
  f.post("/api/payment-intents/:id/approvals", { preHandler: auth }, async (req) => {
    const b = z
      .object({ revision: z.number().int(), digest: z.string(), stepUp: z.unknown() })
      .parse(req.body);
    await approveIntent(
      k,
      req.personId,
      (req.params as { id: string }).id,
      b.revision,
      b.digest,
      b.stepUp,
    );
    return { ok: true };
  });
  f.post("/api/payment-intents/:id/rejections", { preHandler: auth }, async (req) => {
    const b = z
      .object({ reason: z.string().max(500).nullable().default(null) })
      .parse(req.body ?? {});
    await rejectIntent(k, req.personId, (req.params as { id: string }).id, b.reason);
    return { ok: true };
  });
  f.post("/api/payment-intents/:id/cancel-requests", { preHandler: auth }, async (req) => {
    await cancelIntent(k, req.personId, (req.params as { id: string }).id);
    return { ok: true };
  });

  // ---- provider webhooks: authenticated by signature, not session -------------
  f.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    scope.post("/api/webhooks/:provider", async (req, reply) => {
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([h, v]) => [h, Array.isArray(v) ? v[0] : v]),
      );
      const ok = await receiveWebhook(
        k,
        (req.params as { provider: string }).provider,
        headers,
        req.body as string,
      );
      return reply.code(ok ? 202 : 401).send({ ok });
    });
  });

  // ---- recovery, support, audit ------------------------------------------------
  f.post("/api/recovery/start", { preHandler: auth }, async (req) => {
    await startRecovery(k, req.personId, req.personId);
    return { ok: true };
  });
  f.post("/api/freeze", { preHandler: auth }, async (req) => {
    const { reason } = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
    await freezeOwner(k, req.personId, req.personId, reason);
    return { ok: true };
  });
  f.post("/api/unfreeze/options", { preHandler: auth }, async (req) =>
    stepUpOptions(k, opts.rp, req.personId, "recovery", `unfreeze:${req.personId}`),
  );
  f.post("/api/unfreeze", { preHandler: auth }, async (req) => {
    const { stepUp } = z.object({ stepUp: z.unknown() }).parse(req.body);
    await unfreezeOwner(k, req.personId, stepUp);
    return { ok: true };
  });
  f.get("/api/support/overview", { preHandler: auth }, async (req) =>
    supportOverview(k, req.personId),
  );
  f.post("/api/support/submissions", { preHandler: auth }, async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await setSubmissionsEnabled(k, req.personId, enabled);
    return { ok: true };
  });
  f.post("/api/support/freeze", { preHandler: auth }, async (req) => {
    const b = z.object({ ownerId: z.string(), reason: z.string().min(1) }).parse(req.body);
    await freezeOwner(k, req.personId, b.ownerId, b.reason);
    return { ok: true };
  });
  // An owner gets the events about them; support gets the full chain and its verification.
  f.get("/api/audit/export", { preHandler: auth }, async (req, reply) => {
    const support = await isSupport(k.db, req.personId);
    const records = await exportAudit(k.db, support ? undefined : req.personId);
    reply.header("content-type", "application/x-ndjson");
    if (support) reply.header("x-audit-chain", verifyChain(records).ok ? "verified" : "BROKEN");
    return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  });

  // ---- R0 simulator controls (never present outside the demonstrator) ------
  if (opts.devLogin) {
    f.post("/api/dev/fakepay/mode", { preHandler: auth }, async (req) => {
      const { mode } = z
        .object({
          mode: z.enum(["accept", "reject", "timeout_after_accept", "timeout_before_accept"]),
        })
        .parse(req.body);
      await app.fakepay.setMode(mode as FakepayMode);
      return { ok: true };
    });
    f.post("/api/dev/fakepay/advance", { preHandler: auth }, async (req) => {
      const b = z
        .object({
          intentId: z.string(),
          state: z.enum(["delivered", "posted", "returned", "failed"]),
        })
        .parse(req.body);
      const att = await k.db
        .selectFrom("execution_attempt")
        .selectAll()
        .where("intent_id", "=", b.intentId)
        .executeTakeFirst();
      if (!att?.provider_operation_id)
        throw new KernelError("conflict", "no provider operation yet");
      const ev = await app.fakepay.advance(att.provider_operation_id, b.state as FakepayState);
      const { headers, body } = app.fakepay.sign(ev);
      // Delivered through the real webhook route, signature and all.
      const res = await f.inject({
        method: "POST",
        url: "/api/webhooks/fakepay",
        headers: { ...headers, "content-type": "application/json" },
        payload: body,
      });
      return { event: ev, webhookStatus: res.statusCode };
    });
    f.post("/api/dev/connections/:id/break", { preHandler: auth }, async (req) => {
      const id = (req.params as { id: string }).id;
      const c = await k.db
        .selectFrom("finance_connection")
        .select("owner_id")
        .where("id", "=", id)
        .executeTakeFirst();
      if (c?.owner_id !== req.personId) throw new KernelError("not_found", "not found");
      await markNeedsReconnect(k, id);
      return { ok: true };
    });
  }

  return f;
}

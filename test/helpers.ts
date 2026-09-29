import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { inject } from "vitest";
import { type App, buildApp } from "../src/app.js";
import { createDb, type Db, type Tx } from "../src/db/index.js";
import {
  grantDigest,
  type GrantProposal,
  resumeBinding,
  setGrant,
  setGrantStatus,
} from "../src/kernel/grants.js";
import { approvalOptions, approveIntent } from "../src/kernel/intents.js";
import type { Kernel } from "../src/kernel/context.js";
import { issueChallenge, type StepUpPurpose, type StepUpVerifier } from "../src/kernel/stepup.js";
import { connectInstitution, selectAccounts } from "../src/modules/finance/connections.js";
import { FIXTURE_PEOPLE } from "../src/modules/finance/fixtures.js";

export const SECRET = "test-fakepay-secret";

// Stands in for a passkey: the "signature" names the person whose device made
// it. The kernel still enforces challenge binding, purpose, expiry and single use.
export const fakeStepUp: StepUpVerifier = {
  challengeOf: (r) => (r as { challenge?: string })?.challenge ?? null,
  async verify(_tx: Tx, personId: string, _challenge: string, r: unknown) {
    if ((r as { signedBy?: string }).signedBy !== personId)
      throw new Error("signature from wrong device");
    return { method: "test-passkey", credentialId: `test-${personId}` };
  },
};

export type TestApp = App & { url: string; admin: Db };

export async function freshApp(): Promise<TestApp> {
  const adminUrl = inject("pgAdminUrl");
  const name = `t_${randomBytes(6).toString("hex")}`;
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`create database ${name} template delegate_template`);
  await c.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const app = buildApp({ databaseUrl: url.toString(), stepUp: fakeStepUp, fakepaySecret: SECRET });
  // The app runs as the least-privilege role; tests inspect with an owner connection.
  const admin = createDb(url.toString());
  await admin.insertInto("person").values(FIXTURE_PEOPLE).execute();
  await admin
    .insertInto("staff_role")
    .values({ person_id: "p_support", role: "support" })
    .execute();
  return {
    ...app,
    url: url.toString(),
    admin,
    close: async () => {
      await app.close();
      await admin.destroy();
    },
  };
}

export async function signed(
  k: Kernel,
  personId: string,
  purpose: StepUpPurpose,
  digest: string | null,
  signer = personId,
) {
  const challenge = await k.db
    .transaction()
    .execute((tx) => issueChallenge(tx, personId, purpose, digest));
  return { challenge, signedBy: signer };
}

export async function grant(
  k: Kernel,
  grantorId: string,
  p: Omit<GrantProposal, "constraints" | "expiresAt"> & Partial<GrantProposal>,
) {
  const full: GrantProposal = { constraints: {}, expiresAt: null, ...p };
  return setGrant(
    k,
    grantorId,
    full,
    await signed(k, grantorId, "grant", grantDigest(grantorId, full)),
  );
}

export async function approve(k: Kernel, ownerId: string, intentId: string) {
  const opts = await approvalOptions(k, ownerId, intentId);
  const response = { challenge: opts.challenge, signedBy: ownerId };
  await approveIntent(k, ownerId, intentId, opts.revision.number, opts.revision.digest, response);
}

// Connects an owner's institutions and selects every account; returns resource ids by mask.
export async function connectAll(k: Kernel, ownerId: string, institutions: string[]) {
  for (const inst of institutions) await connectInstitution(k, ownerId, inst);
  const rows = await k.db
    .selectFrom("finance_account as a")
    .innerJoin("resource as r", "r.id", "a.resource_id")
    .select(["r.id", "a.mask"])
    .where("r.owner_id", "=", ownerId)
    .execute();
  await selectAccounts(
    k,
    ownerId,
    rows.map((r) => r.id),
    true,
  );
  return Object.fromEntries(rows.map((r) => [r.mask, r.id])) as Record<string, string>;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export async function jobs(app: TestApp, task: string) {
  const r = await sql<{ key: string | null; run_at: Date }>`
    select key, run_at from graphile_worker.jobs where task_identifier = ${task} order by id`.execute(
    app.admin,
  );
  return r.rows;
}

// Resuming a paused grant needs the grantor's passkey over this grant's current version.
export async function resume(k: Kernel, grantorId: string, grantId: string) {
  const g = await k.db
    .selectFrom("delegation_grant")
    .select("version")
    .where("id", "=", grantId)
    .executeTakeFirstOrThrow();
  return setGrantStatus(
    k,
    grantorId,
    grantId,
    "active",
    await signed(k, grantorId, "grant", resumeBinding(grantId, g.version)),
  );
}

import { sql } from "kysely";
import { buildApp } from "../app.js";
import { config, webhookSecret } from "../config.js";
import { audit } from "../kernel/audit.js";
import { newId } from "../kernel/ids.js";
import { addPayee, connectInstitution, selectAccounts } from "../modules/finance/connections.js";
import { FIXTURE_PEOPLE } from "../modules/finance/fixtures.js";

// Demo data. Maria starts connected but with nothing selected or shared, so
// the demo walks through onboarding. Lee and Sam (spouses) and Priya and her
// bookkeeper Omar start with grants already in place. Seeded grants are
// written directly and audited as such: nobody signed them with a passkey.

const app = buildApp({
  databaseUrl: config.databaseUrl,
  stepUp: { challengeOf: () => null, verify: async () => ({}) },
  fakepaySecret: webhookSecret(),
});
const { kernel: k } = app;

const existing = await k.db.selectFrom("person").select("id").execute();
if (existing.length) {
  console.log("already seeded; run `make db-reset` for a fresh demo");
  await app.close();
  process.exit(0);
}

// Simulated account creation: each person may enrol a first passkey for 30 days.
const window = new Date(Date.now() + 30 * 86_400_000);
await k.db
  .insertInto("person")
  .values(FIXTURE_PEOPLE.map((p) => ({ ...p, enrolment_open_until: window })))
  .execute();
await k.db.insertInto("staff_role").values({ person_id: "p_support", role: "support" }).execute();

async function connectAndSelect(owner: string, institutions: string[], select: boolean) {
  for (const i of institutions) await connectInstitution(k, owner, i);
  const ids = (
    await k.db.selectFrom("resource").select("id").where("owner_id", "=", owner).execute()
  ).map((r) => r.id);
  if (select) await selectAccounts(k, owner, ids, true);
  return ids;
}

async function seedGrant(
  grantor: string,
  delegate: string,
  scopes: string[],
  resourceIds: string[],
  constraints: object = {},
) {
  await k.db.transaction().execute(async (tx) => {
    const id = newId("grant");
    await tx
      .insertInto("delegation_grant")
      .values({
        id,
        grantor_id: grantor,
        delegate_id: delegate,
        scopes,
        constraints: JSON.stringify(constraints),
        status: "active",
      })
      .execute();
    await tx
      .insertInto("delegation_grant_resource")
      .values(resourceIds.map((resource_id) => ({ grant_id: id, resource_id })))
      .execute();
    await audit(tx, {
      actorId: null,
      actorKind: "system",
      ownerId: grantor,
      action: "grant.seeded_fixture",
      subjectType: "grant",
      subjectId: id,
    });
  });
}

await connectAndSelect("p_maria", ["harbor", "lakeside", "summit", "northstar"], false);
await addPayee(k, "p_maria", {
  name: "City Water Dept",
  category: "utility",
  website: "https://water.example.test",
});

const lee = await connectAndSelect("p_lee", ["harbor", "summit"], true);
const sam = await connectAndSelect("p_sam", ["harbor"], true);
const all = [
  "finance.balances.read",
  "finance.transactions.read",
  "finance.obligations.manage",
  "finance.payments.prepare",
];
await seedGrant("p_lee", "p_sam", all, lee);
await seedGrant("p_sam", "p_lee", ["finance.balances.read"], sam);

const priya = await connectAndSelect("p_priya", ["harbor", "summit"], true);
await seedGrant(
  "p_priya",
  "p_omar",
  [
    "finance.balances.read",
    "finance.transactions.read",
    "finance.obligations.manage",
    "finance.payments.prepare",
  ],
  priya,
  {
    finance: {
      perPaymentCapCents: 500_000,
      monthlyCapCents: 1_000_000,
      periodTimezone: "America/Los_Angeles",
    },
  },
);

const counts = await sql<{ n: number; what: string }>`
  select count(*)::int as n, 'resources' as what from resource
  union all select count(*)::int, 'grants' from delegation_grant
  union all select count(*)::int, 'work items' from work_item`.execute(k.db);
console.log("seeded:", counts.rows.map((r) => `${r.n} ${r.what}`).join(", "));
await app.close();

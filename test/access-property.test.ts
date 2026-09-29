import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { App } from "../src/app.js";
import { canAccess, visibleResourceIds } from "../src/kernel/access.js";
import { setGrantStatus } from "../src/kernel/grants.js";
import { addPayee, selectAccounts } from "../src/modules/finance/connections.js";
import { accountsView } from "../src/modules/finance/reads.js";
import { connectAll, freshApp, grant } from "./helpers.js";

// The SQL authorisation is checked against an in-memory model that shares no
// code with it: random sequences of grant, pause, resume, revoke and deselect,
// then every (person, scope, resource) triple is compared.

const SCOPES = [
  "finance.balances.read",
  "finance.transactions.read",
  "finance.obligations.manage",
  "finance.payments.prepare",
];
const SCOPE_TYPES: Record<string, string[]> = {
  "finance.balances.read": ["finance.account"],
  "finance.transactions.read": ["finance.account"],
  "finance.obligations.manage": ["finance.account", "finance.payee"],
  "finance.payments.prepare": ["finance.account", "finance.payee"],
};
const OWNERS = ["p_maria", "p_lee", "p_priya"];
const PEOPLE = ["p_maria", "p_lee", "p_priya", "p_sam", "p_omar", "p_tom"];

interface R {
  id: string;
  owner: string;
  type: string;
  shareable: boolean;
  selected: boolean;
}
interface G {
  id: string;
  grantor: string;
  delegate: string;
  scopes: string[];
  resources: string[];
  status: "active" | "paused" | "revoked";
}

let app: App;
let resources: R[];

beforeAll(async () => {
  app = await freshApp();
  await connectAll(app.kernel, "p_maria", ["harbor", "lakeside", "summit"]);
  await connectAll(app.kernel, "p_lee", ["harbor", "summit"]);
  await connectAll(app.kernel, "p_priya", ["harbor", "summit"]);
  await addPayee(app.kernel, "p_maria", { name: "City Water", category: "utility", website: null });
  resources = (await app.kernel.db.selectFrom("resource").selectAll().execute()).map((r) => ({
    id: r.id,
    owner: r.owner_id,
    type: r.type,
    shareable: r.shareable,
    selected: r.selected,
  }));
}, 120_000);
afterAll(() => app.close());

function oracle(
  model: { resources: R[]; grants: G[] },
  person: string,
  scope: string,
  rid: string,
): boolean {
  const r = model.resources.find((x) => x.id === rid)!;
  if (!SCOPE_TYPES[scope]!.includes(r.type)) return false;
  if (r.owner === person) return true;
  if (!r.selected || !r.shareable) return false;
  return model.grants.some(
    (g) =>
      g.status === "active" &&
      g.grantor === r.owner &&
      g.delegate === person &&
      g.scopes.includes(scope) &&
      g.resources.includes(rid),
  );
}

type Op =
  | { kind: "grant"; owner: number; delegate: number; scopes: boolean[]; pick: boolean[] }
  | { kind: "status"; g: number; status: "active" | "paused" | "revoked" }
  | { kind: "deselect"; r: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant("grant" as const),
    owner: fc.nat({ max: 2 }),
    delegate: fc.nat({ max: 5 }),
    scopes: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    pick: fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
  }),
  fc.record({
    kind: fc.constant("status" as const),
    g: fc.nat({ max: 5 }),
    status: fc.constantFrom("active" as const, "paused" as const, "revoked" as const),
  }),
  fc.record({ kind: fc.constant("deselect" as const), r: fc.nat({ max: 20 }) }),
);

describe("authorisation matches an independent model", () => {
  it("for random sequences of grants, pauses, revocations and deselections", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
        const db = app.kernel.db;
        await db.deleteFrom("delegation_grant_resource").execute();
        await db.deleteFrom("grant_request").execute();
        await db.deleteFrom("delegation_grant").execute();
        await db.updateTable("resource").set({ selected: true }).execute();
        const model = {
          resources: resources.map((r) => ({ ...r, selected: true })),
          grants: [] as G[],
        };

        for (const op of ops) {
          if (op.kind === "grant") {
            const owner = OWNERS[op.owner]!;
            const delegate = PEOPLE[op.delegate]!;
            const scopes = SCOPES.filter((_, n) => op.scopes[n]);
            const own = model.resources.filter(
              (r) => r.owner === owner && r.selected && r.shareable,
            );
            const picked = own.filter((_, n) => op.pick[n % op.pick.length]);
            const valid =
              delegate !== owner &&
              scopes.length > 0 &&
              picked.length > 0 &&
              scopes.every((s) => picked.some((r) => SCOPE_TYPES[s]!.includes(r.type)));
            try {
              const { grantId } = await grant(app.kernel, owner, {
                delegateId: delegate,
                scopes,
                resourceIds: picked.map((r) => r.id),
              });
              expect(valid).toBe(true);
              const live = model.grants.find(
                (g) => g.grantor === owner && g.delegate === delegate && g.status !== "revoked",
              );
              if (live) Object.assign(live, { scopes, resources: picked.map((r) => r.id) });
              else
                model.grants.push({
                  id: grantId,
                  grantor: owner,
                  delegate,
                  scopes,
                  resources: picked.map((r) => r.id),
                  status: "active",
                });
            } catch (e) {
              if (valid) throw e;
            }
          } else if (op.kind === "status") {
            const live = model.grants.filter((g) => g.status !== "revoked");
            const g = live[op.g % Math.max(live.length, 1)];
            if (!g) continue;
            await setGrantStatus(app.kernel, g.grantor, g.id, op.status);
            g.status = op.status;
          } else {
            const r = model.resources[op.r % model.resources.length]!;
            await selectAccounts(app.kernel, r.owner, [r.id], false);
            r.selected = false;
            for (const g of model.grants) g.resources = g.resources.filter((x) => x !== r.id);
          }
        }

        for (const person of PEOPLE) {
          for (const scope of SCOPES) {
            const visible = new Set(
              await visibleResourceIds(db, app.kernel.registry, person, scope),
            );
            for (const r of model.resources) {
              const want = oracle(model, person, scope, r.id);
              expect(
                await canAccess(db, app.kernel.registry, person, scope, r.id),
                `${person} ${scope} ${r.id}`,
              ).toBe(want);
              expect(visible.has(r.id), `list ${person} ${scope} ${r.id}`).toBe(want);
            }
          }
          // Aggregates never include an account the person cannot see.
          const totals = (await accountsView(app.kernel, person)).totals;
          for (const t of totals) {
            const expected = model.resources.filter(
              (r) =>
                r.owner === t.ownerId &&
                r.type === "finance.account" &&
                r.selected &&
                oracle(model, person, "finance.balances.read", r.id),
            ).length;
            expect(expected).toBeGreaterThan(0);
          }
        }
      }),
      { numRuns: 40 },
    );
  }, 300_000);
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { canAccess } from "../src/kernel/access.js";
import { digestOf } from "../src/kernel/canonical.js";
import { previewGrant, setGrant } from "../src/kernel/grants.js";
import { connectAll, freshApp, grant, signed, type TestApp } from "./helpers.js";

let app: TestApp;
let resourceId: string;
let grantId: string;

beforeAll(async () => {
  app = await freshApp();
  const accounts = await connectAll(app.kernel, "p_maria", ["harbor"]);
  resourceId = accounts["3821"]!;
  ({ grantId } = await grant(app.kernel, "p_maria", {
    delegateId: "p_tom",
    scopes: ["finance.transactions.read"],
    resourceIds: [resourceId],
  }));
});
afterAll(() => app.close());

describe("kernel grant proposal validation", () => {
  it.each(["scopes", "resourceIds"] as const)(
    "rejects empty %s without replacing an existing grant",
    async (field) => {
      const proposal = {
        delegateId: "p_tom",
        scopes: ["finance.transactions.read"],
        resourceIds: [resourceId],
        constraints: {},
        expiresAt: null,
        [field]: [],
      };
      const before = await app.kernel.db
        .selectFrom("delegation_grant")
        .selectAll()
        .where("id", "=", grantId)
        .executeTakeFirstOrThrow();
      const signature = await signed(
        app.kernel,
        "p_maria",
        "grant",
        digestOf({ op: "grant", grantorId: "p_maria", ...proposal }),
      );

      await expect(previewGrant(app.kernel, "p_maria", proposal)).rejects.toBeInstanceOf(ZodError);
      await expect(setGrant(app.kernel, "p_maria", proposal, signature)).rejects.toBeInstanceOf(
        ZodError,
      );
      const after = await app.kernel.db
        .selectFrom("delegation_grant")
        .selectAll()
        .where("id", "=", grantId)
        .executeTakeFirstOrThrow();
      expect(after).toEqual(before);
      expect(
        await canAccess(
          app.kernel.db,
          app.kernel.registry,
          "p_tom",
          "finance.transactions.read",
          resourceId,
        ),
      ).toBe(true);
    },
  );
});

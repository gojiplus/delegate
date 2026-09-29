import { runOnce } from "graphile-worker";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { taskList } from "../src/worker/tasks.js";
import { approvedIntent, providerOps, type Scenario, scenario, status } from "./scenarios/setup.js";

// The same flows, driven by the real job runner instead of direct calls: the
// dispatch job enqueued inside the approval transaction is what sends it.

let s: Scenario;
beforeAll(async () => {
  s = await scenario();
});
afterAll(() => s.app.close());

describe("graphile-worker", () => {
  it("runs the approval's dispatch job, and recovers a lost response via reconcile", async () => {
    const url = s.app.url;
    const tasks = taskList(s.app);
    const ok = await approvedIntent(s, 5_000);
    await runOnce({ connectionString: url, taskList: tasks });
    expect(await status(s, ok)).toBe("Submitted");

    const lost = await approvedIntent(s, 5_100);
    await s.app.fakepay.setMode("timeout_after_accept");
    await runOnce({ connectionString: url, taskList: tasks });
    expect(await status(s, lost)).toBe("Reconciling");
    // Pull the scheduled reconcile forward instead of waiting for its backoff.
    await sql`update graphile_worker._private_jobs set run_at = now() where key = ${`reconcile:${lost}`}`.execute(
      s.app.admin,
    );
    await runOnce({ connectionString: url, taskList: tasks });
    expect(await status(s, lost)).toBe("Submitted");
    expect(await providerOps(s, lost)).toHaveLength(1);
  });
});

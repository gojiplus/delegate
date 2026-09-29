import { run } from "graphile-worker";
import { buildApp } from "../app.js";
import { config, webhookSecret } from "../config.js";
import { KernelError } from "../kernel/registry.js";
import { taskList } from "./tasks.js";

// The worker is the only process that calls the payment provider. It never
// approves anything, so it gets a verifier that refuses every step-up.
const app = buildApp({
  databaseUrl: config.databaseUrl,
  stepUp: {
    challengeOf: () => null,
    verify: async () => {
      throw new KernelError("forbidden", "the worker cannot authenticate as anyone");
    },
  },
  fakepaySecret: webhookSecret(),
});
const runner = await run({
  connectionString: config.databaseUrl,
  concurrency: 5,
  pollInterval: 1000,
  taskList: taskList(app),
});
await runner.promise;

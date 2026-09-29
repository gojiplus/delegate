import { createDb, type Db } from "./db/index.js";
import type { Kernel } from "./kernel/context.js";
import { Registry } from "./kernel/registry.js";
import type { StepUpVerifier } from "./kernel/stepup.js";
import type { Fakepay } from "./modules/finance/fakepay.js";
import { createFakepay, financeModule } from "./modules/finance/index.js";

export interface App {
  kernel: Kernel;
  fakepay: Fakepay;
  close(): Promise<void>;
}

export function buildApp(opts: {
  databaseUrl: string;
  stepUp: StepUpVerifier;
  fakepaySecret: string;
  db?: Db;
}): App {
  const db = opts.db ?? createDb(opts.databaseUrl);
  // The simulated provider gets its own pool: it is "someone else's system".
  const providerDb = createDb(opts.databaseUrl);
  const fakepay = createFakepay(providerDb, opts.fakepaySecret);
  const registry = new Registry([financeModule(fakepay)]);
  return {
    kernel: { db, registry, stepUp: opts.stepUp },
    fakepay,
    async close() {
      await Promise.all([db.destroy(), providerDb.destroy()]);
    },
  };
}

import type { Db } from "../db/index.js";
import type { Registry } from "./registry.js";
import type { StepUpVerifier } from "./stepup.js";

export interface Kernel {
  db: Db;
  registry: Registry;
  stepUp: StepUpVerifier;
}

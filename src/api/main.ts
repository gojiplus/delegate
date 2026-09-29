import { buildApp } from "../app.js";
import { existsSync } from "node:fs";
import { auditPublicKey, config, webhookSecret } from "../config.js";
import { passkeyVerifier } from "../kernel/webauthn.js";
import { buildServer } from "./server.js";

const rp = { id: config.rpId, name: "Delegate (R0 demonstrator)", origin: config.rpOrigin };
const app = buildApp({
  databaseUrl: config.databaseUrl,
  stepUp: passkeyVerifier(rp),
  fakepaySecret: webhookSecret(),
});
const webRoot = new URL("../../web/dist", import.meta.url).pathname;
const server = await buildServer(app, {
  rp,
  devLogin: config.devLogin,
  logger: { level: "info" },
  auditPublicKey: auditPublicKey(),
  // In production the API serves the built app itself, under the strict CSP.
  webRoot: config.production && existsSync(webRoot) ? webRoot : undefined,
});
await server.listen({ port: config.apiPort, host: "127.0.0.1" });
console.log(
  `api listening on http://127.0.0.1:${config.apiPort}${config.devLogin ? " (dev login ON)" : ""}`,
);

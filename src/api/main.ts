import { buildApp } from "../app.js";
import { config } from "../config.js";
import { passkeyVerifier } from "../kernel/webauthn.js";
import { buildServer } from "./server.js";

const rp = { id: config.rpId, name: "FamilyOps (R0 demonstrator)", origin: config.rpOrigin };
const app = buildApp({
  databaseUrl: config.databaseUrl,
  stepUp: passkeyVerifier(rp),
  fakepaySecret: config.fakepayWebhookSecret,
});
const server = await buildServer(app, { rp, devLogin: config.devLogin });
await server.listen({ port: config.apiPort, host: "127.0.0.1" });
console.log(
  `api listening on http://127.0.0.1:${config.apiPort}${config.devLogin ? " (dev login ON)" : ""}`,
);

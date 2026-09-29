import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const production = process.env.NODE_ENV === "production";
const devLogin = process.env.DEV_LOGIN === "1";

// Demo conveniences fail closed: they cannot be switched on in production, and
// a production process without real secrets refuses to start.
if (production && devLogin) throw new Error("DEV_LOGIN cannot be enabled when NODE_ENV=production");

// Called by the processes that verify or sign webhooks; migrations don't need it.
export function webhookSecret(): string {
  const s =
    process.env.FAKEPAY_WEBHOOK_SECRET ?? (devLogin ? "dev-only-fakepay-secret" : undefined);
  if (!s) throw new Error("FAKEPAY_WEBHOOK_SECRET is required unless DEV_LOGIN=1");
  return s;
}

export const config = {
  production,
  databaseUrl: process.env.DATABASE_URL ?? "postgres://delegate:delegate@localhost:54329/delegate",
  apiPort: Number(process.env.PORT ?? 8787),
  devLogin,
  rpId: process.env.RP_ID ?? "localhost",
  rpOrigin: process.env.RP_ORIGIN ?? "http://localhost:5173",
};

// The key that signs audit checkpoints. In production it comes from the
// environment (a KMS-held key in R1) and must never be stored in the database.
// In the demo a local key is created once under .delegate/ (gitignored).
export function auditSigningKey(): KeyObject {
  const pem = process.env.AUDIT_SIGNING_KEY;
  if (pem) return createPrivateKey(pem);
  if (!devLogin) throw new Error("AUDIT_SIGNING_KEY is required unless DEV_LOGIN=1");
  const path = ".delegate/audit-signing-key.pem";
  if (!existsSync(path)) {
    mkdirSync(".delegate", { recursive: true });
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return createPrivateKey(readFileSync(path));
}

export function auditPublicKey(): KeyObject {
  return createPublicKey(auditSigningKey());
}

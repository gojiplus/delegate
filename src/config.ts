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
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://familyops:familyops@localhost:54329/familyops",
  apiPort: Number(process.env.PORT ?? 8787),
  devLogin,
  rpId: process.env.RP_ID ?? "localhost",
  rpOrigin: process.env.RP_ORIGIN ?? "http://localhost:5173",
};

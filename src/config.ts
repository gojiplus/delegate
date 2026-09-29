export const config = {
  databaseUrl:
    process.env.DATABASE_URL ?? "postgres://familyops:familyops@localhost:54329/familyops",
  apiPort: Number(process.env.PORT ?? 8787),
  devLogin: process.env.DEV_LOGIN === "1",
  rpId: process.env.RP_ID ?? "localhost",
  rpOrigin: process.env.RP_ORIGIN ?? "http://localhost:5173",
  fakepayWebhookSecret: process.env.FAKEPAY_WEBHOOK_SECRET ?? "dev-only-fakepay-secret",
};

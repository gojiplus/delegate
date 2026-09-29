import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "../../db/index.js";
import { newId } from "../../kernel/ids.js";
import type {
  IntentExecutor,
  LookupResult,
  ProviderEvent,
  SubmitResult,
} from "../../kernel/registry.js";
import type { PaymentDetails } from "./payment.js";

// A simulated creditor-payment provider with a controllable failure mode. It
// keeps its own state in the `fakepay` schema and is always reached through
// its own connection, so like a real provider nothing it writes shares a
// transaction with FamilyOps. Its documented semantics, which the adapter
// relies on: one operation per idempotency key, forever; lookups by key.

export type FakepayMode =
  | "accept"
  | "reject"
  // Records the operation, then the response is lost.
  | "timeout_after_accept"
  // The request is lost before the provider sees it.
  | "timeout_before_accept";

export type FakepayState = "pending" | "delivered" | "posted" | "returned" | "canceled" | "failed";

const NORMAL: Record<FakepayState, string> = {
  pending: "Submitted",
  delivered: "Delivered",
  posted: "Posted",
  returned: "Returned",
  canceled: "Canceled",
  failed: "Failed",
};

export class ProviderTimeout extends Error {}

export class Fakepay implements IntentExecutor<PaymentDetails> {
  readonly id = "fakepay";
  readonly idempotentRetry = true;

  constructor(
    private readonly db: Db,
    private readonly secret: string,
  ) {}

  async setMode(mode: FakepayMode): Promise<void> {
    await this.db
      .insertInto("fakepay.behavior")
      .values({ key: "next_submit", mode })
      .onConflict((oc) => oc.column("key").doUpdateSet({ mode }))
      .execute();
  }

  private async takeMode(): Promise<FakepayMode> {
    const row = await this.db
      .deleteFrom("fakepay.behavior")
      .where("key", "=", "next_submit")
      .returning("mode")
      .executeTakeFirst();
    return (row?.mode as FakepayMode | undefined) ?? "accept";
  }

  async submit(idempotencyKey: string, details: PaymentDetails): Promise<SubmitResult> {
    const existing = await this.db
      .selectFrom("fakepay.operation")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    if (existing) return { kind: "accepted", operationId: existing.id, rawStatus: existing.state };
    const mode = await this.takeMode();
    if (mode === "timeout_before_accept") throw new ProviderTimeout("request timed out");
    if (mode === "reject")
      return { kind: "rejected", reason: "creditor account not eligible (simulated)" };
    const id = newId("fpop");
    await this.db
      .insertInto("fakepay.operation")
      .values({
        id,
        idempotency_key: idempotencyKey,
        request: JSON.stringify(details),
        state: "pending",
      })
      .onConflict((oc) => oc.column("idempotency_key").doNothing())
      .execute();
    if (mode === "timeout_after_accept")
      throw new ProviderTimeout("response lost after acceptance");
    const op = await this.db
      .selectFrom("fakepay.operation")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirstOrThrow();
    return { kind: "accepted", operationId: op.id, rawStatus: op.state };
  }

  async lookup(idempotencyKey: string): Promise<LookupResult> {
    const op = await this.db
      .selectFrom("fakepay.operation")
      .selectAll()
      .where("idempotency_key", "=", idempotencyKey)
      .executeTakeFirst();
    return op ? { kind: "found", operationId: op.id, rawStatus: op.state } : { kind: "not_found" };
  }

  async getOperation(operationId: string): Promise<LookupResult> {
    const op = await this.db
      .selectFrom("fakepay.operation")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    return op ? { kind: "found", operationId: op.id, rawStatus: op.state } : { kind: "not_found" };
  }

  async cancel(operationId: string): Promise<{ canceled: boolean; reason: string }> {
    const res = await this.db
      .updateTable("fakepay.operation")
      .set({ state: "canceled" })
      .where("id", "=", operationId)
      .where("state", "=", "pending")
      .executeTakeFirst();
    if (res.numUpdatedRows === 1n) {
      await this.recordEvent(operationId, "canceled");
      return { canceled: true, reason: "canceled before delivery" };
    }
    return { canceled: false, reason: "already delivered to the creditor" };
  }

  normalize(rawStatus: string): string {
    return NORMAL[rawStatus as FakepayState] ?? "Failed";
  }

  // Simulator control: move an operation on and return the webhook it emits.
  async advance(operationId: string, state: FakepayState): Promise<ProviderEvent> {
    await this.db
      .updateTable("fakepay.operation")
      .set({ state })
      .where("id", "=", operationId)
      .execute();
    return this.recordEvent(operationId, state);
  }

  private async recordEvent(operationId: string, state: string): Promise<ProviderEvent> {
    const eventId = newId("fpev");
    await this.db
      .insertInto("fakepay.event")
      .values({ id: eventId, operation_id: operationId, state })
      .execute();
    return { eventId, operationId, rawStatus: state };
  }

  sign(event: ProviderEvent): { headers: Record<string, string>; body: string } {
    const body = JSON.stringify(event);
    const sig = createHmac("sha256", this.secret).update(body).digest("hex");
    return { headers: { "x-fakepay-signature": sig }, body };
  }

  verifyWebhook(headers: Record<string, string | undefined>, body: string): ProviderEvent | null {
    const given = headers["x-fakepay-signature"];
    if (!given) return null;
    const want = createHmac("sha256", this.secret).update(body).digest();
    const got = Buffer.from(given, "hex");
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    const e = JSON.parse(body) as ProviderEvent;
    return typeof e.eventId === "string" &&
      typeof e.operationId === "string" &&
      typeof e.rawStatus === "string"
      ? e
      : null;
  }
}

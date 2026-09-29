import type { Executor } from "../db/index.js";
import type { ActorKind } from "./audit.js";
import { KernelError, type Registry } from "./registry.js";

// Kernel states, common to every intent type. A module adds the states that
// follow Submitted (for a payment: Delivered, Posted, Returned).
export const KERNEL_TRANSITIONS: [string, string][] = [
  ["Draft", "AwaitingApproval"],
  ["Draft", "Canceled"],
  ["AwaitingApproval", "AwaitingApproval"],
  ["AwaitingApproval", "Scheduled"],
  ["AwaitingApproval", "Rejected"],
  ["AwaitingApproval", "Expired"],
  ["AwaitingApproval", "Canceled"],
  ["Scheduled", "AwaitingApproval"],
  ["Scheduled", "Dispatching"],
  ["Scheduled", "Canceled"],
  ["Scheduled", "Expired"],
  ["Dispatching", "Submitted"],
  ["Dispatching", "Reconciling"],
  ["Dispatching", "Failed"],
  ["Reconciling", "Submitted"],
  ["Reconciling", "Failed"],
  ["Submitted", "Failed"],
];

export const UNDISPATCHED = ["Draft", "AwaitingApproval", "Scheduled"];
export const KERNEL_TERMINAL = ["Rejected", "Expired", "Canceled", "Failed"];

export function allowedTransitions(registry: Registry, type: string): Set<string> {
  const t = registry.intentType(type);
  return new Set(
    [...KERNEL_TRANSITIONS, ...t.postSubmission.transitions].map(([a, b]) => `${a}>${b}`),
  );
}

export function isTerminal(registry: Registry, type: string, status: string): boolean {
  return (
    KERNEL_TERMINAL.includes(status) ||
    registry.intentType(type).postSubmission.terminal.includes(status)
  );
}

// Compare-and-set on status, so two workers can never both move an intent out
// of the same state; the loser gets a conflict and does nothing.
export async function transition(
  ex: Executor,
  registry: Registry,
  args: {
    intentId: string;
    from: string;
    to: string;
    actorId: string | null;
    actorKind: ActorKind;
    reason?: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  const intent = await ex
    .selectFrom("intent")
    .select(["type"])
    .where("id", "=", args.intentId)
    .executeTakeFirstOrThrow();
  if (!allowedTransitions(registry, intent.type).has(`${args.from}>${args.to}`)) {
    throw new KernelError("conflict", `illegal transition ${args.from} -> ${args.to}`);
  }
  const res = await ex
    .updateTable("intent")
    .set({
      status: args.to,
      status_reason: args.reason ?? null,
      hold_reason: null,
      updated_at: new Date(),
    })
    .where("id", "=", args.intentId)
    .where("status", "=", args.from)
    .executeTakeFirst();
  if (res.numUpdatedRows !== 1n) {
    throw new KernelError("conflict", `intent ${args.intentId} is no longer ${args.from}`);
  }
  await ex
    .insertInto("intent_event")
    .values({
      intent_id: args.intentId,
      from_status: args.from,
      to_status: args.to,
      actor_id: args.actorId,
      actor_kind: args.actorKind,
      reason: args.reason ?? null,
      detail: JSON.stringify(args.detail ?? {}),
    })
    .execute();
}

// A note on the timeline that does not change status (e.g. "held: access paused").
export async function note(
  ex: Executor,
  intentId: string,
  status: string,
  actorKind: ActorKind,
  reason: string,
  detail: Record<string, unknown> = {},
  actorId: string | null = null,
): Promise<void> {
  await ex
    .insertInto("intent_event")
    .values({
      intent_id: intentId,
      from_status: status,
      to_status: status,
      actor_id: actorId,
      actor_kind: actorKind,
      reason,
      detail: JSON.stringify(detail),
    })
    .execute();
}

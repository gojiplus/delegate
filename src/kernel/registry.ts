import type { z } from "zod";
import type { Executor as DbExecutor, Tx } from "../db/index.js";

// A domain module (finance today) plugs into the kernel by declaring the
// resource types it owns, the scopes that can be granted over them, the kinds
// of work items it tracks and the kinds of intents it can prepare and execute.
// The kernel owns identity, grants, approval, dispatch, reconciliation and audit
// and never looks inside a module's details objects except through these hooks.

export interface ScopeDef {
  id: string;
  resourceTypes: string[];
  // Shown verbatim in the owner's sharing preview, so it must be plain language.
  describe: string;
}

export interface WorkItemTypeDef {
  type: string;
  // Delegates see and update items of this type only on resources where they hold this scope.
  scope: string;
  details: z.ZodType<Record<string, unknown>>;
}

export type CapabilityState = "executable" | "requires_setup" | "external" | "unavailable";

export interface Capability {
  state: CapabilityState;
  reason: string;
  executor?: string;
  externalUrl?: string;
}

export interface IntentDescription {
  summary: string;
  lines: { label: string; value: string }[];
  cancellation: string;
}

export type SubmitResult =
  | { kind: "accepted"; operationId: string; rawStatus: string }
  | { kind: "rejected"; reason: string }
  | { kind: "unknown"; reason: string };

export type LookupResult =
  | { kind: "found"; operationId: string; rawStatus: string }
  | { kind: "not_found" }
  | { kind: "unknown"; reason: string };

export interface ProviderEvent {
  eventId: string;
  operationId: string;
  rawStatus: string;
}

export interface IntentExecutor<D> {
  id: string;
  // True only when the provider documents that resubmitting with the same
  // idempotency key can never create a second operation.
  idempotentRetry: boolean;
  submit(idempotencyKey: string, details: D): Promise<SubmitResult>;
  lookup(idempotencyKey: string): Promise<LookupResult>;
  getOperation(operationId: string): Promise<LookupResult>;
  cancel(operationId: string): Promise<{ canceled: boolean; reason: string }>;
  // Maps a provider status to a normalised intent status or "Failed".
  normalize(rawStatus: string): string;
  verifyWebhook(headers: Record<string, string | undefined>, body: string): ProviderEvent | null;
}

export interface DispatchContext {
  intentId: string;
  ownerId: string;
  initiatorId: string;
  // The delegate's grant when a delegate prepared the intent; null for owner-initiated intents.
  grant: { id: string; version: number; constraints: Record<string, unknown> } | null;
}

export interface IntentTypeDef<D = unknown> {
  type: string;
  prepareScope: string;
  details: z.ZodType<D>;
  // Every resource the intent touches. A delegate must hold prepareScope on all of them.
  resourcesOf(details: D): string[];
  capability(db: DbExecutor, ownerId: string, details: D): Promise<Capability>;
  describe(db: DbExecutor, details: D): Promise<IntentDescription>;
  // Advisory only: shown before approval, never blocking (PRD §5D).
  warnings(db: DbExecutor, ownerId: string, intentId: string, details: D): Promise<string[]>;
  // How long an approval of this revision may be acted on.
  approvalExpiresAt(details: D, approvedAt: Date): Date;
  // Earliest time the worker may dispatch.
  dispatchAt(details: D): Date;
  // Runs inside the dispatch transaction, after every kernel gate has passed.
  reserve?(
    tx: Tx,
    ctx: DispatchContext,
    details: D,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  settle?(tx: Tx, intentId: string, outcome: "consumed" | "released"): Promise<void>;
  executor: IntentExecutor<D>;
  // States after Submitted and their allowed transitions (skipped stages included).
  postSubmission: {
    states: string[];
    transitions: [string, string][];
    // No further change is possible.
    terminal: string[];
    // Polling stops here; a late webhook (e.g. a return) can still move it on.
    settled: string[];
    // Evidence strong enough to mark a linked work item verified done.
    verified: string[];
    // The reservation, if any, is released on reaching these; consumed on `verified`.
    releasing: string[];
  };
}

export interface DomainModule {
  id: string;
  resourceTypes: { type: string; describe: string }[];
  scopes: ScopeDef[];
  workItemTypes: WorkItemTypeDef[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  intentTypes: IntentTypeDef<any>[];
  // Module-specific limits a grantor may attach to a grant, stored under the module id.
  grantConstraints?: z.ZodType<Record<string, unknown>>;
  // Plain-language sentences for those limits, shown in the sharing preview.
  describeConstraints?(c: Record<string, unknown>): string[];
}

export class Registry {
  readonly scopes = new Map<string, ScopeDef>();
  readonly workItemTypes = new Map<string, WorkItemTypeDef>();
  readonly intentTypes = new Map<string, IntentTypeDef>();
  readonly resourceTypes = new Map<string, string>();
  readonly grantConstraints = new Map<string, z.ZodType<Record<string, unknown>>>();
  readonly constraintDescribers = new Map<string, (c: Record<string, unknown>) => string[]>();

  constructor(modules: DomainModule[]) {
    for (const m of modules) {
      if (m.grantConstraints) this.add(this.grantConstraints, m.id, m.grantConstraints);
      if (m.describeConstraints) this.add(this.constraintDescribers, m.id, m.describeConstraints);
      for (const r of m.resourceTypes) this.add(this.resourceTypes, r.type, r.describe);
      for (const s of m.scopes) this.add(this.scopes, s.id, s);
      for (const w of m.workItemTypes) this.add(this.workItemTypes, w.type, w);
      for (const i of m.intentTypes) this.add(this.intentTypes, i.type, i);
    }
  }

  private add<V>(map: Map<string, V>, key: string, value: V) {
    if (map.has(key)) throw new Error(`duplicate registration: ${key}`);
    map.set(key, value);
  }

  scope(id: string): ScopeDef {
    const s = this.scopes.get(id);
    if (!s) throw new KernelError("unknown_scope", `unknown scope ${id}`);
    return s;
  }

  intentType(type: string): IntentTypeDef {
    const t = this.intentTypes.get(type);
    if (!t) throw new KernelError("unknown_intent_type", `unknown intent type ${type}`);
    return t;
  }

  workItemType(type: string): WorkItemTypeDef {
    const t = this.workItemTypes.get(type);
    if (!t) throw new KernelError("unknown_work_item_type", `unknown work item type ${type}`);
    return t;
  }
}

export type KernelErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid"
  | "conflict"
  | "stepup_required"
  | "unknown_scope"
  | "unknown_intent_type"
  | "unknown_work_item_type";

export class KernelError extends Error {
  constructor(
    readonly code: KernelErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: { error?: string; message?: string; capability?: Capability },
  ) {
    super(body.message ?? body.capability?.reason ?? body.error ?? `HTTP ${status}`);
  }
}

export async function api<T>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) throw new ApiError(res.status, (data ?? {}) as ApiError["body"]);
  return data as T;
}

export interface Capability {
  state: "executable" | "requires_setup" | "external" | "unavailable";
  reason: string;
  externalUrl?: string;
  quotedFeeCents?: number;
}

export interface Me {
  id: string;
  displayName: string;
  isSupport: boolean;
  hasPasskey: boolean;
  freeze: { reason: string } | null;
  peopleIHelp: { id: string; display_name: string }[];
  scopes: { id: string; resourceTypes: string[]; describe: string }[];
}

export interface Account {
  id: string;
  owner_id: string;
  owner_name: string;
  label: string;
  selected: boolean;
  shareable: boolean;
  unshareable_reason: string | null;
  institution_id: string;
  kind: "depository" | "credit";
  subtype: string;
  ownership: "sole" | "joint";
  connection_id: string;
  connection_status: string;
  balance: {
    currentCents: number | null;
    availableCents: number | null;
    source: string;
    observedAt: string;
    stale: boolean;
  } | null;
  canSeeTransactions: boolean;
}

export interface WorkItem {
  id: string;
  owner_id: string;
  owner_name: string;
  resource_id: string;
  resource_label: string;
  type: string;
  title: string;
  details: {
    amountCents?: number | null;
    dueDate?: string | null;
    autopay?: string;
    minimumDueCents?: number | null;
  };
  evidence_level: "provider" | "user_confirmed" | "inferred";
  source: string;
  observed_at: string;
  status: string;
  assignee_name: string | null;
  completion: { kind: string; by?: string } | null;
}

export interface IntentSummary {
  id: string;
  type: string;
  owner_id: string;
  initiator_id: string;
  status: string;
  hold_reason: string | null;
  updated_at: string;
}

export interface Grant {
  id: string;
  grantor_id: string;
  delegate_id: string;
  grantor_name: string;
  delegate_name: string;
  scopes: string[];
  constraints: { finance?: { perPaymentCapCents?: number; monthlyCapCents?: number } };
  status: "active" | "paused";
  expires_at: string | null;
  version: number;
  resources: { id: string; label: string }[];
}

export interface IntentView {
  id: string;
  status: string;
  hold_reason: string | null;
  status_reason: string | null;
  owner_id: string;
  owner_name: string;
  initiator_id: string;
  initiator_name: string;
  revision: { number: number; digest: string; details: { amount: { cents: number } } };
  description: { summary: string; lines: { label: string; value: string }[]; cancellation: string };
  warnings: string[];
  capability: Capability;
  approval: { approved_at: string; expires_at: string } | null;
  attempt: { provider_operation_id: string | null; raw_status: string | null } | null;
  timeline: {
    id: string;
    at: string;
    from_status: string | null;
    to_status: string;
    actor_kind: string;
    actor_id: string | null;
    reason: string | null;
  }[];
}

export const usd = (cents: number | null | undefined) =>
  cents == null
    ? "unknown"
    : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
    : "unknown";

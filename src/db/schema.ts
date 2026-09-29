import type { ColumnType, Generated, JSONColumnType } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type Json<T extends object | null = Record<string, unknown>> = JSONColumnType<T, string, string>;
type BigCents = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface Database {
  person: {
    id: string;
    display_name: string;
    email: string;
    created_at: Generated<Date>;
    enrolment_open_until: NullableTimestamp;
    recovery_started_at: NullableTimestamp;
  };
  staff_role: { person_id: string; role: "support" };
  session: {
    token_hash: string;
    person_id: string;
    created_at: Generated<Date>;
    expires_at: Timestamp;
    last_seen_at: Generated<Date>;
  };
  trusted_contact: { owner_id: string; name: string; email: string; created_at: Generated<Date> };
  notification: {
    id: string;
    recipient_person_id: string | null;
    recipient_email: string | null;
    owner_id: string;
    kind: string;
    message: string;
    created_at: Generated<Date>;
    delivered_at: NullableTimestamp;
  };
  audit_checkpoint: { seq: string; hash: string; at: Timestamp; key_id: string; signature: string };
  webauthn_credential: {
    id: string;
    person_id: string;
    public_key: Buffer;
    counter: BigCents;
    transports: string[];
    created_at: Generated<Date>;
  };
  stepup_challenge: {
    challenge: string;
    person_id: string;
    purpose: string;
    binding_digest: string | null;
    created_at: Generated<Date>;
    expires_at: Timestamp;
    used_at: NullableTimestamp;
  };
  invitation: {
    id: string;
    from_person_id: string;
    to_email: string;
    note: string | null;
    created_at: Generated<Date>;
    accepted_by: string | null;
    accepted_at: NullableTimestamp;
  };
  resource: {
    id: string;
    owner_id: string;
    type: string;
    label: string;
    selected: Generated<boolean>;
    shareable: Generated<boolean>;
    unshareable_reason: string | null;
    created_at: Generated<Date>;
  };
  delegation_grant: {
    id: string;
    grantor_id: string;
    delegate_id: string;
    scopes: string[];
    constraints: Json;
    status: "active" | "paused" | "revoked";
    expires_at: NullableTimestamp;
    version: Generated<number>;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
    revoked_at: NullableTimestamp;
  };
  delegation_grant_resource: { grant_id: string; resource_id: string };
  grant_request: {
    id: string;
    grantor_id: string;
    delegate_id: string;
    scopes: string[];
    resource_ids: string[];
    note: string | null;
    status: "pending" | "accepted" | "declined" | "withdrawn";
    created_at: Generated<Date>;
    decided_at: NullableTimestamp;
  };
  work_item: {
    id: string;
    owner_id: string;
    resource_id: string;
    type: string;
    title: string;
    details: Json;
    evidence_level: "provider" | "user_confirmed" | "inferred";
    source: string;
    observed_at: Timestamp;
    status: "open" | "in_progress" | "marked_done" | "verified_done" | "dismissed";
    assignee_id: string | null;
    completion: Json | null;
    created_by: string;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  intent: {
    id: string;
    owner_id: string;
    initiator_id: string;
    type: string;
    status: string;
    hold_reason: string | null;
    status_reason: string | null;
    current_revision: number;
    idempotency_key: string;
    work_item_id: string | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  intent_revision: {
    intent_id: string;
    revision: number;
    details: Json;
    resource_ids: string[];
    digest: string;
    created_by: string;
    created_at: Generated<Date>;
  };
  approval: {
    id: string;
    intent_id: string;
    revision: number;
    digest: string;
    approver_id: string;
    method: string;
    evidence: Json;
    approved_at: Generated<Date>;
    expires_at: Timestamp;
  };
  intent_event: {
    id: Generated<string>;
    intent_id: string;
    at: Generated<Date>;
    from_status: string | null;
    to_status: string;
    actor_id: string | null;
    actor_kind: string;
    reason: string | null;
    detail: Json;
  };
  execution_attempt: {
    id: string;
    intent_id: string;
    executor: string;
    idempotency_key: string;
    provider_operation_id: string | null;
    raw_status: string | null;
    created_at: Generated<Date>;
    last_checked_at: NullableTimestamp;
  };
  inbox_event: {
    provider: string;
    event_id: string;
    payload: Json;
    received_at: Generated<Date>;
    processed_at: NullableTimestamp;
  };
  owner_freeze: { owner_id: string; reason: string; frozen_by: string; at: Generated<Date> };
  system_control: { key: string; value: ColumnType<unknown, string, string> };
  audit_event: {
    seq: Generated<string>;
    at: Timestamp;
    actor_id: string | null;
    actor_kind: "person" | "support" | "system" | "provider";
    owner_id: string | null;
    action: string;
    subject_type: string | null;
    subject_id: string | null;
    detail: Json;
    prev_hash: string;
    hash: string;
  };

  finance_connection: {
    id: string;
    owner_id: string;
    institution_id: string;
    status: "active" | "needs_reconnect";
    token_ref: string;
    consented_products: string[];
    consented_at: Generated<Date>;
    last_refreshed_at: NullableTimestamp;
  };
  finance_account: {
    resource_id: string;
    connection_id: string;
    provider_account_id: string;
    persistent_account_id: string | null;
    institution_id: string;
    name: string;
    mask: string;
    kind: "depository" | "credit";
    subtype: string;
    currency: Generated<string>;
    ownership: "sole" | "joint";
  };
  finance_payee: {
    resource_id: string;
    name: string;
    category: "utility" | "tax" | "insurance" | "other";
    website: string | null;
  };
  finance_balance: {
    resource_id: string;
    current_cents: BigCents | null;
    available_cents: BigCents | null;
    source: string;
    observed_at: Timestamp;
  };
  finance_transaction: {
    id: string;
    resource_id: string;
    provider_ref: string;
    amount_cents: BigCents;
    description: string;
    posted_date: ColumnType<string, string, string>;
    pending: boolean;
    source: string;
    observed_at: Timestamp;
  };
  finance_limit_reservation: {
    intent_id: string;
    grant_id: string;
    period_key: string;
    amount_cents: BigCents;
    status: "held" | "consumed" | "released";
    created_at: Generated<Date>;
    settled_at: NullableTimestamp;
  };
  "fakepay.operation": {
    id: string;
    idempotency_key: string;
    request: Json;
    state: string;
    created_at: Generated<Date>;
  };
  "fakepay.event": {
    id: string;
    operation_id: string;
    state: string;
    seq: Generated<string>;
    created_at: Generated<Date>;
  };
  "fakepay.behavior": { key: string; mode: string };
}

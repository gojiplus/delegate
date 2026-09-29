import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table finance_connection (
      id text primary key,
      owner_id text not null references person,
      institution_id text not null,
      status text not null check (status in ('active', 'needs_reconnect')),
      -- Simulated: in R1 this is a KMS-wrapped reference, never the token itself.
      token_ref text not null,
      consented_products text[] not null,
      consented_at timestamptz not null default now(),
      last_refreshed_at timestamptz
    );

    create table finance_account (
      resource_id text primary key references resource,
      connection_id text not null references finance_connection,
      provider_account_id text not null,
      persistent_account_id text,
      institution_id text not null,
      name text not null,
      mask text not null,
      kind text not null check (kind in ('depository', 'credit')),
      subtype text not null,
      currency text not null default 'USD',
      ownership text not null check (ownership in ('sole', 'joint')),
      unique (connection_id, provider_account_id)
    );

    -- Billers that are not accounts the owner holds: utilities, tax, insurance.
    create table finance_payee (
      resource_id text primary key references resource,
      name text not null,
      category text not null check (category in ('utility', 'tax', 'insurance', 'other')),
      website text
    );

    create table finance_balance (
      resource_id text not null references resource,
      current_cents bigint,
      available_cents bigint,
      source text not null,
      observed_at timestamptz not null,
      primary key (resource_id, observed_at)
    );

    create table finance_transaction (
      id text primary key,
      resource_id text not null references resource,
      provider_ref text not null,
      amount_cents bigint not null,
      description text not null,
      posted_date date not null,
      pending boolean not null,
      source text not null,
      observed_at timestamptz not null,
      unique (resource_id, provider_ref)
    );

    create table finance_limit_reservation (
      intent_id text primary key references intent,
      grant_id text not null references delegation_grant,
      period_key text not null,
      amount_cents bigint not null check (amount_cents > 0),
      status text not null check (status in ('held', 'consumed', 'released')),
      created_at timestamptz not null default now(),
      settled_at timestamptz
    );

    -- The fake payment provider's own state. It lives in its own schema and is
    -- reached over a separate connection so that, like a real provider, none of
    -- its writes share a transaction with ours.
    create schema fakepay;
    create table fakepay.operation (
      id text primary key,
      idempotency_key text not null unique,
      request jsonb not null,
      state text not null,
      created_at timestamptz not null default now()
    );
    create table fakepay.event (
      id text primary key,
      operation_id text not null references fakepay.operation,
      state text not null,
      seq bigserial,
      created_at timestamptz not null default now()
    );
    create table fakepay.behavior (
      key text primary key,
      mode text not null
    );
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("no down migrations");
}

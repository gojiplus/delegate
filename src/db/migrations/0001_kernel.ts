import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    create table person (
      id text primary key,
      display_name text not null,
      email text not null unique,
      created_at timestamptz not null default now()
    );

    -- Staff roles are separate from people's own accounts: support can inspect
    -- metadata and freeze activity but never acts as an owner (P12).
    create table staff_role (
      person_id text primary key references person,
      role text not null check (role in ('support'))
    );

    create table session (
      id text primary key,
      person_id text not null references person,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null
    );

    create table webauthn_credential (
      id text primary key,
      person_id text not null references person,
      public_key bytea not null,
      counter bigint not null,
      transports text[] not null default '{}',
      created_at timestamptz not null default now()
    );

    -- A step-up challenge is bound to one purpose and one digest of the exact
    -- thing being authorised, so it cannot be replayed against anything else.
    create table stepup_challenge (
      challenge text primary key,
      person_id text not null references person,
      purpose text not null,
      binding_digest text,
      created_at timestamptz not null default now(),
      expires_at timestamptz not null,
      used_at timestamptz
    );

    -- An invitation carries no authority; it only introduces two people.
    create table invitation (
      id text primary key,
      from_person_id text not null references person,
      to_email text not null,
      note text,
      created_at timestamptz not null default now(),
      accepted_by text references person,
      accepted_at timestamptz
    );

    create table resource (
      id text primary key,
      owner_id text not null references person,
      type text not null,
      label text not null,
      selected boolean not null default false,
      shareable boolean not null default true,
      unshareable_reason text,
      created_at timestamptz not null default now(),
      check (shareable or unshareable_reason is not null)
    );
    create index resource_owner on resource (owner_id);

    create table delegation_grant (
      id text primary key,
      grantor_id text not null references person,
      delegate_id text not null references person,
      scopes text[] not null,
      constraints jsonb not null default '{}',
      status text not null check (status in ('active', 'paused', 'revoked')),
      expires_at timestamptz,
      version integer not null default 1,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      revoked_at timestamptz,
      check (grantor_id <> delegate_id)
    );
    create unique index one_live_grant_per_pair on delegation_grant (grantor_id, delegate_id)
      where status <> 'revoked';

    create table delegation_grant_resource (
      grant_id text not null references delegation_grant,
      resource_id text not null references resource,
      primary key (grant_id, resource_id)
    );

    -- A delegate may ask for more; only the grantor can turn a request into a grant (P10).
    create table grant_request (
      id text primary key,
      grantor_id text not null references person,
      delegate_id text not null references person,
      scopes text[] not null,
      resource_ids text[] not null,
      note text,
      status text not null check (status in ('pending', 'accepted', 'declined', 'withdrawn')),
      created_at timestamptz not null default now(),
      decided_at timestamptz
    );

    create table work_item (
      id text primary key,
      owner_id text not null references person,
      resource_id text not null references resource,
      type text not null,
      title text not null,
      details jsonb not null default '{}',
      evidence_level text not null check (evidence_level in ('provider', 'user_confirmed', 'inferred')),
      source text not null,
      observed_at timestamptz not null,
      status text not null check (status in ('open', 'in_progress', 'marked_done', 'verified_done', 'dismissed')),
      assignee_id text references person,
      completion jsonb,
      created_by text not null references person,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table intent (
      id text primary key,
      owner_id text not null references person,
      initiator_id text not null references person,
      type text not null,
      status text not null,
      hold_reason text,
      status_reason text,
      current_revision integer not null,
      idempotency_key text not null unique,
      work_item_id text references work_item,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create index intent_owner on intent (owner_id);

    create table intent_revision (
      intent_id text not null references intent,
      revision integer not null,
      details jsonb not null,
      resource_ids text[] not null,
      digest text not null,
      created_by text not null references person,
      created_at timestamptz not null default now(),
      primary key (intent_id, revision)
    );

    create table approval (
      id text primary key,
      intent_id text not null references intent,
      revision integer not null,
      digest text not null,
      approver_id text not null references person,
      method text not null,
      evidence jsonb not null,
      approved_at timestamptz not null default now(),
      expires_at timestamptz not null,
      unique (intent_id, revision),
      foreign key (intent_id, revision) references intent_revision
    );

    create table intent_event (
      id bigserial primary key,
      intent_id text not null references intent,
      at timestamptz not null default clock_timestamp(),
      from_status text,
      to_status text not null,
      actor_id text,
      actor_kind text not null,
      reason text,
      detail jsonb not null default '{}'
    );

    -- One attempt per intent; retries reuse it and its idempotency key (P8).
    create table execution_attempt (
      id text primary key,
      intent_id text not null unique references intent,
      executor text not null,
      idempotency_key text not null unique,
      provider_operation_id text,
      raw_status text,
      created_at timestamptz not null default now(),
      last_checked_at timestamptz
    );

    create table inbox_event (
      provider text not null,
      event_id text not null,
      payload jsonb not null,
      received_at timestamptz not null default now(),
      processed_at timestamptz,
      primary key (provider, event_id)
    );

    create table owner_freeze (
      owner_id text primary key references person,
      reason text not null,
      frozen_by text not null,
      at timestamptz not null default now()
    );

    create table system_control (
      key text primary key,
      value jsonb not null
    );
    insert into system_control values ('submissions_enabled', 'true');

    create table audit_event (
      seq bigserial primary key,
      at timestamptz not null,
      actor_id text,
      actor_kind text not null check (actor_kind in ('person', 'support', 'system', 'provider')),
      owner_id text,
      action text not null,
      subject_type text,
      subject_id text,
      detail jsonb not null default '{}',
      prev_hash text not null,
      hash text not null unique
    );
    create index audit_owner on audit_event (owner_id, seq);

    create function audit_event_is_append_only() returns trigger language plpgsql as $$
    begin
      raise exception 'audit_event is append-only';
    end $$;
    create trigger audit_event_no_update before update or delete on audit_event
      for each row execute function audit_event_is_append_only();
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("no down migrations");
}

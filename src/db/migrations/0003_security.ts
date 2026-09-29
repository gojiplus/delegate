import { type Kysely, sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- A first passkey can be enrolled only inside a window opened by account
    -- creation or completed recovery; every later one needs an existing passkey.
    alter table person add column enrolment_open_until timestamptz;

    -- Sessions are looked up by a SHA-256 of the cookie value, so a copy of the
    -- table cannot be replayed as cookies.
    delete from session;
    alter table session rename column id to token_hash;
    alter table session add column last_seen_at timestamptz not null default now();

    -- Independent of every delegate (FINRA Rule 4512's trusted contact person).
    create table trusted_contact (
      owner_id text primary key references person,
      name text not null,
      email text not null,
      created_at timestamptz not null default now()
    );

    -- Outbox for out-of-band notices. R0 shows it in the app; R1 delivers by email/SMS.
    create table notification (
      id text primary key,
      recipient_person_id text references person,
      recipient_email text,
      owner_id text not null references person,
      kind text not null,
      message text not null,
      created_at timestamptz not null default now(),
      delivered_at timestamptz,
      check (recipient_person_id is not null or recipient_email is not null)
    );
    create index notification_recipient on notification (recipient_person_id, created_at desc);

    create table audit_checkpoint (
      seq bigint primary key,
      hash text not null,
      at timestamptz not null,
      key_id text not null,
      signature text not null
    );

    -- Least privilege. The application role can read and write its tables but
    -- can only append to the audit log, and cannot see the simulated
    -- provider's schema at all; the provider role sees only that schema.
    do $$ begin
      if not exists (select from pg_roles where rolname = 'delegate_app') then create role delegate_app nologin; end if;
      if not exists (select from pg_roles where rolname = 'delegate_fakepay') then create role delegate_fakepay nologin; end if;
    end $$;

    grant usage on schema public to delegate_app;
    grant select, insert, update, delete on all tables in schema public to delegate_app;
    grant usage, select on all sequences in schema public to delegate_app;
    revoke update, delete, truncate on audit_event, audit_checkpoint from delegate_app;
    revoke delete, truncate on intent_event from delegate_app;
    revoke all on kysely_migration, kysely_migration_lock from delegate_app;
    revoke all on schema fakepay from delegate_app;

    grant usage on schema fakepay to delegate_fakepay;
    grant select, insert, update, delete on all tables in schema fakepay to delegate_fakepay;
    grant usage, select on all sequences in schema fakepay to delegate_fakepay;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("no down migrations");
}

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { runMigrations } from "graphile-worker";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { createDb, grantJobPrivileges, migrate } from "../src/db/index.js";

let container: StartedPostgreSqlContainer | undefined;

// One Postgres for the run: TEST_PG_URL (an admin URL to any Postgres 17) if
// set, otherwise a throwaway container. The schema is built once into a
// template database and every test file clones it, so files never share rows.
export async function setup(project: TestProject) {
  let adminUrl = process.env.TEST_PG_URL;
  if (!adminUrl) {
    container = await new PostgreSqlContainer("postgres:17-alpine")
      .withCommand(["postgres", "-c", "max_connections=300"])
      .start();
    adminUrl = container.getConnectionUri();
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const stale = await admin.query<{ datname: string }>(
    "select datname from pg_database where datname = 'delegate_template' or datname like 't\\_%'",
  );
  for (const { datname } of stale.rows)
    await admin.query(`drop database "${datname}" with (force)`);
  await admin.query("create database delegate_template");
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = "/delegate_template";
  const db = createDb(url.toString());
  await migrate(db);
  await runMigrations({ connectionString: url.toString() });
  await grantJobPrivileges(db);
  await db.destroy();
  url.pathname = "/postgres";
  project.provide("pgAdminUrl", url.toString());
}

export async function teardown() {
  await container?.stop();
}

declare module "vitest" {
  export interface ProvidedContext {
    pgAdminUrl: string;
  }
}

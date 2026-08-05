import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let container: StartedPostgreSqlContainer | undefined;
let pool: Pool | undefined;

/**
 * Starts a fresh, ephemeral Postgres container (via Testcontainers),
 * applies the real migration (migrations/001_init.sql — the same file
 * used in production), and returns a connected pool.
 *
 * This makes the test suite genuinely self-contained: no reviewer needs
 * their own Neon/Postgres account or a DATABASE_URL. The only requirement
 * is a running Docker daemon on the machine running `npm test`, which
 * Testcontainers uses to launch and tear down the container automatically.
 */
export async function setupTestDatabase(): Promise<Pool> {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();

  pool = new Pool({ connectionString: container.getConnectionUri() });

  const migrationSql = readFileSync(
    path.join(__dirname, "..", "migrations", "001_init.sql"),
    "utf-8"
  );
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto;");
  await pool.query(migrationSql);

  return pool;
}

export async function teardownTestDatabase(): Promise<void> {
  await pool?.end();
  await container?.stop();
}

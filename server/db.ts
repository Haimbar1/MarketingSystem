import pg from 'pg';

// Postgres (DATABASE_URL). Tables are created lazily, one row per business per thing (tenant_id =
// portal tenant id). Without DATABASE_URL `db()` is null - reading still works, but anything that
// must be kept (an approved change to a live campaign and how to undo it) is refused.
let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;
// SSL first (managed Postgres), and without it when the server says it doesn't support SSL - the
// shared self-hosted Postgres doesn't (same probe as the CRM's sslModeFor).
let useSsl: boolean | null = null;

export function db(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (useSsl === null) useSsl = !/sslmode=disable|localhost|127\.0\.0\.1/.test(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 3, ssl: useSsl ? { rejectUnauthorized: false } : false });
  }
  return pool;
}

async function resetWithoutSsl() {
  const old = pool;
  pool = null;
  useSsl = false;
  await old?.end().catch(() => {});
}

// The pool, with the tables created. Always use the pool this returns (it may have been rebuilt
// without SSL).
export async function ensureTables(): Promise<pg.Pool> {
  if (!db()) throw new Error('no-database');
  try {
    await createTables();
  } catch (e: any) {
    if (!useSsl || !/does not support SSL/i.test(String(e?.message))) throw e;
    await resetWithoutSsl();
    await createTables();
  }
  return db()!;
}

function createTables(): Promise<void> {
  const p = db()!;
  if (!ready) {
    ready = p.query(`
      CREATE TABLE IF NOT EXISTS mk_optimizations (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        campaign_id TEXT NOT NULL,
        campaign_name TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        analysis JSONB NOT NULL,
        suggestions JSONB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mk_optimizations_t ON mk_optimizations (tenant_id, campaign_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS mk_changes (
        id BIGSERIAL PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        optimization_id BIGINT,
        suggestion_id TEXT,
        campaign_id TEXT,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        object_name TEXT,
        action TEXT NOT NULL,
        title TEXT,
        before JSONB,
        after JSONB,
        status TEXT NOT NULL,
        error TEXT,
        done_by TEXT,
        done_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        undone_at TIMESTAMPTZ,
        undone_by TEXT,
        undo_of BIGINT
      );
      CREATE INDEX IF NOT EXISTS mk_changes_t ON mk_changes (tenant_id, campaign_id, done_at DESC);
    `).then(() => undefined).catch(e => { ready = null; throw e; });
  }
  return ready;
}

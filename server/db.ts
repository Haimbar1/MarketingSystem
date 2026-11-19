import pg from 'pg';

// Postgres (DATABASE_URL). Tables are created lazily, one row per business per thing (tenant_id =
// portal tenant id). Without DATABASE_URL `db()` is null - reading still works, but anything that
// must be kept (an approved change to a live campaign and how to undo it) is refused.
let pool: pg.Pool | null = null;
let ready: Promise<void> | null = null;

export function db(): pg.Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: url,
      max: 3,
      ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function ensureTables(): Promise<pg.Pool> {
  const p = db();
  if (!p) throw new Error('no-database');
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
  await ready;
  return p;
}

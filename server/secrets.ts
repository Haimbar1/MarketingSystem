import jwt from 'jsonwebtoken';
import { OPTICS_TENANT, currentTenant } from './tenant.js';

// Each business's keys live encrypted in the portal's vault ("מזהים וחיבורים"), read here
// server-to-server as module `marketing` (the catalog lists which keys this module gets -
// portal/server/src/secrets/catalog.js). 5-minute cache; the last good copy is kept on an outage.
// The optics (tenant 1) may also fall back to this app's Vercel env for a key the vault lacks.
const PORTAL_URL = process.env.PORTAL_URL || 'https://portal.smartesek.com';
const MODULE = 'marketing';
const SHARED_FALLBACK_KEYS = new Set(['GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; secrets: Record<string, string> }>();

export async function vaultSecrets(tenant: string = currentTenant()): Promise<Record<string, string>> {
  const portalId = Number(tenant);
  const shared = process.env.SSO_SHARED_SECRET;
  if (!portalId || !shared) return {};
  const hit = cache.get(tenant);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.secrets;
  try {
    const token = jwt.sign({ typ: 'secrets', tenantId: portalId, module: MODULE }, shared, { expiresIn: '30s' });
    const r = await fetch(`${PORTAL_URL}/api/sso/secrets`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`portal ${r.status}`);
    const d: any = await r.json();
    const secrets = d?.secrets && typeof d.secrets === 'object' ? d.secrets : {};
    cache.set(tenant, { at: Date.now(), secrets });
    return secrets;
  } catch (e: any) {
    console.warn('[secrets] portal vault read failed:', e?.message);
    return hit?.secrets || {};
  }
}

export async function tenantSecret(key: string, tenant: string = currentTenant()): Promise<string> {
  const v = (await vaultSecrets(tenant))[key];
  if (v) return v;
  if (tenant === OPTICS_TENANT && process.env[key]) return process.env[key] as string;
  return SHARED_FALLBACK_KEYS.has(key) ? process.env[key] || '' : '';
}
